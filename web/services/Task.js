const Models = require("../models");  

const taskModel = Models.Tasks;
const Task = {};

Task.insert = async(data) =>{
    return new taskModel(data).save();
} 

Task.getAll = async (condition, projection, options = { lean: true }) => {
    return taskModel.find(condition, projection, options);
}

Task.get = async (condition, projection, options = { lean: true }) => {
    return taskModel.findOne(condition, projection, options);
}

Task.update = async (condition, info) => { 
    return taskModel.updateOne(condition, info);
}

Task.findOneAndUpdate = async(condition, info, options) => {
    return taskModel.findOneAndUpdate(condition, info, options)
}

Task.deleteOne = async (condition) => {
    return taskModel.deleteOne(condition);
}

Task.deleteMany = async (condition) => {
    return taskModel.deleteMany(condition);
}

Task.updateTask = async (merchant, task, status) => {
    try {
        const { [task]: taskDetails } = await Task.get({ merchant }, { [task]: 1, _id: 0 });
        if(taskDetails){
            taskDetails.done = status;
            await Task.update({ merchant }, { $set:{ [task]: taskDetails } });
        }
        return Promise.resolve();
    } catch (error) {
        throwError(error);
    }
}

module.exports = Task;