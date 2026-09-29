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
        const result = await Widget.postAllWidget(req.params.id, req.body);
        res.send(result);
    } catch (error) {
        return next(error);
    }
};

router.get("/:id/:key?", Auth.check, getWidget);
router.post("/upsert/:id", Auth.check, postWidget);

module.exports = router;
