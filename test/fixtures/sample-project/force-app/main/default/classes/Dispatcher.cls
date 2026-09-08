public with sharing class Dispatcher {
    // Dynamic dispatch: the handler class is named by configuration, not by a static
    // reference. This is the construct that must taint the apexType domain.
    public static void run(String handlerName, List<SObject> records) {
        Type handlerType = Type.forName(handlerName);
        IHandler handler = (IHandler) handlerType.newInstance();
        handler.handle(records);
    }
}
