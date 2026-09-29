const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createRequire} = require('node:module');
function setup() {
  const routes={}, calls=[];
  const router={};for(const method of ['get','post','put','delete']) router[method]=(route,...handlers)=>routes[method+' '+route]=handlers;
  const filename=path.resolve(__dirname,'../controllers/merchant/returns.js'),local=createRequire(filename);
  const record={_id:'return-a',merchant:'store-a',outcome:'store_credit',status:'received'};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
    module:{exports:{}},require:name=>name==='express'?{Router:()=>router}:name==='../../shopify.js'?{}:local(name),
    USER_ROLE:{ADMIN:'admin'},Auth:{check(req,res,next){next();},assertMerchantAccess(user,id){
      if(!user.merchants.includes(id)) throw Object.assign(new Error('Forbidden'),{status:403});
    }},Services:{Return:{get:async query=>{
      calls.push(query);return query._id===record._id && query.merchant===record.merchant ? record : null;
    }},ReturnGiftCard:{issue:async row=>{calls.push('issue');return {...row,status:'credited',gift_card_details:{status:'issued',notification_sent_at:new Date()}};}}},
  },{filename});
  const invoke=async(route,req)=>{
    let error,body,status=200;const res={status(n){status=n;return res;},send(value){body=value;}};
    for(const handler of routes['post '+route]) {
      await handler(req,res,e=>{error=e;});if(error || body)break;
    }
    return {error,body,status};
  };
  return {invoke,calls,record};
}
test('gift card endpoint requires store access and binds the return to the selected merchant',async()=>{
  for(const req of [
    {user:{role:'merchant'}},
    {user:{role:'admin',merchants:['other']},merchant:{_id:'store-a'}},
    {user:{role:'merchant'},merchant:{_id:'other'}},
  ]) {
    const app=setup(),result=await app.invoke('/:id/store-credit',{...req,params:{id:'return-a'},body:{}});
    assert.ok(result.error);assert.ok(!app.calls.includes('issue'));
  }
  const app=setup(),result=await app.invoke('/:id/store-credit',{user:{role:'merchant'},merchant:{_id:'store-a'},params:{id:'return-a'},body:{amount:999}});
  assert.equal(result.body.data.status,'credited');
  assert.equal(app.calls.filter(call=>call==='issue').length,1);
  assert.equal(app.calls[0].merchant,'store-a');
});
test('store credit cannot be processed through refund or replacement endpoints',async()=>{
  for(const route of ['/:id/refund','/:id/reorder']) {
    const app=setup(),result=await app.invoke(route,{user:{role:'merchant'},merchant:{_id:'store-a'},params:{id:'return-a'},body:{action_key:'a'}});
    assert.match(result.error.message,/Issue store credit/);assert.equal(result.error.status,409);
  }
});
test('issued store credit cannot be reset through review or received actions',async()=>{
  for(const route of ['/:id/approve','/:id/decline','/:id/received']) {
    const app=setup();app.record.status='credited';
    const result=await app.invoke(route,{user:{role:'merchant'},merchant:{_id:'store-a'},params:{id:'return-a'},body:{reason:'test'}});
    assert.equal(result.status,409);
  }
});
