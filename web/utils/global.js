const randomize = require('randomatic');
global.Moment = require('moment-timezone');
global.getErrorMessage = (err,processId) => {
    // if(err.constructor.name !== 'Error' && isProd()){
    //     err.message = MSG.INTERNAL_ERROR_WITH_ID+processId;
    // }
    return err.message;
};
global.setError = (msg, code) => {
    if (!code) {
        code = 400;
    }
    let err = new Error(msg);
    err.status = code;
    return err;
};
global.throwError = (err,code=400) => {
    if(typeof err === 'string'){
        throw setError(err,code);
    }else{
        throw err;
    }
};
global.createRandomString = (length = 6) => {
    return randomize('a0', length);
};
global.empty = value => {
    value = Mongoose.Types.ObjectId.isValid(value) && value != 0 ? String(value):value;
    if (!_.isUndefined(value)) {
        if ((typeof value == 'array' || typeof value == 'object') && _.isEmpty(value)) {
            return true;
        } else if (value == '') {
            return true;
        } else {
            return false;
        }
    }
    return true;
};
global.ObjectIds = ids => {
    return _.map(ids, function(id) {
        return id ? ObjectId(id) : undefined;
    });
};
global.isProd = function() {
    const env = process.env.NODE_ENV || 'default';
    return _.includes(['production','staging','uat'], env);
};
global.dateToString = function(object) {
    var flatten = require('flat');
    return flatten.unflatten(
        _.transform(flatten(object), function(result, value, key) {
            result[key] = _.isDate(value) ? value.toISOString() : value;
        })
    );
};
global.dateToISO = (addSubtractDays = 0, format = 'MM-DD-YYYY', tz) => {
    return new Date(Moment().tz(tz).add(addSubtractDays, 'days').format(format));
};
global.toISO = (date, format = 'MM-DD-YYYY') => {
    return new Date(Moment(date).format(format));
};
global.UnixTimestamp = () => {
    return Moment().unix();
}
global.replaceMulti = function(string, replacement) {
    _.each(replacement, (replace, search) => {
        string = string.split(search).join(replace);
    });
    return string;
};
global.getAction = method => {
    return method == 'POST' || method == 'PUT' ? 'write' : method == 'DELETE' ? 'delete' : 'read';
};