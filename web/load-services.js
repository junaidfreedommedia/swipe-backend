let services = {};

const Files = Fs.readdirSync(__dirname+'/services');
for(let file of Files){    
    let servicePath = Path.join(__dirname + '/services/' + file);
    let serviceName = file.replace(/\.[^/.]+$/, "");
    if (!!serviceName && Fs.existsSync(servicePath)) {
        let serv = require(servicePath);
        services = {
            ...services,
            ...{ [serviceName]: serv }
        };
    }
}
module.exports = services;
