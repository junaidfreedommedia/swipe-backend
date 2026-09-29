const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appDirectory = path.resolve(__dirname, "..");
const env = { ...process.env };

// Nodemon invokes taskkill by name on Windows. Some terminals omit System32
// from PATH, leaving the old worker running despite "restarting" messages.
if (process.platform === "win32") {
    const windowsDirectory = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const toolsDirectory = path.join(windowsDirectory, "System32");
    if (!fs.existsSync(path.join(toolsDirectory, "taskkill.exe"))) {
        throw new Error("Windows taskkill.exe is unavailable; cannot safely restart the backend.");
    }
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    env[pathKey] = `${toolsDirectory}${path.delimiter}${env[pathKey] || ""}`;
}

env.NODE_ENV = process.argv[2] || env.NODE_ENV || "develop";
const result = spawnSync(process.execPath, [require.resolve("nodemon/bin/nodemon.js"), "index.js"], {
    cwd: appDirectory,
    env,
    stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
