string standalone.Contacts_not_Associated_with_Account()
{
manualContactIds = list();
manualContactIds.add("4971774000478411305");
manualContactIds.add("4971774000478407254");
testLimit = 0;
matchedContacts = list();
if(manualContactIds.size() > 0)
{
	addedManualIds = list();
	for each  manualId in manualContactIds
	{
		manualIdStr = manualId.toString().trim();
		if(manualIdStr != "" && !addedManualIds.contains(manualIdStr))
		{
			manualRow = Map();
			manualRow.put("id",manualIdStr);
			matchedContacts.add(manualRow);
			addedManualIds.add(manualIdStr);
		}
	}
	info "Manual Contact ID(s) provided - running only on " + matchedContacts.size() + " specific Contact(s).";
}
else
{
	offsetList = list();
	offsetList.add(0);
	offsetList.add(2000);
	offsetList.add(4000);
	offsetList.add(6000);
	offsetList.add(8000);
	offsetList.add(10000);
	for each  offsetVal in offsetList
	{
		if(testLimit > 0 && matchedContacts.size() >= testLimit)
		{
			break;
		}
		fetchLimit = 2000;
		if(testLimit > 0)
		{
			fetchLimit = testLimit;
		}
		coqlQuery = {"select_query":"select id from Contacts where (Account_Associated = false) limit " + offsetVal + ", " + fetchLimit};
		coqlResponse = invokeurl
		[
			url :"https://www.zohoapis.com/crm/v8/coql"
			type :POST
			parameters:coqlQuery.toString()
			connection:"zcrm"
		];
		if(coqlResponse == null || coqlResponse.get("data") == null || coqlResponse.get("data").size() == 0)
		{
			info "Offset " + offsetVal + " - no more matching records, stopping fetch.";
			break;
		}
		coqlData = coqlResponse.get("data");
		for each  row in coqlData
		{
			matchedContacts.add(row);
			if(testLimit > 0 && matchedContacts.size() >= testLimit)
			{
				break;
			}
		}
	}
	if(testLimit > 0)
	{
		info "testLimit=" + testLimit + " - fetched " + matchedContacts.size() + " Contact(s) for this run.";
	}
	else
	{
		info "Total unassociated contacts found: " + matchedContacts.size();
	}
}
batchSuccess = 0;
batchFail = 0;
batchSkipped = 0;
batchNoMatch = 0;
batchTotal = matchedContacts.size();
emailDomainMatchCount = 0;
companyNameMatchCount = 0;
stoppedAtContact = "";
for each  contactRow in matchedContacts
{
	contactId = contactRow.get("id");
	info "Contact Id: " + contactId;
	try
	{
		contact = zoho.crm.getRecordById("Contacts",contactId.toLong());
		if(contact == null || contact.get("id") == null)
		{
			throw "Contact not found";
		}
		if(contact.get("Account_Name") != null)
		{
			info "Contact already had Account - flagging Account_Associated only | contactId=" + contactId;
			response = zoho.crm.updateRecord("Contacts",contactId.toLong(),{"Account_Associated":true},{"trigger":{}});
			if(response != null && response.get("id") == contactId)
			{
				batchSkipped = batchSkipped + 1;
			}
			else
			{
				throw "Account_Associated update did not confirm (already had Account) - response: " + response;
			}
			continue;
		}
		contactEmail = ifNull(contact.get("Email"),"").toString().trim().toLowerCase();
		companyName = ifNull(contact.get("Company"),"").toString().trim();
		matchedAccountId = "";
		// ====================================================
		// 1. MATCH BY EMAIL DOMAIN
		// ====================================================
		if(contactEmail != "" && contactEmail.contains("@"))
		{
			contactDomain = contactEmail.getSuffix("@").toLowerCase().trim();
			safeDomain = contactDomain.replaceAll("[()'\",]","").trim();
			info "Contact=" + contactId + " | Contact Domain=" + contactDomain;
			accounts = zoho.crm.searchRecords("Accounts","(Email_Domains:equals:" + safeDomain + ")");
			if(accounts != null && accounts.size() > 0 && accounts.get(0).get("id") != null)
			{
				matchedAccountId = accounts.get(0).get("id").toString();
				emailDomainMatchCount = emailDomainMatchCount + 1;
				info "DOMAIN MATCH | Contact=" + contactId + " | Account=" + matchedAccountId;
			}
			else
			{
				info "NO DOMAIN MATCH | Contact=" + contactId + " | Domain=" + contactDomain;
			}
		}
		// ====================================================
		// 2. MATCH BY COMPANY NAME — via COQL, not searchRecords.
		// searchRecords criteria strings cannot reliably handle
		// ()'",&/:;\ in the value even when backslash-escaped
		// (documented Zoho/community limitation); COQL only needs
		// the single quote doubled, same as any SQL string literal.
		// ====================================================
		if(matchedAccountId == "" && companyName != "")
		{
			safeCompanyName = companyName.replaceAll("'","''");
			companyCoqlQuery = {"select_query":"select id from Accounts where Account_Name = '" + safeCompanyName + "' limit 1"};
			companyCoqlResponse = invokeurl
			[
				url :"https://www.zohoapis.com/crm/v8/coql"
				type :POST
				parameters:companyCoqlQuery.toString()
				connection:"zcrm"
			];
			if(companyCoqlResponse != null && companyCoqlResponse.get("data") != null && companyCoqlResponse.get("data").size() > 0)
			{
				matchedAccountId = companyCoqlResponse.get("data").get(0).get("id").toString();
				companyNameMatchCount = companyNameMatchCount + 1;
				info "COMPANY MATCH | Contact=" + contactId + " | Account=" + matchedAccountId + " | Company=" + companyName;
			}
			else
			{
				info "NO COMPANY MATCH | Contact=" + contactId + " | Company=" + companyName;
			}
		}
		// ====================================================
		// 3. UPDATE CONTACT
		// Match found -> Account_Name set, Account_Associated = true.
		// No match -> leave Account_Associated = false so this Contact
		// stays in the pool and is retried on a future run (e.g. once
		// a matching Account is created later); no update is issued.
		// ====================================================
		if(matchedAccountId != "")
		{
			response = zoho.crm.updateRecord("Contacts",contactId.toLong(),{"Account_Associated":true,"Account_Name":Map({"id":matchedAccountId})},{"trigger":{}});
			if(response != null && response.get("id") == contactId)
			{
				batchSuccess = batchSuccess + 1;
				info "UPDATED | Contact=" + contactId + " | Account=" + matchedAccountId;
			}
			else
			{
				throw "Account update did not confirm - contactId=" + contactId + " | accountId=" + matchedAccountId + " | response=" + response;
			}
		}
		else
		{
			batchNoMatch = batchNoMatch + 1;
			info "NO MATCH | Contact=" + contactId + " (left unassociated for retry)";
		}
	}
	catch (e)
	{
		batchFail = batchFail + 1;
		stoppedAtContact = contactId.toString() + " (" + e.toString() + ")";
	}
}
info "Completed - " + batchSuccess + "/" + batchTotal + " associated, " + batchSkipped + " skipped (already had Account), " + batchNoMatch + " no match (left for retry), " + batchFail + " failed" + if(batchFail > 0," | last error on contact " + stoppedAtContact,"");
info "Email Domain Matches=" + emailDomainMatchCount + " | Company Name Matches=" + companyNameMatchCount;
return "";
}
