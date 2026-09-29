const express = require("express");
const router = express.Router();
const Statistic = Services.Statistic;

const AdminDashboard = async (req, res, next) => {
    try{
        const response = await Statistic.adminDashboard(req.body);
        return res.send(response);
    } catch (error) {
        return next(error);
    }
}

router.post('/list', Auth.check, AdminDashboard);

module.exports = router;