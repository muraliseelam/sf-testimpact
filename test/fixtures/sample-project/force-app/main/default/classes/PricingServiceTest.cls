@IsTest
private class PricingServiceTest {
    @IsTest
    static void ratesAnAccount() {
        Account acct = new Account(Name = 'Test');
        insert acct;
        System.assertEquals(0, PricingService.rate(acct), 'no invoices means zero');
    }
}
