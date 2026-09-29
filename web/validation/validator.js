global.Validator = require('validatorjs');
Validator.prototype._suppliedWithData = function(attribute) {
    return _.has(this.input, attribute);
};
Validator.register(
    'integer',
    function(value, requirement, attribute) {
        return _.isInteger(value);
    },
    'The :attribute must be an integer.'
);
Validator.register(
    'IsValidObjectID',
    function(value, requirement, attribute) {
        return Mongoose.Types.ObjectId.isValid(value);
    },
    'The :attribute field is not valid id'
);
