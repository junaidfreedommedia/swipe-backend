global.PRODUCT_TITLE = "Swipe";
global.EVENT_TYPE = {
    ACTION: 'ACTION',
    COMMENT: 'COMMENT',
    INTERNAL_COMMENT: 'INTERNAL_COMMENT',
    STORE_COMMENT: 'STORE_COMMENT',
    INTERNAL_STORE_COMMENT: 'INTERNAL_STORE_COMMENT',
};
global.EVENT_SUBTYPE = {
    ORDER_CREATED: 'ORDER_CREATED',
    CLAIM_CREATED: 'CLAIM_CREATED',
    CLAIM_APPROVED: 'CLAIM_APPROVED',
    CLAIM_REVIEW: 'CLAIM_REVIEW',
    SEND_INITIAL_EMAIL: 'Send Initial Email',
    CLAIM_CLOSED: 'CLAIM_CLOSED',
    MERCHANT_BLOCKED: 'MERCHANT_BLOCKED',
    MERCHANT_DELETED: 'MERCHANT_DELETED',
    MERCHANT_RESTORED: 'MERCHANT_RESTORED',
    TIMELINE_CREATED:'TIMELINE_CREATED'
};
global.USER_ROLE = {
    ADMIN: 'admin',
    MERCHANT: 'merchant',
}

global.ADMIN_TYPE = {
    SUPER_ADMIN: "super_admin",
    SIMPLE_ADMIN: "simple_admin",
};

global.ADMIN_PERMISSION = {
    CLAIMS_VIEW: "claims_view",
    CLAIMS_CREATE: "claims_create",
};

global.CLAIM_STATUS = {
    REVIEWING: "REVIEWING",
    APPROVED: "APPROVED",
    CLOSED: "CLOSED",
    RESOLVED: "RESOLVED",
}

global.CLAIM_SUB_STATUS = {
    IN_REVIEW: "IN_REVIEW",
    PROCESSED: "PROCESSED",
    OTHER: "OTHER"
}

global.PERMISSION = {
    ACCOUNT_MANAGER : "account_manager",
    DASHBOARD : "dashboard"
}

global.CLAIM_STATUS_OBJECT = {
    REVIEWING: "in_review",
    APPROVED: "approved",
    CLOSED: "closed",
    RESOLVED: "resolved"
};

global.ACTIVITY_LOG_LABEL = {
    SYSTEM: 'Swipe',
    ADMIN: 'Super Admin',
    ACCOUNT_MANAGER: 'Account Manager',
    MERCHANT: 'Merchant',
    CLAIM: 'Claim',
    ORDER: 'Order'
}

global.EVENT_TITLE = {
    APP_INSTALL: "New merchant registered",
    APP_UNINSTALL: "App is uninstalled",
    CLAIM_CREATE: "New claim created",
    CLAIM_REVIEW: 'Claim is in review',
    CLAIM_APPROVED: "Claim approved",
    CLAIM_CLOSED: "Claim closed",
    ORDER_CREATED: "Order created",
    USER_ADDED: "New user added",
    USER_UPDATE: "User information is updated",
    USER_LOGIN: "[USER_NAME] user logged in",
    USER_RESET_PASSWORD: "User have changed password",
    ACCOUNT_MANAGER_ASSIGNED: "Account manager has been assigned",
    COMMENT_ADDED: "New comment added on claim",
    ORDER_COMMENT_ADDED: "New comment added on order",
    MERCHANT_BLOCKED: "Merchant blocked by admin",
    MERCHANT_DELETED: "Merchant deleted by admin",
    MERCHANT_RESTORED: "Merchant restored by admin"
}

global.ADMIN_ROLE = {
    SUPER_ADMIN: 'Super Admin',
    ACCOUNT_MANAGER: 'Account Manager',
    CLAIM_APPROVER: 'Claim Approver',
}

global.ADMIN_ROLES = ['super-admin', 'account-manager', 'claim-approver'];

global.ROLES = {
    SUPER_ADMIN: 'super-admin',
    ACCOUNT_MANAGER: 'account-manager',
    CLAIM_APPROVER: 'claim-approver'
}