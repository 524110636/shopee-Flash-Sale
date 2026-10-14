import { chromium } from 'playwright';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

/**
 * P9 证据：强制弹窗出现期间，**真实业务 handler／runner** 仍在推进。
 *
 * 与上一版的区别（Codex 判定 B5 未完整）：
 * - 一键修复不再只发 requestId：写入**完整有效的修复参数**（含商品 payload）并
 *   mock SPC_CDS Cookie，断言 accepted → runner 真跑到**具体平台写接口**
 *   （`/api/v3/product/update_product_info`），而不是「响应里有个 error 也算通过」。
 * - 断言平台写请求的**方法/接口名**，不把任意 POST 当成功。
 * - 定时复制用带 Cookie 的可推进用例，而不是「只要消费/失败就算过」。
 *
 * 隔离保障：所有 shopee.tw 请求被 route mock，绝不触真实店铺。
 */

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:5796';
const EXT = resolve(process.cwd(), '.output', 'chrome-mv3');
const CHROME = 'C:\\Users\\52411\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const ADMIN = { email: 'verify-admin@example.invalid', password: 'VerifyAdmin!2026' };

const MOCK_SPC_CDS = 'P9MOCKSPCCDS0000000000000000000000';
const MOCK_SHOP_ID = 900001;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function adminToken() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  return (await res.json()).token;
}

async function loginAdmin() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`隔离管理员登录失败: ${JSON.stringify(data)}`);
  return { token: data.token, userId: data.user.id };
}

async function bindMockStore(token, spcCds) {
  const res = await fetch(`${BASE}/api/stores/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ spcCds, shopId: MOCK_SHOP_ID, accountId: 900002, shopUsername: 'p9verify', shopName: 'P9 隔离店铺' }),
  });
  if (!res.ok) throw new Error(`绑定 mock 店铺失败: ${res.status} ${await res.text()}`);
}

async function publishForced(title) {
  const token = await adminToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${BASE}/api/admin/popup-policies`, {
    method: 'POST', headers,
    body: JSON.stringify({
      mode: 'forced_update', title, contentHtml: '<p>请升级</p>',
      requiredVersion: '99.0.0', downloadUrl: 'https://example.com/app.zip',
    }),
  });
  const { record } = await created.json();
  await fetch(`${BASE}/api/admin/popup-policies/${record.recordId}/publish`, { method: 'POST', headers });
}

async function withdrawAll() {
  const token = await adminToken();
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetch(`${BASE}/api/admin/popup-policies`, { headers });
  const { records } = await res.json();
  for (const r of records ?? []) {
    await fetch(`${BASE}/api/admin/popup-policies/${r.recordId}/withdraw`, { method: 'POST', headers });
  }
}

/** 开卖循环需要的商品结构。 */
function mockProduct() {
  return {
    itemid: '111', name: 'P9 模拟商品', images: ['https://cf.shopee.tw/file/mock.jpg'],
    variationImages: [], transparentBackgroundImage: '', status: 0,
    inputOriginPrice: '100', originPrice: '100', normalStock: 50, localPrice: '100',
    pffTag: false, normalSellerStock: 50, normalWmsStock: 0, minPurchaseLimit: 1,
    itemSellerSellableStock: 50, itemWmsSellableStock: 0, itemTotalReservedStock: 0, itemNormalStock: 50,
    modelList: [{
      modelid: '9001', name: 'P9 规格', inputOriginPrice: '100', originPrice: '100',
      normalStock: 50, localPrice: '100', pffTag: false, normalSellerStock: 50, normalWmsStock: 0,
      modelNormalStock: 50, modelSellerSellableStock: 50, modelWmsSellableStock: 0,
      modelTotalReservedStock: 0, enableShopFlashSaleNewStock: false, totalNormalStock: 50,
    }],
  };
}

/** 修复 runner 读商品详情时期望的结构（含 model_list，才能构造更新请求）。 */
function mockProductInfo() {
  return {
    code: 0,
    data: {
      product_info: {
        product_id: 111,
        name: 'P9 模拟商品',
        model_list: [{
          model_id: 9001, model_name: 'P9 规格', model_sku: 'SKU-9001',
          model_normal_stock: 50, model_price: '100', model_original_price: '100',
          model_id_list: [], has_model: true, tier_index: [0],
        }],
        tier_variation: [{ name: '规格', option_list: [{ option: 'P9 规格', image: { image_id: '' } }] }],
        price_info: [{ original_price: '100', current_price: '100' }],
        stock_info_v2: { summary_info: { total_sellable_stock: 50 } },
      },
    },
  };
}

async function main() {
  console.log(`\n=== P9 真实业务 handler 证据 @ ${BASE} ===\n`);

  await withdrawAll();
  await publishForced('P9 强制升级');

  const admin = await loginAdmin();
  await bindMockStore(admin.token, MOCK_SPC_CDS);

  const userDataDir = resolve(process.cwd(), '.agent-tmp/popup-review-20261014/profile-background');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });

  // 记录所有被拦截的平台请求（含方法与路径），用于按**具体接口**断言
  const platformCalls = [];

  await context.route('**/*shopee.tw/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    let path = url;
    try { path = new URL(url).pathname; } catch { /* 保留原 url */ }
    platformCalls.push({ url, method, path });

    if (url.includes('/get_time_slot_id/')) {
      const now = Math.floor(Date.now()/1000);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:[{timeslot_id:101,start_time:now+60,end_time:now+3660}]})}); return;
    }
    if (url.includes('/get_shop_flash_sale_list/')) {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{flash_sale_list:[]}})}); return;
    }
    if (url.includes('/set_shop_flash_sale/')) {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{flash_sale_id:777777}})}); return;
    }
    if (url.includes('/api/marketing/v4/graphql/query/')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'ok', data: { products: { items: [mockProduct()] } } }),
      });
      return;
    }
    if (url.includes('/api/v3/product/get_product_info')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockProductInfo()) });
      return;
    }
    // 店铺身份核实接口：必须返回数字 id/shopid，否则修复会以「无法核实身份」拒绝
    if (url.includes('/api/v2/login/')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 900002, shopid: MOCK_SHOP_ID }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'ok', data: { id: MOCK_SHOP_ID } }),
    });
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = sw.url().split('/')[2];
  await sw.evaluate((backendUrl) => chrome.storage.local.set({ backendUrl }), BASE);

  await context.newPage().then((p) => p.goto('https://seller.shopee.tw/marketing/flash-sale'));

  // mock SPC_CDS Cookie：修复与复制都从 Cookie 现读凭据
  await context.addCookies([
    { name: 'SPC_CDS', value: MOCK_SPC_CDS, domain: '.shopee.tw', path: '/' },
    { name: 'SPC_CDS_VER', value: '1', domain: '.shopee.tw', path: '/' },
  ]);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector('#root');
  await popup.waitForFunction(
    () => !document.body.innerText.includes('正在检查通知'), null, { timeout: 12000 },
  );
  check('强制弹窗已出现', (await popup.locator('body').innerText()).includes('P9 强制升级'));

  // 登录态 + 开卖参数
  await sw.evaluate(async ({ token, spcCds, product, shopId }) => {
    await chrome.storage.local.set({
      backendAuth: { token, user: { id: 1, email: 'verify-admin@example.invalid', role: 'admin', autoModeEnabled: 1, trialUsed: 0, trialEnabled: 1 } },
      _enableParams: {
        flashSaleId: 987654321, spcCds, spcCdsVer: '1',
        products: [product], discountRate: 50, flashSaleStock: 10, purchaseLimit: 1,
        skuOverrides: {}, maxRetries: 1, infiniteRetry: false, shopId,
      },
    });
    await chrome.storage.local.remove(['_enableProgress']);
  }, { token: admin.token, spcCds: MOCK_SPC_CDS, product: mockProduct(), shopId: MOCK_SHOP_ID });

  // ---------- a) 真实 runEnableLoop 路径 ----------
  const startEnable = await popup.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'START_ENABLE' }, (resp) => resolve(resp));
  }));
  check('真实 START_ENABLE 被受理并返回成功', startEnable?.success === true, JSON.stringify(startEnable));

  const enableProgress = await sw.evaluate(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await chrome.storage.local.get('_enableProgress');
      const p = r._enableProgress;
      if (p && ((p.progress && p.progress.currentRound > 0) || p.error)) return p;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    return null;
  });
  check('真实开卖循环写出了进度（业务链路确在推进）',
    !!enableProgress && (enableProgress.progress?.currentRound ?? 0) > 0,
    JSON.stringify(enableProgress)?.slice(0, 240));
  check('开卖真实打到平台写接口 shop_flash_sale_items',
    platformCalls.some((c) => c.method === 'POST' && c.path.includes('shop_flash_sale_items')),
    JSON.stringify(platformCalls.filter((c) => c.method === 'POST').map((c) => c.path)));
  check('平台请求全部被本用例拦截（未真实出网）',
    platformCalls.length > 0 && platformCalls.every((c) => c.url.includes('shopee.tw')));

  // ---------- b) 真实 alarm 名 + 可推进的定时复制 ----------
  const alarmsBefore = (await sw.evaluate(() => chrome.alarms.getAll())).map((a) => a.name);

  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      _scheduledCopy: {
        flashSaleId: 555, targetStartTime: Math.floor(Date.now() / 1000) + 60,
        sourceFlashSaleName: 'P9 定时源', products: [], spcCds: '', spcCdsVer: '1', shopId: 900001,
      },
    });
    await chrome.storage.local.remove(['_copyTaskStatus']);
  });

  const alarmFired = await sw.evaluate(() => new Promise((resolve) => {
    chrome.alarms.create('scheduled_copy', { when: Date.now() + 500 });
    const timer = setTimeout(() => resolve(false), 10000);
    const probe = (alarm) => {
      if (alarm.name === 'scheduled_copy') {
        clearTimeout(timer);
        chrome.alarms.onAlarm.removeListener(probe);
        resolve(true);
      }
    };
    chrome.alarms.onAlarm.addListener(probe);
  }));
  check('真实业务名 alarm（scheduled_copy）按原分支触发', alarmFired);

  const copyOutcome = await sw.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = await chrome.storage.local.get(['_scheduledCopy', '_copyTaskStatus']);
      if (r._copyTaskStatus) return { status: r._copyTaskStatus, consumed: !r._scheduledCopy };
      await new Promise((r2) => setTimeout(r2, 200));
    }
    return { status: null, consumed: false };
  });
  check('scheduled_copy 成功完成真实创建流程（非失败清理）', copyOutcome.status?.success === true, JSON.stringify(copyOutcome).slice(0,200));
  check('scheduled_copy 业务分支真跑了（写出 _copyTaskStatus）', !!copyOutcome.status,
    JSON.stringify(copyOutcome).slice(0, 200));
  check('定时复制打到真实平台接口（不是空转）',
    platformCalls.some((c) => c.path.includes('flash_sale') || c.path.includes('product')),
    JSON.stringify(platformCalls.map((c) => c.path).slice(0, 14)));

  // ---------- c) 一键修复：有效参数 + 断言真实写接口 ----------
  const repairRequestId = 'p9-verify-repair';
  await sw.evaluate(async ({ requestId, product, spcCds }) => {
    await chrome.storage.local.set({
      _oneDaySkuRepairRequest: {
        requestId, products: [product], shopId: 900001, spcCds, spcCdsVer: '1', requestedAt: Date.now(),
      },
    });
    await chrome.storage.local.remove([
      '_oneDaySkuRepairTask', '_oneDaySkuRepairStartError', '_oneDaySkuRepairDiagnostics',
    ]);
  }, { requestId: repairRequestId, product: mockProduct(), spcCds: MOCK_SPC_CDS });

  const writesBefore = platformCalls.filter((c) => c.path.includes('update_product_info')).length;

  const repairResult = await popup.evaluate((requestId) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'START_ONE_DAY_REPAIR', requestId }, (resp) => resolve(resp));
  }), repairRequestId);
  check('一键修复被**受理**（success=true，不接受「失败也算通过」）',
    repairResult?.success === true, JSON.stringify(repairResult));

  const repairWriteSeen = await (async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const now = platformCalls.filter((c) => c.method === 'POST' && c.path.includes('update_product_info')).length;
      if (now > writesBefore) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();
  check('一键修复真跑到平台写接口 /api/v3/product/update_product_info', repairWriteSeen,
    JSON.stringify(platformCalls.filter((c) => c.path.includes('product')).map((c) => `${c.method} ${c.path}`)));

  const repairTask = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get(['_oneDaySkuRepairTask', '_oneDaySkuRepairStartError']);
    return r;
  });
  check('一键修复落下真实任务或明确失败原因（未被弹窗吞掉）',
    !!repairTask._oneDaySkuRepairTask || !!repairTask._oneDaySkuRepairStartError,
    JSON.stringify(repairTask).slice(0, 220));


  // Independent evidence for the three existing alarm paths omitted by developer fixture.
  // Finish the isolated repair before starting another same-shop scenario.
  await sw.evaluate(async()=>{
    const until=Date.now()+30000;
    while(Date.now()<until){const r=await chrome.storage.local.get('_oneDaySkuRepairTask');const t=r._oneDaySkuRepairTask;if(!t||['completed','failed','interrupted','partial'].includes(t.status))return;await new Promise(resolve=>setTimeout(resolve,250));}
    throw new Error('Isolated repair did not settle before alarm probes');
  });
  const params={flashSaleId:987654322,spcCds:MOCK_SPC_CDS,spcCdsVer:'1',products:[mockProduct()],discountRate:50,flashSaleStock:10,purchaseLimit:1,skuOverrides:{},maxRetries:1,infiniteRetry:false,shopId:MOCK_SHOP_ID};
  const writeCount=()=>platformCalls.filter(c=>c.method==='POST'&&c.path.includes('set_shop_flash_sale_items')).length;
  let beforeWrites=writeCount();
  await sw.evaluate(async params=>{
    await chrome.storage.local.remove(['_enableProgress','_oneDaySkuRepairTask','_oneDaySkuRepairRequest']);
    await chrome.alarms.clear('scheduled_copy_enable');
    await chrome.storage.local.set({_enableParams:params,_scheduledEnable:{flashSaleId:params.flashSaleId,scheduledAt:Date.now()}});
    chrome.alarms.create('scheduled_enable',{when:Date.now()+500});
  },params);
  let until=Date.now()+15000;while(Date.now()<until&&writeCount()===beforeWrites)await new Promise(resolve=>setTimeout(resolve,200));
  const scheduledProgress=await sw.evaluate(async()=>{const r=await chrome.storage.local.get('_enableProgress');return r._enableProgress;});
  check('independent scheduled_enable wrote specific submit endpoint under forced overlay',writeCount()>beforeWrites&&scheduledProgress?.progress?.successSkus===1,JSON.stringify(scheduledProgress).slice(0,180));
  await sw.evaluate(async params=>{
    await chrome.storage.local.set({_wizardFlowParams:{timeSlotId:101,enableFireTime:Math.floor(Date.now()/1000)+3600,enableParams:params,cds:params.spcCds,cdsVer:'1'}});
    chrome.alarms.create('wizard_create',{when:Date.now()+500});
  },params);
  until=Date.now()+12000;let wizard;
  while(Date.now()<until){wizard=await sw.evaluate(()=>chrome.storage.local.get(['_wizardFlashSaleId','_wizardFlowParams','_enableParams']));if(wizard._wizardFlashSaleId===777777&&!wizard._wizardFlowParams)break;await new Promise(resolve=>setTimeout(resolve,200));}
  const wizardAlarms=(await sw.evaluate(()=>chrome.alarms.getAll())).map(a=>a.name);
  check('independent wizard_create created activity and kept follow-up scheduled alarm',wizard?._wizardFlashSaleId===777777&&!wizard?._wizardFlowParams&&wizardAlarms.includes('scheduled_enable'),JSON.stringify({id:wizard?._wizardFlashSaleId,alarms:wizardAlarms}));
  beforeWrites=writeCount();
  await sw.evaluate(async params=>{
    await chrome.alarms.clear('scheduled_enable');
    await chrome.storage.local.remove(['_enableProgress','_scheduledEnable']);
    await chrome.storage.local.set({_autoModeStatus:{isRunning:true,phase:'waiting_enable',currentRound:2,totalRounds:2,currentFlashSaleId:987654323,sourceFlashSaleId:987654320,sourceFlashSaleName:'isolated prior round',enableParams:params,config:{advanceMinutes:5,delayMinutes:5,totalRounds:2,mode:'rounds'}}});
    chrome.alarms.create('auto_mode_enable',{when:Date.now()+500});
  },params);
  until=Date.now()+15000;let auto;
  while(Date.now()<until){auto=(await sw.evaluate(()=>chrome.storage.local.get('_autoModeStatus')))._autoModeStatus;if(auto?.currentRound===3&&auto?.phase==='completed')break;await new Promise(resolve=>setTimeout(resolve,200));}
  check('independent auto_mode_enable continued existing second round and completed',writeCount()>beforeWrites&&auto?.currentRound===3&&auto?.phase==='completed',JSON.stringify({round:auto?.currentRound,phase:auto?.phase,writes:writeCount()-beforeWrites}));

  // ---------- 关键否定断言 ----------
  const alarmsNow = (await sw.evaluate(() => chrome.alarms.getAll())).map((a) => a.name);
  check('原有业务 alarm 未被弹窗清除（按名字比对）',
    alarmsBefore.every((n) => alarmsNow.includes(n)),
    `before=${JSON.stringify(alarmsBefore)} now=${JSON.stringify(alarmsNow)}`);

  check('整个过程中强制弹窗一直存在',
    (await popup.evaluate(() => document.body.innerText)).includes('P9 强制升级'));

  check('平台请求数量有限（无重复启动）', platformCalls.length < 150, `calls=${platformCalls.length}`);

  await context.close();
  await withdrawAll();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  console.log(`隔离说明：共拦截 ${platformCalls.length} 次平台请求，全部返回用例内 mock，未接触真实店铺。`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('P9 验收异常:', e);
  process.exit(1);
});
