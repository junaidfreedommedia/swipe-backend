const Merchant = Services.Merchant;
const User = Services.User;
const FieldPermissions = Services.FieldPermissions;
const hmacSHA256 = require("crypto-js/hmac-sha256");
const Base64 = require("crypto-js/enc-base64");
const crypto = require("crypto");

const isAdmin = (user) => user?.role === USER_ROLE.ADMIN;

// Existing admin records do not have admin_type. Treat them as super admins
// during the migration so the rollout does not remove their current access.
const isSuperAdmin = (user) =>
    isAdmin(user) &&
    (!user.admin_type || user.admin_type === ADMIN_TYPE.SUPER_ADMIN);

const hasAdminPermission = (user, permission) =>
    isSuperAdmin(user) ||
    (isAdmin(user) &&
        user.admin_type === ADMIN_TYPE.SIMPLE_ADMIN &&
        Boolean(user.admin_permissions?.[permission]));

const getAssignedMerchantIds = (user) =>
    (Array.isArray(user?.merchants) ? user.merchants : [])
        .map((merchantId) => String(merchantId))
        .filter(Boolean);

const hasMerchantAccess = (user, merchantId) => {
    if (isSuperAdmin(user)) return true;
    if (!merchantId) return false;
    if (user?.role === USER_ROLE.MERCHANT) {
        return (
            String(user.merchant || "") === String(merchantId) ||
            getAssignedMerchantIds(user).includes(String(merchantId))
        );
    }
    if (!isAdmin(user)) return false;
    return getAssignedMerchantIds(user).includes(String(merchantId));
};

const assertMerchantAccess = (user, merchantId) => {
    if (!hasMerchantAccess(user, merchantId)) {
        throwError("You do not have access to this store.", 403);
    }
};

module.exports = {
    isSuperAdmin,
    hasAdminPermission,
    getAssignedMerchantIds,
    hasMerchantAccess,
    assertMerchantAccess,
    requireSuperAdmin: async (req, _res, next) => {
        try {
            if (!isSuperAdmin(req.user)) {
                throwError("Super Admin access is required.", 403);
            }
            next();
        } catch (error) {
            next(setError(error.message || error, 403));
        }
    },
    requireAdminPermission: (permission) => {
        return async (req, _res, next) => {
            try {
                if (!hasAdminPermission(req.user, permission)) {
                    throwError("You do not have permission for this action.", 403);
                }
                next();
            } catch (error) {
                next(setError(error.message || error, 403));
            }
        };
    },
    requireAdminPermissionIfAdmin: (permission) => {
        return async (req, _res, next) => {
            try {
                if (
                    req.user?.role === USER_ROLE.ADMIN &&
                    !hasAdminPermission(req.user, permission)
                ) {
                    throwError("You do not have permission for this action.", 403);
                }
                next();
            } catch (error) {
                next(setError(error.message || error, 403));
            }
        };
    },
    requireMerchantAccess: (location, field) => {
        return async (req, _res, next) => {
            try {
                const source = req[location] || {};
                assertMerchantAccess(req.user, source[field]);
                next();
            } catch (error) {
                next(setError(error.message || error, 403));
            }
        };
    },
    check: async (req, _res, next) => {
        try {
            const token = req.headers["x-access-token"];
            const xMerchantId = req.headers["x-merchant-id"];
            if (!token) throwError(MSG.AUTH_TOKEN_EMPTY);
            const decoded = await User.decodeToken(token);
            req.auth = decoded;
            const requestMerchantId = decoded.isImpersonating
                ? decoded.merchant || decoded.merchantId
                : xMerchantId || decoded.merchant;
            if (decoded.role === USER_ROLE.MERCHANT || xMerchantId) {
                const merchant = await Merchant.get(
                    { 
                        _id: requestMerchantId,
                        $or: [
                            { is_active: true },
                            { is_blocked: true },
                            { is_deleted: true }
                        ]
                    },
                    {},
                    { lean: true }
                );
                if (!merchant) throwError(MSG.MERCHANT_NOT_EXIST, 403);
                
                // Check if merchant is blocked or deleted
                if (merchant.is_blocked) {
                    return next(setError({
                        message: 'Your shop access has been blocked. Please contact support for more information.',
                        blocked: true
                    }, 403));
                }
                
                if (merchant.is_deleted) {
                    return next(setError({
                        message: 'Your shop has been removed from our system. Please contact support for more information.',
                        deleted: true
                    }, 403));
                }
                
                req.merchant = merchant;
            }
            const authUser = await User.get(
                { _id: decoded._id },
                { password: 0 }
            );
            if (!authUser || authUser.disabled)
                throwError(MSG.USER_NOT_EXIST, 403);
            if (decoded.isImpersonating) {
                const impersonatedMerchant = decoded.merchant || decoded.merchantId;
                req.user = {
                    ...authUser,
                    role: USER_ROLE.MERCHANT,
                    merchant: impersonatedMerchant,
                    merchants: impersonatedMerchant ? [impersonatedMerchant] : [],
                    permissions: [
                        "account_manager",
                        "billing",
                        "claims",
                        "dashboard",
                        "users",
                    ],
                    impersonatedBy: decoded.impersonatedBy,
                    isImpersonating: true,
                };
            } else {
                req.user = authUser;
            }
            next();
        } catch (error) {
            console.log(error);
            next(setError(error.message, 403));
        }
    },

    validate: async (req, _res, next) => {
        try {
            const token = req.headers["x-access-token"];
           
            if (!token) throwError(MSG.AUTH_TOKEN_EMPTY);
            const decoded = await User.decodeToken(token);
            req.auth = decoded;
            
            const authUser = await User.get(
                { _id: decoded._id },
                { password: 0 }
            );
            if (!authUser || authUser.disabled)
                throwError(MSG.USER_NOT_EXIST, 403);
            if (decoded.isImpersonating) {
                const impersonatedMerchant = decoded.merchant || decoded.merchantId;
                req.user = {
                    ...authUser,
                    role: USER_ROLE.MERCHANT,
                    merchant: impersonatedMerchant,
                    merchants: impersonatedMerchant ? [impersonatedMerchant] : [],
                    permissions: [
                        "account_manager",
                        "billing",
                        "claims",
                        "dashboard",
                        "users",
                    ],
                    impersonatedBy: decoded.impersonatedBy,
                    isImpersonating: true,
                };
            } else {
                req.user = authUser;
            }
            next();
        } catch (error) {
            console.log(error);
            next(setError(error.message, 403));
        }
    },

    checkPermission: async (req, _res, next) => {
        try {
            const { permissions, role } = await User.get(
                { email: req.user.email },
                { permissions: 1, role: 1 },
                { lean: true }
            );
            const fieldPermissions = await FieldPermissions.get(
                { role },
                { permissions: 1 }
            );
            let userPermission = [];
            const url = req.originalUrl
                .split("/")
                .filter((value) => value !== "");
            const filteredUrl = url[1];
            if (
                filteredUrl !== PERMISSION.ACCOUNT_MANAGER &&
                filteredUrl !== PERMISSION.DASHBOARD
            ) {
                let checkPermission = permissions.find(
                    (x) => x === filteredUrl
                );
                if (!checkPermission)
                    return throwError({ message: MSG.NOT_RBS_PERMISSION });
            }
            for (const permission of permissions) {
                const value = fieldPermissions.permissions[permission];
                if (value) userPermission = [...userPermission, ...value];
                userPermission = [...new Set(userPermission)];
            }
            req.userPermission = userPermission;
            next();
        } catch (error) {
            console.log(error);
            next(setError(error.message, 403));
        }
    },
    // verifyWebhook: async (req, _res, next) => {
    //     try {
    //         // const payload = req.body.toString();
    //         // const hmac = req.header("X-Shopify-Hmac-Sha256");
    //         // if (empty(payload) || empty(hmac)) throwError(MSG.WEBHOOK_ERROR);
    //         // const genHash = await hmacSHA256(
    //         //     payload,
    //         //     process.env.SHOPIFY_CLIENT_SECRET
    //         // ).toString(Base64);
    //         // if (hmac !== genHash) throwError(MSG.WEBHOOK_ERROR);
    //         next();
    //     } catch (error) {
    //         console.log(error);
    //         Logger.error(error.stack);
    //         next(setError(error.message, 401));
    //     }
    // },

  verifyWebhook: (req, res, next) => {
    try {
        // 🔥 LOCAL TESTING: ALWAYS BYPASS
        if (process.env.NODE_ENV !== "production") {
            return next();
        }

        const rawBody = req.body;
        const hmacHeader = req.header("X-Shopify-Hmac-Sha256");

        if (!rawBody || !hmacHeader) {
            return res.status(401).send("Webhook Auth Failed (Missing data)");
        }

        const digest = crypto
            .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
            .update(rawBody)
            .digest("base64");

        if (digest !== hmacHeader) {
            return res.status(401).send("Invalid HMAC");
        }

        next();
    } catch (err) {
        return res.status(401).send("Webhook Auth Failed");
    }
},

    verifyEasyPostWebhook: async (req, _res, next) => {
        try {
            const WEBHOOK_SECRET = process.env.EASYPOST_WEBHOOK_SECRET;
            const rawSignature = req.headers["x-hmac-signature"];
            if (!rawSignature) throw new Error("Missing signature header");

            const signature = rawSignature.replace("hmac-sha256-hex=", "");
            const payload = req.body.toString("utf8");

            const expectedSignature = crypto
                .createHmac("sha256", WEBHOOK_SECRET)
                .update(payload)
                .digest("hex");

            if (signature !== expectedSignature) {
                console.error("Signature mismatch");
                throw new Error("Webhook signature verification failed");
            }
            next();
        } catch (error) {
            console.log(error);
            Logger.error(error.stack);
            next(setError(error.message, 401));
        }
    },
    acl: (...resource) => {
        return async (req, _res, next) => {
            if (ROLES.SUPER_ADMIN === req.user.role) {
                next();
            } else {
                if (!resource) resource = req.resource;
                let allowed = await Services.Acl.rolesPermissions(
                    req.user.role,
                    resource,
                    [getAction(req.method)]
                );
                if (allowed) {
                    req.resource = resource;
                    next();
                } else {
                    return next(setError(MSG.IS_OWN_ACL_ERROR, 401));
                }
            }
        };
    },
};
