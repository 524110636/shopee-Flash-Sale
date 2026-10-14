from pathlib import Path
import json
import re
import shutil

folder=Path(__file__).resolve().parent
root=folder.parent.parent
previous=root/'.agent-tmp/popup-u1u3-review-20261014'
for name in ['data','assets']:
    (folder/name).mkdir(exist_ok=True)
(folder/'OWNER.txt').write_text('Codex F1／F2 独立复核和用户体验，2026-10-14；仅独立测试数据库、账号、包、下载与浏览器。\n',encoding='utf-8')
for name in ['api-probe.cjs','browser-probe.cjs','extract_package.py']:
    text=(previous/name).read_text(encoding='utf-8').replace('127.0.0.1:5802','127.0.0.1:5799')
    (folder/name).write_text(text,encoding='utf-8')
text=(previous/'upgrade-probe.cjs').read_text(encoding='utf-8')
text=re.sub(r'1\.15\.[01]',lambda m:{'1.15.0':'1.15.1','1.15.1':'1.15.2'}[m.group()],text)
text=text.replace('127.0.0.1:5802','127.0.0.1:5799').replace('127.0.0.1:5803','127.0.0.1:5798').replace('server.listen(5803','server.listen(5798')
(folder/'upgrade-probe.cjs').write_text(text,encoding='utf-8')
(folder/'format-probe.cjs').write_text(r'''const fs=require('node:fs');const path=require('node:path');const BASE='http://127.0.0.1:5799';let admin;const result=[];
async function api(method,url,body,token=admin){const r=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return r.json();}
(async()=>{
 admin=(await api('POST','/api/auth/login',{email:'admin@review.invalid',password:'LocalReview!2026'},null)).token;
 const user=(await api('POST','/api/auth/login',{email:'invalid@review.invalid',password:'LocalReview!2026'},null)).token;
 const record=(await api('POST','/api/admin/popup-policies',{mode:'notice',title:'全局修订核对',contentHtml:'<p>test</p>'})).record.recordId;const revision=(await api('POST',`/api/admin/popup-policies/${record}/publish`,{})).revision;
 for(const value of [0,-1,0.5,9007199254740992,'1',null,1]){const response=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision:value},user);result.push({reportedRevision:value,actualGlobalRevision:revision,response,passed:response.counted===false});}
 const before=(await api('GET',`/api/admin/popup-policies/${record}/viewers`)).total;const good=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision},user);const after=(await api('GET',`/api/admin/popup-policies/${record}/viewers`)).total;
 result.push({name:'global-slot-revision-valid-record-counter-different',revision,before,after,response:good,passed:revision>1&&before===0&&after===1&&good.counted===true});await api('POST',`/api/admin/popup-policies/${record}/withdraw`,{});
 fs.writeFileSync(path.join(__dirname,'format-observations.json'),JSON.stringify(result,null,2),'utf-8');console.log(JSON.stringify(result));if(result.some(r=>!r.passed))process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
''',encoding='utf-8')

source=root/'.agent-tmp/extension-announcements-and-forced-update/packages'
old=folder/'old-1.15.1'
if not old.exists():
    shutil.copytree(source/'popup-1.15.1',old)
    manifest=json.loads((old/'manifest.json').read_text(encoding='utf-8'))
    manifest['name']='限时特卖助手（弹窗验收）'
    (old/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
shutil.copyfile(source/'popup-1.15.2.zip',folder/'popup-1.15.2.zip')
(folder/'experience.config.ts').write_text('''import { defineConfig } from 'wxt';
import base from '../../wxt.config';
export default defineConfig({
  ...base,
  outDir: '.agent-tmp/popup-f12-review-20261014/built',
  manifest: (env) => ({...base.manifest(env), name: '限时特卖助手（弹窗验收）'}),
});
''',encoding='utf-8')
(folder/'启动测试环境.cmd').write_text('''@echo off
cd /d "%~dp0"
node experience-server.cjs
pause
''',encoding='utf-8')
(folder/'构建新版测试包.cmd').write_text('''@echo off
cd /d "%~dp0..\\.."
set VITE_BACKEND_URL=http://localhost:5799
set VITE_BACKEND_FALLBACK_URL=
call npx wxt build --mode development -c .agent-tmp/popup-f12-review-20261014/experience.config.ts
if errorlevel 1 goto failed
python -X utf8 .agent-tmp/popup-f12-review-20261014/package_new.py
:failed
pause
''',encoding='utf-8')
(folder/'package_new.py').write_text('''from pathlib import Path
import json
import re
import zipfile
folder=Path(__file__).resolve().parent
root=folder.parent.parent
package=folder/'built/chrome-mv3-dev'
source_version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
actual_version=json.loads((package/'manifest.json').read_text(encoding='utf-8'))['version']
if source_version != actual_version or actual_version != '1.15.2':
    raise RuntimeError('Expected source and actual manifest both at 1.15.2')
for script in package.rglob('*.js'):
    if '43.99.86.228' in script.read_text(encoding='utf-8'):
        raise RuntimeError('Unexpected production backend in test package')
with zipfile.ZipFile(folder/'popup-1.15.2.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for file in package.rglob('*'):
        if file.is_file():
            archive.write(file,file.relative_to(package))
print('Test version 1.15.2 packaged; download http://127.0.0.1:5798/popup-1.15.2.zip')
''',encoding='utf-8')
(folder/'experience-server.cjs').write_text(r'''const path=require('node:path');const fs=require('node:fs');const http=require('node:http');const net=require('node:net');const {spawn}=require('node:child_process');
const folder=__dirname;const root=path.resolve(folder,'../..');let child,download;
const free=port=>new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`Port ${port} is occupied; stop this test console before restarting`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
(async()=>{
 await free(5799);await free(5798);
 const log=fs.openSync(path.join(folder,'experience-server.log'),'a');
 child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:path.join(root,'backend'),windowsHide:true,env:{...process.env,DB_PATH:path.join(folder,'data/review.db'),POPUP_ASSETS_DIR:path.join(folder,'assets'),ADMIN_WEB_DIST:path.join(root,'admin-web/dist'),PORT:'5799',JWT_SECRET:'codex-f12-review-20261014'},stdio:['ignore',log,log]});
 child.on('exit',()=>{download?.close();});
 for(let i=0;i<30;i++){try{const r=await fetch('http://localhost:5799/api/extension/popup-policy');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,200));if(i===29)throw Error('Backend did not start; inspect experience-server.log');}
 download=http.createServer((req,res)=>{if(req.url!=='/popup-1.15.2.zip'){res.statusCode=404;res.end();return;}res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition','attachment; filename="popup-1.15.2.zip"');res.end(fs.readFileSync(path.join(folder,'popup-1.15.2.zip')));});
 await new Promise((resolve,reject)=>{download.once('error',reject);download.listen(5798,'127.0.0.1',resolve);});
 console.log('Ready: http://localhost:5799/admin/');console.log('Account: admin@review.invalid / LocalReview!2026');console.log('New package: http://127.0.0.1:5798/popup-1.15.2.zip');console.log('Keep this test console open. Close it after testing.');
})().catch(e=>{console.error(e.message);child?.kill();download?.close();process.exitCode=1;});
function stop(){child?.kill();download?.close(()=>process.exit());if(!download)process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>child?.kill());
''',encoding='utf-8')
print('Focused probes and repeatable user test environment prepared')
