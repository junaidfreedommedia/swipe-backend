module.exports = {
    NewClaim: {
        mid: "required",
        oid: "required",
        type: "required",
        description: "required",
        preference: "required",
        ip_address: "string",
    },
    V2NewClaim: {
        reason: "required",
        product_id: "required",
        oid: "required",
        type: "required",
        description: "required",
        ip_address: "string",
    },
    UserLogin: {
        email: "required|email",
        password: "required",
        mfa_method: "string|in:email,totp"
    },
    VerifyMFA: {
        temp_token: "required|string",
        otp: "required|string|min:6|max:6",
    },
    EnableMFARequest: {
        password: "required|string",
    },
    ConfirmEnableMFA: {
        otp: "required|string|min:6|max:6",
    },
    ManageMFA: {
        action: "required|string|in:enable,disable,verify,reset,change",
        method: "string|in:email,totp",
    },
    FindOrder: {
        email: "required|email",
        orderId: "required|numeric",
    },
    TrackClaimDetails: {
        email: "required|email",
        order_number: "required|numeric",
    },
    TrackOrderDetails: {
        email: "required|email",
        order_number: "required|numeric",
        shop_id: "required|string",
    },
    TrackClaimDetailsDashboard: {
        email: "required|email",
        order_number: "required|numeric",
        shop_id: "required|string",
    },
    setUserPassword: {
        user_id: "required|string",
        password:  "required|string",
        confirm_password:  "required|string"
    },
};
