public with sharing class AccountHandler implements IHandler {
    public void handle(List<SObject> records) {
        for (Account acct : (List<Account>) records) {
            acct.Rating__c = PricingService.rate(acct);
        }
    }
}
