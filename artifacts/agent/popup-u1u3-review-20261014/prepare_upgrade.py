from pathlib import Path

folder = Path(__file__).resolve().parent
probe = folder/'browser-probe.cjs'
probe.write_text(probe.read_text(encoding='utf-8').replace('newContext({viewport:{width:953,height:900}})', 'newContext({viewport:{width:1366,height:900}})'), encoding='utf-8')
(folder/'extract_package.py').write_text('''from pathlib import Path
import sys
import zipfile
target = Path(sys.argv[2]).resolve()
workspace = Path(__file__).resolve().parent
if not target.is_relative_to(workspace):
    raise RuntimeError('Extraction outside owned review folder')
with zipfile.ZipFile(sys.argv[1]) as archive:
    for item in archive.infolist():
        destination = (target / item.filename).resolve()
        if not destination.is_relative_to(target) or ((item.external_attr >> 16) & 0o170000) == 0o120000:
            raise RuntimeError('Unsafe archive entry')
    archive.extractall(target)
''', encoding='utf-8')
(folder/'upgrade-probe.cjs').write_text(r'''const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {execFileSync}=require('node:child_process');
const BASE='http://127.0.0.1:5802';const DOWNLOAD='http://127.0.0.1:5803/popup-1.15.1.zip';const folder=__dirname;const source=path.resolve(folder,'../extension-announcements-and-forced-update/packages');let context,server,admin,record;
async function api(method,url,body){const r=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',...(admin?{Authorization:`Bearer ${admin}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return r.json();}
(async()=>{
 admin=(await api('POST','/api/auth/login',{email:'admin@review.invalid',password:'LocalReview!2026'})).token;
 server=http.createServer((req,res)=>{if(req.url!=='/popup-1.15.1.zip'){res.statusCode=404;res.end();return;}res.setHeader('Content-Type','application/zip');res.end(fs.readFileSync(path.join(source,'popup-1.15.1.zip')));});await new Promise(r=>server.listen(5803,'127.0.0.1',r));
 record=(await api('POST','/api/admin/popup-policies',{mode:'forced_update',title:'真实包升级验证',contentHtml:'<p>升级</p>',requiredVersion:'1.15.1',downloadUrl:DOWNLOAD})).record.recordId;await api('POST',`/api/admin/popup-policies/${record}/publish`,{});
 const downloaded=path.join(folder,'downloaded-1.15.1.zip');const bytes=Buffer.from(await (await fetch(DOWNLOAD)).arrayBuffer());fs.writeFileSync(downloaded,bytes);const unpacked=path.join(folder,'unpacked-new');execFileSync('python',['-X','utf8',path.join(folder,'extract_package.py'),downloaded,unpacked]);
 const extension=path.join(folder,'upgrade-live');if(fs.existsSync(extension))throw Error('Review live extension directory already exists');fs.cpSync(path.join(source,'popup-1.15.0'),extension,{recursive:true});
 const run=async()=>{context=await chromium.launchPersistentContext(path.join(folder,'profile-upgrade'),{headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});await context.route('**/*',r=>r.request().url().startsWith(BASE)||r.request().url().startsWith('http://127.0.0.1:5803')||r.request().url().startsWith('chrome-extension://')?r.continue():r.abort());const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20000});await sw.evaluate(async backendUrl=>chrome.storage.local.set({backendUrl}),BASE);return sw.url().split('/')[2];};
 const open=async id=>{const page=await context.newPage();await page.addInitScript(()=>{window.__opened=[];window.open=url=>{window.__opened.push(url);return null;};});await page.goto(`chrome-extension://${id}/popup.html`);await page.waitForFunction(()=>document.querySelector('#root')?.children.length>0&&!document.body.innerText.includes('正在检查通知'));return page;};
 const oldId=await run();const oldPage=await open(oldId);const before=await oldPage.evaluate(()=>({version:chrome.runtime.getManifest().version,forced:document.body.innerText.includes('真实包升级验证')}));await oldPage.getByRole('button',{name:'下载最新版本'}).click();const afterClick=await oldPage.evaluate(()=>({forced:document.body.innerText.includes('真实包升级验证'),opened:window.__opened}));await context.close();context=null;
 fs.cpSync(unpacked,extension,{recursive:true});const newId=await run();const newPage=await open(newId);const afterUpgrade=await newPage.evaluate(()=>({version:chrome.runtime.getManifest().version,forced:document.body.innerText.includes('真实包升级验证')}));const policy=await api('GET','/api/extension/popup-policy');
 const result={before,afterClick,afterUpgrade,sameExtensionId:oldId===newId,downloadBytes:bytes.length,downloadMatchesDeliveredZip:bytes.equals(fs.readFileSync(path.join(source,'popup-1.15.1.zip'))),requiredVersionStill:policy.forcedUpdate?.requiredVersion,recordStillPublished:policy.forcedUpdate?.recordId===record,backend:BASE};result.passed=before.version==='1.15.0'&&before.forced&&afterClick.forced&&afterClick.opened[0]===DOWNLOAD&&afterUpgrade.version==='1.15.1'&&!afterUpgrade.forced&&result.sameExtensionId&&result.requiredVersionStill==='1.15.1'&&result.recordStillPublished;
 fs.writeFileSync(path.join(folder,'upgrade-observations.json'),JSON.stringify(result,null,2),'utf-8');console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(context)await context.close();if(record)await api('POST',`/api/admin/popup-policies/${record}/withdraw`,{});if(server)await new Promise(r=>server.close(r));});
''', encoding='utf-8')
print('Upgrade and adjusted UI fixtures prepared')
