const Models = require("../models");
const eventModels = Models.Event;
const Event = {};
const heicConvert = require("heic-convert");

Event.insert = async (data) => {
    return new eventModels(data).save();
};

Event.get = async (condition, projection, options) => {
    return eventModels.findOne(condition, projection, options);
};

Event.getAll = async (condition, projection, options = { lean: true }) => {
    return eventModels.find(condition, projection, options);
};

Event.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse) return eventModels.aggregate(pipeline).allowDiskUse(true);
    return eventModels.aggregate(pipeline);
};

Event.findByIdAndUpdate = async (user_id, info) => {
    return eventModels.findByIdAndUpdate(user_id, info, { new: true });
};

Event.updateOne = async (condition, info) => {
    return eventModels.updateOne(condition, info);
};

Event.findByIdAndDelete = async (user_id, info) => {
    return eventModels.findByIdAndDelete(user_id);
};

Event.deleteMany = async (condition) => {
    return eventModels.deleteMany(condition);
};

Event.count = async (condition) => {
    return eventModels.countDocuments(condition);
};

Event.insertComment = async (req) => {
    const { claim, content, merchant, order, type } = req.body;
    let uploadedFiles = [];
    if (req.files && req.files.attachments) {
        const attachments = req.files.attachments;
        const files = Array.isArray(attachments) ? attachments : [attachments]; // normalize

        for (const file of files) {
            if (file.size > 20971520) {
                throw new Error(
                    `${file.name} exceeds the maximum allowed size of 20 MB.`
                );
            }
            const originalName = file.name;
            const extension = originalName.split(".").pop();
            const baseName = originalName.replace(`.${extension}`, "");
            let file_name = `${baseName}_${createRandomString(
                10
            )}.${extension}`;
            let environment = `notes/${process.env.S3_ENVIRONMENT}`;
            let data;
            if (["heic", "heif"].includes(extension)) {
                try {
                    const outputBuffer = await heicConvert({
                        buffer: file.data, // HEIC file buffer
                        format: "JPEG", // Output format
                        quality: 1, // Quality: 0–1
                    });

                    file_name = `${baseName}_${createRandomString(10)}.jpg`;
                    const bufferToUpload = outputBuffer;
                    data = await S3.uploadExport(
                        file_name,
                        bufferToUpload,
                        environment
                    );
                    console.log("data", data);
                } catch (err) {
                    console.error("HEIC conversion failed:", err);
                    throw new Error("Failed to convert HEIC image.");
                }
            } else {
                data = await S3.uploadExport(file_name, file.data, environment);
            }

            if (data) {
                uploadedFiles.push(data.Location);
                console.log("uploadedFiles", uploadedFiles);
            }
        }
    }
    const newComment = await Services.Event.insert({
        claim,
        order,
        content,
        attachments: uploadedFiles,
        merchant,
        created_by: req.user._id,
        type: type,
        title: EVENT_TITLE.COMMENT_ADDED,
        who: req.user.display_name,
        action_on: ACTIVITY_LOG_LABEL.CLAIM,
        ts: Math.floor(new Date().getTime() / 1000),
    });
    return {
        message: MSG.COMMENT_ADDED,
        data: newComment,
    };
};

Event.getAllComment = async (req, typeFilter) => {
    try {
        const comments = await Services.Event.aggregate([
            {
                $match: {
                    claim: ObjectId(req.params.claim),
                    type: { $in: typeFilter },
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "created_by",
                    foreignField: "_id",
                    as: "created_by",
                },
            },
            {
                $unwind: {
                    path: "$created_by",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    _id: 1,
                    merchant: 1,
                    ts: 1,
                    type: 1,
                    attachments: 1,
                    content: 1,
                    claim: 1,
                    created_by: "$created_by.display_name",
                    createdAt: 1,
                },
            },
            { $sort: { createdAt: -1 } },
        ]);

        comments.forEach((comment) => {
            comment.image_attachments = [];
            comment.pdf_attachments = [];

            if (Array.isArray(comment.attachments)) {
                comment.attachments.forEach((file) => {
                    const fileName = file.split("/").pop().split("?")[0];
                    const extension = file
                        .split(".")
                        .pop()
                        .split("?")[0]
                        .toLowerCase();

                    if (
                        [
                            "jpg",
                            "jpeg",
                            "png",
                            "gif",
                            "webp",
                            "bmp",
                            "tif",
                            "tiff",
                            "heic",
                            "heif",
                            "svg",
                            "eps",
                            "ai",
                            "ico",
                            "psd",
                            "xcf",
                            "raw",
                            "cr2",
                            "nef",
                            "arw",
                        ].includes(extension)
                    ) {
                        comment.image_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    } else if (
                        [
                            "txt",
                            "md",
                            "rtf",
                            "doc",
                            "docx",
                            "xls",
                            "xlsx",
                            "ppt",
                            "pptx",
                            "pdf",
                            "epub",
                            "mobi",
                            "odt",
                            "ods",
                            "odp",
                        ]
                    ) {
                        comment.pdf_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    }
                });
            }
        });
        const comment = comments.filter((c) => c.type === EVENT_TYPE.COMMENT);
        const internalComments = comments.filter(
            (c) => c.type === EVENT_TYPE.INTERNAL_COMMENT
        );
        return {
            message: MSG.DATA_FOUND,
            data: {
                comment: comment,
                internal_comments: internalComments,
            },
        };
    } catch (error) {
        return error;
    }
};

Event.insertOrderComment = async (req) => {
    const { order, content, merchant, type } = req.body;
    let uploadedFiles = [];
    if (req.files && req.files.attachments) {
        const attachments = req.files.attachments;

        const files = Array.isArray(attachments) ? attachments : [attachments]; // normalize

        console.log("files", files);

        for (const file of files) {
            console.log("file.size", file.size);
            if (file.size > 20971520) {
                throw new Error(
                    `${file.name} exceeds the maximum allowed size of 20 MB.`
                );
            }
            const originalName = file.name;
            const extension = originalName.split(".").pop();
            const baseName = originalName.replace(`.${extension}`, "");
            let file_name = `${baseName}_${createRandomString(
                10
            )}.${extension}`;
            let environment = `notes/${process.env.S3_ENVIRONMENT}`;
            let data;
            if (["heic", "heif"].includes(extension)) {
                try {
                    const outputBuffer = await heicConvert({
                        buffer: file.data, // HEIC file buffer
                        format: "JPEG", // Output format
                        quality: 1, // Quality: 0–1
                    });

                    file_name = `${baseName}_${createRandomString(10)}.jpg`;
                    const bufferToUpload = outputBuffer;
                    data = await S3.uploadExport(
                        file_name,
                        bufferToUpload,
                        environment
                    );
                    console.log("data", data);
                } catch (err) {
                    console.error("HEIC conversion failed:", err);
                    throw new Error("Failed to convert HEIC image.");
                }
            } else {
                data = await S3.uploadExport(file_name, file.data, environment);
            }

            if (data) {
                await uploadedFiles.push(data.Location);
                console.log("uploadedFiles", uploadedFiles);
            }
        }
    }
    const newComment = await Services.Event.insert({
        order,
        content,
        merchant,
        attachments: uploadedFiles,
        created_by: req.user._id,
        type: type,
        title: EVENT_TITLE.ORDER_COMMENT_ADDED,
        who: req.user.display_name,
        action_on: ACTIVITY_LOG_LABEL.ORDER,
        ts: Math.floor(new Date().getTime() / 1000),
    });
    return {
        message: MSG.COMMENT_ADDED,
        data: newComment,
    };
};

Event.getAllOrderComment = async (req, typeFilter) => {
    try {
        const comments = await Services.Event.aggregate([
            {
                $match: {
                    order: ObjectId(req.params.order),
                    type: { $in: typeFilter },
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "created_by",
                    foreignField: "_id",
                    as: "created_by",
                },
            },
            {
                $unwind: {
                    path: "$created_by",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    _id: 1,
                    merchant: 1,
                    ts: 1,
                    type: 1,
                    content: 1,
                    attachments: 1,
                    order: 1,
                    created_by: "$created_by.display_name",
                    createdAt: 1,
                },
            },
            { $sort: { createdAt: -1 } },
        ]);
        comments.forEach((comment) => {
            comment.image_attachments = [];
            comment.pdf_attachments = [];

            if (Array.isArray(comment.attachments)) {
                comment.attachments.forEach((file) => {
                    const fileName = file.split("/").pop().split("?")[0];
                    const extension = file
                        .split(".")
                        .pop()
                        .split("?")[0]
                        .toLowerCase();

                    if (
                        [
                            "jpg",
                            "jpeg",
                            "png",
                            "gif",
                            "webp",
                            "bmp",
                            "tif",
                            "tiff",
                            "heic",
                            "heif",
                            "svg",
                            "eps",
                            "ai",
                            "ico",
                            "psd",
                            "xcf",
                            "raw",
                            "cr2",
                            "nef",
                            "arw",
                        ].includes(extension)
                    ) {
                        comment.image_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    } else if (
                        [
                            "txt",
                            "md",
                            "rtf",
                            "doc",
                            "docx",
                            "xls",
                            "xlsx",
                            "ppt",
                            "pptx",
                            "pdf",
                            "epub",
                            "mobi",
                            "odt",
                            "ods",
                            "odp",
                        ]
                    ) {
                        comment.pdf_attachments.push({
                            url: file,
                            fileName: fileName,
                        });
                    }
                });
            }
        });
        const comment = comments.filter((c) => c.type === EVENT_TYPE.COMMENT);
        const internalComments = comments.filter(
            (c) => c.type === EVENT_TYPE.INTERNAL_COMMENT
        );
        return {
            message: MSG.DATA_FOUND,
            // data: comments,
            data: {
                comments: comment,
                internal_comments: internalComments,
            },
        };
    } catch (error) {
        return error;
    }
};

module.exports = Event;
