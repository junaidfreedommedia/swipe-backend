const express = require("express");
const router = express.Router();
const Merchant = Services.Merchant;
const User = Services.User;
const shopify = require("./../../shopify");
const { createSavedProduct } = require("./../../app-install");
const heicConvert = require("heic-convert");

const getRequestIp = (req) =>
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip;

const MerchantList = async (req, res, next) => {
    try {
        let { merchant, shop_owner, start_date, end_date, search } = req.body;

        const mainCondition = [];
        const dateCondition = [];
        if (!Auth.isSuperAdmin(req.user)) {
            mainCondition.push({
                _id: {
                    $in: Auth.getAssignedMerchantIds(req.user).map((id) => ObjectId(id)),
                },
            });
        }
        if (merchant) {
            Auth.assertMerchantAccess(req.user, merchant);
            mainCondition.push({ _id: ObjectId(merchant) });
        }
        if (shop_owner) {
            mainCondition.push({ shop_owner: shop_owner });
        }
        if (start_date && end_date) {
            start_date = Moment(start_date).toDate();
            end_date = Moment(end_date).endOf("day").toDate();
            dateCondition.push({
                createdAt: { $gte: start_date, $lte: end_date },
            });
        }
        let regexCondition = {};
        if (search) {
            regexCondition = {
                $or: [
                    { email: { $regex: search, $options: "i" } },
                    { name: { $regex: search, $options: "i" } },
                    { domain: { $regex: search, $options: "i" } },
                ],
            };
        }
        const limit = parseInt(req.query.limit, 10) || 25;
        const page = parseInt(req.query.page, 10) || 1;
        const skip = (page - 1) * limit;
        const pipeline = [];
        if (mainCondition.length) {
            pipeline.push({ $match: { $and: mainCondition } });
        }
        if (Object.keys(regexCondition).length) {
            pipeline.push({ $match: regexCondition });
        }
        if (dateCondition.length) {
            pipeline.push({ $match: { $and: dateCondition } });
        }
        pipeline.push(
            { $sort: { createdAt: -1 } },
            {
                $project: {
                    name: 1,
                    email: 1,
                    platform: 1,
                    domain: 1,
                    shop_owner: 1,
                    is_active: 1,
                    is_blocked: 1,
                    is_deleted: 1,
                    date: {
                        $dateToString: { format: "%m-%d-%Y", date: "$createdAt" }
                    }
                },
            },
            {
                $facet: {
                    metadata: [{ $count: "totalRecords" }],
                    merchantList: [{ $skip: skip }, { $limit: limit }],
                },
            }
        );
        const [result] = await Merchant.aggregate(pipeline);
        const totalRecords = (result.metadata[0] || {}).totalRecords || 0;
        return res.send({
            message: result.merchantList.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: {
                totalRecords,
                response: result.merchantList,
            },
        });
    } catch (err) {
        return next(err);
    }
};

const StoreList = async (req, res, next) => {
    try {
        const condition = Auth.isSuperAdmin(req.user)
            ? {}
            : {
                  _id: {
                      $in: Auth.getAssignedMerchantIds(req.user).map((id) => ObjectId(id)),
                  },
              };
        const response = await Merchant.getAll(
            condition,
            { _id: 1, name: 1, shop_owner: 1, domain: 1, email: 1 },
            { sort: { createdAt: -1 } }
        );

        return res.send({
            message: response ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: {
                response: response,
                totalRecords: response.length,
            },
        });
    } catch (error) {
        return next(error);
    }
};

const ImpersonateMerchant = async (req, res, next) => {
    try {
        if (req.auth?.isImpersonating) {
            throwError("Nested impersonation is not allowed.", 403);
        }
        if (req.user.role !== USER_ROLE.ADMIN) {
            throwError(MSG.NOT_RBS_PERMISSION, 403);
        }

        const { merchantId } = req.params;
        if (!merchantId || !IsValidObjectId(merchantId)) {
            throwError(MSG.INVALID_MERCHANT_ID, 400);
        }

        const merchant = await Merchant.get(
            {
                _id: ObjectId(merchantId),
                is_active: true,
                is_blocked: { $ne: true },
                is_deleted: { $ne: true },
            },
            {
                _id: 1,
                name: 1,
                email: 1,
                domain: 1,
                shop_owner: 1,
                is_onboarding: 1,
                account_manager: 1,
            },
            { lean: true }
        );
        if (!merchant) throwError(MSG.MERCHANT_NOT_EXIST, 404);

        const token = User.getToken(
            {
                email: req.user.email,
                _id: req.user._id,
                role: USER_ROLE.MERCHANT,
                merchant: merchant._id,
                merchantId: merchant._id,
                merchantName: merchant.name,
                impersonatedBy: req.user._id,
                isImpersonating: true,
            },
            "1h"
        );

        await Models.ImpersonationLog.create({
            admin: req.user._id,
            merchant: merchant._id,
            admin_email: req.user.email,
            merchant_name: merchant.name,
            merchant_email: merchant.email,
            ip: getRequestIp(req),
            user_agent: req.headers["user-agent"],
            action: "start",
        });

        return res.send({
            message: MSG.LOGIN_SUCCESS,
            data: {
                token,
                role: USER_ROLE.MERCHANT,
                merchantId: merchant._id,
                merchantName: merchant.name,
                merchant,
                impersonatedBy: req.user._id,
                isImpersonating: true,
                expiresIn: "1h",
            },
        });
    } catch (error) {
        return next(error);
    }
};

const StopImpersonate = async (req, res, next) => {
    try {
        if (!req.auth?.isImpersonating || !req.auth?.impersonatedBy) {
            throwError("No active impersonation session found.", 400);
        }

        const admin = await User.get(
            {
                _id: ObjectId(req.auth.impersonatedBy),
                role: USER_ROLE.ADMIN,
                disabled: false,
                is_deleted: { $ne: true },
            },
            { password: 0, password_reset_key: 0 },
            { lean: true }
        );
        if (!admin) throwError(MSG.USER_NOT_EXIST, 404);

        const token = User.getToken({
            email: admin.email,
            _id: admin._id,
            role: USER_ROLE.ADMIN,
        });

        if (req.auth.merchant || req.auth.merchantId) {
            await Models.ImpersonationLog.create({
                admin: admin._id,
                merchant: ObjectId(req.auth.merchant || req.auth.merchantId),
                admin_email: admin.email,
                merchant_name: req.auth.merchantName,
                ip: getRequestIp(req),
                user_agent: req.headers["user-agent"],
                action: "stop",
            });
        }

        return res.send({
            message: MSG.LOGIN_SUCCESS,
            data: {
                token,
                _id: admin._id,
                email: admin.email,
                display_name: admin.display_name,
                role: USER_ROLE.ADMIN,
                isImpersonating: false,
            },
        });
    } catch (error) {
        return next(error);
    }
};
const AddMerchantUser = async (req, res, next) => {
    try {
        const newUser = await Services.User.AddUser(req.body);
        return res.send(newUser);
    } catch (error) {
        return next(error);
    }
};

const UpdateMerchantUser = async (req, res, next) => {
    try {
        const updateUserProfile = await Services.User.UpdateMerchantUser(req);
        return res.send(updateUserProfile);
    } catch (error) {
        return next(error);
    }
};

const DeleteMerchantUser = async (req, res, next) => {
    try {
        const { userId, merchantId } = req.query;
        if (String(userId) === String(req.user._id))
            throwError(MSG.USER_DELETED_ERROR);
        let userInfo = await Services.User.get({
            _id: userId,
            merchant: merchantId,
        });
        if (!userInfo) throwError(MSG.INVALID_DETAILS);
        await Services.DeletionLog.insert({
            collection: "users",
            deleted_data: userInfo,
            deleted_by: req.user._id,
            reason: "deletion from Dashboard",
        });
        await User.findOneAndUpdate(
            { _id: userId },
            { $set: { is_deleted: true } },
            { new: true }
        );
        return res.send({ message: MSG.USER_DELETED_SUCCESS });
    } catch (error) {
        return next(error);
    }
};

const Details = async (req, res, next) => {
    try {
        Auth.assertMerchantAccess(req.user, req.params.id);
        const { id: merchantId } = req.params;
        const { startdate: startDate, enddate: endDate } = req.query;
        const merchantInfo = await Services.Merchant.get({ _id: merchantId });
        if (empty(merchantInfo))
            return res.send({ message: MSG.DATA_NOT_FOUND });
        // Reading store details must not trigger sheet repair. Claim changes,
        // sheet setup and the scheduled pending refresh own sheet maintenance.
        let start = Moment(new Date(startDate)).format("MM-DD-YYYY");
        let end = Moment(new Date(endDate)).format("MM-DD-YYYY");
        let innerCondition = {};
        let sortOrder = { createdAt: -1 };
        if (startDate && endDate)
            innerCondition["date"] = { $gte: start, $lte: end };
        let claimList = await Services.Claim.aggregate([
            {
                $match: {
                    merchant: ObjectId(merchantId),
                    status: {
                        $in: [
                            CLAIM_STATUS.REVIEWING,
                            CLAIM_STATUS.APPROVED,
                            CLAIM_STATUS.CLOSED,
                            CLAIM_STATUS.RESOLVED,
                        ],
                    },
                },
            },
            {
                $addFields: {
                    date: {
                        $dateToString: {
                            format: "%m-%d-%Y",
                            date: "$createdAt",
                        },
                    },
                },
            },
            { $sort: sortOrder },
            { $match: innerCondition },
            {
                $lookup: {
                    from: "orders",
                    localField: "order",
                    foreignField: "_id",
                    as: "orders",
                },
            },
            {
                $unwind: {
                    path: "$orders",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $group: {
                    _id: "$merchant",
                    claim_order: {
                        $push: {
                            claim_id: "$$ROOT._id",
                            order_id: "$$ROOT.orders.name",
                            customer_email: "$$ROOT.orders.customer.email",
                            createdAt: "$$ROOT.createdAt",
                            status: "$$ROOT.status",
                            sub_status: "$$ROOT.sub_status",
                            previous_status: "$$ROOT.previous_status",
                        },
                    },
                },
            },
        ]);

        const tasks = await Services.Task.get(
            { merchant: merchantId },
            { createdAt: 0, updatedAt: 0, __v: 0 }
        );
        const users = await Services.User.getAll(
            { merchant: merchantId },
            {
                password: 0,
                __v: 0,
                createdAt: 0,
                updatedAt: 0,
                password_reset_key: 0,
            }
        );
        let totalclaim = { in_review: 0, approved: 0, closed: 0, resolved: 0 },
            claimObj = {
                [CLAIM_STATUS.REVIEWING]: "in_review",
                [CLAIM_STATUS.APPROVED]: "approved",
                [CLAIM_STATUS.CLOSED]: "closed",
                [CLAIM_STATUS.RESOLVED]: "resolved",
            };
        claimList = claimList[0];
        totalclaim["total"] = claimList?.claim_order?.length || 0;
        if (claimList) {
            for (let { status } of claimList.claim_order) {
                totalclaim[claimObj[status]] += 1;
            }
            totalclaim["shop_id"] = claimList.shop_id;
        }
        if (merchantInfo.is_billing) {
            totalclaim["shopify_billing"] = true;
        } else {
            const session = await Services.ShopifySession.get({
                shop: merchantInfo.shop_id,
            });
            totalclaim["shopify_billing"] =
                await Services.Billing.checkBillingStatus(session);
        }
        let account_info;
        if (merchantInfo.account_manager) {
            account_info = await Services.User.get(
                {
                    _id: merchantInfo.account_manager,
                },
                { email: 1 }
            );
        }
        return res.send({
            message: MSG.DATA_FOUND,
            data: {
                merchant_id: merchantInfo._id,
                merchant_name: merchantInfo.name,
                merchant_email: merchantInfo.email,
                merchant_phone: merchantInfo.phone,
                merchant_shop_id: merchantInfo.shop_id,
                merchant_address1: merchantInfo.address1,
                merchant_platform: merchantInfo.platform,
                merchant_account_manager: account_info,
                shop_id: merchantInfo.shop_id,
                id: merchantInfo.id,
                is_active: merchantInfo.is_active,
                is_billing: merchantInfo.is_billing,
                google_sheet_claim_sync_enabled:
                    merchantInfo.google_sheet_claim_sync_enabled === true,
                google_sheet_id: merchantInfo.google_sheet_id || null,
                google_sheet_url: merchantInfo.google_sheet_url || null,
                is_blocked: merchantInfo.is_blocked,
                is_deleted: merchantInfo.is_deleted,
                blocked_date: merchantInfo.blocked_date,
                deleted_date: merchantInfo.deleted_date,
                merchant_commission: merchantInfo.competition || 0,
                iana_timezone:
                    merchantInfo.iana_timezone || "America/Chicago",
                merchant_billing_type: merchantInfo.billing_type || "stripe",
                billing_approved_date: merchantInfo.billing_approved_date || null,
                task: tasks,
                user: users,
                ...claimList,
                ...totalclaim,
            },
        });
    } catch (error) {
        return next(error);
    }
};


const TaskUpdate = async (req, res, next) => {
    try {
        const { task, status, merchant } = req.body;
        await Services.Task.updateTask(merchant, task, status); 
        const allTasks = await Services.Task.get({ merchant: merchant });
        
        if (allTasks) {
            const onboardTaskDoneStatus = (allTasks.onboard_task && allTasks.onboard_task.done) ? true : false;
            
            await Services.Merchant.updateOne(
                { _id: merchant },
                { $set: { is_onboarding: onboardTaskDoneStatus } } 
            );
        }
        
        if (task === "billing_task") {
             const merchantInfo = await Services.Merchant.get(
                { _id: merchant },
                { shop_id: 1 }
             );
             if (!merchantInfo)
                 return res.send({ message: MSG.MERCHANT_NOT_EXIST });
             const session = await Services.ShopifySession.get({
                 shop: merchantInfo.shop_id,
             });
             if (status == true && merchantInfo.billing_type !== "stripe") {
                 const chargeInfo =
                     await shopify.api.rest.RecurringApplicationCharge.all({
                         session,
                     });
                 const [active_charge] = chargeInfo.data.filter(
                     (charge) => charge.status == "active"
                 );
                 await Services.Merchant.updateOne(
                     { _id: merchant },
                     {
                         $set: {
                             is_billing: true,
                             billing_approved_date: new Date(),
                             charge_id: active_charge?.id,
                         },
                     }
                 );
                 await Services.Order.updateOne(
                     { merchant: merchant, is_invoiced: null },
                     { $set: { is_invoiced: false, is_claim_created: false } },
                     { multi: true }
                 );
                 await Services.Billing.createUsagesForMerchant(merchant);
             } else if (
                 status == false &&
                 merchantInfo.billing_type == "shopify" &&
                 merchantInfo.is_billing == true
             ) {
                 await Services.Billing.cancelShopifyBilling(session);
             }
        }
        
        res.send({ message: MSG.TASK_UPDATED });
    } catch (error) {
        return next(error);
    }
};
const updateMerchantSetting = async (req, res, next) => {
    try {
        const response = await Merchant.UpsertSetting(req.params.id, req.body);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const MerchantSettingList = async (req, res, next) => {
    try {
        const response = await Merchant.SettingList(req.params.id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const ClaimGraph = async (req, res, next) => {
    try {
        const merchantInfo = await Services.Merchant.get(
            { _id: req.params.id },
            { iana_timezone: 1 }
        );
        const response = await Services.Claim.ClaimGraphisList(
            merchantInfo._id,
            merchantInfo.iana_timezone
        );

        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const blockMerchant = async (req, res, next) => {
    try {
        const { merchant_id } = req.body;

        if (!merchant_id) {
            throwError(MSG.INVALID_MERCHANT);
        }

        // Get merchant info
        const merchantInfo = await Services.Merchant.get({ _id: merchant_id });
        if (!merchantInfo) {
            throwError(MSG.MERCHANT_NOT_EXIST);
        }

        // Update merchant to blocked status
        const updatedMerchant = await Services.Merchant.findOneAndUpdate(
            { _id: merchant_id },
            {
                $set: {
                    is_active: false,
                    is_blocked: true,
                    blocked_date: new Date(),
                },
            },
            { new: true }
        );

        // Delete webhooks for the shop
        const session = await Services.ShopifySession.get({
            shop: merchantInfo.shop_id,
        });
        if (session) {
            // Get all webhooks
            const webhooks = await shopify.api.rest.Webhook.all({ session });

            // Delete each webhook
            for (const webhook of webhooks.data) {
                await shopify.api.rest.Webhook.delete({
                    session,
                    id: webhook.id,
                });
            }
        }

      

        // Log the event
        await Services.Event.insert({
            merchant: merchantInfo._id,
            type: EVENT_TYPE.ACTION,
            sub_type: EVENT_SUBTYPE.MERCHANT_BLOCKED,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: EVENT_TITLE.MERCHANT_BLOCKED,
            ts: Math.floor(new Date().getTime() / 1000),
        });

        return res.send({
            message: MSG.MERCHANT_BLOCKED,
            data: updatedMerchant,
        });
    } catch (error) {
        return next(error);
    }
};

const deleteMerchant = async (req, res, next) => {
    try {
        const { merchant_id } = req.body;

        if (!merchant_id) {
            throwError(MSG.INVALID_MERCHANT);
        }

        // Get merchant info
        const merchantInfo = await Services.Merchant.get({ _id: merchant_id });
        if (!merchantInfo) {
            throwError(MSG.MERCHANT_NOT_EXIST);
        }

        // Update merchant to deleted status
        const updatedMerchant = await Services.Merchant.findOneAndUpdate(
            { _id: merchant_id },
            {
                $set: {
                    is_active: false,
                    is_deleted: true,
                    deleted_date: new Date(),
                },
            },
            { new: true }
        );

        // Delete webhooks for the shop
        const session = await Services.ShopifySession.get({
            shop: merchantInfo.shop_id,
        });
        if (session) {
            // Get all webhooks
            const webhooks = await shopify.api.rest.Webhook.all({ session });

            // Delete each webhook
            for (const webhook of webhooks.data) {
                await shopify.api.rest.Webhook.delete({
                    session,
                    id: webhook.id,
                });
            }
        }


        // Log the event
        await Services.Event.insert({
            merchant: merchantInfo._id,
            type: EVENT_TYPE.ACTION,
            sub_type: EVENT_SUBTYPE.MERCHANT_DELETED,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: EVENT_TITLE.MERCHANT_DELETED,
            ts: Math.floor(new Date().getTime() / 1000),
        });

        return res.send({
            message: MSG.MERCHANT_DELETED,
            data: updatedMerchant,
        });
    } catch (error) {
        return next(error);
    }
};

// DeleteSwipeProduct graphql api
const deleteSwipeProduct = async (session) => {
    if (!session) return false;
    const client = new shopify.api.clients.Graphql({ session });
    try {
        const findRes = await client.query({
            data: {
                query: `
          query findSwipeProduct($q: String!) {
            products(first: 1, query: $q) {
              nodes { id }
            }
          }
        `,
        variables: { q: "title:'Swipe Package Protection'" },
            },
        });
        const nodes = findRes.body.data.products.nodes;
        if (nodes.length === 0) {
            console.log('Swipe Package Protection product Not Found.');
            return false;
        }
        const productGid = nodes[0].id;
        const delRes = await client.query({
            data: {
                query: `
          mutation deleteSwipeProduct($input: ProductDeleteInput!) {
            productDelete(input: $input) {
              deletedProductId
              userErrors { field message }
            }
          }
        `,
        variables: { input: { id: productGid } },
            },
        });

        const { userErrors } = delRes.body.data.productDelete;
        if (userErrors.length) {
            console.error(
                'Deletion errors:',
                userErrors.map(e => e.message).join('; ')
            );
            return false;
        }
       
        console.log(`Deleted Swipe product: ${productGid}`);
        return true;

    } catch (err) {
        console.error('GraphQL delete error:', err);
        return false;
    }
};

// Add function to restore a merchant (unblock or undelete)
const restoreMerchant = async (req, res, next) => {
    try {
        const { merchant_id } = req.body;

        if (!merchant_id) {
            throwError(MSG.INVALID_MERCHANT);
        }

        // Get merchant info
        const merchantInfo = await Services.Merchant.get({ _id: merchant_id });
        if (!merchantInfo) {
            throwError(MSG.MERCHANT_NOT_EXIST);
        }
const elapsed = Date.now() - new Date(merchantInfo.deleted_date).getTime();
 if (elapsed > 60 * 1000) {
   throwError("Restore window has expired.");
}
        // Update merchant to active status
        const updatedMerchant = await Services.Merchant.findOneAndUpdate(
            { _id: merchant_id },
            {
                $set: {
                    is_active: true,
                    is_blocked: false,
                    is_deleted: false,
                },
                $unset: {
                    blocked_date: "",
                    deleted_date: "",
                },
            },
            { new: true }
        );

        // Re-register webhooks for the shop
        const session = await Services.ShopifySession.get({
            shop: merchantInfo.shop_id,
        });
        if (session) {
            await Services.Webhook.registerWebhooks(session);
        }

        // Log the event
        await Services.Event.insert({
            merchant: merchantInfo._id,
            type: EVENT_TYPE.ACTION,
            sub_type: EVENT_SUBTYPE.MERCHANT_RESTORED,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: EVENT_TITLE.MERCHANT_RESTORED,
            ts: Math.floor(new Date().getTime() / 1000),
        });

        return res.send({
            message: MSG.MERCHANT_RESTORED,
            data: updatedMerchant,
        });
    } catch (error) {
        return next(error);
    }
};

const getMerchantStatus = async (req, res, next) => {
    try {
        const { merchant_id } = req.params;

        if (!merchant_id) {
            throwError(MSG.INVALID_MERCHANT);
        }

        // Get merchant info
        const merchantInfo = await Services.Merchant.get({ _id: merchant_id });
        if (!merchantInfo) {
            throwError(MSG.MERCHANT_NOT_EXIST);
        }

        // Return merchant status info
        return res.send({
            message: MSG.DATA_FOUND,
            data: {
                is_active: merchantInfo.is_active,
                is_blocked: merchantInfo.is_blocked,
                is_deleted: merchantInfo.is_deleted,
                blocked_date: merchantInfo.blocked_date,
                deleted_date: merchantInfo.deleted_date,
            },
        });
    } catch (error) {
        return next(error);
    }
};

const AddComment = async (req, res, next) => {
    try {
        const { merchant, type, content } = req.body;
        let uploadedFiles = [];
        if (req.files && req.files.attachments) {
            const attachments = req.files.attachments;
            const files = Array.isArray(attachments)
                ? attachments
                : [attachments]; // normalize

            console.log("files", files);

            for (const file of files) {
                if (file.size > 20971520) {
                    throw new Error(
                        `${file.name} exceeds the maximum allowed size of 20 MB.`
                    );
                }
                const originalName = file.name;
                const extension = originalName.split(".").pop();
                const baseName = originalName.replace(`.${extension}`, "");
                let file_name = `${baseName}_${createRandomString(
                    10
                )}.${extension}`;
                let environment = `notes/${process.env.S3_ENVIRONMENT}`;
                let data;
                if (["heic", "heif"].includes(extension)) {
                    try {
                        const outputBuffer = await heicConvert({
                            buffer: file.data, // HEIC file buffer
                            format: "JPEG", // Output format
                            quality: 1, // Quality: 0–1
                        });

                        file_name = `${baseName}_${createRandomString(10)}.jpg`;
                        const bufferToUpload = outputBuffer;
                        data = await S3.upload(
                            file_name,
                            bufferToUpload,
                            environment
                        );
                        console.log("data", data);
                    } catch (err) {
                        console.error("HEIC conversion failed:", err);
                        throw new Error("Failed to convert HEIC image.");
                    }
                } else {
                    data = await S3.upload(file_name, file.data, environment);
                }

                if (data) {
                    uploadedFiles.push(data.Location);
                    console.log("uploadedFiles", uploadedFiles);
                }
            }
        }

        const newComment = await Services.Event.insert({
            content,
            merchant,
            attachments: uploadedFiles,
            created_by: req.user._id,
            type: type,
            title: EVENT_TITLE.COMMENT_ADDED,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.CLAIM,
            ts: Math.floor(new Date().getTime() / 1000),
        });
        return res.send({
            message: MSG.COMMENT_ADDED,
            data: newComment,
        });
    } catch (error) {
        next(error);
    }
};

const ListComment = async (req, res, next) => {
    try {
        const comments = await Services.Event.aggregate([
            {
                $match: {
                    merchant: ObjectId(req.params.merchant),
                    type: {
                        $in: [
                            EVENT_TYPE.STORE_COMMENT,
                            EVENT_TYPE.INTERNAL_STORE_COMMENT,
                        ],
                    },
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "created_by",
                    foreignField: "_id",
                    as: "created_by",
                },
            },
            {
                $unwind: {
                    path: "$created_by",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    _id: 1,
                    merchant: 1,
                    ts: 1,
                    type: 1,
                    content: 1,
                    attachments: 1,
                    claim: 1,
                    created_by: "$created_by.display_name",
                    createdAt: 1,
                },
            },
            { $sort: { createdAt: -1 } },
        ]);
        comments.forEach((comment) => {
            comment.image_attachments = [];
            comment.pdf_attachments = [];

            if (Array.isArray(comment.attachments)) {
                comment.attachments.forEach((file) => {
                    const fileName = file.split("/").pop().split("?")[0];
                    const extension = file
                        .split(".")
                        .pop()
                        .split("?")[0]
                        .toLowerCase();

                    if (
                        [
                            "jpg",
                            "jpeg",
                            "png",
                            "gif",
                            "webp",
                            "bmp",
                            "tif",
                            "tiff",
                            "heic",
                            "heif",
                            "svg",
                            "eps",
                            "ai",
                            "ico",
                            "psd",
                            "xcf",
                            "raw",
                            "cr2",
                            "nef",
                            "arw",
                        ].includes(extension)
                    ) {
                        comment.image_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    } else if (
                        [
                            "txt",
                            "md",
                            "rtf",
                            "doc",
                            "docx",
                            "xls",
                            "xlsx",
                            "ppt",
                            "pptx",
                            "pdf",
                            "epub",
                            "mobi",
                            "odt",
                            "ods",
                            "odp",
                        ]
                    ) {
                        comment.pdf_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    }
                });
            }
        });

        const storeComments = comments.filter(
            (c) => c.type === EVENT_TYPE.STORE_COMMENT
        );
        const internalComments = comments.filter(
            (c) => c.type === EVENT_TYPE.INTERNAL_STORE_COMMENT
        );

        return res.send({
            message: MSG.DATA_FOUND,
            data: {
                store_comments: storeComments,
                internal_comments: internalComments,
            },
        });

        // return res.send({
        //     message: MSG.DATA_FOUND,
        //     data: comments,
        // });
    } catch (error) {
        next(error);
    }
};

router.post("/store", Auth.check, MerchantList);
router.get("/storelist", Auth.check, StoreList);
router.post(
    "/impersonate/:merchantId",
    Auth.check,
    Auth.requireSuperAdmin,
    ImpersonateMerchant
);
router.post("/stop-impersonate", Auth.validate, StopImpersonate);
router.get("/:id", Func.validate(AdminRules.ParamsId), Auth.check, Details);
router.post(
    "/add-user",
    Auth.check,
    Auth.requireSuperAdmin,
    AddMerchantUser
);
router.put(
    "/edit-profile/:id",
    Auth.check,
    Func.validate(MerchantRules.UserUpdate),
    Auth.requireSuperAdmin,
    UpdateMerchantUser
);
router.delete(
    "/delete",
    Auth.check,
    Auth.requireSuperAdmin,
    DeleteMerchantUser
);
router.put(
    "/task",
    Func.validate(AdminRules.TaskUpdate),
    Auth.check,
    Auth.requireSuperAdmin,
    TaskUpdate
);
router.post(
    "/setting/:id",
    Auth.check,
    Auth.requireMerchantAccess("params", "id"),
    updateMerchantSetting
);
router.get(
    "/settinglist/:id",
    Func.validate(AdminRules.ParamsId),
    Auth.check,
    Auth.requireMerchantAccess("params", "id"),
    MerchantSettingList
);
router.get(
    "/claim/graph/:id",
    Auth.check,
    Auth.requireMerchantAccess("params", "id"),
    ClaimGraph
);
router.post(
    "/block",
    Auth.check,
    Auth.requireSuperAdmin,
    Func.validate(AdminRules.BlockMerchant),
    blockMerchant
);
router.post(
    "/delete",
    Auth.check,
    Auth.requireSuperAdmin,
    Func.validate(AdminRules.DeleteMerchant),
    deleteMerchant
);
router.post(
    "/restore",
    Auth.check,
    Auth.requireSuperAdmin,
    Func.validate(AdminRules.RestoreMerchant),
    restoreMerchant
);
router.post("/comment", Auth.check, AddComment);
router.get("/comment/:merchant", Auth.check, ListComment);
router.get("/status/:merchant_id", Auth.check, getMerchantStatus);

module.exports = router;
