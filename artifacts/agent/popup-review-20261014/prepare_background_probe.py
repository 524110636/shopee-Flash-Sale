from pathlib import Path

# Owner: Codex independent review 2026-10-14; adapt fixture routing only, no product edits.
ROOT=Path(__file__).resolve().parents[2]
folder=Path(__file__).resolve().parent
source=(ROOT/'.agent-tmp/extension-announcements-and-forced-update/verify-p9.mjs').read_text(encoding='utf-8')
source=source.replace("'http://localhost:5799'", "'http://127.0.0.1:5796'")
source=source.replace("const userDataDir = mkdtempSync(join(tmpdir(), 'p9-'));", "const userDataDir = resolve(process.cwd(), '.agent-tmp/popup-review-20261014/profile-background');")
source=source.replace('headless: false','headless: true')
anchor="  const extensionId = sw.url().split('/')[2];"
assert source.count(anchor)==1
source=source.replace(anchor,anchor+"\n  await sw.evaluate((backendUrl) => chrome.storage.local.set({ backendUrl }), BASE);",1)
anchor="    if (url.includes('/api/marketing/v4/graphql/query/')) {"
assert source.count(anchor)==1
source=source.replace(anchor,r'''    if (url.includes('/get_time_slot_id/')) {
      const now = Math.floor(Date.now()/1000);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:[{timeslot_id:101,start_time:now+60,end_time:now+3660}]})}); return;
    }
    if (url.includes('/get_shop_flash_sale_list/')) {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{flash_sale_list:[]}})}); return;
    }
    if (url.includes('/set_shop_flash_sale/')) {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{flash_sale_id:777777}})}); return;
    }
''' + anchor,1)
anchor="  check('scheduled_copy 业务分支真跑了（写出 _copyTaskStatus）', !!copyOutcome.status,"
assert source.count(anchor)==1
source=source.replace(anchor,"  check('scheduled_copy 成功完成真实创建流程（非失败清理）', copyOutcome.status?.success === true, JSON.stringify(copyOutcome).slice(0,200));\n"+anchor,1)
extra=r'''
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
'''
anchor='  // ---------- 关键否定断言 ----------'
assert source.count(anchor)==1
source=source.replace(anchor,extra+'\n'+anchor,1)
(folder/'background-probe.mjs').write_text(source,encoding='utf-8')
print('Independent background fixture prepared, with missing existing alarm paths')
