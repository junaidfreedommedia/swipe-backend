const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const copy = value => structuredClone(value);

function setup(options = {}) {
  const db = { _id: "return-a", merchant: "merchant-a", shop: "test.myshopify.com", shopify_order_id: "123",
    outcome: "store_credit", status: "received", store_credit_total: {amount:55,currency:"USD"},
    items: [{line_item_id:"1",quantity:1,resolution:"pending"}], timeline: [], ...options.record };
  const cards = [], calls = [];
  let timeout = options.timeout, saveFailure = options.saveFailure, notifyFailure = options.notifyFailure;
  const get = (obj, key) => key.split('.').reduce((value, part) => value?.[part], obj);
  const matches = condition => Object.entries(condition).every(([key,value]) => {
    if (key === '$or') return value.some(matches);
    if (key === 'items') return !db.items.some(item => item.resolution && !['pending','store_credit'].includes(item.resolution));
    const actual = get(db,key);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op,expected]) => op === '$exists' ? (actual !== undefined) === expected
        : op === '$in' ? expected.includes(actual) : op === '$ne' ? actual !== expected
        : op === '$lte' ? actual <= expected : false);
    }
    return actual === value;
  });
  const set = (key,value,remove=false) => {
    if(key.startsWith('items.$[].')) { db.items.forEach(item => item[key.slice(10)] = value); return; }
    const parts=key.split('.'),last=parts.pop();let obj=db;
    parts.forEach(part => {obj[part] ||= {};obj=obj[part];});
    if(remove) delete obj[last]; else obj[last]=value;
  };
  const update = (condition,change) => {
    if(!matches(condition)) return {matchedCount:0};
    if(change.$push?.timeline && saveFailure) { saveFailure=false;throw new Error('Database interrupted'); }
    Object.entries(change.$set || {}).forEach(([key,value])=>set(key,value));
    Object.keys(change.$unset || {}).forEach(key=>set(key,null,true));
    Object.entries(change.$push || {}).forEach(([key,value])=>db[key].push(value));
    return {matchedCount:1};
  };
  const publicRecord=()=>{const row=copy(db);delete row.gift_card_code;return row;};
  const model={
    updateOne:async(condition,change)=>update(condition,change),
    findOneAndUpdate:(condition,change)=>({select:selection=>{
      assert.equal(selection,'+gift_card_code');
      return {lean:async()=> update(condition,change).matchedCount ? copy(db) : null};
    }}),
  };
  const client={request:async(query,{variables})=>{
    calls.push({query,variables:copy(variables)});
    if(query.includes('ReturnGiftCardAccess')) return {data:{currentAppInstallation:{accessScopes:
      (options.scopes || ['write_gift_cards','write_customers']).map(handle=>({handle}))},
      order:{customer:options.noCustomer ? null : {id:'gid://shopify/Customer/7',email:'guest@example.com'}}}};
    if(query.includes('ReturnGiftCardLookup')) return {data:{giftCards:{nodes:cards.filter(card=>card.code===variables.query)}}};
    if(query.includes('ReturnGiftCardCreate')) {
      if(options.pauseCreate) await options.pauseCreate;
      assert.ok(!cards.some(card=>card.code===variables.input.code),'duplicate gift card code');
      const input=variables.input;
      const card={id:'gid://shopify/GiftCard/1',code:input.code,note:input.note,lastCharacters:input.code.slice(-4),
        initialValue:input.initialAmount,customer:{id:input.customerId}};
      cards.push(card);
      if(timeout){timeout=false;throw new Error('Response lost');}
      return {data:{giftCardCreate:{giftCard:card,userErrors:[]}}};
    }
    if(query.includes('ReturnGiftCardNotify')) {
      if(notifyFailure){notifyFailure=false;throw new Error('Notification failed');}
      return {data:{giftCardSendNotificationToCustomer:{giftCard:{id:variables.id},userErrors:[]}}};
    }
    throw new Error('Unexpected query');
  }};
  const filename=path.resolve(__dirname,'../services/ReturnGiftCard.js'),localRequire=createRequire(filename);
  const context={module:{exports:{}},Models:{Return:model},Services:{ShopifySession:{get:async()=>({shop:db.shop})},Return:{get:async scope=>{
    assert.equal(scope.merchant,db.merchant);return publicRecord();
  }}},require:name=>name==='../shopify' ? {api:{clients:{Graphql:class {constructor(options){assert.equal(options.apiVersion,'2026-07');return client;}}}}} : localRequire(name)};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  return {issue:()=>context.module.exports.issue(publicRecord()),db,cards,calls,publicRecord};
}

test('guest customer receives the quoted gift card and email; repeated clicks do not issue again',async()=>{
  const app=setup(),row=await app.issue();
  assert.equal(app.cards.length,1);assert.equal(app.cards[0].initialValue.amount,'55.00');
  assert.equal(app.cards[0].customer.id,'gid://shopify/Customer/7');
  assert.equal(row.status,'credited');assert.equal(row.items[0].resolution,'store_credit');
  assert.equal(row.gift_card_details.email,'guest@example.com');
  assert.ok(row.gift_card_details.notification_sent_at);assert.equal(row.gift_card_code,undefined);
  assert.equal(row.timeline.length,1);
  await app.issue();assert.equal(app.cards.length,1);
  assert.equal(app.calls.filter(call=>call.query.includes('ReturnGiftCardNotify')).length,1);
});

test('lost Shopify response is recovered without issuing another gift card',async()=>{
  const app=setup({timeout:true});await assert.rejects(app.issue(),/could not be confirmed/);
  const code=app.db.gift_card_code;assert.equal(app.cards.length,1);assert.equal(app.db.status,'received');
  const row=await app.issue();assert.equal(app.cards.length,1);assert.equal(app.db.gift_card_code,code);
  assert.equal(row.status,'credited');assert.equal(row.timeline.length,1);
});

test('database save failure after Shopify issuance is recovered using the same card',async()=>{
  const app=setup({saveFailure:true});await assert.rejects(app.issue());
  await app.issue();assert.equal(app.cards.length,1);assert.equal(app.db.timeline.length,1);
});

test('email failure retains issued credit and retry only sends the existing gift card',async()=>{
  const app=setup({notifyFailure:true}),row=await app.issue();
  assert.equal(row.status,'credited');assert.ok(row.gift_card_details.notification_error);
  assert.equal(row.gift_card_details.notification_sent_at,undefined);
  await app.issue();assert.equal(app.cards.length,1);
  assert.ok(app.db.gift_card_details.notification_sent_at);
  assert.equal(app.db.gift_card_details.notification_error,undefined);
});

test('concurrent requests cannot issue duplicate gift cards',async()=>{
  let release;const pauseCreate=new Promise(resolve=>release=resolve),app=setup({pauseCreate});
  const first=app.issue();
  while(!app.calls.some(call=>call.query.includes('ReturnGiftCardCreate'))) await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(app.issue(),/already processing/);release();await first;
  assert.equal(app.cards.length,1);
});

test('invalid states, mixed processing, missing permissions and missing customer fail before creation',async()=>{
  for(const options of [
    {record:{outcome:'refund'}},{record:{status:'approved'}},{record:{status:'declined'}},
    {record:{items:[{resolution:'refund'}]}},{record:{items:[{resolution:'reorder'}]}},
    {record:{store_credit_total:{amount:0,currency:'USD'}}},
    {record:{store_credit_total:{amount:0.001,currency:'USD'}}},{record:{shopify_order_id:null}},
    {scopes:['write_customers']},{noCustomer:true},
  ]) {
    const app=setup(options);await assert.rejects(app.issue());assert.equal(app.cards.length,0);
  }
});
