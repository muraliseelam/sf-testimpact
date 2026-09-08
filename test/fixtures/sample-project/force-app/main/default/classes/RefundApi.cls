@RestResource(urlMapping='/refund/*')
global with sharing class RefundApi {
    @HttpPost
    global static String post(String reason) {
        if (!FeatureManagement.checkPermission('Approve_Refunds')) {
            return System.Label.Refund_Denied;
        }
        return 'ok';
    }
}
