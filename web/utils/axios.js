const axios = require('axios');

const axiosService = {};

axiosService.get = async (url, options) => {
    try{
        const response = await axios.get(url, options);
        return response.data;
    }catch(error){
         console.log("token error:",error.message)
        throwError(`Axios Error: ${error.message}`);
    }
}

axiosService.post = async (url, data, config) => {
    try{
        const response = axios.post(url, data, config);
        return response;
    }catch(error){
        console.log("token error:",error.message)
        throwError(`Axios Error: ${error.message}`);
    }
}


module.exports = axiosService;