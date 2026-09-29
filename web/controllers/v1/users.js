const express = require("express");
const router = express.Router();
const User = Services.User;
const axiosService = require("./../../utils/axios");
const jwt = require("jsonwebtoken");
const SECRET = Config.get("APP").SECRET;
const bcrypt = require("bcryptjs");

const Login = async (req, res, next) => {
    try {
        const { email, password, mfa_method } = req.body;

        Func.emailValidation(email);
        const userInfo = await User.get({ email, disabled: false });
        if (!userInfo) throwError(MSG.USER_NOT_EXIST);
        if (userInfo.user_verified === false) throwError(MSG.VERIFY_FIRST);

        if (userInfo.is_deleted === true) throwError(MSG.ALREADY_DELETED);
        // let merchantInfo, userTabPermission, dashboardTask;
        // if (userInfo.role === USER_ROLE.MERCHANT) {
        //     merchantInfo = await Services.Merchant.get(
        //         { _id: userInfo.merchant, is_active: true },
        //         { domain: 1, email: 1, name: 1, is_onboarding: 1 },
        //         { lean: true }
        //     );
        //     if (!merchantInfo) throwError(MSG.MERCHANT_NOT_EXIST, 403);
        // }

        const same = User.isPasswordSame(password, userInfo.password);
        if (!same) throwError(MSG.LOGIN_INVALID);

        // MFA authentication flow
        if (userInfo.mfa_enabled) {
            // Use the user's preferred method if available, or allow override if specified
            const preferredMethod =
                mfa_method || userInfo.mfa_method || "email";

            // Generate temporary token for MFA verification
            const tempToken = User.getTemporaryToken(userInfo, preferredMethod);

            // Handle MFA based on method
            if (preferredMethod === "email") {
                // Email OTP method
                const otpRecord = await Services.OTP.createOTP({
                    user_id: userInfo._id,
                    purpose: "login",
                });

                // Send OTP via email
                await Notifications.sendNotification({
                    subject: `Your Swipe Authentication Code`,
                    to: [userInfo.email],
                    template: "MFA_OTP",
                    user_name: userInfo.display_name,
                    otp: otpRecord.otp,
                });
            }

            const userTabPermission = await User.permission(userInfo);

            // Create a user object with all data except password
            const userObj = { ...userInfo };
            delete userObj.password;

            // Return response with temporary token and MFA flag
            return res.send({
                data: {
                    ...userObj,
                    mfa_required: true,
                    mfa_method: preferredMethod,
                    temp_token: tempToken,
                },
                userTabPermission,
                message:
                    preferredMethod === "email"
                        ? "Authentication code sent to your email"
                        : "Please enter the code from your authenticator app",
            });
        }

        let user = { ...userInfo };
        let payload = { email: user.email, _id: user._id, role: user.role };

        const userTabPermission = await User.permission(userInfo);

        user.token = User.getToken(payload);
        delete user.password;

        return res.send({
            data: { ...user },
            userTabPermission,
            message: MSG.LOGIN_SUCCESS,
        });
    } catch (error) {
        return next(error);
    }
};

const UserInfo = async (req, res, next) => {
    try {
        let merchants = [];
        if (
            Array.isArray(req.user?.merchants) &&
            req.user.merchants.length > 0
        ) {
            merchants = await Services.Merchant.getAll(
                { _id: { $in: req.user.merchants } },
                {
                    _id: 1,
                    id: 1,
                    name: 1,
                    email: 1,
                    domain: 1,
                    myshopify_domain: 1,
                    is_blocked: 1,
                    is_deleted: 1,
                    site_url: 1,
                    is_onboarding: 1,
                }
            );
        }
        return res.send({
            data: { merchants: merchants, roles: req.user.roles },
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const Authenticate = async (req, res, next) => {
    const startedAt = Date.now();
    try {
        const user = req.user;
        const userTabPermission = await User.permission(user);
        let data = { ...user };
        if (user.role === USER_ROLE.MERCHANT) {
            data["account_manager"] = await Services.User.get(
                { _id: req.merchant.account_manager },
                { display_name: 1, email: 1 }
            );
            data["dashboardTask"] = await Services.Task.get({
                merchant: user.merchant,
            });
            data["merchantInfo"] = req.merchant;
        } else if (user.role === USER_ROLE.ADMIN) {
            data["merchantInfo"] = { is_onboarding: true };
        }
        console.log(
            `[perf] GET /v1/users/authenticate role=${user?.role || "unknown"} user=${user?._id || "unknown"} merchant=${req.merchant?._id || user?.merchant || "n/a"} duration_ms=${Date.now() - startedAt}`
        );
        res.send({ data, userTabPermission, message: MSG.DATA_FOUND });
    } catch (error) {
        console.log(
            `[perf] GET /v1/users/authenticate failed role=${req.user?.role || "unknown"} user=${req.user?._id || "unknown"} merchant=${req.merchant?._id || req.user?.merchant || "n/a"} duration_ms=${Date.now() - startedAt} error=${error?.message || error}`
        );
        return next(error);
    }
};

const Resetpassword = async (req, res, next) => {
    try {
        const UpdatePassword = await User.ResetPassword(req);
        res.send(UpdatePassword);
    } catch (error) {
        return next(error);
    }
};

const SetOnboarding = async (req, res, next) => {
    try {
        const { event_url, invitee_url } = req.body;
        const merchant = await Services.Merchant.findOneAndUpdate(
            { _id: req.merchant._id },
            {
                $set: {
                    is_onboarding: true,
                },
            }
        );
        await Services.Calendly.getToken();
        const tokenData = await Services.Calendly.get();
        const data = await axiosService.get(event_url, {
            headers: {
                Authorization: `Bearer ${tokenData.token}`,
            },
        });
        if (data.resource) {
            const timezone = "America/New_York";
            const meeting_link = data.resource.location.join_url;
            const dateTime = Moment.tz(data.resource.start_time, timezone);
            const formattedDate = dateTime.format("D MMMM YYYY, ddd");
            const formattedTime = dateTime.format("h:mma");

            await Notifications.sendNotification({
                subject: `Congratulations! Your Booking is Confirmed`,
                to: [merchant.email],
                template: "BOOKING_CONFIRMATION",
                merchant_name: merchant.name,
                date: formattedDate,
                time: formattedTime,
                meeting_link: meeting_link,
            });
        }

        return res.send({
            message: MSG.DATA_UPDATED,
        });
    } catch (error) {
        return next(error);
    }
};

const getUserForSetPassword = async (req, res, next) => {
    try {
        const user_id = req.params.id;
        if (!user_id) {
            return res
                .status(400)
                .json({ message: "Missing required fields." });
        }

        const getUser = await Services.User.get({ _id: ObjectId(user_id) });
        if (!getUser) {
            return res.status(404).json({ message: "User not found." });
        }
        if (getUser.user_verified === true) {
            return res.status(404).json({
                message:
                    "You have already set the password please login in dashboard.",
            });
        }

        res.send({
            data: getUser,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const SetPassword = async (req, res, next) => {
    try {
        const { user_id, password, confirm_password } = req.body;
        if (!user_id || !password || !confirm_password) {
            return res
                .status(400)
                .json({ message: "Missing required fields." });
        }
        Func.passwordValidation(password);

        if (password !== confirm_password) {
            return res.status(400).json({ message: "Passwords do not match." });
        }

        // decoded = await User.decodeToken(token);

        // const userId = decoded.id;
        // if (ObjectId(userId) !== decoded.id) {
        //     return res.status(400).json({ message: "Invalid token payload." });
        // }
        const getUser = await Services.User.get({ _id: ObjectId(user_id) });
        if (!getUser) {
            return res.status(404).json({ message: "User not found." });
        }

        // Update the user in DB
        await Services.User.findOneAndUpdate(
            { _id: user_id },
            { $set: { password, user_verified: true } },
            { new: true }
        );

        return res
            .status(200)
            .json({ message: "Password has been set successfully." });
    } catch (error) {
        return next(error);
    }
};

const UpdateOnboardingStatus = async (req, res, next) => {
    try {
        const { merchant_id, is_onboarding } = req.body;

        if (!merchant_id) {
            return res
                .status(400)
                .json({ message: "Merchant ID is required." });
        }

        if (is_onboarding === undefined) {
            return res
                .status(400)
                .json({ message: "is_onboarding flag is required." });
        }

        const merchant = await Services.Merchant.get({
            _id: ObjectId(merchant_id),
        });
        if (!merchant) {
            return res.status(404).json({ message: "Merchant not found." });
        }

        const updatedMerchant = await Services.Merchant.findOneAndUpdate(
            { _id: merchant_id },
            { $set: { is_onboarding } },
            { new: true }
        );

        return res.status(200).json({
            message: "Merchant onboarding status updated successfully.",
            data: {
                merchant: {
                    _id: updatedMerchant._id,
                    name: updatedMerchant.name,
                    is_onboarding: updatedMerchant.is_onboarding,
                },
            },
        });
    } catch (error) {
        return next(error);
    }
};

const getUsersByMerchant = async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        const userList = await User.getAll(
            {
                merchants: { $in: req.params.merchant_id },
                is_deleted: { $ne: true },
            },
            { password: 0 },
            { skip, limit, sort: { createdAt: -1 } }
        );
        return res.send({
            message: userList.length ? MSG.USERS_FETCHED : MSG.DATA_NOT_FOUND,
            data: userList,
        });
    } catch (error) {
        return next(error);
    }
};

const UserProfileDetails = async (req, res, next) => {
    try {
        const user = req.params.id;
        let userDetails = await Services.User.get({ _id: ObjectId(user) });
        if (!userDetails) {
            return res.status(404).send({
                message: "User not found.",
            });
        }

        const isMerchant = userDetails.roles.includes("merchant");

        let merchantDetails = [];

        if (isMerchant && Array.isArray(userDetails.merchants)) {
            // Fetch all merchant details in parallel
            console.log("hello");
            merchantDetails = await Promise.all(
                userDetails.merchants.map((merchantId) =>
                    Services.Merchant.get(
                        { _id: merchantId },
                        {
                            _id: 1,
                            id: 1,
                            name: 1,
                            email: 1,
                            domain: 1,
                            myshopify_domain: 1,
                            is_blocked: 1,
                            is_deleted: 1,
                            site_url: 1,
                            is_onboarding: 1,
                            competition: 1,
                        }
                    )
                )
            );
            userDetails.merchantDetails = merchantDetails;
        }

        return res.send({
            data: userDetails,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const UserProfileUpdate = async (req, res, next) => {
    try {
        const userId = req.params.id;
        const { email, display_name } = req.body;
        let userDetails = await User.get({ _id: ObjectId(userId) });
        if (!userDetails) {
            return res.status(404).send({ message: "User not found." });
        }
        if (email) {
            Func.emailValidation(email);
            if (email !== userDetails.email) {
                // Check if email is already in use by another user
                const existingEmailUser = await User.get({
                    email: email,
                    _id: { $ne: ObjectId(userId) },
                });

                if (existingEmailUser) {
                    return res.status(409).send({
                        message:
                            "This email is already associated with another account.",
                    });
                }

                // Generate a temporary token for email verification
                const tempToken = jwt.sign(
                    {
                        _id: userDetails._id,
                        email: email,
                        purpose: "email_verification",
                    },
                    SECRET,
                    { expiresIn: "10m" }
                );

                // Send verification email
                try {
                    await Notifications.sendNotification({
                        subject: `Verify Your New Email Address`,
                        to: [email],
                        template: "VERIFY_NEW_EMAIL",
                        user_name: userDetails.display_name,
                        verify_link: `https://app.swipe.ai/v1/users/email-verify?tempToken=${tempToken}`,
                    });
                } catch (notifError) {
                    console.error("Notification error:", notifError);
                    return res.status(500).send({
                        message:
                            "Failed to send verification email. Please try again later.",
                    });
                }

                return res.status(200).send({
                    message:
                        "Verification email sent successfully. Please check your inbox to verify your email address.",
                });
            }
        }
        if (display_name && display_name !== userDetails.display_name) {
            const updatedUser = await User.findOneAndUpdate(
                { _id: ObjectId(userId) },
                { $set: { display_name } },
                { new: true }
            );

            return res.status(200).send({
                data: updatedUser,
                message: "Display name updated successfully.",
            });
        }
        return res.status(200).send({
            message: "No changes detected.",
        });
    } catch (error) {
        return next(error);
    }
};

const UserNewEmailVerification = async (req, res, next) => {
    try {
        const temp_token = req.query.tempToken;

        if (!temp_token) {
            return res.render("email-verify-failure", {
                message: "Missing verification token.",
            });
        }
        let decoded;
        try {
            decoded = await jwt.verify(temp_token, SECRET);
            console.log("decode", decoded);
        } catch (err) {
            return res.render("email-verify-failure", {
                message:
                    "The verification link is invalid or has expired. Please update your email again.",
            });
        }

        // Get the user
        const user = await User.get({ _id: decoded._id });
        console.log(user, user);
        if (!user) {
            return res.render("email-verify-failure", {
                message: "user not found.",
            });
        }

        // Update user's email
        await User.findOneAndUpdate(
            { _id: user._id },
            {
                $set: { email: decoded.email, email_verified: true },
            },
            { new: true }
        );
        return res.render("email-verify-success", {
            message: "Your email has been verified and updated successfully!",
        });
    } catch (error) {
        return next(error);
    }
};

const MerchantProfileUpdate = async (req, res, next) => {
    try {
        const merchant = req.params.id;
        let merchantDetails = await Services.Merchant.get({
            _id: ObjectId(merchant),
        });
        if (!merchantDetails) {
            return res.status(404).send({
                message: "User not found.",
            });
        }
        const updatedMerchant = await User.findOneAndUpdate(
            { _id: merchant_id },
            { $set: { email, display_name } },
            { new: true }
        );
        return res.send({
            data: updatedMerchant,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Verify MFA OTP and complete login
 */
const VerifyMFA = async (req, res, next) => {
    try {
        const { temp_token, otp } = req.body;

        if (!temp_token || !otp) {
            return res.status(400).json({
                message: "Missing required fields",
            });
        }

        let decoded;
        try {
            decoded = await jwt.verify(temp_token, SECRET);

            // Validate that this is indeed a temporary token for MFA
            if (!decoded.is_temporary_token || !decoded.requires_mfa) {
                return res.status(401).json({
                    message: "Invalid verification token",
                });
            }
        } catch (err) {
            return res.status(401).json({
                message: "Invalid or expired session",
            });
        }

        // Determine verification method based on token info
        const mfa_method = decoded.mfa_method || "email";
        let isValid = false;

        if (mfa_method === "email") {
            isValid = await Services.OTP.verifyOTP({
                user_id: decoded._id,
                otp: otp,
                purpose: "login",
            });
        } else if (mfa_method === "totp") {
            // TOTP verification
            isValid = await Services.TOTP.verify(decoded._id, otp);
        }

        if (!isValid) {
            return res.status(401).json({
                message: "Invalid or expired verification code",
            });
        }

        // OTP is valid, get user details
        const userInfo = await User.get({ _id: decoded._id }, { password: 0 });

        if (!userInfo) {
            return res.status(404).json({
                message: "User not found",
            });
        }

        // Generate full access token (NOT a temporary token)
        let payload = {
            email: userInfo.email,
            _id: userInfo._id,
            role: userInfo.role,
        };

        const token = User.getToken(payload);

        // Get user permissions
        const userTabPermission = await User.permission(userInfo);

        // Return the same response structure as the normal login
        return res.send({
            data: {
                ...userInfo,
                token,
            },
            userTabPermission,
            message: MSG.LOGIN_SUCCESS,
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Get MFA status for a user
 */
const GetMFAStatus = async (req, res, next) => {
    try {
        const userId = req.user._id;

        // Get user's MFA status
        const userInfo = await User.get(
            { _id: userId },
            { mfa_enabled: 1, mfa_method: 1 }
        );

        if (!userInfo) {
            return res.status(404).json({ message: "User not found" });
        }

        return res.send({
            data: {
                mfa_enabled: userInfo.mfa_enabled,
                mfa_method: userInfo.mfa_method || "email",
            },
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Get TOTP setup information for QR code generation
 */
const GetTOTPSetup = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const email = req.user.email;

        // Generate TOTP setup info
        const setupInfo = await Services.TOTP.generateSetupInfo(userId, email);

        return res.send({
            data: setupInfo,
            message: "TOTP setup information generated.",
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Unified MFA management - handles both enabling and disabling MFA
 */
const ManageMFA = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const { action, password, otp, method = "email" } = req.body;

        // Validate action
        if (
            !action ||
            !["enable", "disable", "verify", "reset", "change"].includes(action)
        ) {
            return res.status(400).json({
                message:
                    "Invalid action. Must be 'enable', 'disable', 'verify', 'reset', or 'change'",
            });
        }

        // Validate method
        if (!["email", "totp"].includes(method)) {
            return res.status(400).json({
                message: "Invalid method. Must be 'email' or 'totp'",
            });
        }

        // Get user info
        const userInfo = await User.get({ _id: userId });
        if (!userInfo) {
            return res.status(404).json({ message: "User not found" });
        }

        // Handle disable action (no verification needed, just password)
        if (action === "disable") {
            // Verify password first for security
            if (!password) {
                return res
                    .status(400)
                    .json({ message: "Password is required to disable MFA" });
            }

            const passwordValid = User.isPasswordSame(
                password,
                userInfo.password
            );
            if (!passwordValid) {
                return res.status(401).json({ message: "Invalid password" });
            }

            if (!userInfo.mfa_enabled) {
                return res
                    .status(400)
                    .json({ message: "MFA is not currently enabled" });
            }

            // Disable MFA
            await User.updateOne(
                { _id: userId },
                {
                    $set: { mfa_enabled: false },
                    $unset: { mfa_method: "" },
                }
            );

            // Clear any pending OTPs
            await Services.OTP.clearOTPs(userId);

            // Reset TOTP secret if it exists
            await Services.TOTP.resetSecret(userId);

            return res.send({
                data: { mfa_enabled: false },
                message:
                    "Two-factor authentication has been disabled for your account",
            });
        }

        // Handle change action (changing the MFA method)
        if (action === "change") {
            // Verify password first for security
            if (!password) {
                return res.status(400).json({
                    message: "Password is required to change MFA method",
                });
            }

            const passwordValid = User.isPasswordSame(
                password,
                userInfo.password
            );
            if (!passwordValid) {
                return res.status(401).json({ message: "Invalid password" });
            }

            // Check if MFA is enabled
            if (!userInfo.mfa_enabled) {
                return res.status(400).json({
                    message:
                        "MFA is not currently enabled. Use 'enable' action instead.",
                });
            }

            // Check if trying to change to the same method
            if (userInfo.mfa_method === method) {
                return res.status(400).json({
                    message: `MFA is already set to ${method} method. No change needed.`,
                });
            }

            if (method === "email") {
                // For email method, we need to send an OTP for verification
                const otpRecord = await Services.OTP.createOTP({
                    user_id: userId,
                    purpose: "change_mfa",
                });

                // Store the requested method change in a temporary field
                await User.updateOne(
                    { _id: userId },
                    { $set: { pending_mfa_method: "email" } }
                );

                // Send OTP via email
                await Notifications.sendNotification({
                    subject: `Change Two-Factor Authentication Method for Your Swipe Account`,
                    to: [userInfo.email],
                    template: "ENABLE_MFA_OTP",
                    user_name: userInfo.display_name,
                    otp: otpRecord.otp,
                });

                return res.send({
                    message:
                        "Verification code sent to your email. Please verify to change MFA method.",
                });
            } else if (method === "totp") {
                // For TOTP, we need to generate setup info
                const setupInfo = await Services.TOTP.generateSetupInfo(
                    userId,
                    userInfo.email
                );

                // Store the requested method change in a temporary field
                await User.updateOne(
                    { _id: userId },
                    { $set: { pending_mfa_method: "totp" } }
                );

                return res.send({
                    data: {
                        ...setupInfo,
                        mfa_enabled: true,
                    },
                    message:
                        "Please scan the QR code with your authenticator app and verify the code to change MFA method.",
                });
            }
        }

        // Handle reset action for TOTP (regenerate secret)
        if (action === "reset" && method === "totp") {
            // Verify password first for security
            if (!password) {
                return res
                    .status(400)
                    .json({ message: "Password is required to reset TOTP" });
            }

            const passwordValid = User.isPasswordSame(
                password,
                userInfo.password
            );
            if (!passwordValid) {
                return res.status(401).json({ message: "Invalid password" });
            }

            // Reset TOTP secret
            await Services.TOTP.resetSecret(userId);

            // Generate new setup info
            const setupInfo = await Services.TOTP.generateSetupInfo(
                userId,
                userInfo.email
            );

            return res.send({
                data: setupInfo,
                message:
                    "TOTP secret has been reset. Please reconfigure your authenticator app.",
            });
        }

        // Handle enable request (first step)
        if (action === "enable") {
            if (userInfo.mfa_enabled) {
                return res
                    .status(400)
                    .json({ message: "MFA is already enabled" });
            }

            // Verify password
            if (!password) {
                return res
                    .status(400)
                    .json({ message: "Password is required to enable MFA" });
            }

            const passwordValid = User.isPasswordSame(
                password,
                userInfo.password
            );
            if (!passwordValid) {
                return res.status(401).json({ message: "Invalid password" });
            }

            // Method-specific setup
            if (method === "email") {
                // Generate and store OTP for MFA enablement via email
                const otpRecord = await Services.OTP.createOTP({
                    user_id: userId,
                    purpose: "enable_mfa",
                });

                // Send OTP via email
                await Notifications.sendNotification({
                    subject: `Enable Two-Factor Authentication for Your Swipe Account`,
                    to: [userInfo.email],
                    template: "ENABLE_MFA_OTP",
                    user_name: userInfo.display_name,
                    otp: otpRecord.otp,
                });

                return res.send({
                    message:
                        "Verification code sent to your email. Please verify to enable MFA.",
                });
            } else if (method === "totp") {
                // Verify password
                const validPassword = User.isPasswordSame(
                    password,
                    userInfo.password
                );
                if (!validPassword) {
                    return res.status(401).send({
                        error: "Invalid password",
                    });
                }

                // Enable MFA and set other defaults
                await Services.User.enableMFA(userId, method);

                // Generate different response based on method
                // Generate TOTP setup info
                const setupInfo = await Services.TOTP.generateSetupInfo(
                    userId,
                    userInfo.email
                );

                return res.send({
                    data: setupInfo,
                    message:
                        "Please scan the QR code with your authenticator app and verify the code to enable MFA.",
                });
            }
        }

        // Handle verify action (second step of enabling or changing)
        if (action === "verify") {
            if (!otp) {
                return res
                    .status(400)
                    .json({ message: "Verification code is required" });
            }

            // Check if this is a method change verification
            const pendingMethod = userInfo.pending_mfa_method;
            const isMethodChange = pendingMethod && userInfo.mfa_enabled;

            // Use either the pending method (for changes) or the provided method (for enabling)
            const methodToVerify = pendingMethod || method;

            // Verify the OTP based on method
            let isValid = false;

            if (methodToVerify === "email") {
                // Determine the correct purpose based on whether this is a change or initial setup
                const purpose = isMethodChange ? "change_mfa" : "enable_mfa";
                console.log(
                    `[MFA Debug] Verifying email OTP with purpose: ${purpose}`
                );

                isValid = await Services.OTP.verifyOTP({
                    user_id: userId,
                    otp: otp,
                    purpose: purpose,
                });

                console.log(
                    `[MFA Debug] Email OTP verification result: ${isValid}`
                );
            } else if (methodToVerify === "totp") {
                console.log(`[MFA Debug] Verifying TOTP code`);
                isValid = await Services.TOTP.verify(userId, otp);
                console.log(`[MFA Debug] TOTP verification result: ${isValid}`);
            }

            if (!isValid) {
                return res
                    .status(401)
                    .json({ message: "Invalid or expired verification code" });
            }

            // Update user to enable MFA or change method
            const updateFields = {
                mfa_enabled: true,
                mfa_method: methodToVerify,
            };

            const unsetFields = {
                mfa_setup_in_progress: "",
                pending_mfa_method: "",
            };

            await User.updateOne(
                { _id: userId },
                {
                    $set: updateFields,
                    $unset: unsetFields,
                }
            );

            const message = isMethodChange
                ? `Two-factor authentication method has been changed to ${methodToVerify}`
                : `Two-factor authentication has been enabled for your account using ${methodToVerify}`;

            return res.send({
                data: {
                    mfa_enabled: true,
                    method: methodToVerify,
                },
                message: message,
            });
        }
    } catch (error) {
        return next(error);
    }
};

const UserOldEmailVerification = async (req, res, next) => {
    try {
        const userId = req.params.id;
        const { email } = req.body;
        let userDetails = await User.get({ _id: ObjectId(userId) });
        if (!userDetails) {
            return res.status(404).send({ message: "User not found." });
        }
        if (email) {
            Func.emailValidation(email);

            // Generate a temporary token for email verification
            const tempToken = jwt.sign(
                {
                    _id: userDetails._id,
                    email: email,
                    purpose: "email_verification",
                },
                SECRET,
                { expiresIn: "10m" }
            );

            // Send verification email
            try {
                await Notifications.sendNotification({
                    subject: `Verify Your New Email Address`,
                    to: [email],
                    template: "VERIFY_NEW_EMAIL",
                    user_name: userDetails.display_name,
                    verify_link: `https://app.swipe.ai/v1/users/email-verify?tempToken=${tempToken}`,
                });
            } catch (notifError) {
                console.error("Notification error:", notifError);
                return res.status(500).send({
                    message:
                        "Failed to send verification email. Please try again later.",
                });
            }

            return res.status(200).send({
                message:
                    "Verification email sent successfully. Please check your inbox to verify your email address.",
            });
        }
    } catch (error) {
        return next(error);
    }
};

const UpdateSocialDetails = async (req, res, next) => {
    try {
        const userId = req.params.id;
        const { social_links } = req.body;

        if (Array.isArray(social_links) && social_links.length > 0) {
            // Validate each link object
            for (const link of social_links) {
                if (!link.type || !link.value) {
                    return res.status(400).send({
                        message:
                            "Each social link must include a type and value.",
                    });
                }

                // Optional: Validate URL format
                try {
                    new URL(link.value);
                } catch (err) {
                    console.log("err", err);
                    return res.status(400).send({
                        message: `Invalid URL for social link:`,
                    });
                }
            }
        }

        // Update the user
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { $set: { social_links } },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(404).send({
                message: "User not found.",
            });
        }

        return res.status(200).send({
            message: "Social details updated successfully.",
            data: updatedUser.social_links,
        });
    } catch (error) {
        return next(error);
    }
};

router.post("/login", Func.validate(V1Rules.UserLogin), Login);
router.post("/onboarding/toggle", UpdateOnboardingStatus);
router.get("/info", Auth.validate, UserInfo);
router.get("/list/:merchant_id", Auth.validate, getUsersByMerchant);
router.get("/authenticate", Auth.check, Authenticate);
router.post(
    "/resetpassword",
    Auth.check,
    Func.validate(MerchantRules.AccountResetPassword),
    Resetpassword
);
router.post("/set-onboarding", Auth.check, SetOnboarding);
router.post("/set", SetPassword);
router.get("/get/:id", getUserForSetPassword);
router.get("/profile-detail/:id", Auth.check, UserProfileDetails);
router.put("/user-profile/:id", Auth.check, UserProfileUpdate); // verification api for new email
router.get("/email-verify", UserNewEmailVerification); // old and new email verified here
router.put("/merchant-profile/:id", Auth.check, MerchantProfileUpdate);
router.post("/verify-mfa", Func.validate(V1Rules.VerifyMFA), VerifyMFA);
router.get("/mfa/status", Auth.validate, GetMFAStatus);
router.get("/mfa/totp-setup", Auth.validate, GetTOTPSetup);
router.post(
    "/mfa/manage",
    Auth.validate,
    Func.validate(V1Rules.ManageMFA),
    ManageMFA
);
router.post("/verify-old-email/:id", Auth.check, UserOldEmailVerification); //verification api for old email
router.post("/social-details/:id", Auth.check, UpdateSocialDetails);

module.exports = router;
