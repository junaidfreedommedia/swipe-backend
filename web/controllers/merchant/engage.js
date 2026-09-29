const express = require("express");
const router = express.Router();
const Engage = Services.Engage;

const engageUpsert = async (req, res, next) => {
    try {
        const response = await Engage.upsertEngage(req, req.merchant._id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};
const engageList = async (req, res, next) => {
    try {
        const response = await Engage.EngageList(req.merchant._id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

router.post("/upsert", Auth.check, engageUpsert);
router.get("/list", Auth.check, engageList);

module.exports = router;
