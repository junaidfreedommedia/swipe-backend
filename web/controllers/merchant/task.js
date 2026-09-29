const express = require("express");
const router = express.Router();
const Task = Services.Task;

const TaskList = async (req, res, next) => {
    try {
        const taskDetails = await Task.get({ merchant: req.merchant._id });
        return res.send({
            message: taskDetails ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: taskDetails
        });
    } catch (error) {
        return next(error);
    }
}

const SetupGuide = async (req, res, next) => {
    try {
        const { key , task ,value} = req.params
       
        const updateField = {
            [`${key}.${task}`]: value
        };

        let taskDetails = await Task.findOneAndUpdate(
            { merchant: req.merchant._id },
            { $set: updateField },
            { new: true }
        );
            
        const allTasksCompleted = Object.values(taskDetails[key])
        .filter(taskValue => typeof taskValue === 'string' && taskValue === 'Completed')
        .length === Object.keys(taskDetails[key]).length - 1; 

            if (allTasksCompleted) {
                taskDetails[key].done = true;
                await taskDetails.save();
            }
            return res.send({
                message: MSG.DATA_UPDATED ,
                data: taskDetails
            });
    } catch (error) {
        return next(error);
    }
}

const SetupGuideList = async (req, res, next) => {
    try {
        
        const list = await Task.getAll({ merchant: req.merchant._id },
            {install_task:0, onboard_task:0, partner_task:0, billing_task:0, widget_task:0}); 
            return res.send({
                message: list.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
                data: list
            });
    } catch (error) {
        return next(error);
    }
}

router.get('/', Auth.check, Auth.checkPermission, TaskList);
router.get('/setup-guide/:key/:task/:value', Auth.check, SetupGuide);
router.get('/setup-list', Auth.check, SetupGuideList);

module.exports = router;