const crypto = require('crypto');
const base32 = require('hi-base32');
const TOTPSecretSchema = require('../models/TOTPSecret');

const TOTP = {};

// Constants for TOTP
const DIGITS = 6;
const PERIOD = 30; // seconds
const ALGORITHM = 'sha1';

/**
 * Generate a secret key for TOTP
 * @returns {string} - Base32 encoded secret key
 */
TOTP.generateSecret = () => {
    const buffer = crypto.randomBytes(20);
    return base32.encode(buffer).replace(/=/g, '');
};

/**
 * Generate a TOTP URI for QR code generation
 * @param {string} secret - The secret key
 * @param {string} account - User account/email
 * @param {string} issuer - App name/issuer
 * @returns {string} - TOTP URI for QR code
 */
TOTP.generateTOTPUri = (secret, account, issuer = 'Swipe') => {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedAccount = encodeURIComponent(account);
    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
};

/**
 * Generate the current TOTP code for verification
 * @param {string} secret - The secret key
 * @returns {string} - Current TOTP code
 */
TOTP.generateTOTP = (secret) => {
    const counter = Math.floor(Date.now() / 1000 / PERIOD);
    return TOTP._generateHOTP(secret, counter);
};

/**
 * Verify a TOTP code
 * @param {string} userId - User ID
 * @param {string} token - TOTP code to verify
 * @returns {boolean} - True if valid, false otherwise
 */
TOTP.verify = async (userId, token) => {
    try {
        // Get the user's TOTP secret from the database
        const secretRecord = await TOTPSecretSchema.findOne({ user_id: userId });
        
        // If no secret is found, verification fails
        if (!secretRecord) {
            return false;
        }
        
        const secret = secretRecord.secret;
        
        // Current time window
        const currentCounter = Math.floor(Date.now() / 1000 / PERIOD);
        const currentTOTP = TOTP._generateHOTP(secret, currentCounter);
        
        // Previous time window (30 seconds ago)
        const previousTOTP = TOTP._generateHOTP(secret, currentCounter - 1);
        
        // Next time window (30 seconds ahead - for clock drift in the other direction)
        const nextTOTP = TOTP._generateHOTP(secret, currentCounter + 1);
        
        // Compare with all three time windows to allow for clock drift
        const isValid = token === currentTOTP || token === previousTOTP || token === nextTOTP;
        
        // If valid, update the last_used timestamp
        if (isValid) {
            await TOTPSecretSchema.updateOne(
                { _id: secretRecord._id },
                { $set: { last_used: new Date() } }
            );
        }
        
        return isValid;
    } catch (error) {
        return false;
    }
};

/**
 * Generate HOTP (HMAC-based One-Time Password)
 * @param {string} secret - The secret key
 * @param {number} counter - The counter value
 * @returns {string} - HOTP code
 * @private
 */
TOTP._generateHOTP = (secret, counter) => {
    try {
        // Handle potential undefined or invalid secret
        if (!secret) {
            return '000000'; // Return invalid code
        }
        
        // Convert counter to buffer
        const buffer = Buffer.alloc(8);
        for (let i = 0; i < 8; i++) {
            buffer[7 - i] = counter & 0xff;
            counter = counter >> 8;
        }
        
        // Properly pad the secret for base32 decoding
        // Base32 requires padding to multiple of 8
        let paddedSecret = secret;
        if (paddedSecret.length % 8 !== 0) {
            paddedSecret = paddedSecret.padEnd(paddedSecret.length + (8 - paddedSecret.length % 8), '=');
        }
        
        // Convert secret from base32 to buffer - with extra error handling
        let secretBuffer;
        try {
            secretBuffer = Buffer.from(base32.decode.asBytes(paddedSecret));
        } catch (error) {
            return '000000'; // Return invalid code
        }
        
        // Generate HMAC
        const hmac = crypto.createHmac(ALGORITHM, secretBuffer)
            .update(buffer)
            .digest();
        
        // Get offset
        const offset = hmac[hmac.length - 1] & 0xf;
        
        // Generate code
        const code = ((hmac[offset] & 0x7f) << 24 |
            (hmac[offset + 1] & 0xff) << 16 |
            (hmac[offset + 2] & 0xff) << 8 |
            (hmac[offset + 3] & 0xff)) % Math.pow(10, DIGITS);
        
        // Return code as string, padded with leading zeros if necessary
        return code.toString().padStart(DIGITS, '0');
    } catch (error) {
        return '000000'; // Return invalid code on error
    }
};

/**
 * Generate or retrieve TOTP setup info for a user
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @returns {Object} - TOTP setup info
 */
TOTP.generateSetupInfo = async (userId, email) => {
    // Check if secret already exists for this user
    let secretRecord = await TOTPSecretSchema.findOne({ user_id: userId });
    
    // If not, generate and store a new secret
    if (!secretRecord) {
        const secret = TOTP.generateSecret();
        
        secretRecord = await TOTPSecretSchema.create({
            user_id: userId,
            secret
        });
    }
    
    // Generate URI for QR code
    const uri = TOTP.generateTOTPUri(secretRecord.secret, email);
    
    // Return both the secret and URI
    return {
        secret: secretRecord.secret,
        uri
    };
};

/**
 * Reset TOTP secret for a user
 * @param {string} userId - User ID
 * @returns {boolean} - True if successful
 */
TOTP.resetSecret = async (userId) => {
    try {
        // Delete existing secret
        await TOTPSecretSchema.deleteOne({ user_id: userId });
        return true;
    } catch (error) {
        return false;
    }
};

module.exports = TOTP; 