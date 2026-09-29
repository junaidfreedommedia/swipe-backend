const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const AWS_CREDENTIALS = Config.get("AWS_CREDENTIALS");
const mime = require("mime-types");

const s3 = new S3Client({
  region: AWS_CREDENTIALS.AWS_REGION,
});


module.exports = {
    uploadExport: async (fileName, content, environment = "dev") => {
        const today = new Date();
        const dateFolder = today.toISOString().split("T")[0];

        const contentType = mime.lookup(fileName) || "application/octet-stream";
        const key = `${environment}/exports/${dateFolder}/${fileName}`;

        try {
            await s3.send(
                new PutObjectCommand({
                    Bucket: "swipe-images-storage",
                    Key: key,
                    Body: content,
                    ContentType: contentType,
                    ContentDisposition: `attachment; filename="${fileName}"`,
                })
            );

            const location = `https://swipe-images-storage.s3.${AWS_CREDENTIALS.AWS_REGION}.amazonaws.com/${key}`;
            console.log(`Export file uploaded successfully to S3: ${location}`);

            return {
                Location: location,
                Key: key,
            };
        } catch (err) {
            console.error("Error uploading export file to S3:", err);
            throw err;
        }
    },
};
