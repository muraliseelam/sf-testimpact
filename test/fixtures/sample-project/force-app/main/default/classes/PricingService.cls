public with sharing class PricingService {
    public static Decimal rate(Account acct) {
        List<Invoice__c> invoices = [SELECT Id, Amount__c FROM Invoice__c WHERE Account__c = :acct.Id];
        Decimal total = 0;
        for (Invoice__c inv : invoices) {
            total += inv.Amount__c;
        }
        return total;
    }
}
