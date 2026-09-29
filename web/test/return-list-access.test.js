const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const plain = x => JSON.parse(JSON.stringify(x));
function setup() {
  const routes = {}, calls = [];
  const router = {};
  for (const method of ['get','put','post','delete']) router[method] = (route,...handlers) => { routes[method+' '+route] = handlers; };
  const filename = path.resolve(__dirname,'../controllers/merchant/returns.js'), local = createRequire(filename);
  const Auth = { check() {}, isSuperAdmin: u => u.super, getAssignedMerchantIds: u => u.merchants || [], assertMerchantAccess: (u,id) => {
    if (!u.super && !(u.merchants || []).includes(id)) throw Object.assign(new Error('Forbidden'),{status:403});
  }};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), {
    module:{exports:{}},
    require:n=>n==='express'?{Router:()=>router}:n==='../../shopify.js'?{}:local(n),
    Auth, USER_ROLE:{ADMIN:'admin'},
    Services:{Return:{list:async opts=>{calls.push(plain(opts));return {rows:[],total:0};}, analytics:async (...args)=>{calls.push(plain(args));return {};}}},
  },{filename});
  return {routes,calls,Auth};
}
test('fast rows and summary preserve merchant, assigned-admin and super-admin scopes', async () => {
  for (const route of ['get /','get /list-summary']) {
    for (const [req,scope] of [
      [{user:{role:'merchant'},merchant:{_id:'own'}},{merchantId:'own'}],
      [{user:{role:'admin',merchants:['own']}},{merchantIds:['own']}],
      [{user:{role:'admin',merchants:[]}},{merchantIds:[]}],
      [{user:{role:'admin',super:true}},{}],
    ]) {
      const app=setup(),handlers=app.routes[route];
      assert.equal(handlers[0],app.Auth.check);
      let error;
      handlers[1](req,{},e=>{error=e;});
      assert.equal(error,undefined);
      await handlers.at(-1)({...req,query:{view:'rows',merchantId:'untrusted',status:'declined',page:2}}, {send(){}},e=>{error=e;});
      assert.equal(error,undefined);
      assert.deepEqual(Object.fromEntries(Object.entries(app.calls[0]).filter(([key])=>key.startsWith('merchant'))),scope);
      assert.equal(app.calls[0].view,route==='get /'?'rows':'summary');
      assert.equal(app.calls[0].status,'declined');
    }
  }
});
test('both list routes reject an unassigned store and missing merchant context', () => {
  const app=setup();
  for (const route of ['get /','get /list-summary']) {
    for (const req of [{user:{role:'admin',merchants:['own']},merchant:{_id:'other'}},{user:{role:'merchant'}}]) {
      let error;
      app.routes[route][1](req,{},e=>{error=e;});
      assert.ok(error);
    }
  }
  assert.equal(app.calls.length,0);
});

test('analytics forwards the date range with authorized store scope only', async () => {
  const app=setup(),handlers=app.routes['get /analytics'];
  assert.equal(handlers[0],app.Auth.check);
  const req={user:{role:'admin',merchants:['own']},query:{startDate:'2026-09-01',endDate:'2026-09-15',merchantId:'other'}};
  let error;
  handlers[1](req,{},e=>{error=e;});
  await handlers.at(-1)(req,{send(){}},e=>{error=e;});
  assert.equal(error,undefined);
  assert.deepEqual(app.calls[0],[null,null,['own'],{startDate:'2026-09-01',endDate:'2026-09-15',allTime:false}]);
  handlers[1]({...req,merchant:{_id:'other'}},{},e=>{error=e;});
  assert.equal(error.status,403);
});
