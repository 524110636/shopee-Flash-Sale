from pathlib import Path
folder=Path(__file__).resolve().parent
(folder/'f3').mkdir(exist_ok=True)
(folder/'vitest-f3.config.ts').write_text("""import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({resolve:{alias:{'@':resolve(__dirname,'../..')}},test:{include:['.agent-tmp/popup-u45-review-20261014/f3-integration.test.tsx'],environment:'jsdom',testTimeout:10000}});
""",encoding='utf-8',newline='\n')
(folder/'f3-integration.test.tsx').write_text(r'''import {it,expect,vi} from 'vitest';
import React,{act} from 'react';import {createRoot} from 'react-dom/client';
const store:Record<string,unknown>={backendUrl:'http://127.0.0.1:5805'};
(globalThis as any).browser={storage:{local:{get:async(k:string)=>({[k]:store[k]}),set:async(o:any)=>Object.assign(store,o),remove:async(k:string)=>{delete store[k];}}},runtime:{getManifest:()=>({version:'1.15.2'})}};(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const api=await import('@/entrypoints/popup/backend-api');const {PopupPolicyHost}=await import('@/entrypoints/popup/PopupPolicyHost');const {reportPopupView}=await import('@/entrypoints/popup/popup-views');
const base='http://127.0.0.1:5805',nativeFetch=globalThis.fetch;const pause=()=>new Promise(r=>setTimeout(r,20));
async function call(method:string,url:string,body?:unknown,token?:string){return (await nativeFetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})})).json();}
async function signIn(name:string){const data=await call('POST','/api/auth/login',{email:`${name}@f3-review.invalid`,password:'IsolatedF3!2026'});expect(data.token).toBeTruthy();await api.saveAuthToStorage(data.token,data.user);return data;}
function idOf(token:string){return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).userId;}
it('real backend: same host realm A logout B shows same force; total2 and both accounts',async()=>{
 const admin=await call('POST','/api/auth/login',{email:'admin@f3-review.invalid',password:'IsolatedF3!2026'});const created=await call('POST','/api/admin/popup-policies',{mode:'forced_update',title:'F3 独立同会话计数',contentHtml:'<p>仅隔离验收</p>',requiredVersion:'1.15.3',downloadUrl:base+'/admin/'},admin.token);const recordId=created.record.recordId;await call('POST',`/api/admin/popup-policies/${recordId}/publish`,{},admin.token);
 const viewers=()=>call('GET',`/api/admin/popup-policies/${recordId}/viewers`,undefined,admin.token);const requests:number[]=[],pending:Promise<any>[]=[];
 vi.stubGlobal('fetch',(url:any,init:any)=>{const request=nativeFetch(url,init);if(String(url).endsWith('/popup-views')){requests.push(idOf(init.headers.Authorization.slice(7)));pending.push(request);}return request;});
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div);let a:any,b:any;
 async function display(name:string){await api.clearAuth();const data=await signIn(name);await act(async()=>root.render(<PopupPolicyHost><div>functional area</div></PopupPolicyHost>));for(let i=0;i<150&&!div.textContent?.includes('F3 独立同会话计数');i++)await act(async()=>{await pause();});expect(div.textContent).toContain('F3 独立同会话计数');for(let i=0;i<10&&pending.length===0;i++)await act(async()=>{await pause();});await Promise.all(pending);pending.length=0;return data;}
 try{
  a=await display('a');expect((await viewers()).total).toBe(1);await act(async()=>root.render(<div>login screen</div>));
  b=await display('b');let detail=await viewers();expect(detail.total).toBe(2);expect(new Set(detail.viewers.map((v:any)=>v.email))).toEqual(new Set(['a@f3-review.invalid','b@f3-review.invalid']));expect(requests).toEqual([a.user.id,b.user.id]);
  await act(async()=>root.render(<div>login screen</div>));await display('a');expect((await viewers()).total).toBe(2);expect(requests).toEqual([a.user.id,b.user.id]);
  await act(async()=>root.render(<div>login screen</div>));await display('b');expect((await viewers()).total).toBe(2);expect(requests).toEqual([a.user.id,b.user.id]);
  console.log(JSON.stringify({phase:'real-backend-same-module',accounts:detail.viewers.map((v:any)=>v.email),total:detail.total,postUserIds:requests}));
 }finally{await act(async()=>root.unmount());div.remove();vi.unstubAllGlobals();await call('POST',`/api/admin/popup-policies/${recordId}/withdraw`,{},admin.token);}
});
it('old A failure deletes A captured key only; B remains deduplicated',async()=>{
 let rejectA!:(e:Error)=>void;const calls:number[]=[];
 vi.stubGlobal('fetch',vi.fn((_u:any,init:any)=>{const id=idOf(init.headers.Authorization.slice(7));calls.push(id);if(calls.length===1)return new Promise<Response>((_resolve,reject)=>{rejectA=reject;});return Promise.resolve(new Response('{}'));}));
 const a=await signIn('a');reportPopupView(base,'failure-cleanup', 'notice',33,()=>true)();await api.clearAuth();const b=await signIn('b');reportPopupView(base,'failure-cleanup','notice',33,()=>true)();await pause();rejectA(new Error('simulated old A request failure'));await pause();
 reportPopupView(base,'failure-cleanup','notice',33,()=>true)();await api.clearAuth();await signIn('a');reportPopupView(base,'failure-cleanup','notice',33,()=>true)();await pause();expect(calls).toEqual([a.user.id,b.user.id,a.user.id]);vi.unstubAllGlobals();
});
it('same user with refreshed token keeps dedup by account',async()=>{
 const calls:number[]=[];vi.stubGlobal('fetch',vi.fn(async(_u:any,i:any)=>{calls.push(idOf(i.headers.Authorization.slice(7)));return new Response('{}');}));const data=await signIn('a');reportPopupView(base,'token-rotation','notice',34,()=>true)();await pause();const jwt=data.token.split('.');const payload=JSON.parse(Buffer.from(jwt[1],'base64url').toString());payload.iat+=1;jwt[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');await api.saveAuthToStorage(jwt.join('.'),data.user);reportPopupView(base,'token-rotation','notice',34,()=>true)();await pause();expect(calls).toEqual([data.user.id]);vi.unstubAllGlobals();
});
''',encoding='utf-8',newline='\n')
(folder/'run-f3.cjs').write_text(r'''const fs=require('node:fs'),path=require('node:path'),net=require('node:net');const {spawn}=require('node:child_process');const {createRequire}=require('node:module');const folder=__dirname,root=path.resolve(folder,'../..'),req=createRequire(path.join(root,'backend/package.json'));let child,client;let code=1;
const free=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(5805,'127.0.0.1',()=>s.close(resolve));});
const run=(args,opts)=>new Promise(resolve=>{const p=spawn(process.execPath,args,{windowsHide:true,...opts});p.on('exit',c=>resolve(c));});
(async()=>{await free();const log=fs.openSync(path.join(folder,'f3/server.log'),'w');child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:path.join(root,'backend'),windowsHide:true,env:{...process.env,PORT:'5805',DB_PATH:path.join(folder,'f3/review.db'),POPUP_ASSETS_DIR:path.join(folder,'f3/assets'),ADMIN_WEB_DIST:path.join(root,'admin-web/dist'),JWT_SECRET:'codex-independent-f3-20261014'},stdio:['ignore',log,log]});
 let ready=false;for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:5805/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('Own fixture not ready; inspect f3/server.log');
 client=req('@libsql/client').createClient({url:`file:${path.join(folder,'f3/review.db')}`});const hash=await req('bcryptjs').hash('IsolatedF3!2026',10);for(const name of ['admin','a','b'])await client.execute({sql:'INSERT INTO users(email,password_hash,role,is_active,max_stores,auto_mode_enabled,trial_enabled) VALUES(?,?,?,1,1,0,1) ON CONFLICT(email) DO NOTHING',args:[`${name}@f3-review.invalid`,hash,name==='admin'?'admin':'user']});client.close();client=null;
 code=await run([path.join(root,'node_modules/vitest/vitest.mjs'),'run','--config','.agent-tmp/popup-u45-review-20261014/vitest-f3.config.ts','--reporter=json','--outputFile=.agent-tmp/popup-u45-review-20261014/f3/integration-observations.json'],{cwd:root,stdio:'inherit'});
})().catch(e=>console.error(e.stack)).finally(async()=>{client?.close();if(child){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}process.exitCode=code;console.log('Own backend stopped; review exit='+code);});
''',encoding='utf-8',newline='\n')
print('Focused F3 real backend fixture prepared')
