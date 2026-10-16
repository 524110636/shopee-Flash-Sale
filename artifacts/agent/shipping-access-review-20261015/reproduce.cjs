const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const crypto = require('crypto');
const root = process.cwd();
const output = path.join(root, 'artifacts/agent/shipping-access-review-20261015');
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
    getCredential:async()=>credential,getShopIdentity:async()=>({shopId:77,accountId:700}),getAuthUserId:async()=>1,validateAccess:async()=>({allowed:true}),verifiedContext:async()=>({credential:await deps.getCredential(),...(await deps.getShopIdentity()),userId:await deps.getAuthUserId()}),
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
      if(url.includes('get_shop_flash_sale_list')) {listRequests++;return {code:0,data:{flash_sale_list:Array.from({length:listRequests===1?50:1},(_,i)=>({flash_sale_id:listRequests===1?i+1:51,start_time:1,end_time:9999999999})),total:51,has_more:listRequests===1}};}
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
    let identityReads=0;
    const h=makeHarness({getShopIdentity:async()=>{
      identityReads++;
      if(identityReads===2)throw new Error('fixture identity read unavailable at submission');
      return {shopId:77,accountId:700};
    }});
    await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('identity read exception at submission prevents product writes',0,h.state.writes.length);
    observations.push({name:'identity read exception observation',observed:{identityReads,status:h.state.task.status}});
  }
  {
    const h=makeHarness({fetchChannelList:async()=>null},{toggleLogistics:true});
    const preview=await runner.previewShippingTargets(h.deps,{...settings,toggleLogistics:true});
    const out=await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});
    record('requested logistics list failure stops all product writes',0,h.state.writes.length);
    observations.push({name:'logistics preview and run semantics',observed:{previewOk:preview.ok,previewError:preview.logistics.error,runStatus:out.task.status},note:'Both preview and run now fail closed when requested logistics cannot be read.'});
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
    let activeShop=88, writes=0; const receivedBatches=[];
    const fixture={
      getCredential:async()=>credential,getShopIdentity:async()=>({shopId:activeShop,accountId:880}),getAuthUserId:async()=>2,
      validateAccess:async()=>({allowed:true}),findOtherWriteConflict:async()=>null,log:()=>{},
      injectedFetch:async(url,method,body)=>{
        if(url.includes('search_product_list_v2'))return {code:0,data:{list:[{...product,days_to_ship:7}],page_info:{cursor:'',total:1}}};
        if(url.includes('get_shop_flash_sale_list'))return {code:0,data:{flash_sale_list:[]}};
        if(url.includes('update_product/')){writes++;receivedBatches.push(clone(body));return {code:0,data:{result:body.map(item=>({id:item.id,code:0}))}};}
        if(url.includes('get_product_info'))return {code:0,data:{product_info:{enable_model_level_dts:false,pre_order_info:{days_to_ship:7}}}};
        throw new Error('unrecognized isolated route');
      },
    };

    // Legacy unbound plan is now blocked; it must not bind itself to a new identity.
    await bg.checkShippingPlans(fixture);
    await until(()=>!bg.isShippingInFlight(),'unbound plan blocked');
    record('unbound legacy plan sends zero product writes',0,writes);

    store[types.SHIPPING_PLANS_KEY][0] = {...clone(types.SHIPPING_DEFAULT_PLANS[0]),enabled:true,date:today,time:'00:00',days:7,ownerShopId:88,ownerUserId:2,lastRunId:null};
    await bg.checkShippingPlans(fixture);
    await until(()=>store[types.SHIPPING_TASK_KEY]?.status!=='running' && !bg.isShippingInFlight(),'bound plan task');
    record('bound plan result reaches actual completed state','completed',store[types.SHIPPING_PLANS_KEY][0].lastResult);
    record('plan preserves original owner shop',88,store[types.SHIPPING_TASK_KEY]?.shopId);

    // Actual background preview then manual start after switching shops.
    delete store[types.SHIPPING_TASK_KEY];
    store[types.SHIPPING_PLANS_KEY]=[];
    activeShop=88;
    const confirmed=await bg.handleShippingPreview(fixture,settings,'review-preview-original');
    activeShop=99;
    const beforeSwitch=writes;
    const switched=await bg.handleShippingStart(fixture,{requestId:'review-manual-switch',previewRequestId:'review-preview-original',settings,items:confirmed.items,source:'manual'});
    await until(()=>!bg.isShippingInFlight(),'manual switched task');
    record('preview owner shop cannot be rebound at manual start',0,writes-beforeSwitch);
    observations.push({name:'manual preview and task owner observation',observed:{previewShopId:confirmed.shopId,started:switched.success,taskShopId:store[types.SHIPPING_TASK_KEY]?.shopId}});

    // Backend access revoked after initial start validation but before product submission.
    delete store[types.SHIPPING_TASK_KEY];
    activeShop=88;
    let accessAllowed=true, accessCalls=0;
    const originalFetch=fixture.injectedFetch;
    fixture.validateAccess=async()=>{accessCalls++;return {allowed:accessAllowed,error:'fixture permission revoked'};};
    fixture.injectedFetch=async(url,method,body)=>{
      if(url.includes('search_product_list_v2'))accessAllowed=false;
      return originalFetch(url,method,body);
    };
    store[types.SHIPPING_PREVIEW_KEY]={requestId:'review-revoked-preview',at:Date.now(),shopId:88,ownerUserId:2,settings:clone(settings),itemIds:['101'],result:confirmed};
    const beforeRevoke=writes;
    await bg.handleShippingStart(fixture,{requestId:'review-permission-revoked',previewRequestId:'review-revoked-preview',settings,items:[target],source:'manual'});
    await until(()=>!bg.isShippingInFlight(),'permission revoked task');
    record('revoked backend permission prevents product submission',0,writes-beforeRevoke);
    observations.push({name:'permission validation call count before writes',observed:accessCalls});


    // Valid preview identifier paired with a different valid target day.
    delete store[types.SHIPPING_TASK_KEY];
    accessAllowed=true;
    fixture.injectedFetch=originalFetch;
    await bg.handleShippingPreview(fixture,settings,'review-fixed-settings');
    const beforeChangedSettings=writes;
    await bg.handleShippingStart(fixture,{requestId:'review-changed-settings',previewRequestId:'review-fixed-settings',settings:{...settings,days:3},items:[target],source:'manual'});
    await until(()=>!bg.isShippingInFlight(),'modified settings task');
    record('start settings differing from authoritative preview are rejected',0,writes-beforeChangedSettings);
    observations.push({name:'changed settings actual submitted payload',observed:writes>beforeChangedSettings?receivedBatches.at(-1):[]});

    // Valid preview identifier with an extra product outside the confirmed preview.
    delete store[types.SHIPPING_TASK_KEY];
    await bg.handleShippingPreview(fixture,settings,'review-fixed-items');
    const beforeExtraItems=writes;
    fixture.injectedFetch=async(url,method,body)=>{
      if(url.includes('search_product_list_v2'))return {code:0,data:{list:[{...product,days_to_ship:7},{...product,id:202,days_to_ship:7}],page_info:{cursor:'',total:2}}};
      return originalFetch(url,method,body);
    };
    await bg.handleShippingStart(fixture,{requestId:'review-extra-items',previewRequestId:'review-fixed-items',settings,items:[target,{...target,itemId:'202'}],source:'manual'});
    await until(()=>!bg.isShippingInFlight(),'expanded targets task');
    record('items outside authoritative preview are not submitted',0,writes-beforeExtraItems);
    observations.push({name:'expanded target actual submitted payload',observed:writes>beforeExtraItems?receivedBatches.at(-1):[]});
    fixture.injectedFetch=originalFetch;
    accessAllowed=false;


    // Runtime payload must not turn unconfirmed logistics management on.
    delete store[types.SHIPPING_TASK_KEY];
    accessAllowed=true;fixture.injectedFetch=originalFetch;
    await bg.handleShippingPreview(fixture,settings,'review-false-logistics');
    let channelEnabled=true;const channelActions=[];
    fixture.injectedFetch=async(url,method,body)=>{
      if(url.includes('get_channel_list'))return {code:0,data:{list:[{channel_id:9,enabled:channelEnabled}]}};
      if(url.includes('update_channel_toggle')){channelActions.push({channelId:body.channel_id,enabled:body.enabled});channelEnabled=body.enabled;return {code:0};}
      return originalFetch(url,method,body);
    };
    await bg.handleShippingStart(fixture,{requestId:'review-runtime-logistics',previewRequestId:'review-false-logistics',settings:{...settings,toggleLogistics:'true'},items:[target],source:'manual'});
    await until(()=>!bg.isShippingInFlight(),'runtime logistics task');
    record('non-boolean logistics input cannot enable unconfirmed channel writes',0,channelActions.length);
    observations.push({name:'runtime logistics payload and task observation',observed:{confirmedLogistics:false,requestValueType:'string',taskRequested:store[types.SHIPPING_TASK_KEY]?.logistics?.requested,channelActions}});
    accessAllowed=false;

    // Restore is also a business write and must revalidate current server permission.
    store[types.SHIPPING_TASK_KEY]=taskModule.createShippingTask({taskId:'review-restore-permission',requestId:'r',shopId:88,ownerUserId:2,source:'manual',mode:'preorder',days:7,range:'all',excludeIds:[],total:0,toggleLogistics:true,now:Date.now()});
    store[types.SHIPPING_TASK_KEY].status='failed';
    store[types.SHIPPING_TASK_KEY].logistics.records=[{channelId:9,originallyEnabled:true,closed:'success',restored:'pending'}];
    let restoreWrites=0;
    fixture.injectedFetch=async(url,method,body)=>{
      if(url.includes('update_channel_toggle')){restoreWrites++;return {code:0};}
      if(url.includes('get_channel_list'))return {code:0,data:{list:[{channel_id:9,enabled:true}]}};
      return originalFetch(url,method,body);
    };
    const beforeRestoreAccess=accessCalls;
    await bg.handleShippingRestoreLogistics(fixture);
    record('revoked backend permission prevents logistics restore write',0,restoreWrites);
    observations.push({name:'restore server permission validation calls',observed:accessCalls-beforeRestoreAccess});

  }

  {
    let session='A', sentSession=null;
    const h=makeHarness({
      getCredential:async()=>({spcCds:session==='A'?'fixture-session-a':'fixture-session-b',spcCdsVer:'2'}),
      getShopIdentity:async()=>({shopId:session==='A'?77:88,accountId:700}),
      validateAccess:async()=>{session='B';return {allowed:true};},
      updateChannelToggle:async(used)=>{sentSession=used.spcCds==='fixture-session-b'?'B':'A';return {success:true};},
    },{toggleLogistics:true});
    h.initial.status='failed';
    h.initial.logistics.records=[{channelId:9,originallyEnabled:true,closed:'success',restored:'pending'}];
    h.state.task=clone(h.initial);
    const result=await runner.restorePendingLogistics(h.initial,h.deps);
    record('restore uses the seller context verified before that write',false,sentSession==='B');
    observations.push({name:'seller context change during access validation',observed:{verifiedShopId:77,sessionUsedAtWrite:sentSession,restoreCompleted:result.completed}});
  }

  for(const test of [{name:'same-cookie backend account switch',nextUser:2,refresh:false},{name:'refreshed-cookie missing backend account',nextUser:null,refresh:true},{name:'same-owner credential refresh',nextUser:1,refresh:true}]){
    let changed=false, toggleCount=0;const diagnostics=[];
    const h=makeHarness({
      verifiedContext:async()=>({credential:{spcCds:changed&&test.refresh?'fixture-refreshed-cookie':'fixture-original-cookie',spcCdsVer:'2'},shopId:77,userId:changed?test.nextUser:1}),
      getAuthUserId:async()=>changed?test.nextUser:1,
      validateAccess:async()=>{changed=true;return {allowed:true};},
      updateChannelToggle:async()=>{toggleCount++;return {success:true};},
      recordDiagnostic:async entry=>diagnostics.push(clone(entry)),
    },{toggleLogistics:true});
    h.initial.status='failed';h.initial.logistics.records=[{channelId:9,originallyEnabled:true,closed:'success',restored:'pending'}];h.state.task=clone(h.initial);
    const result=await runner.restorePendingLogistics(h.initial,h.deps);
    record(test.name+' expected logistics restore writes',test.nextUser===1?1:0,toggleCount);
    if(test.nextUser===1)record('same-owner credential refresh completes restore',true,result.completed);
    observations.push({name:test.name+' runtime observation',observed:{anchorUser:1,currentUser:test.nextUser,cookieRefreshed:test.refresh,completed:result.completed,diagnosticContexts:diagnostics.map(d=>({stage:d.stage,expectedUserId:d.expectedUserId,actualUserId:d.actualUserId,contextChange:d.contextChange}))}});
  }

  {
    let refreshed=false, permissionNowAllowed=true, toggles=0;const validations=[],diagnostics=[];
    const h=makeHarness({
      verifiedContext:async()=>({credential:{spcCds:refreshed?'fixture-current':'fixture-before-refresh',spcCdsVer:'2'},shopId:77,userId:1}),
      validateAccess:async used=>{
        const allowed=permissionNowAllowed;
        validations.push({credentialTag:used.spcCds==='fixture-current'?'current':'before-refresh',allowed});
        if(!refreshed){refreshed=true;permissionNowAllowed=false;}
        return {allowed,error:allowed?undefined:'fixture server access revoked during refresh'};
      },
      updateChannelToggle:async()=>{toggles++;return {success:true};},
      recordDiagnostic:async entry=>diagnostics.push(clone(entry)),
    },{toggleLogistics:true});
    h.initial.status='failed';h.initial.logistics.records=[{channelId:9,originallyEnabled:true,closed:'success',restored:'pending'}];h.state.task=clone(h.initial);
    const result=await runner.restorePendingLogistics(h.initial,h.deps);
    record('same-owner refreshed context with revoked permission sends no restore writes',0,toggles);
    record('same-owner refreshed context with revoked permission is not restored',false,result.completed);
    observations.push({name:'refreshed-context permission observation',observed:{sameShop:true,sameUser:true,permissionAtSubmission:permissionNowAllowed,validations,restoreCompleted:result.completed,diagnostics:diagnostics.map(d=>({stage:d.stage,access:d.access,contextChange:d.contextChange,credentialChanged:d.credentialChanged,blockedBy:d.blockedBy}))}});
  }

  for (const pathKind of ['product','close','restore']) for(const accessMode of ['denied','throw','allowed']) {
    let reads=0;
    const validations=[], sent=[],diagnostics=[];
    const h=makeHarness({
      verifiedContext:async()=>({credential:{spcCds:++reads>=(pathKind==='close'?3:2)?'fresh-fixture':'old-fixture',spcCdsVer:'2'},shopId:77,userId:1}),
      validateAccess:async(used,shopId)=>{
        const fresh=used.spcCds==='fresh-fixture';
        validations.push({credentialTag:fresh?'fresh':'old',shopId,outcome:fresh?accessMode:'allowed'});
        if(fresh && accessMode==='throw')throw new Error('fixture access network unavailable');
        return {allowed:!fresh||accessMode==='allowed',error:'fixture access denied'};
      },
      updateProductBatch:async(used,payload)=>{sent.push({kind:'product',credentialTag:used.spcCds==='fresh-fixture'?'fresh':'old'});return {topLevelSuccess:true,itemResults:payload.map(p=>({id:String(p.id),code:0}))};},
      updateChannelToggle:async(used,id,enabled)=>{sent.push({kind:enabled?'restore':'close',credentialTag:used.spcCds==='fresh-fixture'?'fresh':'old'});return {success:true};},
      recordDiagnostic:async d=>diagnostics.push(clone(d)),
    },{toggleLogistics:pathKind!=='product'});
    let completed, pending;
    if(pathKind==='restore'){
      h.initial.status='failed';h.initial.logistics.records=[{channelId:9,originallyEnabled:true,closed:'success',restored:'pending'}];h.state.task=clone(h.initial);
      const result=await runner.restorePendingLogistics(h.initial,h.deps);
      completed=result.completed;pending=!result.task.logistics.restoreCompleted&&result.task.logistics.records.some(r=>r.restored!=='success');
    }else{
      const result=await runner.runShippingTask(h.initial,[target],h.deps,{readback:false});completed=result.task.status==='completed';
    }
    record(pathKind+' '+accessMode+' checks fresh credential',true,validations.some(v=>v.credentialTag==='fresh'&&v.shopId===77));
    record(pathKind+' '+accessMode+' refresh branch reached',true,diagnostics.some(d=>d.credentialChanged===true && (accessMode==='allowed'?d.contextChange==='same-owner-refresh':d.blockedBy==='access-'+(accessMode==='throw'?'read-failed':'denied'))));
    record(pathKind+' '+accessMode+' expected actual writes',accessMode==='allowed'?true:false,sent.some(s=>s.kind===pathKind));
    record(pathKind+' '+accessMode+' completes only when allowed',accessMode==='allowed',completed);
    if(accessMode!=='allowed')record(pathKind+' '+accessMode+' zero subsequent business writes',0,sent.length);
    else record(pathKind+' allowed uses new credential at write',true,sent.filter(s=>s.kind===pathKind).every(s=>s.credentialTag==='fresh'));
    if(pathKind==='restore'&&accessMode!=='allowed')record('restore '+accessMode+' preserves obligation',true,pending);
    observations.push({name:pathKind+' '+accessMode+' matrix observation',observed:{validations,sent,completed,pending,diagnostics}});
  }

  const result={scope:'independent isolated execution of actual modules; no browser/server/store API/network requests',sourceHashes,observations,contractFailures:observations.filter(r=>r.meetsContract===false).length};
  fs.writeFileSync(path.join(output,'module-observations.json'),JSON.stringify(result,null,2),'utf-8');
  for(const result of observations)console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
