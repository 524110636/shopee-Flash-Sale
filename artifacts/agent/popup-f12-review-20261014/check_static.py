from pathlib import Path

folder=Path(__file__).resolve().parent
config=folder/'experience.config.ts'
text=config.read_text(encoding='utf-8').replace("name: '限时特卖助手（弹窗验收）'", "name: '限时特卖助手（弹窗验收）', description: '静态本地验收包；仅连接 5799 测试后端，无需热更新服务'")
config.write_text(text,encoding='utf-8')
script=r'''const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');let context,token,record;const BASE='http://localhost:5799';const results=[];
async function api(method,url,body){const r=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return r.json();}
(async()=>{
 token=(await api('POST','/api/auth/login',{email:'admin@review.invalid',password:'LocalReview!2026'})).token;record=(await api('POST','/api/admin/popup-policies',{mode:'forced_update',title:'开发静态包入口',contentHtml:'<p>test</p>',requiredVersion:'1.15.2',downloadUrl:'http://127.0.0.1:5798/popup-1.15.2.zip'})).record.recordId;await api('POST',`/api/admin/popup-policies/${record}/publish`,{});
 const pkg=path.join(__dirname,'built/chrome-mv3-dev');context=await chromium.launchPersistentContext(path.join(__dirname,'profile-static'),{headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${pkg}`,`--load-extension=${pkg}`]});await context.route('**/*',r=>r.request().url().startsWith(BASE)||r.request().url().startsWith('chrome-extension://')?r.continue():r.abort());const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=sw.url().split('/')[2];const page=await context.newPage();page.on('response',r=>{if(r.url().includes('/api/extension/popup-policy'))results.push({url:r.url(),status:r.status()});});await page.goto(`chrome-extension://${id}/popup.html`);await page.getByText('开发静态包入口',{exact:true}).waitFor();const manifest=await page.evaluate(()=>chrome.runtime.getManifest());const result={version:manifest.version,name:manifest.name,description:manifest.description,policyResponses:results,storageBackendWasOverridden:false,passed:manifest.version==='1.15.1'&&results.some(r=>r.url.startsWith(BASE)&&r.status===200)};fs.writeFileSync(path.join(__dirname,'static-observations.json'),JSON.stringify(result,null,2),'utf-8');console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(context)await context.close();if(record)await api('POST',`/api/admin/popup-policies/${record}/withdraw`,{});});
'''
(folder/'static-probe.cjs').write_text(script,encoding='utf-8')
print('Static test package description and probe prepared')
