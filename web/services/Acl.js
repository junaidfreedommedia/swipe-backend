const Acl = {};
Acl.getAll = async (params = {}) => {
    try {
        const { condition = {}, projection = {}, options = { lean: true } } = params;
        return await Models.Acl.find(condition, projection, options);
    } catch (err) {
        throwError(err.message);
    }
};
Acl.getPermission = async (roles) =>{
    try {      
        let mPermissions = {};
        let data = await Acl.getAll({ condition: { role: roles } });
        if(data){
            for (const record of data) {    
                const { permissions } = record;    
                const keys = Object.keys(permissions);    
                for (const key of keys) {        
                    if( key in mPermissions){
                        mPermissions[key] = [...new Set([...mPermissions[key], ...permissions[key]])];
                    }else{
                        mPermissions[key] = permissions[key];
                    }
                }
            }
        }
        return mPermissions;
    } catch (err) {
        throwError(err.message);
    }
}
Acl.rolesPermissions = async (role, resource, permissions=[], cb = ()=>{}) =>{
    try {
        let dbPermissions = await Acl.getPermission(role);
        const resourcePermissions = dbPermissions[resource];
        if(resourcePermissions){
            permissions = permissions.filter(function(p) {
                return resourcePermissions.indexOf(p) === -1;
            });
            return (permissions.length === 0);
        }
        return true;
    } catch (err) {
        throwError(err.message);
    }
}
module.exports = Acl;