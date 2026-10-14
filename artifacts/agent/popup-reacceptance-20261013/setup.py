from pathlib import Path

# Owner: Codex independent reacceptance 2026-10-13; do not edit product files.
root = next(p for p in Path(__file__).resolve().parents if (p / 'AGENTS.md').exists())
folder = root / '.agent-tmp/popup-reacceptance-20261013'
folder.mkdir(parents=True, exist_ok=True)
(folder/'OWNER.txt').write_text('Codex independent popup reacceptance 2026-10-13; local test data only.\n',encoding='utf-8')
original = (root/'artifacts/agent/popup-acceptance-20261013/reproduce.py').read_text(encoding='utf-8')
original = original.replace("'.agent-tmp/popup-acceptance-20261013'", "'.agent-tmp/popup-reacceptance-20261013'")
(folder/'generate_probe.py').write_text(original,encoding='utf-8')
seed = r'''const fs=require('node:fs');const path=require('node:path');const {createRequire}=require('node:module');const backendRequire=createRequire(path.resolve(__dirname,'../../backend/package.json'));const {createClient}=backendRequire('@libsql/client');const bcrypt=backendRequire('bcryptjs');
(async()=>{const dbPath=path.join(__dirname,'data/review.db');const client=createClient({url:`file:${dbPath}`});try{const hash=await bcrypt.hash('VerifyAdmin!2026',10);await client.execute({sql:"INSERT INTO users(email,password_hash,role,is_active,max_stores,auto_mode_enabled,trial_enabled) VALUES(?,?,'admin',1,10,1,0)",args:['verify-admin@example.invalid',hash]});console.log('Isolated fixture account created');}finally{client.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
'''
(folder/'seed.cjs').write_text(seed,encoding='utf-8')
print('Independent reacceptance setup prepared')
