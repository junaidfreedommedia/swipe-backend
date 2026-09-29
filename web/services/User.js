const Models = require("../models");
const userModels = Models.Users;
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const SECRET = Config.get("APP").SECRET;
const TOKENEXPIRESTIME = Config.get("APP").TOKENEXPIRESTIME;
const User = {};

User.insert = async (data) => {
    return new userModels(data).save();
};

User.get = async (condition, projection, options = { lean: true }) => {
    return userModels.findOne(condition, projection, options);
};

User.getAll = async (condition, projection, options = { lean: true }) => {
    return userModels.find(condition, projection, options);
};

User.count = async (condition) => {
    return userModels.count(condition);
};

User.findOneAndUpdate = async (condition, info, options) => {
    return userModels.findOneAndUpdate(condition, info, options);
};

User.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse) return userModels.aggregate(pipeline).allowDiskUse(true);
    return userModels.aggregate(pipeline);
};

User.findByIdAndUpdate = async (user_id, info) => {
    return userModels.findByIdAndUpdate(user_id, info, { new: true });
};

User.updateOne = async (condition, info) => {
    return userModels.updateOne(condition, info);
};

User.findByIdAndDelete = async (user_id) => {
    return userModels.findByIdAndDelete(user_id);
};

User.deleteMany = async (condition) => {
    return userModels.deleteMany(condition);
};

User.getToken = (user, expiresIn = TOKENEXPIRESTIME) => {
    return jwt.sign(user, SECRET, { expiresIn });
};

User.decodeToken = async (token) => {
    try {
        const { iat, ...verify } = await jwt.verify(token, SECRET);
        
        if (verify.is_temporary_token) {
            throwError("Invalid access token. MFA verification required.", 403);
        }
        
        return verify;
    } catch (err) {
        throwError("Failed to authenticate token.", 403);
    }
};

/**
 * Generate a temporary token for MFA verification
 * @param {Object} user - User data
 * @param {string} method - MFA method ('email' or 'totp')
 * @returns {string} - Generated token
 */
User.getTemporaryToken = (user, method = 'email') => {
    return jwt.sign(
        { 
            _id: user._id, 
            email: user.email,
            purpose: 'mfa',
            mfa_method: method,
            requires_mfa: true,
            is_temporary_token: true // Clearly identify this as a temporary token
        }, 
        SECRET, 
        { expiresIn: '10m' }
    );
};

/**
 * Verify a temporary token
 * @param {string} token - Token to verify
 * @param {string} purpose - Expected purpose
 * @returns {Object|null} - Decoded token or null if invalid
 */
User.verifyTemporaryToken = async (token, purpose = 'mfa') => {
    try {
        const decoded = await jwt.verify(token, SECRET);
        if (decoded.purpose !== purpose || !decoded.requires_mfa) {
            return null;
        }
        return decoded;
    } catch (err) {
        return null;
    }
};

User.isPasswordSame = (password, hash) => {
  if (!hash) return false;              // if there’s no hash, it can’t match
  return bcrypt.compareSync(password, hash);
};

User.permission = async (userInfo) => {
    try {
        const FieldPermissions = await Services.FieldPermissions.get(
            { role: userInfo.role },
            { permissions: 1 },
            { lean: true }
        );
        let userPermission = [];
        for (const permission of userInfo.permissions) {
            const value = FieldPermissions.permissions[permission];
            if (value) userPermission = [...userPermission, ...value];
            userPermission = [...new Set(userPermission)];
        }
        return userPermission;
    } catch (error) {
        throwError(error);
    }
};

User.AddUser = async (payload) => {
    try {
        Func.emailValidation(payload.email);
        // Func.passwordValidation(payload.password);
        let user = await Services.User.get({ email: payload.email });
        if (user && user?.is_deleted === true)
            throwError(MSG.ALREADY_DELETED_REACTIVE_IT);
        let condition = { email: payload.email };
        if (payload.merchant) {
            condition.merchants = { $in: [payload.merchant] };
        }
        let validUser = await Services.User.get(
            { email: payload.email },
            { email: 1, merchants: 1 }
        );
        if (validUser) {
            if (payload.merchant) {
                let userMerchant =
                    validUser.merchants?.map((id) => String(id)) || [];
                if (
                    userMerchant?.length &&
                    userMerchant?.includes(String(payload.merchant))
                ) {
                    throwError(MSG.EMAIL_EXIST);
                } else {
                    validUser = await Services.User.findOneAndUpdate(
                        { email: payload.email },
                        {
                            $addToSet: {
                                merchants: payload.merchant,
                                roles: payload.role,
                            },
                        },
                        { new: true }
                    );
                }
            } else {
                throwError(MSG.EMAIL_EXIST);
            }
            if (payload.role == USER_ROLE.ADMIN) {
                throwError(MSG.EMAIL_EXIST);
            }
            return { message: MSG.USER_ADDED, data: validUser };
        }

        if (payload.role === USER_ROLE.ADMIN) {
            if (payload.admin_type === ADMIN_TYPE.SIMPLE_ADMIN) {
                payload.permissions = [
                    "dashboard",
                    "billing",
                    ...(payload.admin_permissions?.claims_view ? ["claims"] : []),
                ];
            } else {
                payload.permissions = [
                    "account_manager",
                    "billing",
                    "claims",
                    "dashboard",
                    "users",
                ];
            }
        }

        if (payload.merchant) {
            payload.merchants = [payload.merchant];
        }
        if (payload.role) {
            payload.roles = [payload.role];
        }
        const newUser = await Services.User.insert({ ...payload });
        // let payload = {
        //     email: newUser.email,
        //     _id: newUser._id,
        //     role: newUser.role,
        // };
        // const token = User.getToken(payload);
        if (
            newUser.role === USER_ROLE.ADMIN ||
            newUser.role === USER_ROLE.MERCHANT
        ) {
            await Notifications.sendNotification({
                subject: `Please Set Your password for Swipe Access!`,
                to: [newUser.email],
                template: "SET-PASSWORD",
                password_url: `https://dashboard.swipe.ai/updatePassword?id=${newUser._id}`,
                customer_name: newUser.display_name,
            });
        }
        // if (newUser.role === USER_ROLE.ADMIN) {
        //     await Services.Event.insert({
        //         created_by: user._id,
        //         action_on: ACTIVITY_LOG_LABEL.ADMIN,
        //         title: EVENT_TITLE.USER_LOGIN.replace(
        //             "[USER_NAME]",
        //             user.display_name
        //         ),
        //         ts: Math.floor(new Date().getTime() / 1000),
        //     });
        // }
        if (payload.merchant) {
            const task = await Services.Task.get({
                merchant: payload.merchant,
            });
            if (task.admin.add_your_team !== "Completed") {
                const userData = await Services.User.getAll({
                    merchant: payload.merchant,
                });
                if (userData.length > 1) {
                    await Services.Task.findOneAndUpdate(
                        { merchant: payload.merchant },
                        { $set: { "admin.add_your_team": "Completed" } }
                    );
                }
                const updated_task = await Services.Task.get({
                    merchant: payload.merchant,
                });
                if (
                    updated_task.admin.add_your_team == "Completed" &&
                    updated_task.admin.merchant_communication_email ==
                        "Completed"
                ) {
                    await Services.Task.findOneAndUpdate(
                        { merchant: payload.merchant },
                        { $set: { "admin.done": true } }
                    );
                }
            }
        }
        return { message: MSG.USER_ADDED, data: newUser };
    } catch (error) {
        throwError(error);
    }
};

User.ResetPassword = async (req) => {
    try {
        const { currentpassword, newpassword, confirmpassword } = req.body;
        const user = req.user;
        Func.passwordValidation(newpassword);
        let userdetails = await Services.User.get(
            { _id: user._id },
            {},
            { lean: false }
        );
        let checkcurrentpassword = Services.User.isPasswordSame(
            currentpassword,
            userdetails.password
        );
        if (!checkcurrentpassword) throwError(MSG.CURRENT_PASSWORD_NOT_MATCH);
        let checknewpassword = Services.User.isPasswordSame(
            newpassword,
            userdetails.password
        );
        if (checknewpassword) throwError(MSG.NEW_PASSWORD_CURRENT_PASSWORD);
        if (newpassword !== confirmpassword)
            throwError(MSG.NEW_AND_CONFIRM_PASSWORD_NOT_MATCH);
        userdetails.password = newpassword;
        await Services.User.insert(userdetails);
        return { message: MSG.PASSWORD_UPDATE };
    } catch (error) {
        throwError(error);
    }
};

User.UpdateMerchantUser = async (req) => {
    try {
        let userInfo = await Services.User.get({
            _id: req.params.id,
            merchant: { $in: req.merchant._id },
        });
        if (!userInfo) throwError(MSG.INVALID_DETAILS);
        if (String(req.user._id) === String(req.params.id) && req.body.disabled)
            throwError(MSG.USER_INACTIVE_ERROR);
        const updatedUser = await Services.User.findByIdAndUpdate(
            req.params.id,
            req.body
        );
        const userPermission = await Services.User.permission(updatedUser);
        return {
            message: MSG.USER_INFO_UPDATE,
            data: { updatedUser, userPermission },
        };
    } catch (error) {
        throwError(error);
    }
};

/**
 * Enable MFA for a user
 * @param {string} userId - User ID
 * @param {string} method - MFA method ('email' or 'totp')
 * @returns {Promise<Object>} - Updated user
 */
User.enableMFA = async (userId, method = 'email') => {
    try {
        // Only update the MFA flag but don't set it to true yet
        // The actual enabling happens after verification
        return await userModels.updateOne(
            { _id: userId },
            { 
                $set: { 
                    mfa_setup_in_progress: true,
                    pending_mfa_method: method  // Store as pending until verified
                } 
            }
        );
    } catch (error) {
        console.error('Error enabling MFA:', error);
        throwError('Failed to update MFA settings');
    }
};

module.exports = User;
