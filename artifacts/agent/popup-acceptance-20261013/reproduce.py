from pathlib import Path

# Owner: Codex independent acceptance, 2026-10-13. No product source edits.
root = next(p for p in Path(__file__).resolve().parents if (p / 'AGENTS.md').exists())
folder = root / '.agent-tmp/popup-acceptance-20261013'
folder.mkdir(parents=True, exist_ok=True)
(folder / 'OWNER.txt').write_text('Codex independent popup acceptance 2026-10-13; isolated browser and generated bundles only.\n', encoding='utf-8')
entry = '''import React from 'react';
import { createRoot } from 'react-dom/client';
import { PopupPolicyHost } from '../../entrypoints/popup/PopupPolicyHost';
import { fetchPolicy } from '../../entrypoints/popup/popup-policy';
window.__probeFetchPolicy = fetchPolicy;
const host = React.createElement(PopupPolicyHost, null, React.createElement('button', null, 'underlying-app'));
const app = location.search.includes('strict=1') ? React.createElement(React.StrictMode, null, host) : host;
createRoot(document.getElementById('root')).render(app);
'''
(folder / 'probe-entry.tsx').write_text(entry, encoding='utf-8')
script = r'''const { build } = require('esbuild');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const folder = __dirname;
const root = path.resolve(folder, '../..');
let browser, server;
const observations = [];
async function run() {
  await build({entryPoints:[path.join(folder,'probe-entry.tsx')], bundle:true, outfile:path.join(folder,'probe.js'), platform:'browser', format:'iife', define:{'process.env.NODE_ENV':'"development"','import.meta.env.VITE_BACKEND_URL':'"http://127.0.0.1:59998"'}});
  server = http.createServer((req,res) => {
    if (req.url.startsWith('/probe.js')) {res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(folder,'probe.js')));return;}
    if (req.url.startsWith('/popup-assets/')) {res.statusCode=404;res.end('asset is not in popup origin');return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/probe.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true, executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',args:['--no-sandbox']});
  for (const [name,strict,storageReject,body] of [
    ['strict-empty',true,false,{notice:null,forcedUpdate:null}],
    ['strict-notice',true,false,{notice:{mode:'notice',revision:1,title:'probe-notice',contentHtml:'<p>body</p>',requiredVersion:null,downloadUrl:null,publishedAt:null},forcedUpdate:null}],
    ['control-without-strict',false,false,{notice:null,forcedUpdate:null}],
    ['storage-write-rejection',false,true,{notice:null,forcedUpdate:null}],
    ['relative-image',false,false,{notice:{mode:'notice',revision:1,title:'probe-image',contentHtml:'<p><img src="/popup-assets/00000000000000000000000000000000"></p>',requiredVersion:null,downloadUrl:null,publishedAt:null},forcedUpdate:null}],
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors=[];let requests=0;const responses=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({storageReject})=>{
      const data={};
      window.browser={runtime:{getManifest:()=>({version:'1.15.0'})},storage:{local:{get:async key=>({[key]:data[key]}),set:async values=>{if(storageReject)throw new Error('probe storage write rejected');Object.assign(data,values);}}}};
    },{storageReject});
    await page.route('http://127.0.0.1:59998/api/extension/popup-policy',async route=>{
      requests++;responses.push(200);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(`${base}/?strict=${strict?1:0}`);
    await page.waitForTimeout(5500);
    const observed=await page.evaluate(()=>({checking:document.body.innerText.includes('正在检查通知'),notice:document.body.innerText.includes('probe-notice'),images:Array.from(document.images).map(img=>({raw:img.getAttribute('src'),resolved:img.src,loaded:img.complete&&img.naturalWidth>0}))}));
    observations.push({name,requests,responses,...observed,errors});
    await context.close();
  }
  {
    const context=await browser.newContext();const page=await context.newPage();
    await page.addInitScript(()=>{const data={};window.browser={runtime:{getManifest:()=>({version:'1.15.0'})},storage:{local:{get:async key=>({[key]:data[key]}),set:async values=>Object.assign(data,values)}}};});
    let malformed=false;
    await page.route('http://127.0.0.1:59998/api/extension/popup-policy',async route=>{
      const body=malformed ? {} : {notice:null,forcedUpdate:{mode:'forced_update',revision:7,title:'cached-force',contentHtml:'<p>upgrade</p>',requiredVersion:'99.0.0',downloadUrl:'https://example.invalid/download',publishedAt:null}};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(`${base}/?strict=0`);await page.waitForFunction(()=>document.body.innerText.includes('cached-force'));
    malformed=true;
    const result=await page.evaluate(()=>window.__probeFetchPolicy('http://127.0.0.1:59998'));
    observations.push({name:'malformed-object-after-cached-force',source:result.source,forcedRetained:result.payload.forcedUpdate!==null,connectionError:result.connectionError});
    await context.close();
  }
  const expected=observations.map(row=>({name:row.name,pass:row.name==='malformed-object-after-cached-force' ? row.forcedRetained&&row.connectionError!==null : !row.checking && row.errors.length===0 && (row.name!=='relative-image'||row.images.every(i=>i.loaded))}));
  fs.writeFileSync(path.join(folder,'observations.json'),JSON.stringify({observations,acceptance:expected},null,2),'utf-8');
  for(const row of observations)console.log(JSON.stringify(row));
  console.log(JSON.stringify({acceptance:expected}));
}
run().catch(err=>{console.error(err.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
'''
(folder / 'probe.cjs').write_text(script, encoding='utf-8')
release = r'''const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const folder=__dirname;const root=path.resolve(folder,'../..');let server,context;
(async()=>{
 server=http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');if(req.url==='/api/extension/popup-policy'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({notice:{mode:'notice',revision:1,title:'release-image-probe',contentHtml:'<p><img src="/popup-assets/00000000000000000000000000000000"></p>',requiredVersion:null,downloadUrl:null,publishedAt:null},forcedUpdate:null}));return;}
 if(req.url.startsWith('/popup-assets/')){res.setHeader('Content-Type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=','base64'));return;}
 res.statusCode=401;res.setHeader('Content-Type','application/json');res.end('{"error":"isolated test, no account"}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 context=await chromium.launchPersistentContext(path.join(folder,'profile-release'),{headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${path.join(root,'.output/chrome-mv3')}`,`--load-extension=${path.join(root,'.output/chrome-mv3')}`]});
 await context.route('**/*',async route=>{const url=route.request().url();if(url.startsWith('chrome-extension://')||url.startsWith(base))await route.continue();else await route.abort();});
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20000});const id=sw.url().split('/')[2];
 await sw.evaluate(async backendUrl=>chrome.storage.local.set({backendUrl}),base);
 const page=await context.newPage();const responses=[];const errors=[];const failed=[];page.on('pageerror',e=>errors.push(e.message.slice(0,300)));page.on('requestfailed',r=>failed.push({local:r.url().startsWith(base),extension:r.url().startsWith('chrome-extension://'),error:r.failure()?.errorText}));page.on('response',r=>{if(r.url().endsWith('/api/extension/popup-policy'))responses.push(r.status());});
 await page.goto(`chrome-extension://${id}/popup.html`);await page.waitForTimeout(6500);
 const data=await page.evaluate(()=>({version:chrome.runtime.getManifest().version,rootMounted:document.querySelector('#root')?.children.length>0,checking:document.body.innerText.includes('正在检查通知'),noticeDisplayed:document.body.innerText.includes('release-image-probe'),images:Array.from(document.images).map(img=>({raw:img.getAttribute('src'),resolved:img.src,loaded:img.complete&&img.naturalWidth>0}))}));
 const result={environment:'current static release package; isolated no-cookie profile',...data,responses,errors,failed};fs.writeFileSync(path.join(folder,'release-observations.json'),JSON.stringify(result,null,2),'utf-8');console.log(JSON.stringify(result));
})().catch(err=>{console.error(err.stack);process.exitCode=1;}).finally(async()=>{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));});
'''
(folder / 'release.cjs').write_text(release, encoding='utf-8')
print('Acceptance probe generated')
