const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const crypto = require('crypto');
const root = process.cwd();
const output = path.join(root, 'artifacts/agent/shipping-acceptance-20261014');
fs.mkdirSync(output,{recursive:true});
require.extensions['.ts'] = (mod, filename) => {
  const content = fs.readFileSync(filename,'utf-8');
  const js = ts.transpileModule(content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  mod._compile(js,filename);
};
const observations=[];
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
function record(name, expected, observed) { observations.push({name,expected,observed,meetsContract:JSON.stringify(expected)===JSON.stringify(observed)}); }
const api=require(path.join(root,'features/shipping/api.ts'));
const runner=require(path.join(root,'features/shipping/runner.ts'));
const taskModule=require(path.join(root,'features/shipping/task.ts'));
const types=require(path.join(root,'features/shipping/types.ts'));
const rules=require(path.join(root,'features/shipping/rules.ts'));
const scheduler=require(path.join(root,'features/shipping/scheduler.ts'));
const target={itemId:'101',name:'fixture-product',status:1,categoryPath:'1/2'};
const product={id:101,name:'fixture-product',status:1,category_path:'1/2',days_to_ship:1,enable_model_level_dts:false};
const credential={spcCds:'review-fixture-only',spcCdsVer:'2'};
const settings={mode:'preorder',days:7,range:'all',excludeIds:'',toggleLogistics:false};
function makeHarness(overrides={}, taskOverrides={}) {
  const initial=taskModule.createShippingTask({taskId:'review-task',requestId:'review-request',shopId:77,ownerUserId:1,source:'manual',mode:'preorder',days:7,range:'all',excludeIds:[],total:1,toggleLogistics:false,now:Date.now(),...taskOverrides});
  const state={task:clone(initial),writes:[],toggles:[],reads:0};
  const deps={
    getCredential:async()=>credential,getShopIdentity:async()=>({shopId:77,accountId:700}),getAuthUserId:async()=>1,
    fetchAllProducts:async()=>({complete:true,products:[{...product}]}),
    fetchProductDetail:async()=>({enable_model_level_dts:false,pre_order_info:{days_to_ship:7}}),
    fetchFlashSaleExcludeIds:async()=>({ok:true,itemIds:new Set()}),
    fetchChannelList:async()=>[{channelId:9,enabled:true}],
    updateChannelToggle:async(_c,id,enabled)=>{state.toggles.push({id,enabled});return {success:true};},
    updateProductBatch:async(_c,payload)=>{state.writes.push(clone(payload));return {topLevelSuccess:true,itemResults:payload.map(i=>({id:String(i.id),code:0}))};},
    loadTask:async()=>clone(state.task),saveTask:async t=>{state.task=clone(t);},now:()=>Date.now(),sleep:async()=>{},
    startKeepalive:()=>{},stopKeepalive:()=>{},isStopRequested:()=>false,log:()=>{},...overrides,
  };
  return {initial,state,deps};
}
async function until(fn,label) {
  for(let i=0;i<500;i++){if(fn())return; await new Promise(resolve=>setTimeout(resolve,2));}
  throw new Error('fixture did not settle: '+label);
}

(async()=>{
  const sourceHashes={};
  for(const rel of ['api.ts','runner.ts','background.ts','scheduler.ts','rules.ts','store.ts','task.ts','types.ts']) {
    sourceHashes[rel]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'features/shipping',rel))).digest('hex');
  }
  {
    const parsed=api.parseBatchWriteResponse({code:0,data:{result:[{id:101}]}});
    record('missing per-item result code is not confirmed as success',false,parsed.itemResults[0]?.code===0);
  }
  {
    const found=await api.fetchFlashSaleExcludeIds(async url=>{
      if(url.includes('get_shop_flash_sale_list'))return {code:0,data:{flash_sale_list:[{flash_sale_id:1,start_time:1,end_time:9999999999},{flash_sale_id:2,start_time:1,end_time:9999999999}]}};
      if(new URL(url).searchParams.get('flash_sale_id')==='1')return {code:0,data:{item_ids:[201]}};
      throw new Error('second activity unavailable');
    },credential,200);
    record('partial flash-sale exclusion must fail closed',false,found.ok);
  }
  {
    let listRequests=0;
    await api.fetchFlashSaleExcludeIds(async url=>{
      if(url.includes('get_shop_flash_sale_list')) {listRequests++;return {code:0,data:{flash_sale_list:Array.from({length:50},(_,i)=>({flash_sale_id:i+1,start_time:1,end_time:9999999999})),total:51,has_more:true}};}
      return {code:0,data:{item_ids:[201]}};
    },credential,200);
    record('flash-sale list continuation is read',true,listRequests>1);
  }
  {
    const h=makeHarness({fetchFlashSaleExcludeIds:async()=>({ok:false,itemIds:new Set(),error:'unavailable'})});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('execution preflight failure sends zero product writes',0,h.state.writes.length);
  }
  {
    let count=0;
    const h=makeHarness({updateProductBatch:async()=>{count++;throw new Error('response lost after send');}});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('unknown transport result is not blindly resent',1,count);
  }
  {
    const h=makeHarness({getAuthUserId:async()=>2});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('changed backend account sends zero product writes',0,h.state.writes.length);
  }
  {
    let channelReads=0;
    const h=makeHarness({
      fetchChannelList:async()=>++channelReads===1?[{channelId:9,enabled:true}]:null,
      updateChannelToggle:async()=>({success:false,unknown:true,error:'close result unavailable'}),
    },{toggleLogistics:true});
    const out=await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('unknown channel closure retains a restore obligation',true,out.summary.needsLogisticsRestore);
    const restored=await runner.restorePendingLogistics(out.task,h.deps);
    record('unknown channel closure cannot be declared fully restored',false,restored.completed);
  }
  {
    const h=makeHarness({fetchAllProducts:async()=>({complete:true,products:[{...product,enable_model_level_dts:true}]})});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('fresh SKU-level change is excluded before writes',0,h.state.writes.length);
  }
  {
    let detailReads=0;
    const h=makeHarness({fetchAllProducts:async()=>({complete:true,products:[{id:101,status:1,name:'sku-mode-unknown'}]}),fetchProductDetail:async()=>{detailReads++;return {enable_model_level_dts:true};}});
    const result=await runner.previewShippingTargets(h.deps,settings);
    record('missing SKU-mode information is resolved before preview',true,detailReads>0);
    record('SKU-level detail is excluded from preview',0,result.items.length);
  }
  {
    const h=makeHarness();
    const preview=await runner.previewShippingTargets(h.deps,{...settings,range:'nonhot'});
    record('non-hot range without ranking data is blocked',false,preview.ok);
  }
  {
    const h=makeHarness({fetchAllProducts:async()=>{throw new Error('request failed SPC_CDS=review-synthetic-secret');}});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('persisted diagnostic removes credential values',false,JSON.stringify(h.state.task).includes('review-synthetic-secret'));
  }
  {
    const future={...clone(types.SHIPPING_DEFAULT_PLANS[0]),enabled:true,date:'2099-01-01',time:'00:01',loopDaily:true};
    const now=Date.parse('2026-10-14T12:00:00+08:00');
    observations.push({name:'additional daily start-date observation',observed:rules.resolvePlanDue(future,now)?.taipeiDate ?? null,note:'not used as a blocker; daily UI disables date and this is outside the frozen matrix'});
  }
  {
    const store={};
    global.browser={storage:{local:{get:async keys=>{
      if(typeof keys==='string')return {[keys]:clone(store[keys])};
      const result={};for(const key of keys || [])result[key]=clone(store[key]);return result;
    },set:async values=>{for(const [key,value]of Object.entries(values))store[key]=clone(value);},remove:async key=>{delete store[key];}}}};
    global.chrome={alarms:{create:async()=>{},clear:async()=>true}};
    const bg=require(path.join(root,'features/shipping/background.ts'));
    const now=Date.now();
    const yesterday=rules.taipeiDateString(now-86400000);
    const today=rules.taipeiDateString(now);
    store[types.SHIPPING_PLANS_KEY]=[{...clone(types.SHIPPING_DEFAULT_PLANS[0]),enabled:true,date:today,time:'00:00',days:7,lastRunId:null}];
    let activeShop=88, writes=0;
    const fixture={
      getCredential:async()=>credential,getShopIdentity:async()=>({shopId:activeShop,accountId:880}),getAuthUserId:async()=>2,
      validateAccess:async()=>({allowed:true}),findOtherWriteConflict:async()=>null,log:()=>{},
      injectedFetch:async(url,method,body)=>{
        if(url.includes('search_product_list_v2'))return {code:0,data:{list:[{...product,days_to_ship:7}],page_info:{cursor:'',total:1}}};
        if(url.includes('get_shop_flash_sale_list'))return {code:0,data:{flash_sale_list:[]}};
        if(url.includes('update_product/')){writes++;return {code:0,data:{result:body.map(item=>({id:item.id,code:0}))}};}
        if(url.includes('get_product_info'))return {code:0,data:{product_info:{enable_model_level_dts:false,pre_order_info:{days_to_ship:7}}}};
        throw new Error('unrecognized isolated route');
      },
    };
    // Same saved plan executes using whichever shop/account is present at trigger time.
    await bg.checkShippingPlans(fixture);
    await until(()=>store[types.SHIPPING_TASK_KEY]?.status!=='running' && !bg.isShippingInFlight(),'plan task');
    const job=store[types.SHIPPING_TASK_KEY];
    record('plan persists an owner shop before execution',true,'shopId' in store[types.SHIPPING_PLANS_KEY][0] || 'ownerShopId' in store[types.SHIPPING_PLANS_KEY][0]);
    record('plan result reaches actual completed state','completed',store[types.SHIPPING_PLANS_KEY][0].lastResult);
    observations.push({name:'plan runtime identity observation',observed:{taskShopId:job?.shopId,taskOwnerUserId:job?.ownerUserId,productWriteCount:writes},note:'plan has no saved owner; task binds to current trigger identity'});
    if(store[types.SHIPPING_PLANS_KEY][0].date===yesterday)throw new Error('unexpected fixture date');
  }
  const result={scope:'independent isolated execution of actual modules; no browser/server/store API/network requests',sourceHashes,observations,contractFailures:observations.filter(r=>r.meetsContract===false).length};
  fs.writeFileSync(path.join(output,'module-observations.json'),JSON.stringify(result,null,2),'utf-8');
  for(const result of observations)console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
