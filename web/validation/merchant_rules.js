module.exports = {
    UserRegistration:{
        merchantId: 'required',
        email : 'required|email',
        firstName : 'required',
        lastName : 'required'
    },
    UserUpdate:{
        display_name : 'required',
        permissions : 'required',
        disabled : 'sometimes|boolean',
        email_verified : 'sometimes|boolean'
    },
    SearchOrder:{
        search : 'required'
    },
    AccountResetPassword:{
        currentpassword: 'required',
        newpassword: 'required',
        confirmpassword: 'required'
    },
    AddUser:{
        display_name: 'required',
        email: 'required|email',
        permissions: 'required',
        disabled : 'sometimes|boolean',
    },
    ResetPasswordLink:{
        key: 'required'
    },
    ResetPassword:{
        key: 'required',
        password: 'required'
    }
}