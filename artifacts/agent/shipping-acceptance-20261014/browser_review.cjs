const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=process.cwd();
const temporary=path.join(root,'.agent-tmp/shipping-acceptance-20261014');
const evidenceDir=path.join(root,'artifacts/agent/shipping-acceptance-20261014');
const extension=path.join(root,'.agent-tmp/shipping-m02-20261014/iso-output/chrome-mv3');
const profile=path.join(temporary,'profile');
const results=[],writes=[],requests=[];
let context,worker,mode='normal',closureSent=false,days=1;
const cookie='review-isolated-cookie';
const products=()=>[{id:101,name:'review item',status:1,category_path:'1/2',days_to_ship:days,enable_model_level_dts:false}];
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
      else if(url.pathname.includes('validate'))data={allowed:true};
      else if(url.pathname.includes('popup-policy'))data={notice:null,forceUpdate:null};
    }else if(url.hostname==='seller.shopee.tw'){
      requests.push({path:url.pathname,method:req.method()});
      if(!url.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated review</title><body>fixture</body>'});
      if(url.pathname.includes('/v2/login'))data={id:700,shopid:77,username:'fixture'};
      else if(url.pathname.includes('search_product_list_v2'))data={code:0,data:{list:products(),page_info:{cursor:'',total:1}}};
      else if(url.pathname.includes('get_product_info'))data={code:0,data:{product_info:{enable_model_level_dts:false,pre_order_info:{days_to_ship:days}}}};
      else if(url.pathname.includes('get_shop_flash_sale_list')){
        if(mode==='recheck-failure')data={code:500,message:'fixture activity listing unavailable'};
        else if(mode==='partial-exclusion')data={code:0,data:{flash_sale_list:[{flash_sale_id:11,start_time:1,end_time:9999999999},{flash_sale_id:12,start_time:1,end_time:9999999999}]}};
        else data={code:0,data:{flash_sale_list:[]}};
      }else if(url.pathname.includes('get_shop_flash_sale_item_id_list')){
        data=url.searchParams.get('flash_sale_id')==='11'?{code:0,data:{item_ids:[102]}}:{code:500,message:'fixture second activity unavailable'};
      }else if(url.pathname.includes('/product/update_product/')){
        const body=req.postDataJSON();writes.push({kind:'product',items:body});days=body[0].days_to_ship;
        data={code:0,data:{result:body.map(item=>({id:item.id,code:0}))}};
      }else if(url.pathname.includes('get_channel_list')){
        data=closureSent && mode==='unknown-close'?{code:500,message:'fixture channel read unavailable'}:{code:0,data:{list:[{channel_id:9,enabled:!closureSent}]}};
      }else if(url.pathname.includes('update_channel_toggle')){
        const body=req.postDataJSON();writes.push({kind:'channel',channelId:body.channel_id,enabled:body.enabled});
        if(mode==='unknown-close' && body.enabled===false){closureSent=true;data={code:500,message:'fixture close result unavailable'};}else{closureSent=!body.enabled;data={code:0};}
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
      const data=url.pathname.includes('validate')?{allowed:true}:url.pathname.includes('check-admin')?{isAdmin:true,autoModeEnabled:1,trialUsed:0,trialEnabled:0}:{status:'ok'};
      return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
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
  await reset(page);mode='partial-exclusion';
  const partial=await preview(page);add('actual UI rejects partial activity exclusion',false,partial.ok);
  if(partial.ok){const before=writes.length;await page.getByRole('button',{name:'确认并开始修改',exact:true}).click();await waitTask();add('partial exclusion sends no writes',0,writes.length-before);}
  await reset(page);mode='normal';await preview(page);mode='recheck-failure';
  const before=writes.length;await page.getByRole('button',{name:'确认并开始修改',exact:true}).click();await waitTask();
  add('actual worker rejects failed execution exclusion check',0,writes.length-before);
  await reset(page);mode='unknown-close';await page.getByText('自动管理店铺物流',{exact:true}).click();await preview(page);
  await page.getByRole('button',{name:'确认并开始修改',exact:true}).click();const channelTask=await waitTask();
  const restoreButtons=await page.getByRole('button',{name:'恢复物流（需先登录原店铺）',exact:true}).count();
  add('unknown actual channel result exposes recovery button',true,restoreButtons>0);
  results.push({name:'unknown channel runtime observation',observed:{closed:channelTask.logistics.records[0]?.closed,restoreAttempted:channelTask.logistics.restoreAttempted,restoreButtonCount:restoreButtons}});
  await page.screenshot({path:path.join(evidenceDir,'browser-unknown-close.png'),fullPage:true});
  fs.writeFileSync(path.join(evidenceDir,'browser-observations.json'),JSON.stringify({scope:'actual isolated static extension; synthetic identity/cookie; all HTTP intercepted; no backend service/DB/live store',package:path.relative(root,extension),backgroundSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(extension,'background.js'))).digest('hex'),results,requests,writes},null,2),'utf-8');
  for(const result of results)console.log(JSON.stringify(result));
})().catch(error=>{fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,'browser-error.json'),JSON.stringify({message:error.message,stack:error.stack},null,2),'utf-8');console.error(error.message);process.exitCode=1;}).finally(async()=>{if(context)await context.close();});
