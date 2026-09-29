const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const range = {startDate:'2026-09-10T00:00:00.000Z',endDate:'2026-09-11T23:59:59.999Z'};
function setup() {
  const rows = [
    ['2000-09-07T23:59:59.999Z','a','refund','refunded',100],
    ['2026-09-08T00:00:00.000Z','a','refund','refunded',5],
    ['2026-09-09T23:59:59.999Z','a','exchange','requested',10],
    ['2026-09-10T00:00:00.000Z','a','exchange','needs_review',20],
    ['2026-09-11T23:59:59.999Z','a','refund','refunded',30],
    ['2026-09-12T00:00:00.000Z','a','exchange','exchanged',200],
    ['2026-09-10T12:00:00.000Z','b','exchange','exchanged',40],
  ].map(([date,merchant,outcome,status,amount])=>({createdAt:new Date(date),merchant,outcome,status,revenue_kept:{amount},items:[{title:'Shirt',quantity:2,reason_label:'Too small'}]}));
  let captured;
  const filename=path.resolve(__dirname,'../services/Return.js');
  const context={module:{exports:{}},require:createRequire(filename),Models:{Return:{find(condition,projection){
    captured={condition,projection};
    return {lean:async()=>rows.filter(row=>(!condition.createdAt || (row.createdAt>=condition.createdAt.$gte && row.createdAt<condition.createdAt.$lt)) &&
      (!condition.merchant || (typeof condition.merchant==='string' ? row.merchant===condition.merchant : condition.merchant.$in.includes(row.merchant))))};
  }}}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  return {analytics:context.module.exports.analytics,captured:()=>captured};
}
test('analytics uses inclusive selected dates and the immediately previous equal period for all metrics',async()=>{
  const app=setup(),data=await app.analytics('a',30,undefined,range);
  assert.equal(data.period_days,2);
  assert.equal(data.current.returns,2);
  assert.equal(data.current.needs_review,1);
  assert.equal(data.current.exchange_rate,50);
  assert.equal(data.current.revenue_kept,50);
  assert.equal(data.current.reasons['Too small'],4);
  assert.deepEqual(JSON.parse(JSON.stringify(data.current.top_products)),[['Shirt',4]]);
  assert.equal(data.previous.returns,2);
  assert.equal(data.previous.revenue_kept,15);
  assert.equal(data.previous.exchange_rate,50);
  assert.equal(app.captured().condition.merchant,'a');
  assert.equal(app.captured().projection['items.title'],1);
});
test('date-filtered analytics retains assigned-store restrictions and empty scope',async()=>{
  assert.equal((await setup().analytics(undefined,30,['b'],range)).current.returns,1);
  assert.equal((await setup().analytics(undefined,30,[],range)).current.returns,0);
  assert.equal((await setup().analytics(undefined,30,undefined,range)).current.returns,3);
});
test('invalid, incomplete and reversed ranges fail before querying',async()=>{
  for(const value of [{startDate:range.startDate},{endDate:range.endDate},{startDate:'bad',endDate:range.endDate},{startDate:range.endDate,endDate:range.startDate}]) {
    const app=setup();
    await assert.rejects(app.analytics('a',30,undefined,value),error=>error.status===400);
    assert.equal(app.captured(),undefined);
  }
});
test('clearing the range retains the default last-30-days calculation',async()=>{
  const app=setup(),data=await app.analytics('a');
  assert.equal(data.period_days,30);
  const dates=app.captured().condition.createdAt;
  assert.equal(dates.$lt-dates.$gte,60*86400000);
});

test('all-time analytics includes old returns and preserves merchant restrictions',async()=>{
  const app=setup(),data=await app.analytics('a',30,undefined,{allTime:true});
  assert.equal(app.captured().condition.createdAt,undefined);
  assert.equal(data.current.returns,6);
  assert.equal(data.current.revenue_kept,365);
  assert.equal(data.current.exchange_rate,50);
  assert.equal(data.current.needs_review,2);
  assert.equal(data.current.top_products[0][1],12);
  assert.equal(data.period_days,null);
  assert.equal(data.previous,null);
  assert.equal((await setup().analytics(undefined,30,['b'],{allTime:true})).current.returns,1);
  assert.equal((await setup().analytics(undefined,30,[],{allTime:true})).current.returns,0);
});
