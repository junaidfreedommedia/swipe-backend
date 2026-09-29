const express = require("express");
const router = express.Router();
const User = Services.User;

const LEGACY_USER_ROLES = new Set([
  ROLES.ACCOUNT_MANAGER,
  ROLES.CLAIM_APPROVER,
  USER_ROLE.MERCHANT,
]);

const normalizeAdminPayload = (payload = {}) => {
  const adminType = Object.values(ADMIN_TYPE).includes(payload.admin_type)
    ? payload.admin_type
    : ADMIN_TYPE.SUPER_ADMIN;
  const claimsCreate = Boolean(payload.admin_permissions?.claims_create);
  const claimsView = Boolean(
    payload.admin_permissions?.claims_view || claimsCreate
  );
  const merchants = [
    ...new Set(
      (Array.isArray(payload.merchants) ? payload.merchants : [])
        .map(String)
        .filter((id) => IsValidObjectId(id))
    ),
  ];

  return {
    display_name: payload.display_name,
    email: payload.email,
    role: USER_ROLE.ADMIN,
    roles: [USER_ROLE.ADMIN],
    admin_type: adminType,
    admin_permissions:
      adminType === ADMIN_TYPE.SUPER_ADMIN
        ? { claims_view: true, claims_create: true }
        : { claims_view: claimsView, claims_create: claimsCreate },
    permissions:
      adminType === ADMIN_TYPE.SUPER_ADMIN
        ? ["account_manager", "billing", "claims", "dashboard", "users"]
        : ["dashboard", "billing", ...(claimsView ? ["claims"] : [])],
    merchants: adminType === ADMIN_TYPE.SUPER_ADMIN ? [] : merchants,
  };
};

const validateAdminStores = async (adminPayload) => {
  if (adminPayload.admin_type !== ADMIN_TYPE.SIMPLE_ADMIN) return;
  if (!adminPayload.merchants.length) {
    throwError("Select at least one store for a Simple Admin.");
  }
  const storeCount = await Services.Merchant.count({
    _id: { $in: adminPayload.merchants.map((id) => ObjectId(id)) },
    is_deleted: { $ne: true },
  });
  if (storeCount !== adminPayload.merchants.length) {
    throwError("One or more selected stores are invalid.");
  }
};

const normalizeCreatePayload = (payload = {}) => {
  if (
    payload.role === USER_ROLE.ADMIN ||
    Object.values(ADMIN_TYPE).includes(payload.admin_type)
  ) {
    return normalizeAdminPayload(payload);
  }
  if (!LEGACY_USER_ROLES.has(payload.role)) {
    throwError("Please select a valid user role.");
  }
  return {
    display_name: payload.display_name,
    email: payload.email,
    role: payload.role,
    roles: [payload.role],
  };
};

// Create or Reactivate a user
const UserAdd = async (req, res, next) => {
  try {
    const userPayload = normalizeCreatePayload(req.body);
    const { email } = userPayload;
    if (userPayload.role === USER_ROLE.ADMIN) {
      await validateAdminStores(userPayload);
    }
    // Check for existing user by email
    const existingUser = await User.get({ email });
    if (existingUser) {
      if (existingUser.is_deleted) {
        // Reactivate soft-deleted user via findOneAndUpdate
        const updatedUser = await User.findOneAndUpdate(
          { _id: existingUser._id },
          {
            $set: {
              is_deleted: false,
              ...userPayload
            }
          },
          { new: true }
        );
        return res.send({ message: MSG.USER_REACTIVATED, data: updatedUser });
      }
      // If not deleted, cannot create duplicate
      throwError(MSG.USER_EMAIL_EXISTS);
    }
    // Otherwise proceed to create new user
    const newUser = await User.AddUser(userPayload);
    return res.send(newUser);
  } catch (error) {
    return next(error);
  }
};

// Update user profile
const UserProfileUpdate = async (req, res, next) => {
  try {
    const userInfo = await Services.User.get({ _id: req.params.id });
    if (!userInfo) throwError(MSG.INVALID_DETAILS);
    if (String(req.user._id) === String(req.params.id) && req.body.disabled)
      throwError(MSG.USER_INACTIVE_ERROR);

    let update;
    if (userInfo.role === USER_ROLE.ADMIN) {
      const normalized = normalizeAdminPayload({
        ...(typeof userInfo.toObject === "function"
          ? userInfo.toObject()
          : userInfo),
        ...req.body,
        admin_type:
          req.body.admin_type ||
          userInfo.admin_type ||
          ADMIN_TYPE.SUPER_ADMIN,
      });
      await validateAdminStores(normalized);
      if (
        String(req.user._id) === String(req.params.id) &&
        normalized.admin_type !== ADMIN_TYPE.SUPER_ADMIN
      ) {
        throwError("You cannot remove your own Super Admin access.");
      }
      update = {
        ...normalized,
        disabled: Boolean(req.body.disabled),
      };
      delete update.email;
    } else {
      update = {
        display_name: req.body.display_name,
        permissions: Array.isArray(req.body.permissions)
          ? req.body.permissions
          : userInfo.permissions,
        disabled: Boolean(req.body.disabled),
      };
    }
    const updatedUser = await Services.User.findByIdAndUpdate(
      req.params.id,
      update
    );
    return res.send({ message: MSG.USER_INFO_UPDATE, data: updatedUser });
  } catch (error) {
    return next(error);
  }
};

// Get one user
const UserDetails = async (req, res, next) => {
  try {
    const user = await User.get(
      { _id: req.params.id, is_deleted: { $ne: true } },
      { password: 0, password_reset_key: 0 }
    );
    if (!user) throwError(MSG.USER_NOT_EXIST, 404);
    return res.send({ message: MSG.DATA_FOUND, data: user });
  } catch (error) {
    return next(error);
  }
};

// List all users (any role) with pagination and optional search
const UserList = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 25;
    const page = parseInt(req.query.page, 10) || 1;
    const skip = (page - 1) * limit;

    const rawSearch = req.query.search;
    const search =
      typeof rawSearch === "string" && rawSearch.trim() !== "" && rawSearch !== "undefined"
        ? rawSearch.trim()
        : null;

    const pipeline = [];
    pipeline.push({ $match: { is_deleted: { $ne: true } } });
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { display_name: { $regex: search, $options: "i" } },
            { email:        { $regex: search, $options: "i" } }
          ]
        }
      });
    }
    pipeline.push({
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              password: 0,
              __v: 0,
              createdAt: 0,
              updatedAt: 0,
              password_reset_key: 0,
            }
          }
        ],
        totalRecords: [{ $count: "count" }]
      }
    });

    const result = await User.aggregate(pipeline);
    const users = result[0].data || [];
    const totalRecords = result[0].totalRecords[0]?.count || 0;
    const message = users.length === 0 ? MSG.DATA_NOT_FOUND : MSG.DATA_FOUND;

    return res.send({ message, data: users, totalRecords });
  } catch (error) {
    return next(error);
  }
};

// List only admin users with pagination and optional search
const AdminUser = async (req, res, next) => {
  try {
    const rawSearch = req.query.search;
    const search =
      typeof rawSearch === "string" && rawSearch.trim() !== "" && rawSearch !== "undefined"
        ? rawSearch.trim()
        : null;

    const pipeline = [
      { $match: { role: USER_ROLE.ADMIN } },
      { $match: { is_deleted: { $ne: true } } }
    ];
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { display_name: { $regex: search, $options: "i" } },
            { email:        { $regex: search, $options: "i" } }
          ]
        }
      });
    }
    pipeline.push({
      $facet: {
        data: [
          {
            $project: {
              password: 0,
              __v: 0,
              createdAt: 0,
              updatedAt: 0,
              password_reset_key: 0,
            }
          }
        ],
        totalRecords: [{ $count: "count" }]
      }
    });

    const result = await User.aggregate(pipeline);
    const users = result[0].data || [];
    const totalRecords = result[0].totalRecords[0]?.count || 0;
    const message = users.length === 0 ? MSG.DATA_NOT_FOUND : MSG.DATA_FOUND;

    return res.send({ message, data: users, totalRecords });
  } catch (error) {
    return next(error);
  }
};

// Soft-delete a user and log the action
const DeleteUser = async (req, res, next) => {
  try {
    const deleteId = req.params.id;
    if (String(deleteId) === String(req.user._id))
      throwError(MSG.USER_DELETED_ERROR);

    const userInfo = await User.get({ _id: deleteId });
    if (!userInfo) throwError(MSG.INVALID_DETAILS);

    await Services.DeletionLog.insert({
      collection: "users",
      deleted_data: userInfo,
      deleted_by: req.user._id,
      reason: "Deletion from Dashboard",
    });

    await User.findOneAndUpdate(
      { _id: deleteId },
      { $set: { is_deleted: true } },
      { new: true }
    );

    return res.send({ message: MSG.USER_DELETED_SUCCESS });
  } catch (error) {
    return next(error);
  }
};

// Route bindings
router.post(
  "/add",
  Auth.check,
  Func.validate(AdminRules.AddUser),
  Auth.requireSuperAdmin,
  UserAdd
);
router.put(
  "/:id",
  Auth.check,
  Auth.requireSuperAdmin,
  Func.validate(AdminRules.UserProfileUpdate),
  UserProfileUpdate
);
router.get(
  "/admin",
  Auth.check,
  Auth.requireSuperAdmin,
  AdminUser
);
router.get(
  "/:id",
  Auth.check,
  Auth.requireSuperAdmin,
  UserDetails
);
router.get(
  "/",
  Auth.check,
  Auth.requireSuperAdmin,
  UserList
);
router.delete(
  "/delete/:id",
  Auth.check,
  Auth.requireSuperAdmin,
  DeleteUser
);

module.exports = router;
