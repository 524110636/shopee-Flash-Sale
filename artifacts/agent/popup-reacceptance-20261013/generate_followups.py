from pathlib import Path

# Owner: Codex independent reacceptance, 2026-10-13. Test fixtures only.
root = next(p for p in Path(__file__).resolve().parents if (p / 'AGENTS.md').exists())
folder = root / '.agent-tmp/popup-reacceptance-20261013'
folder.mkdir(parents=True, exist_ok=True)
deadline = r'''const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');let server,browser;const rows=[];
(async()=>{
 server=http.createServer((req,res)=>{if(req.url.startsWith('/probe.js')){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(__dirname,'probe.js')));return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script src="/probe.js"></script></body></html>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});
 for(const name of ['backend-address-storage-hangs','network-timeout-with-known-forced-cache']){
  const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({name})=>{const base='http://127.0.0.1:59998';const data={_popupPolicyCache:{[base]:{notice:null,forcedUpdate:{mode:'forced_update',revision:7,title:'known-force',contentHtml:'<p>required</p>',requiredVersion:'99.0.0',downloadUrl:'https://example.invalid/download',publishedAt:null}}}};window.browser={runtime:{getManifest:()=>({version:'1.15.0'})},storage:{local:{get:async key=>{if(name==='backend-address-storage-hangs'&&key==='backendUrl')return new Promise(()=>{});return {[key]:data[key]};},set:async values=>Object.assign(data,values)}}};},{name});
  await page.route('http://127.0.0.1:59998/api/extension/popup-policy',()=>new Promise(()=>{}));
  const start=Date.now();await page.goto(`http://127.0.0.1:${server.address().port}/?strict=1`);await page.waitForTimeout(5600);
  const data=await page.evaluate(()=>({checking:document.body.innerText.includes('正在检查通知'),forcedShown:document.body.innerText.includes('known-force'),downloadButtonPresent:document.body.innerText.includes('下载最新版本'),underlyingInert:document.querySelector('#root > div')?.hasAttribute('inert'),timeoutText:document.body.innerText.includes('超时')}));rows.push({name,elapsed:Date.now()-start,...data,errors});await context.close();
 }
 fs.writeFileSync(path.join(__dirname,'deadline-observations.json'),JSON.stringify(rows,null,2),'utf-8');rows.forEach(r=>console.log(JSON.stringify(r)));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
'''
(folder/'deadline-probe.cjs').write_text(deadline,encoding='utf-8')
records = r'''const fs=require('node:fs');const path=require('node:path');const base='http://127.0.0.1:5797';let token;const observations=[];
async function api(method,endpoint,body,admin=true){const response=await fetch(base+endpoint,{method,headers:{'Content-Type':'application/json',...(admin?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(`Isolated ${method} ${endpoint} failed: ${response.status}`);return data;}
(async()=>{
 token=(await api('POST','/api/auth/login',{email:'verify-admin@example.invalid',password:'VerifyAdmin!2026'},false)).token;
 const forcedInput={mode:'forced_update',title:'type-change-force',contentHtml:'<p>forced-original</p>',requiredVersion:'99.0.0',downloadUrl:'https://example.invalid/update'};
 const created=await api('POST','/api/admin/popup-policies',forcedInput);const id=created.record.recordId;
 await api('POST',`/api/admin/popup-policies/${id}/publish`,{});
 const before=await api('GET','/api/extension/popup-policy',undefined,false);
 await api('PATCH',`/api/admin/popup-policies/${id}/draft`,{mode:'notice',title:'now-notice',contentHtml:'<p>notice-new</p>'});
 const draft=await api('GET','/api/extension/popup-policy',undefined,false);
 await api('POST',`/api/admin/popup-policies/${id}/publish`,{});
 const after=await api('GET','/api/extension/popup-policy',undefined,false);const list=await api('GET','/api/admin/popup-policies');
 observations.push({name:'published-record-change-forced-to-notice',before:{notice:before.notice?.title,forced:before.forcedUpdate?.title},afterDraft:{notice:draft.notice?.title,forced:draft.forcedUpdate?.title},afterPublish:{notice:after.notice,forcedUpdate:after.forcedUpdate},listStatus:list.records.find(r=>r.recordId===id)?.status,activeSlots:list.slots});
 const noticeA=await api('POST','/api/admin/popup-policies',{mode:'notice',title:'withdraw-status-probe',contentHtml:'<p>A</p>'});await api('POST',`/api/admin/popup-policies/${noticeA.record.recordId}/publish`,{});await api('POST',`/api/admin/popup-policies/${noticeA.record.recordId}/withdraw`,{});const withdrawnList=await api('GET','/api/admin/popup-policies');
 observations.push({name:'explicit-withdraw-retained-status',status:withdrawnList.records.find(r=>r.recordId===noticeA.record.recordId)?.status,retained:withdrawnList.records.some(r=>r.recordId===noticeA.record.recordId)});
 fs.writeFileSync(path.join(__dirname,'record-observations.json'),JSON.stringify(observations,null,2),'utf-8');observations.forEach(row=>console.log(JSON.stringify(row)));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
'''
(folder/'record-probe.cjs').write_text(records,encoding='utf-8')
print('Deadline and record probes generated')
