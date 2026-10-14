from pathlib import Path

folder = Path(__file__).resolve().parent
(folder / 'experience-smoke.cjs').write_text(r'''const {chromium}=require('playwright');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const folder=__dirname;const root=path.resolve(folder,'../..');const base='http://127.0.0.1:5796';
let token,recordId,context;
async function api(method,url,body){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(`${url}: ${response.status}`);return result;}
(async()=>{
 token=(await api('POST','/api/auth/login',{email:'verify-admin@example.invalid',password:'VerifyAdmin!2026'})).token;
 recordId=(await api('POST','/api/admin/popup-policies',{mode:'notice',title:'隔离体验入口检查',contentHtml:'<p>本机测试通知</p>'})).record.recordId;
 await api('POST',`/api/admin/popup-policies/${recordId}/publish`,{});
 const extension=path.join(folder,'experience/chrome-mv3');
 context=await chromium.launchPersistentContext(path.join(folder,'profile-experience'),{headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const unexpected=[];const policyResponses=[];
 await context.route('**/*',async route=>{const url=route.request().url();if(url.startsWith('chrome-extension://')||url.startsWith(base))await route.continue();else{unexpected.push(new URL(url).origin);await route.abort();}});
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20000});const id=sw.url().split('/')[2];
 const page=await context.newPage();page.on('response',r=>{if(r.url().includes('/api/extension/popup-policy'))policyResponses.push({url:r.url(),status:r.status()});});
 await page.goto(`chrome-extension://${id}/popup.html`);await page.getByText('隔离体验入口检查',{exact:true}).waitFor({timeout:10000});
 const result=await page.evaluate(()=>({manifest:chrome.runtime.getManifest(),checking:document.body.innerText.includes('正在检查通知'),noticeDisplayed:document.body.innerText.includes('隔离体验入口检查')}));
 const before=JSON.parse(fs.readFileSync(path.join(folder,'production-package-before.json'),'utf-8'));
 const productionUnchanged=Object.entries(before).every(([file,hash])=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'.output/chrome-mv3',file))).digest('hex')===hash);
 const observation={name:result.manifest.name,version:result.manifest.version,checking:result.checking,noticeDisplayed:result.noticeDisplayed,policyResponses,unexpectedOrigins:[...new Set(unexpected)],productionUnchanged};
 if(observation.checking||!observation.noticeDisplayed||!productionUnchanged||unexpected.length||!policyResponses.some(r=>r.url.startsWith(base)&&r.status===200))throw new Error(JSON.stringify(observation));
 fs.writeFileSync(path.join(folder,'experience-observations.json'),JSON.stringify(observation,null,2),'utf-8');console.log(JSON.stringify(observation));
})().catch(err=>{console.error(err.stack);process.exitCode=1;}).finally(async()=>{if(context)await context.close();if(recordId)await api('POST',`/api/admin/popup-policies/${recordId}/withdraw`,{});});
''', encoding='utf-8')
print('Experience entry smoke fixture prepared')
