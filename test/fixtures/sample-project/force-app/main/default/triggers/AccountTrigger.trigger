trigger AccountTrigger on Account (before insert, before update) {
    Dispatcher.run('AccountHandler', Trigger.new);
}
