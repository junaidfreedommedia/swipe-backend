const express = require("express");
const router = express.Router();
const User = Services.User;

const Register = async (req, res, next) => {
    try {
        const { merchantId, email, firstName, lastName, phoneNumber, siteUrl } =
            req.body;
        Func.emailValidation(email);
        // Func.passwordValidation(password);
        const merchant = await Services.Merchant.get({ _id: merchantId });
        if (empty(merchant)) throwError(MSG.MERCHANT_NOT_EXIST);
        let merchantUser = await User.get({ email }, { email: 1 });
        // console.log("merchantUser", merchantUser);
        let userDetails = await User.get({
            merchants: { $in: [ObjectId(merchantId)] },
        });
        if (userDetails) throwError(MSG.ALREADY_REGISTER);

        // if (merchantUser) throwError(MSG.EMAIL_EXIST);
        // const checkMerchantUser = await User.count({ merchant: merchantId, disabled: false });
        // if (checkMerchantUser) throwError(MSG.MERCHANT_USER_ALREADY_ADDED);
        await Services.Merchant.updateOne(
            { _id: merchantId },
            { $set: { site_url: siteUrl, phone_no: phoneNumber } }
        );

        merchantUser = await User.findOneAndUpdate(
            { email: email },
            {
                $set: {
                    merchant: merchantId,
                    merchants: [merchantId],
                    email,
                    display_name: `${firstName} ${lastName}`,
                    permissions: [
                        "account_manager",
                        "billing",
                        "claims",
                        "dashboard",
                        "users",
                    ],
                    role: USER_ROLE.MERCHANT,
                    roles: [USER_ROLE.MERCHANT],
                },
            },
            { upsert: true, new: true }
        );

        merchantUser = merchantUser.toJSON();
        merchantUser.token = await User.getToken({
            email,
            _id: merchantUser._id,
            role: USER_ROLE.MERCHANT,
            merchant: merchantId,
            is_onboarding: merchant.is_onboarding,
        });

        await Notifications.sendNotification({
            subject: `Please Set Your password for Swipe Access!`,
            to: [email],
            template: "SET-PASSWORD",
            password_url: `https://dashboard.swipe.ai/updatePassword?id=${merchantUser._id}`,
            customer_name: merchantUser.display_name,
        });
        Notifications.sendNotification({
            subject: `Welcome to Swipe`,
            to: [merchant.email],
            template: "WELCOME_AUTOMATION_EMAIL",
            merchant_name: merchant.name,
            schedule_call_url: process.env.SCHEDULE_CALL_URL,
        });
        return res.send({ message: MSG.USER_REGISTERED, data: merchantUser });
    } catch (error) {
        return next(error);
    }
};

const AddUser = async (req, res, next) => {
    try {
        req.body.merchant = req.merchant._id;
        const newUser = await User.AddUser(req.body);
        return res.send(newUser);
    } catch (error) {
        return next(error);
    }
};

const List = async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        const userList = await User.getAll(
            { merchants: { $in: req.merchant._id }, is_deleted: { $ne: true } },
            { password: 0 },
            { skip, limit, sort: { createdAt: -1 } }
        );
        const totalRecords = await User.count({
            merchants: { $in: req.merchant._id },
             is_deleted: { $ne: true }
        });
        return res.send({
            message: userList.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: {
                totalRecords: totalRecords,
                response: userList,
            },
        });
    } catch (error) {
        return next(error);
    }
};

const Edit = async (req, res, next) => {
    try {
        req.body.merchant = req.merchant._id;
        const updateUserProfile = await User.UpdateMerchantUser(req);
        return res.send(updateUserProfile);
    } catch (error) {
        return next(error);
    }
};

const DeleteUser = async (req, res, next) => {
    try {
        const deleteId = req.params.id;
        if (deleteId === String(req.user._id))
            throwError(MSG.USER_DELETED_ERROR);
        let userInfo = await User.get({
            _id: req.params.id,
            merchants: { $in: req.merchant._id },
        });
        if (!userInfo) throwError(MSG.INVALID_DETAILS);
        await Services.DeletionLog.insert({
            collection: "users",
            deleted_data: userInfo,
            deleted_by: req.user._id,
            reason: "deletion from Dashboard",
        });
        await User.findOneAndUpdate(
            { _id: req.params.id },
            { $set: { is_deleted: true } },
            { new: true }
        );
        return res.send({ message: MSG.USER_DELETED_SUCCESS });
    } catch (error) {
        return next(error);
    }
};
const SendResetPasswordLink = async (req, res, next) => {
    try {
        const email = req.params.email;
        await Func.emailValidation(email);
           const userDetail = await User.get(
      { email },
      { email: 1, merchant: 1 },
      { populate: [{ path: "merchant", select: "name is_active" }], lean: true }
    );
        if (!userDetail) throwError(MSG.EMAIL_NOT_EXIST);
            const merchantName =
      (userDetail?.merchant && userDetail?.merchant.name ||"admin");
        const password_reset_key = createRandomString(50);
        await User.updateOne({ email }, { $set: { password_reset_key } });
        await Notifications.sendNotification({
            subject: `Swipe Reset your password`,
            to: [email],
            template: "RESET_PASSWORD",
            reset_password_url: `${
                Config.get("APP").FE_HOST
            }reset-password/${password_reset_key}`,
            merchant_name: merchantName,
        });
        return res.send({ message: MSG.PASSWORD_LINK_SENT });
    } catch (err) {
        return next(err);
    }
};

const ValidateResetPasswordLink = async (req, res, next) => {
    try {
        const { key: password_reset_key } = req.body;
        const userDetail = await User.get(
            { password_reset_key },
            { email: 1, merchant: 1, role: 1 },
            {
                populate: [{ path: "merchant", select: "is_active" }],
                lean: true,
            }
        );
        if (
            !userDetail ||
            (!userDetail?.merchant?.is_active &&
                userDetail.role === USER_ROLE.MERCHANT)
        )
            throwError(MSG.INVALID_ACTIVATION_LINK);
        return res.send({ userDetail, message: MSG.DATA_FOUND });
    } catch (err) {
        return next(err);
    }
};

const ResetPassword = async (req, res, next) => {
    try {
        const { key: password_reset_key, password } = req.body;
        Func.passwordValidation(password);
    console.log('👉  ResetPassword payload:', req.body);
const userDetail = await User.get(
  { password_reset_key },
  { password_reset_key: 1, password: 1 },
  { lean: false }
);
console.log('    Looking for key=', password_reset_key, ' – got userDetail=', userDetail);

        if (!userDetail)
        {
     throwError(MSG.PASSWORD_CHANGE_ERROR);
    }       

   if (
      userDetail.password &&
      User.isPasswordSame(password, userDetail.password)
    ) {
      throwError(MSG.NEW_PASSWORD_CURRENT_PASSWORD);
    }

        userDetail.password = password;
        userDetail.password_reset_key = "";
       await userDetail.save();

        return res.send({ message: MSG.PASSWORD_CHANGE_SUCCESS });
    } catch (err) {
        return next(err);
    }
};
const UserDetails = async (req, res, next) => {
    try {
        const userDetail = await User.get(
            { _id: req.params.id },
            { password: 0, createdAt: 0, updatedAt: 0, __v: 0 }
        );
        return res.send({
            message: userDetail ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: userDetail,
        });
    } catch (error) {
        return next(error);
    }
};

router.post(
    "/register",
    Func.validate(MerchantRules.UserRegistration),
    Register
);
router.get("/send-reset-password/:email", SendResetPasswordLink);
router.post(
    "/",
    Auth.check,
    Auth.checkPermission,
    Func.validate(MerchantRules.AddUser),
    AddUser
);
router.post("/list", Auth.check, Auth.checkPermission, List);
router.post(
    "/validate-reset-password",
    Func.validate(MerchantRules.ResetPasswordLink),
    ValidateResetPasswordLink
);
router.post(
    "/reset-password",
    Func.validate(MerchantRules.ResetPassword),
    ResetPassword
 );
router.get("/details/:id", Auth.check, Auth.checkPermission, UserDetails);
router.put(
    "/edit/:id",
    Auth.check,
    Auth.checkPermission,
    Func.validate(MerchantRules.UserUpdate),
    Edit
);
router.delete("/delete/:id", Auth.check, Auth.checkPermission, DeleteUser);

module.exports = router;
