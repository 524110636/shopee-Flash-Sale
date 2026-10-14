from pathlib import Path

folder = Path(__file__).resolve().parent
(folder/'browser-probe.cjs').write_text(r'''const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});const context=await browser.newContext({viewport:{width:953,height:900}});await context.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:5802')?r.continue():r.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5802/admin/');await page.locator('input').first().fill('admin@review.invalid');await page.locator('input[type=password]').fill('LocalReview!2026');await page.getByRole('button',{name:/登\s*录/}).click();await page.getByRole('menuitem').filter({hasText:'弹窗管理'}).click();await page.waitForSelector('.ant-table');
 const row=page.locator('.ant-table-row').filter({hasText:'独立统计复核'});const countText=await row.locator('a').innerText();await row.locator('a').click();let modal=page.locator('.ant-modal-content');await modal.waitFor();await modal.locator('.ant-table-row').first().waitFor();const viewerText=await modal.innerText();await modal.getByRole('button',{name:/关\s*闭/}).click();
 await page.getByText('如何修改版本与测试升级（点开看步骤）',{exact:true}).click();const guide=await page.locator('.ant-collapse-content-active').innerText();
 const layouts=[];
 for(const width of [953,1366,420]){
  await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'新建弹窗'}).click();modal=page.locator('.ant-modal-content');await modal.waitFor();await modal.locator('input[type=checkbox]').check();
  const a=await modal.getByText('要求版本',{exact:true}).boundingBox();const b=await modal.getByText('下载地址',{exact:true}).boundingBox();const ai=await modal.locator('input[placeholder^="例如 1."]').boundingBox();const bi=await modal.locator('input[placeholder^="https://"]').boundingBox();
  const aligned=width===420?b.y>ai.y:Math.abs(a.y-b.y)<1&&Math.abs(ai.y-bi.y)<1;
  layouts.push({width,labels:[a,b],inputs:[ai,bi],labelsAboveInputs:a.y<ai.y&&b.y<bi.y,aligned,withinViewport:bi.x+bi.width<=width});
  if(width===953)await page.screenshot({path:path.join(__dirname,'layout-953.png')});await modal.getByRole('button',{name:/取\s*消/}).click();
 }
 const result={countText,viewerText,guide,layouts,errors};fs.writeFileSync(path.join(__dirname,'browser-observations.json'),JSON.stringify(result,null,2),'utf-8');console.log(JSON.stringify({countText,viewerAccounts:viewerText.match(/[a-z]+@review.invalid/g),layouts:layouts.map(({width,labelsAboveInputs,aligned,withinViewport})=>({width,labelsAboveInputs,aligned,withinViewport})),guideOrder:guide.match(/\d\. [^\n]+/g),errors}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
''', encoding='utf-8')
(folder/'extension-probe.cjs').write_text(r'''const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');
const BASE='http://127.0.0.1:5802';let admin,context;const results=[];const created=[];
async function api(method,url,body,token){const res=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return res.json();}
async function create(mode,title,version){const record=(await api('POST','/api/admin/popup-policies',{mode,title,contentHtml:'<p>真实扩展展示</p>',...(mode==='forced_update'?{requiredVersion:version,downloadUrl:BASE+'/admin/'}:{})},admin)).record.recordId;created.push(record);await api('POST',`/api/admin/popup-policies/${record}/publish`,{},admin);return record;}
async function show(user,phase){const page=await context.newPage();const reports=[];page.on('response',async r=>{if(r.url().endsWith('/api/extension/popup-views'))reports.push(await r.json());});await page.goto(`chrome-extension://${user.id}/popup.html`);await page.waitForTimeout(2200);const text=await page.locator('body').innerText();results.push({phase,actualVersion:await page.evaluate(()=>chrome.runtime.getManifest().version),forcedVisible:text.includes('真实强制展示'),checking:text.includes('正在检查通知'),reports});await page.close();}
(async()=>{
 admin=(await api('POST','/api/auth/login',{email:'admin@review.invalid',password:'LocalReview!2026'})).token;
 const notice=await create('notice','强制遮住的通知');const forced=await create('forced_update','真实强制展示','99.0.0');
 const pkg=path.resolve(__dirname,'../../.output/chrome-mv3');
 for(const [email,label] of [['valid@review.invalid','A'],['invalid@review.invalid','B']]){
  const login=await api('POST','/api/auth/login',{email,password:'LocalReview!2026'});
  context=await chromium.launchPersistentContext(path.join(__dirname,'profile-'+label),{headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${pkg}`,`--load-extension=${pkg}`]});
  await context.route('**/*',r=>r.request().url().startsWith(BASE)||r.request().url().startsWith('chrome-extension://')?r.continue():r.abort());
  const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20000});const id=sw.url().split('/')[2];await sw.evaluate(async args=>chrome.storage.local.set(args),{backendUrl:BASE,backendAuth:{token:login.token,user:login.user}});
  await show({id},label);if(label==='A')await show({id},'A-repeat');await context.close();context=null;
 }
 const forceViewers=await api('GET',`/api/admin/popup-policies/${forced}/viewers`,undefined,admin);const noticeViewers=await api('GET',`/api/admin/popup-policies/${notice}/viewers`,undefined,admin);
 const observation={results,forcedTotal:forceViewers.total,forcedAccounts:forceViewers.viewers.map(r=>r.email),hiddenNoticeTotal:noticeViewers.total,passed:forceViewers.total===2&&noticeViewers.total===0&&results.every(r=>r.forcedVisible&&!r.checking)};
 fs.writeFileSync(path.join(__dirname,'extension-observations.json'),JSON.stringify(observation,null,2),'utf-8');console.log(JSON.stringify(observation));if(!observation.passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(context)await context.close();for(const id of created)await api('POST',`/api/admin/popup-policies/${id}/withdraw`,{},admin);});
''', encoding='utf-8')
print('Independent browser probes prepared')
