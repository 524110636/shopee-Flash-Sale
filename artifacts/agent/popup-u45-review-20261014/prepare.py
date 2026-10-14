from pathlib import Path

folder = Path(__file__).resolve().parent
(folder/'OWNER.txt').write_text('Codex independent U4 U5 acceptance. Mock local requests only; no store or production writes.\n', encoding='utf-8')
(folder/'vitest.config.ts').write_text("""import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({resolve:{alias:{'@':resolve(__dirname,'../..')}},test:{include:['.agent-tmp/popup-u45-review-20261014/review.test.tsx'],environment:'jsdom',testTimeout:10000}});
""", encoding='utf-8')
(folder/'review.test.tsx').write_text(r'''import {it,expect,vi} from 'vitest';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const storage:Record<string,any>={};
(globalThis as any).browser={storage:{local:{get:async(k:string)=>({[k]:storage[k]}),set:async(o:any)=>Object.assign(storage,o),remove:async(k:string)=>{delete storage[k];}}},runtime:{getManifest:()=>({version:'1.15.2'})}};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const api=await import('@/entrypoints/popup/backend-api');
const {reportPopupView}=await import('@/entrypoints/popup/popup-views');
const {PopupPolicyHost}=await import('@/entrypoints/popup/PopupPolicyHost');
const base='http://localhost:5804';
function token(id:number){const b=(v:any)=>Buffer.from(JSON.stringify(v)).toString('base64url');return `${b({alg:'HS256'})}.${b({userId:id,email:`viewer${id}@review.invalid`,role:'user',iat:1,exp:4000000000})}.signature`;}
async function login(id:number){await api.saveAuthToStorage(token(id),{id,email:`viewer${id}@review.invalid`,role:'user',autoModeEnabled:0,trialUsed:0,trialEnabled:1});}
const pause=()=>new Promise(r=>setTimeout(r,15));
it('same account repeated actual displays send once',async()=>{
 const seen:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_u:any,i:any)=>{seen.push(i.headers.Authorization);return new Response('{}');}));await login(101);
 const a=reportPopupView(base,'same-account','notice',1,()=>true);a();const b=reportPopupView(base,'same-account','notice',1,()=>true);b();await pause();expect(seen).toEqual([`Bearer ${token(101)}`]);vi.unstubAllGlobals();
});
it('logout then different account in same popup must report both real displays',async()=>{
 const seen:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_u:any,i:any)=>{seen.push(i.headers.Authorization);return new Response('{}');}));
 await login(102);const stop=reportPopupView(base,'same-popup-two-accounts','notice',7,()=>true);await pause();stop();await api.clearAuth();
 await login(103);const stop2=reportPopupView(base,'same-popup-two-accounts','notice',7,()=>true);await pause();stop2();
 const observed=seen.map(t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString()).userId);console.log('same_popup_expected_accounts=[102,103]; actual_accounts='+JSON.stringify(observed));
 vi.unstubAllGlobals();expect(observed).toEqual([102,103]);
});
it('unmount drops late policy response and does not report displayed view',async()=>{
 await api.clearAuth();await login(104);storage.backendUrl=base;
 let release!:(v:Response)=>void;const reports:any[]=[];
 vi.stubGlobal('fetch',vi.fn((u:any,i:any)=>{if(String(u).endsWith('/popup-views')){reports.push(i);return Promise.resolve(new Response('{}'));}return new Promise<Response>(r=>{release=r;});}));
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 await act(async()=>root.render(<PopupPolicyHost><button>functional area</button></PopupPolicyHost>));await pause();expect(div.textContent).toContain('正在检查通知');
 await act(async()=>root.unmount());await act(async()=>release(new Response(JSON.stringify({notice:{recordId:'late',mode:'notice',revision:1,title:'late response',contentHtml:'<p>late</p>',requiredVersion:null,downloadUrl:null,publishedAt:null},forcedUpdate:null}))));
 await pause();expect(reports).toHaveLength(0);expect(div.textContent).toBe('');div.remove();vi.unstubAllGlobals();
});
it('real host unmount and remount across accounts shows both but reports both',async()=>{
 storage.backendUrl=base;const seen:number[]=[];
 vi.stubGlobal('fetch',vi.fn(async(u:any,i:any)=>{if(String(u).endsWith('/popup-views')){seen.push(JSON.parse(Buffer.from(i.headers.Authorization.split('.')[1],'base64url').toString()).userId);return new Response('{}');}return new Response(JSON.stringify({notice:null,forcedUpdate:{recordId:'11111111-2222-3333-4444-555555555555',mode:'forced_update',revision:11,title:'host-account-check',contentHtml:'<p>test</p>',requiredVersion:'1.15.3',downloadUrl:base+'/download.zip',publishedAt:null}}));}));
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div);
 await login(105);await act(async()=>{root.render(<PopupPolicyHost><button>functional A</button></PopupPolicyHost>);await pause();});await act(async()=>{await pause();});expect(div.textContent).toContain('host-account-check');
 await act(async()=>root.render(<div>login screen</div>));await api.clearAuth();await login(106);
 await act(async()=>{root.render(<PopupPolicyHost><button>functional B</button></PopupPolicyHost>);await pause();});await act(async()=>{await pause();});expect(div.textContent).toContain('host-account-check');
 console.log('real_host_both_displayed=true; expected_accounts=[105,106]; actual_accounts='+JSON.stringify(seen));await act(async()=>root.unmount());div.remove();vi.unstubAllGlobals();expect(seen).toEqual([105,106]);
});
''', encoding='utf-8')
(folder/'browser-probe.cjs').write_text(r'''const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {chromium}=require('playwright');const folder=__dirname,root=path.resolve(folder,'../..');let server,ctx;
const results=[],errors=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));const exe='C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
function check(name,passed,detail){results.push({name,passed,detail});console.log(JSON.stringify(results.at(-1)));}
const user={id:201,email:'viewer201@review.invalid',role:'admin',autoModeEnabled:0,trialUsed:0,trialEnabled:1};const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const token=b({alg:'HS256'})+'.'+b({userId:user.id,email:user.email,role:user.role,iat:1,exp:4000000000})+'.signature';
const entry=(mode)=>({recordId:mode==='notice'?'11111111-2222-3333-4444-555555555555':'22222222-2222-3333-4444-555555555555',mode,revision:1,title:mode==='notice'?'独立登录后通知':'独立登录后强制',contentHtml:'<p>验收内容</p>',requiredVersion:mode==='notice'?null:'1.15.3',downloadUrl:mode==='notice'?null:'http://localhost:5804/download.zip',publishedAt:new Date().toISOString()});
(async()=>{
 server=http.createServer((req,res)=>{let rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/admin\/?/,'');if(!rel||!path.extname(rel))rel='index.html';const file=path.resolve(folder,'admin-dist',rel);if(!file.startsWith(path.resolve(folder,'admin-dist')+path.sep)){res.writeHead(403);res.end();return;}try{const data=fs.readFileSync(file);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}});await new Promise((r,j)=>{server.on('error',j);server.listen(5804,'127.0.0.1',r);});
 const pkg=path.join(root,'.output/chrome-mv3');ctx=await chromium.launchPersistentContext(path.join(folder,'profile'),{headless:true,executablePath:exe,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${pkg}`,`--load-extension=${pkg}`]});
 let policy={notice:entry('notice'),forcedUpdate:entry('forced_update')},authDelay=0,bindingDelay=0,viewCount=0,failList=false,listDelay=0;const traffic=[];
 const record={recordId:'notice',mode:'notice',status:'published',isActive:true,viewCount:0,draft:{title:'独立刷新通知',contentHtml:'<p>正文</p>',requiredVersion:null,downloadUrl:null,updatedAt:null},published:null,createdAt:null};
 await ctx.route('**/*',async route=>{const req=route.request(),url=req.url();if(url.startsWith('chrome-extension://'))return route.continue();if(!url.startsWith('http://127.0.0.1:5804')&&!url.startsWith('http://localhost:5804'))return route.abort();const pathname=new URL(url).pathname;if(!pathname.startsWith('/api/'))return route.continue();traffic.push({path:pathname,method:req.method()});let payload={};let status=200;
 if(pathname==='/api/auth/login'){const body=req.postDataJSON();if(body.password==='wrong'){payload={error:'登录失败'};status=401;}else payload={token,user};}
 else if(pathname==='/api/auth/check-admin'){await pause(authDelay);payload={isAdmin:true,autoModeEnabled:0,trialUsed:0,trialEnabled:1};}
 else if(pathname==='/api/stores'){await pause(bindingDelay);payload={stores:[]};}
 else if(pathname==='/api/extension/popup-policy')payload=policy;
 else if(pathname==='/api/extension/popup-views'){viewCount=1;payload={counted:true};}
 else if(pathname==='/api/admin/popup-policies'){await pause(listDelay);status=failList?500:200;payload=failList?{error:'独立测试刷新失败'}:{records:[{...record,viewCount}],total:1,slots:[]};}
 else if(pathname.endsWith('/viewers'))payload={total:viewCount,viewers:viewCount?[{userId:user.id,email:user.email,firstViewedAt:new Date().toISOString()}]:[],page:1,pageSize:20};
 else if(pathname==='/api/health')payload={ok:true};
 return route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload),headers:{'Access-Control-Allow-Origin':'*'}});});
 const sw=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');const id=sw.url().split('/')[2];await sw.evaluate(async()=>{await chrome.storage.local.clear();await chrome.storage.local.set({backendUrl:'http://localhost:5804'});});
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`chrome-extension://${id}/popup.html`);await page.locator('input[placeholder="邮箱"]').waitFor();
 check('P18 anonymous both modes: no policy/check/report',!(await page.locator('body').innerText()).includes('独立登录后')&&!traffic.some(x=>x.path.includes('popup-policy')||x.path.includes('popup-views')),traffic);
 await page.locator('input[placeholder="邮箱"]').fill(user.email);await page.locator('input[placeholder="密码"]').fill('wrong');await page.getByRole('button',{name:/^登录$/}).click();await page.waitForTimeout(200);check('P18 failed login remains uncovered',await page.locator('input[placeholder="邮箱"]').isVisible()&&!traffic.some(x=>x.path==='/api/extension/popup-policy'));
 bindingDelay=1200;await page.locator('input[placeholder="密码"]').fill('valid');await page.getByRole('button',{name:/^登录$/}).click();await page.waitForTimeout(350);check('P19 first binding waits without policy start',!traffic.some(x=>x.path==='/api/extension/popup-policy'),await page.locator('body').innerText());
 await page.getByText('独立登录后强制',{exact:true}).waitFor();check('P19 same popup login forced appears',await page.getByRole('button',{name:'下载最新版本'}).isVisible());await page.keyboard.press('Escape');check('P19 forced remains after Escape',await page.getByText('独立登录后强制',{exact:true}).isVisible());await page.waitForTimeout(100);check('P19 real shown force reported once hidden notice not reported',traffic.filter(x=>x.path==='/api/extension/popup-views').length===1);
 await page.close();policy={notice:entry('notice'),forcedUpdate:null};bindingDelay=0;const p2=await ctx.newPage();await p2.goto(`chrome-extension://${id}/popup.html`);await p2.getByText('独立登录后通知',{exact:true}).waitFor();check('P19 valid saved login cold start notice',await p2.getByRole('button',{name:'我知道了'}).isVisible());await p2.getByRole('button',{name:'我知道了'}).click();await p2.close();
 const expired=b({alg:'HS256'})+'.'+b({userId:user.id,email:user.email,role:user.role,iat:1,exp:2})+'.signature';const cached={'http://localhost:5804':{notice:null,forcedUpdate:entry('forced_update')}};
 await sw.evaluate(async data=>chrome.storage.local.set(data),{backendAuth:{token:expired,user},_popupPolicyCache:cached});authDelay=1200;const authTrafficStart=traffic.length;const p3=await ctx.newPage();await p3.goto(`chrome-extension://${id}/popup.html`);await p3.waitForTimeout(300);check('P18 slow identity restoration ignores forced cache',!(await p3.locator('body').innerText()).includes('独立登录后')&&!traffic.slice(authTrafficStart).some(x=>x.path.includes('popup-policy')||x.path.includes('popup-views')));await p3.locator('input[placeholder="邮箱"]').waitFor();check('P18 expired credentials no popup or report',!traffic.slice(authTrafficStart).some(x=>x.path.includes('popup-policy')||x.path.includes('popup-views')));const retained=await sw.evaluate(()=>chrome.storage.local.get('_popupPolicyCache'));check('P18 forced cache retained unchanged',require('node:util').isDeepStrictEqual(retained._popupPolicyCache,cached),{expected:cached,actual:retained._popupPolicyCache});await p3.close();authDelay=0;
 const browserPage=await ctx.newPage();browserPage.on('pageerror',e=>errors.push(e.message));await browserPage.goto('http://127.0.0.1:5804/admin/');await browserPage.locator('input').first().fill(user.email);await browserPage.locator('input[type=password]').fill('valid');await browserPage.getByRole('button',{name:/登\s*录/}).click();await browserPage.getByRole('menuitem').filter({hasText:'弹窗管理'}).click();const row=browserPage.locator('.ant-table-row').filter({hasText:'独立刷新通知'});await row.waitFor();
 const refresh=browserPage.getByRole('button',{name:/刷\s*新/}),newBtn=browserPage.getByRole('button',{name:'新建弹窗'});const a=await refresh.boundingBox(),c=await newBtn.boundingBox();check('P20 refresh left of New',a.x<c.x&&Math.abs(a.y-c.y)<5);
 viewCount=0;await refresh.click();await browserPage.waitForTimeout(350);check('P20 baseline real current count0',(await row.innerText()).includes('共 0 位用户查看过'));
 viewCount=1;listDelay=600;const before=traffic.length;await refresh.click();await refresh.click({force:true});await browserPage.waitForTimeout(850);check('P20 refreshed count1 no duplicate GET',(await row.innerText()).includes('共 1 位用户查看过')&&traffic.slice(before).filter(x=>x.path==='/api/admin/popup-policies').length===1,traffic.slice(before));
 await row.locator('a').click();await browserPage.getByText(user.email,{exact:true}).last().waitFor();check('P20 viewer detail fetched latest account',(await browserPage.locator('.ant-modal-content').innerText()).includes(user.email));await browserPage.locator('.ant-modal-content').getByRole('button',{name:/关\s*闭/}).click();
 listDelay=0;failList=true;await refresh.click();await browserPage.getByText('加载弹窗列表失败',{exact:true}).waitFor();check('P20 failure keeps count1',(await row.innerText()).includes('共 1 位用户查看过'));failList=false;await browserPage.getByRole('button',{name:/重\s*试/}).click();await browserPage.waitForTimeout(350);check('P20 retry clears error',await browserPage.getByText('加载弹窗列表失败',{exact:true}).count()===0);
 check('P20 refresh only reads',!traffic.slice(before).some(x=>x.method!=='GET'),traffic.slice(before));check('versions still1.15.2',JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version==='1.15.2'&&JSON.parse(fs.readFileSync(path.join(pkg,'manifest.json'))).version==='1.15.2');
})().catch(e=>{errors.push(e.stack);console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(ctx)await ctx.close();if(server)await new Promise(r=>server.close(r));fs.writeFileSync(path.join(folder,'browser-observations.json'),JSON.stringify({results,errors,mode:'real delivered extension and isolated current admin build; all backend and store requests intercepted'},null,2),'utf-8');if(results.some(r=>!r.passed))process.exitCode=1;});
''', encoding='utf-8')
print('Independent probes prepared')
