const Config = require("config");
const AWS_SERVICES = Config.get("AWS_SERVICES");
const AWS_CREDENTIALS = Config.get("AWS_CREDENTIALS");

const {
    SESClient,
    SendEmailCommand,
} = require("@aws-sdk/client-ses");

const {
    S3Client,
    PutObjectCommand,
} = require("@aws-sdk/client-s3");

/* =========================
   AWS CLIENTS (v3)
========================= */

const sesClient = new SESClient({
  region: process.env.AWS_REGION,
});


const s3Client = new S3Client({
  region: process.env.AWS_REGION,
});


/* =========================
   MODULE EXPORT
========================= */

module.exports = {
    send: async (to, subject, message, attachment, cc = [], options = {}) => {
        const params = {
            Destination: {
                ToAddresses: to,
                CcAddresses: cc,
            },
            Message: {
                Body: {
                    Html: {
                        Charset: "UTF-8",
                        Data: message,
                    },
                },
                Subject: {
                    Charset: "UTF-8",
                    Data: subject,
                },
            },
            Source: AWS_SERVICES.EMAIL,
        };

        /* ========= OPTIONAL ATTACHMENT UPLOAD ========= */
        if (attachment && attachment.length) {
            const s3Params = {
                Bucket: "swipe-report",
                Key: attachment[0].filename,
                Body: attachment[0].content,
                ContentType: "application/pdf",
            };

            try {
                await s3Client.send(
                    new PutObjectCommand(s3Params)
                );
            } catch (err) {
                console.error("Error uploading attachment to S3:", err);
                return;
            }
        }

        /* ================= SEND EMAIL ================= */
        try {
            const command = new SendEmailCommand(params);
            const data = await sesClient.send(command);
            console.log("Email sent.", data);
            return data;
        } catch (err) {
            if (options.throwOnError) throw err;
            console.log("Email Not Sent.!!", err);
        }
    },
};
