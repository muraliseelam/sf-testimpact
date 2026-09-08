@IsTest
private class DispatcherTest {
    @IsTest
    static void dispatchesByName() {
        Test.startTest();
        Dispatcher.run('AccountHandler', new List<SObject>());
        Test.stopTest();
    }
}
