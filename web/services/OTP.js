const OTPSchema = Models.OTP;
const OTP = {};

/**
 * Generate a random numeric OTP of specified length
 * @param {number} length - Length of the OTP to generate (default: 6)
 * @returns {string} - Generated OTP
 */
OTP.generateOTP = (length = 6) => {
    let otp = '';
    for (let i = 0; i < length; i++) {
        otp += Math.floor(Math.random() * 10); // Generate random digit between 0-9
    }
    return otp;
};

/**
 * Create and store a new OTP for a user
 * @param {Object} data - OTP data
 * @param {string} data.user_id - User ID
 * @param {string} data.purpose - Purpose of OTP ('login' or 'enable_mfa')
 * @param {number} expiryMinutes - Minutes until OTP expires (default: 10)
 * @returns {Promise<Object>} - Created OTP object
 */
OTP.createOTP = async (data, expiryMinutes = 10) => {
    // First delete any existing OTPs for this user and purpose
    await OTPSchema.deleteMany({ 
        user_id: data.user_id, 
        purpose: data.purpose 
    });
    
    // Generate new OTP
    const otp = OTP.generateOTP();
    
    // Calculate expiry time
    const expires_at = new Date();
    expires_at.setMinutes(expires_at.getMinutes() + expiryMinutes);
    
    // Create and save new OTP
    return new OTPSchema({
        user_id: data.user_id,
        otp,
        purpose: data.purpose,
        expires_at
    }).save();
};

/**
 * Verify an OTP for a user
 * @param {Object} data - Verification data
 * @param {string} data.user_id - User ID
 * @param {string} data.otp - OTP to verify
 * @param {string} data.purpose - Purpose of OTP ('login' or 'enable_mfa')
 * @returns {Promise<boolean>} - True if OTP is valid, false otherwise
 */
OTP.verifyOTP = async (data) => {
    console.log(`[OTP Debug] Verifying OTP: ${data.otp} for user: ${data.user_id}, purpose: ${data.purpose}`);
    
    // First check if there's any OTP for this user and purpose
    const allOtps = await OTPSchema.find({
        user_id: data.user_id,
        purpose: data.purpose
    });
    
    console.log(`[OTP Debug] Found ${allOtps.length} OTPs for this user and purpose`);
    if (allOtps.length > 0) {
        allOtps.forEach(record => {
            console.log(`[OTP Debug] OTP record: ${record.otp}, expires: ${record.expires_at}, now: ${new Date()}`);
        });
    }
    
    // Now find the matching OTP
    const otpRecord = await OTPSchema.findOne({
        user_id: data.user_id,
        otp: data.otp,
        purpose: data.purpose,
        expires_at: { $gt: new Date() }
    });
    
    if (!otpRecord) {
        console.log(`[OTP Debug] No valid OTP found matching criteria`);
        return false;
    }
    
    console.log(`[OTP Debug] Valid OTP found, deleting to prevent reuse`);
    
    // OTP is valid, delete it to prevent reuse
    await OTPSchema.deleteOne({ _id: otpRecord._id });
    
    return true;
};

/**
 * Clear all OTPs for a user
 * @param {string} user_id - User ID
 * @param {string} purpose - Optional purpose to delete specific OTPs
 * @returns {Promise<Object>} - Delete result
 */
OTP.clearOTPs = async (user_id, purpose) => {
    const query = { user_id };
    if (purpose) {
        query.purpose = purpose;
    }
    
    return OTPSchema.deleteMany(query);
};

module.exports = OTP; 