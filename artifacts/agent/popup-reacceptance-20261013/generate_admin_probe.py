from pathlib import Path

# Owner: Codex independent reacceptance 2026-10-13. Local UI fixture only.
root = next(p for p in Path(__file__).resolve().parents if (p / 'AGENTS.md').exists())
folder = root / '.agent-tmp/popup-reacceptance-20261013'
folder.mkdir(parents=True, exist_ok=True)
script = r'''const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/52411/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});const context=await browser.newContext();await context.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:5797')?r.continue():r.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5797/admin/');await page.locator('input').first().fill('verify-admin@example.invalid');await page.locator('input[type=password]').fill('VerifyAdmin!2026');await page.getByRole('button',{name:/登\s*录/}).click();await page.getByRole('menuitem').filter({hasText:'弹窗管理'}).click();await page.waitForSelector('.ant-table');
 const listReady=(await page.locator('body').innerText()).includes('弹窗列表');await page.getByRole('button',{name:'新建弹窗'}).click();const modal=page.locator('.ant-modal-content');await modal.waitFor();const title=page.locator('input[placeholder="例如：重要更新提醒"]');const blankTitle=await title.inputValue();const before=await modal.innerText();await modal.locator('input[type=checkbox]').check();const after=await modal.innerText();await modal.getByRole('button',{name:'取消'}).click();
 const rows={listReady,blankTitle,forcedFieldsHidden:!before.includes('下载地址'),forcedFieldsShown:after.includes('要求版本')&&after.includes('下载地址'),errors};fs.writeFileSync(path.join(__dirname,'admin-observations.json'),JSON.stringify(rows,null,2),'utf-8');console.log(JSON.stringify(rows));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
'''
script = script.replace("name:'取消'", r"name:/取\s*消/")
(folder/'admin-probe.cjs').write_text(script,encoding='utf-8')
print('Admin UI probe generated')
