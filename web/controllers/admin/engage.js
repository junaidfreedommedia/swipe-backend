const express = require("express");
const router = express.Router();
const Engage = Services.Engage;

const engageUpsert = async (req, res, next) => {
    try {
        const response = await Engage.upsertEngage(req,req.params.id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const engageList = async (req, res, next) => {
    try {
        const response = await Engage.EngageList(req.params.id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

router.post("/upsert/:id", Auth.check, engageUpsert);
router.get("/list/:id", Auth.check, engageList);

module.exports = router;
