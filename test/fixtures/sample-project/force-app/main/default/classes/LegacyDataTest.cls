@IsTest(SeeAllData=true)
private class LegacyDataTest {
    @IsTest
    static void readsOrgData() {
        List<Account> existing = [SELECT Id FROM Account LIMIT 1];
        System.assertNotEquals(null, existing, 'org data must be readable');
    }
}
