const taskModel = Models.Tasks;
const Dashboard = {};

Dashboard.insert = async(data) =>{
    return new taskModel(data).save();
} 

Dashboard.getAll = async (condition, projection, options = { lean: true }) => {
    return taskModel.find(condition, projection, options);
}

Dashboard.get = async (condition, projection, options = { lean: true }) => {
    return taskModel.findOne(condition, projection, options);
}

Dashboard.update = async (condition, info) => { 
    return taskModel.updateOne(condition, info);
}

Dashboard.findOneAndUpdate = async(condition, info, options) => {
    return taskModel.findOneAndUpdate(condition, info, options)
}

Dashboard.updateTask = async (merchant, task, status) => {
    try {
        const { [task]: taskDetails } = await Dashboard.get({ merchant }, { [task]: 1, _id: 0 });
        if(taskDetails){
            taskDetails.done = status;
            await Dashboard.update({ merchant }, { $set:{ [task]: taskDetails } });
        }
        return Promise.resolve();
    } catch (error) {
        throwError(error);
    }
}

Dashboard.deleteOne = async (condition) => {
    return taskModel.deleteOne(condition);
}

module.exports = Dashboard;