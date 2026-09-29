const Routes = function (app) {
  const controllersPath = Fs.readdirSync(Path.join(__dirname, "controllers"));

  for (let portal of controllersPath) {
    const controllers = Fs.readdirSync(Path.join(__dirname, "controllers", portal));

    for (let controller of controllers) {
      if (controller === "webhooks.js") continue;

      let routerPath = Path.join(__dirname, "controllers", portal, controller);

      let contName = controller.replace(/\.[^/.]+$/, "");
      if (!!contName && Fs.existsSync(routerPath)) {
        const file = require(routerPath);
        app.use(`/${portal}/${contName}`, file);
      }
    }
  }
};

module.exports = Routes;
