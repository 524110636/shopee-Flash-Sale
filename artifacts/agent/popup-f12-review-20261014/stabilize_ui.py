from pathlib import Path
import json

folder=Path(__file__).resolve().parent
probe=folder/'browser-probe.cjs'
data=json.loads((folder/'browser-observations.json').read_text(encoding='utf-8'))
print(json.dumps([x for x in data['layouts'] if x['width']==1366]))
text=probe.read_text(encoding='utf-8')
text=text.replace("await modal.locator('input[type=checkbox]').check();", "await modal.locator('input[type=checkbox]').check();await page.waitForTimeout(350);")
probe.write_text(text,encoding='utf-8')
print('Layout observation waits for modal animation before geometry capture')
