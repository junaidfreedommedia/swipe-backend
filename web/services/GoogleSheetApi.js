// One connection is shared by claim syncs and the scheduled carry-forward job.
// Pace requests below Google's per-user minute limit. A second app worker may
// still consume the same account quota, so retry explicit quota rejections too.
module.exports = (client, {
    intervalMs = 1200,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
} = {}) => {
    let queue = Promise.resolve();
    let nextStart = 0;
    const run = (operation) => {
        const current = queue.catch(() => {}).then(async () => {
            for (let attempt = 0; ; attempt += 1) {
                if (nextStart > now()) await wait(nextStart - now());
                nextStart = now() + intervalMs;
                try { return await operation(); }
                catch (error) {
                    const status = Number(error?.response?.status || error?.status || error?.code);
                    // Only 429 is known to be rejected before a mutation. Do
                    // not replay ambiguous failed addSheet/addTable requests.
                    if (status !== 429 || attempt >= 6) throw error;
                    await wait(Math.min(30000, 2000 * 2 ** attempt));
                }
            }
        });
        queue = current;
        return current;
    };
    // googleapis exposes read-only resource properties. Use new plain objects;
    // assignment through an inherited read-only resource can mutate the source
    // method and recursively enqueue itself.
    const wrapped = {
        ...client,
        spreadsheets: {
            ...client.spreadsheets,
            values: { ...client.spreadsheets.values },
        },
    };
    for (const [target, source, methods] of [
        [wrapped.spreadsheets, client.spreadsheets, ["get", "create", "batchUpdate"]],
        [wrapped.spreadsheets.values, client.spreadsheets.values, ["get", "update", "append", "batchUpdate", "clear", "batchClear"]],
    ]) {
        for (const method of methods) if (source[method]) {
            const original = source[method].bind(source);
            target[method] = (params, options = {}) => run(() => original(params, {
                timeout: 30000,
                retry: false,
                ...options,
            }));
        }
    }
    return wrapped;
};
