const express = require("express");
const router = express.Router();
const Widget = Services.Widget;

const getWidget = async (req, res, next) => {
    try {
        const result = await Widget.getAllWidget(req.params.id , req.params.key);
        res.send(result);
    } catch (error) {
        return next(error);
    }
};

const postWidget = async (req, res, next) => {
    try {
        const result = await Widget.postAllWidget(req.merchant._id, req.body);
        res.send(result);
    } catch (error) {
        return next(error);
    }
};

router.get("/:id/:key?", getWidget);
router.post("/upsert", Auth.check, postWidget);

module.exports = router;
