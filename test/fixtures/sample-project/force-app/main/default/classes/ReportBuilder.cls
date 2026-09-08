public with sharing class ReportBuilder {
    public static List<SObject> build(String soql) {
        // Dynamic SOQL: may read any object or field.
        return Database.query(soql);
    }
}
