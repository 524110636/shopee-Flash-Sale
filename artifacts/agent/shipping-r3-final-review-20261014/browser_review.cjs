const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=process.cwd();
const temporary=path.join(root,'.agent-tmp/shipping-r3-final-review-20261014');
const evidenceDir=path.join(root,'artifacts/agent/shipping-r3-final-review-20261014');
const extension=path.join(root,'.agent-tmp/shipping-m02-20261014/iso-output/chrome-mv3');
const profile=path.join(temporary,'profile-alarm-reviewed');
const results=[],writes=[],requests=[];
let context,worker,mode='normal',closureSent=false,days=1;
const cookie='review-isolated-cookie';
let activeShop=77, activeUser=1, accessAllowed=true, extraProduct=false, holdResolve=null, holdEntered=false;
let browserSession;
const products=()=>[{id:101,name:'review item',status:1,category_path:'1/2',days_to_ship:days,enable_model_level_dts:false},...(extraProduct?[{id:202,name:'extra item',status:1,category_path:'1/2',days_to_ship:days,enable_model_level_dts:false}]:[])];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await sleep(50);}throw new Error('Timeout: '+label);}
function add(name,expected,observed){results.push({name,expected,observed,meetsContract:JSON.stringify(expected)===JSON.stringify(observed)});}
async function getTask(){return worker.evaluate(async()=> (await chrome.storage.local.get('_shippingTask'))._shippingTask);}
async function waitTask(){return waitFor(async()=>{const task=await getTask();return task && task.status!=='running'?task:null;},'task terminal');}
async function reset(page){days=1;closureSent=false;await worker.evaluate(async()=>chrome.storage.local.remove(['_shippingTask','_shippingPreview','_shippingStartError']));await page.getByRole('button',{name:'预检并预览目标',exact:true}).waitFor();}
async function preview(page){await page.getByRole('button',{name:'预检并预览目标',exact:true}).click();return waitFor(async()=>worker.evaluate(async()=> (await chrome.storage.local.get('_shippingPreview'))._shippingPreview?.result),'preview');}
(async()=>{
  fs.mkdirSync(evidenceDir,{recursive:true});
  if(fs.existsSync(profile))throw new Error('Profile already exists; do not overwrite another run');
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:'C:\\Users\\52411\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check'],viewport:{width:700,height:800}});
  await context.route(/^https?:\/\//,async route=>{
    const req=route.request(),url=new URL(req.url());
    let data={};
    if(['localhost','127.0.0.1'].includes(url.hostname)){
      if(url.pathname.includes('check-admin'))data={isAdmin:true,autoModeEnabled:1,trialUsed:0,trialEnabled:0};
      else if(url.pathname.replace(/\/$/,'')==='/api/stores')data={stores:[{id:1,userId:1,isActive:1,shopId:77,spcCds:cookie,shopUsername:'fixture',shopName:'review-store'}]};
      else if(url.pathname.includes('validate')){data={allowed:accessAllowed,error:'fixture permission revoked'};if(!accessAllowed)return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify(data)});}
      else if(url.pathname.includes('popup-policy'))data={notice:null,forceUpdate:null};
    }else if(url.hostname==='seller.shopee.tw'){
      requests.push({path:url.pathname,method:req.method()});
      if(!url.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated review</title><body>fixture</body>'});
      if(url.pathname.includes('/v2/login'))data={id:700,shopid:activeShop,username:'fixture'};
      else if(url.pathname.includes('search_product_list_v2')){if(mode==='revoke-before-write'){accessAllowed=false;await worker.evaluate(()=>globalThis.__reviewDenied=true);}data={code:0,data:{list:products(),page_info:{cursor:'',total:products().length}}};}
      else if(url.pathname.includes('get_product_info'))data={code:0,data:{product_info:{enable_model_level_dts:false,pre_order_info:{days_to_ship:days}}}};
      else if(url.pathname.includes('get_shop_flash_sale_list')){
        if(mode==='recheck-failure')data={code:500,message:'fixture activity listing unavailable'};
        else if(mode==='partial-exclusion')data={code:0,data:{flash_sale_list:[{flash_sale_id:11,start_time:1,end_time:9999999999},{flash_sale_id:12,start_time:1,end_time:9999999999}]}};
        else data={code:0,data:{flash_sale_list:[]}};
      }else if(url.pathname.includes('get_shop_flash_sale_item_id_list')){
        data=url.searchParams.get('flash_sale_id')==='11'?{code:0,data:{item_ids:[102]}}:{code:500,message:'fixture second activity unavailable'};
      }else if(url.pathname.includes('/product/update_product/')){
        const body=req.postDataJSON();writes.push({kind:'product',items:body});if(mode==='hold-write'){holdEntered=true;await new Promise(resolve=>holdResolve=resolve);}days=body[0].days_to_ship;
        data={code:0,data:{result:body.map(item=>({id:item.id,code:0}))}};
      }else if(url.pathname.includes('get_channel_list')){
        data=closureSent && mode==='unknown-close'?{code:500,message:'fixture channel read unavailable'}:{code:0,data:{list:[{channel_id:9,enabled:!closureSent}]}};
      }else if(url.pathname.includes('update_channel_toggle')){
        const body=req.postDataJSON();writes.push({kind:'channel',channelId:body.channel_id,enabled:body.enabled});
        if(mode==='unknown-close' && body.enabled===false){closureSent=true;return route.abort('failed');}else{closureSent=!body.enabled;data={code:0};}
      }else if(url.pathname.includes('graphql'))data={code:0,data:{products:{items:[]}}};
      else return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:500,message:'unrecognized isolated route'})});
    }else{return route.abort();}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await context.addCookies([{name:'SPC_CDS',value:cookie,domain:'seller.shopee.tw',path:'/',secure:true},{name:'SPC_CDS_VER',value:'2',domain:'seller.shopee.tw',path:'/',secure:true}]);
  worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:20000});
  // Keep backend communication entirely inside the isolated worker as a fixture.
  await worker.evaluate(()=>{
    globalThis.fetch=async input=>{
      const url=new URL(typeof input==='string'?input:input.url);
      if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('isolated worker network blocked');
      const denied=url.pathname.includes('validate')&&globalThis.__reviewDenied;const data=url.pathname.includes('validate')?{allowed:!denied,error:'fixture permission revoked'}:url.pathname.includes('check-admin')?{isAdmin:true,autoModeEnabled:1,trialUsed:0,trialEnabled:0}:{status:'ok'};
      return new Response(JSON.stringify(data),{status:denied?403:200,headers:{'content-type':'application/json'}});
    };
  });
  const now=Math.floor(Date.now()/1000);
  const payload={userId:1,email:'review@fixture.invalid',role:'admin',iat:now,exp:now+3600};
  const token=Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.fixture';
  await worker.evaluate(async({token,cookie})=>chrome.storage.local.set({backendUrl:'http://localhost:5789',backendAuth:{token,user:{id:1,email:'review@fixture.invalid',role:'admin',autoModeEnabled:1,trialUsed:0,trialEnabled:0}},_shippingSettings:{mode:'preorder',days:7,range:'all',excludeIds:'',toggleLogistics:false}}),{token,cookie});
  const seller=await context.newPage();await seller.goto('https://seller.shopee.tw/portal/product/list/live/all');
  const page=await context.newPage();await page.goto('chrome-extension://'+new URL(worker.url()).host+'/popup.html');
  await page.locator('[data-feature-id="shipping"]').click({timeout:20000});
  await page.getByText('商品备货天数修改',{exact:true}).waitFor();
  add('actual homepage opens shipping interface',true,true);
  const normalPreview=await preview(page);add('normal fixture preview contains one target',1,normalPreview.items.length);
  await page.getByRole('button',{name:'确认并开始修改',exact:true}).click();
  const normal=await waitTask();add('normal actual worker completes product write','completed',normal.status);
  add('actual request sets pre_order and days_to_ship',{pre_order:true,days_to_ship:7},{pre_order:writes[0].items[0].pre_order,days_to_ship:writes[0].items[0].days_to_ship});

  // New public handler requires original preview request ID and refuses switched identity.
  async function startFromPreview(settingsOverride={}, itemsOverride=null){
    const saved=await worker.evaluate(async()=> (await chrome.storage.local.get('_shippingPreview'))._shippingPreview);
    await page.evaluate(async args=>chrome.runtime.sendMessage({type:'SHIPPING_START',requestId:'review-'+Math.random(),previewRequestId:args.record.requestId,settings:{mode:'preorder',days:7,range:'all',excludeIds:'',toggleLogistics:false,...args.override},items:args.items||args.record.result.items}),{record:saved,override:settingsOverride,items:itemsOverride});
  }
  async function waitRejected(){return waitFor(async()=>worker.evaluate(async()=> (await chrome.storage.local.get('_shippingStartError'))._shippingStartError?.error),'rejected start');}
  await reset(page);await preview(page);activeShop=88;
  let before=writes.filter(w=>w.kind==='product').length;
  await startFromPreview();await waitRejected();
  add('switching shop invalidates original preview with zero writes',0,writes.filter(w=>w.kind==='product').length-before);
  activeShop=77;
  await reset(page);await preview(page);
  const secondPayload={...payload,userId:2,email:'review2@fixture.invalid'};
  const secondToken=Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(secondPayload)).toString('base64url')+'.fixture';
  await worker.evaluate(async token=>chrome.storage.local.set({backendAuth:{token,user:{id:2,email:'review2@fixture.invalid',role:'admin',autoModeEnabled:1,trialUsed:0,trialEnabled:0}}}),secondToken);
  before=writes.filter(w=>w.kind==='product').length;
  await startFromPreview();await waitRejected();
  add('same-shop account switch invalidates original preview with zero writes',0,writes.filter(w=>w.kind==='product').length-before);
  await reset(page);await preview(page);
  before=writes.filter(w=>w.kind==='product').length;mode='revoke-before-write';
  await startFromPreview();await waitTask();
  add('actual HTTP 403 before submission prevents product writes',0,writes.filter(w=>w.kind==='product').length-before);
  mode='normal';accessAllowed=true;await worker.evaluate(()=>globalThis.__reviewDenied=false);
  await reset(page);await preview(page);before=writes.filter(w=>w.kind==='product').length;
  await startFromPreview({days:3});await waitTask();
  add('different valid days with original preview are rejected',0,writes.filter(w=>w.kind==='product').length-before);
  await reset(page);extraProduct=false;const original=await preview(page);extraProduct=true;
  before=writes.filter(w=>w.kind==='product').length;
  await startFromPreview({},[...original.items,{itemId:'202',name:'extra item',status:1,categoryPath:'1/2'}]);await waitTask();
  add('extra product outside original preview is rejected',0,writes.filter(w=>w.kind==='product').length-before);
  extraProduct=false;

  // Actual Chrome alarm events with controlled scheduler time; no hours-long waiting.
  async function clearTasks(){await worker.evaluate(async()=>chrome.storage.local.remove(['_shippingTask','_shippingPlans','_shippingPreview','_shippingStartError']));}
  async function clock(iso){await worker.evaluate(now=>{globalThis.__realNow??=Date.now.bind(Date);globalThis.__reviewNow=now;Date.now=()=>globalThis.__reviewNow;},Date.parse(iso));}
  async function fire(){await worker.evaluate(()=>chrome.alarms.create('shipping_plan_check',{when:globalThis.__realNow()-1}));}
  const makePlan=(id,days,time='00:00',daily=false,date='2026-10-14')=>({id,enabled:true,date,time,days,range:'all',loopDaily:daily,excludeIds:'',toggleLogistics:false,ownerShopId:77,ownerUserId:2,lastRunId:null,lastRunAt:null,lastResult:null,lastTaskId:null,lastError:null,missed:false,updatedAt:Date.now()});
  async function plans(){return worker.evaluate(async()=> (await chrome.storage.local.get('_shippingPlans'))._shippingPlans);}
  async function setPlans(value){await worker.evaluate(async p=>chrome.storage.local.set({_shippingPlans:p}),value);}
  await clearTasks();await clock('2026-10-14T12:00:00+08:00');
  await setPlans([makePlan('plan1',5),makePlan('plan2',7,'00:01')]);
  before=writes.filter(w=>w.kind==='product').length;await fire();
  await waitFor(async()=>{const p=await plans();return p?.length===2&&p.every(x=>x.lastResult==='completed');},'two due plans');
  add('actual alarms execute two due plans once in order',[5,7],writes.filter(w=>w.kind==='product').slice(before).map(w=>w.items[0].days_to_ship));
  await fire();await sleep(350);
  add('duplicate alarm after same occurrences adds no writes',2,writes.filter(w=>w.kind==='product').length-before);
  results.push({name:'two-plan actual-alarm snapshot',observed:await plans()});
  await clearTasks();await clock('2026-10-14T23:59:00+08:00');
  await setPlans([makePlan('plan1',6,'00:01',true)]);
  before=writes.filter(w=>w.kind==='product').length;await fire();
  await waitFor(async()=> (await plans())?.[0]?.date==='2026-10-15','daily first date');
  await clock('2026-10-15T00:02:00+08:00');await fire();
  await waitFor(async()=> (await plans())?.[0]?.date==='2026-10-16','daily second date');
  add('daily actual alarms across midnight run one occurrence per day',2,writes.filter(w=>w.kind==='product').length-before);
  results.push({name:'daily cross-midnight snapshot',observed:await plans()});

  // Physical interruption/restart is independently verified by browser_lifecycle.cjs.
  await page.screenshot({path:path.join(evidenceDir,'actual-alarm-result.png'),fullPage:true});
  fs.writeFileSync(path.join(evidenceDir,'browser-observations.json'),JSON.stringify({scope:'actual static MV3, intercepted network and synthetic identity; real alarm events and real worker stop/restart; no backend/DB/live store',package:path.relative(root,extension),backgroundSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(extension,'background.js'))).digest('hex'),results,requests,writes},null,2),'utf-8');
  for(const result of results)if('meetsContract' in result)console.log(JSON.stringify(result));
})().catch(error=>{fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,'browser-error.json'),JSON.stringify({message:error.message,stack:error.stack,partialResults:results},null,2),'utf-8');console.error(error.message);process.exitCode=1;}).finally(async()=>{if(holdResolve)holdResolve();if(context)await context.close();});
