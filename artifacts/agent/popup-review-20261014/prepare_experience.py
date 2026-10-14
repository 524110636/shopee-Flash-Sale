from pathlib import Path
import hashlib
import json

folder = Path(__file__).resolve().parent
root = folder.parent.parent
source = root / '.output/chrome-mv3'
hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
(folder / 'production-package-before.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
(folder / 'experience.config.ts').write_text('''import { defineConfig } from 'wxt';
import base from '../../wxt.config';
export default defineConfig({
  ...base,
  outDir: '.agent-tmp/popup-review-20261014/experience',
  manifest: (env) => ({
    ...base.manifest(env),
    name: '限时特卖助手（弹窗隔离体验）',
    description: '仅连接本机 5796 测试后端；本次只体验弹窗管理与通知',
  }),
});
''', encoding='utf-8')
(folder / 'OWNER.txt').write_text('Codex 独立弹窗验收 2026-10-14；本机隔离后端、测试数据库、浏览器夹具及独立体验包。\n', encoding='utf-8')
print('Isolated experience configuration prepared')
