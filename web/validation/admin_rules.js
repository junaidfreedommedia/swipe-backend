module.exports = {
    UserProfileUpdate:{
        display_name : 'required',
    },
    NewClaim :{
        mid : 'required',
        oid : 'required',
        type : 'required',
        description : 'required',
        preference : 'required'
    },
    AddUser:{
        display_name: 'required',
        email: 'required|email',
    },
    TaskUpdate:{
        merchant: 'required|IsValidObjectID',
        task: 'required',
        status: 'required|boolean'
    },
    SearchOrder: { search: 'required' },
    ParamsId: { id: 'required|IsValidObjectID' },
    SendBilling: { shop_id: 'required|string' },
    CreateUsage: { 
        shop_id: 'required|string',
        amount: 'required|numeric',
        merchant: 'required|IsValidObjectID',
        order: 'required|IsValidObjectID',
        record_date: 'sometimes|date',
        generated: 'sometimes|string',
    },
    CreateAppCredit: {
        shop_id: 'required|string',
        amount: 'required|numeric',
        description: 'sometimes|string'
    },
    StatementFilter: {
        merchant: 'required|IsValidObjectID',
        start_date: 'sometimes|string',
        end_date: 'sometimes|string',
    },
    ExternalBilling: {
        merchant: 'required|IsValidObjectID',
        method_name: 'sometimes|string',
    },
    BlockMerchant: {
        merchant_id: {
            in: ['body'],
            notEmpty: {
                errorMessage: 'Merchant ID is required'
            }
        }
    },
    DeleteMerchant: {
        merchant_id: {
            in: ['body'],
            notEmpty: {
                errorMessage: 'Merchant ID is required'
            }
        }
    },
    RestoreMerchant: {
        merchant_id: {
            in: ['body'],
            notEmpty: {
                errorMessage: 'Merchant ID is required'
            }
        }
    },
    CustomerEmailCommunication: {
    customer_email: 'required|email',
    merchant_email: 'required|email',
    'cc_email.*': 'email',
    subject: 'required|string',
    message: 'required|string'
}
};