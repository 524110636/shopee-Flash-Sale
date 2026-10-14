from pathlib import Path

folder = Path(__file__).resolve().parent
(folder/'data').mkdir(exist_ok=True)
(folder/'assets').mkdir(exist_ok=True)
(folder/'OWNER.txt').write_text('Codex U1–U3 独立验收，2026-10-14；仅自己的隔离数据库、夹具、浏览器与证据。\n', encoding='utf-8')
(folder/'api-probe.cjs').write_text(r'''const fs=require('node:fs');const path=require('node:path');const {createRequire}=require('node:module');
const req=createRequire(path.resolve(__dirname,'../../backend/package.json'));const {createClient}=req('@libsql/client');const bcrypt=req('bcryptjs');
const BASE='http://127.0.0.1:5802';let client;const results=[];
async function api(method,url,body,token){const r=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
async function token(email){const result=await api('POST','/api/auth/login',{email,password:'LocalReview!2026'});if(!result.body.token)throw Error('Fixture login failed');return result.body.token;}
(async()=>{
 client=createClient({url:`file:${path.join(__dirname,'data/review.db')}`});const hash=await bcrypt.hash('LocalReview!2026',10);
 const names=['admin','admin2','valid','invalid','omitted','stale'];
 for(const name of names)await client.execute({sql:'INSERT INTO users(email,password_hash,role,is_active,max_stores,auto_mode_enabled,trial_enabled) VALUES(?,?,?,1,1,0,0)',args:[`${name}@review.invalid`,hash,name.startsWith('admin')?'admin':'user']});
 const admin=await token('admin@review.invalid');const admin2=await token('admin2@review.invalid');const valid=await token('valid@review.invalid');
 const record=(await api('POST','/api/admin/popup-policies',{mode:'notice',title:'独立统计复核',contentHtml:'<p>仅隔离测试</p>'},admin)).body.record.recordId;
 const draft=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision:1},valid);results.push({name:'draft-rejected',response:draft,passed:draft.body.counted===false});
 const pub=await api('POST',`/api/admin/popup-policies/${record}/publish`,{},admin);const revision=pub.body.revision;
 const first=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision},valid);
 await Promise.all(Array.from({length:5},()=>api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision},valid)));
 const viewers=await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,admin);results.push({name:'valid-and-concurrent-dedup',first:first.body,total:viewers.body.total,viewers:viewers.body.viewers,passed:first.body.counted===true&&viewers.body.total===1});
 const ordinary=await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,valid);const anon=await api('GET',`/api/admin/popup-policies/${record}/viewers`);results.push({name:'viewer-authorization',ordinaryStatus:ordinary.status,anonymousStatus:anon.status,passed:ordinary.status===403&&anon.status===401});
 for(const [name,reportedRevision] of [['invalid',999999],['omitted',undefined]]){
   const t=await token(`${name}@review.invalid`);const before=(await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,admin)).body.total;
   const response=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',...(reportedRevision===undefined?{}:{revision:reportedRevision})},t);
   const after=(await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,admin)).body.total;
   results.push({name:`${name}-revision-must-not-increment`,actualRevision:revision,reportedRevision:reportedRevision??'missing',response:response.body,before,after,passed:response.body.counted===false&&after===before});
 }
 const next=(await api('POST',`/api/admin/popup-policies/${record}/publish`,{},admin)).body.revision;
 const staleToken=await token('stale@review.invalid');const stale=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision},staleToken);
 results.push({name:'old-revision-after-republish',actualRevision:next,reportedRevision:revision,response:stale.body,passed:stale.body.counted===false});
 await api('POST',`/api/admin/popup-policies/${record}/withdraw`,{},admin);const retained=(await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,admin)).body;
 const late=await api('POST','/api/extension/popup-views',{recordId:record,mode:'notice',revision:next},valid);results.push({name:'withdraw-retains-and-rejects-late',total:retained.total,response:late.body,passed:retained.total>=1&&late.body.counted===false});
 await client.execute({sql:"UPDATE users SET role='user' WHERE email=?",args:['admin2@review.invalid']});const revoked=await api('GET',`/api/admin/popup-policies/${record}/viewers`,undefined,admin2);results.push({name:'revoked-admin-token-rejected',status:revoked.status,passed:revoked.status===403});
 fs.writeFileSync(path.join(__dirname,'api-observations.json'),JSON.stringify(results,null,2),'utf-8');console.log(JSON.stringify(results));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>client?.close());
''', encoding='utf-8')
print('Independent review fixtures prepared')
