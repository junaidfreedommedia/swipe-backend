const fieldPermissionModels = Models.FieldPermissions;
const FieldPermissions = {};

FieldPermissions.get = async (condition, projection, options = { lean: true }) => {
    return fieldPermissionModels.findOne(condition, projection, options);
}

FieldPermissions.getAll = async (condition) => {
    return fieldPermissionModels.find(condition);
}

module.exports = FieldPermissions;