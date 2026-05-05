import { defineContentScript } from 'wxt/utils/define-content-script';

interface ProgressData {
  totalSkus: number;
  successSkus: number;
  failedSkus: number;
  currentRound: number;
  isComplete: boolean;
}

interface FailedItemDetail {
  itemId: number;
  modelId: number;
  image: string;
  itemName: string;
  modelName: string;
  promoPrice: number;
  stock: number;
  purchaseLimit: number;
  errMsg: string;
}

let container: HTMLDivElement | null = null;
let panelContainer: HTMLDivElement | null = null;
let autoSectionEl: HTMLElement | null = null;
let autoBodyEl: HTMLElement | null = null;
let progressSectionEl: HTMLElement | null = null;
let copySectionEl: HTMLElement | null = null;
let successEl: HTMLElement | null = null;
let failedEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let barEl: HTMLElement | null = null;
let headerEl: HTMLElement | null = null;
let stopBtnEl: HTMLElement | null = null;
let toggleBtnEl: HTMLButtonElement | null = null;
let detailsContainerEl: HTMLDivElement | null = null;
let failedDetailItems: FailedItemDetail[] = [];
let detailsExpanded = false;
let removeTimer: ReturnType<typeof setTimeout> | null = null;

function createProgressUI() {
  if (container) return;
  // 清理残留 DOM（内容脚本重新加载后部分变量重置但旧元素仍在页面上）
  const stale = document.getElementById('__flash_sale_progress__');
  if (stale) stale.remove();

  container = document.createElement('div');
  container.id = '__flash_sale_progress__';
  Object.assign(container.style, {
    position: 'fixed',
    right: '0',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: '99999',
    background: 'rgba(255,255,255,0.92)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid #e5e7eb',
    borderRight: 'none',
    borderRadius: '8px 0 0 8px',
    padding: '14px 18px',
    minWidth: '190px',
    boxShadow: '-2px 2px 12px rgba(0,0,0,0.08)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    color: '#374151',
    lineHeight: '1.5',
    transition: 'opacity 0.4s ease',
  });

  // 标题
  headerEl = document.createElement('div');
  headerEl.textContent = '🚀 限时特卖进度';
  Object.assign(headerEl.style, {
    fontWeight: '600',
    fontSize: '14px',
    marginBottom: '10px',
    color: '#1f2937',
  });
  container.appendChild(headerEl);

  // 成功/失败行
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
    marginBottom: '4px',
  });

  successEl = document.createElement('span');
  successEl.innerHTML = '成功: <strong style="color:#16a34a">0</strong>';

  failedEl = document.createElement('span');
  failedEl.innerHTML = '失败: <strong style="color:#dc2626">0</strong>';

  row.appendChild(successEl);
  row.appendChild(failedEl);
  container.appendChild(row);

  // 元信息行
  metaEl = document.createElement('div');
  Object.assign(metaEl.style, {
    fontSize: '12px',
    color: '#6b7280',
    marginBottom: '8px',
  });
  container.appendChild(metaEl);

  // 进度条
  const track = document.createElement('div');
  Object.assign(track.style, {
    height: '5px',
    background: '#e5e7eb',
    borderRadius: '3px',
    overflow: 'hidden',
  });

  barEl = document.createElement('div');
  Object.assign(barEl.style, {
    height: '100%',
    width: '0%',
    background: 'linear-gradient(90deg, #22c55e, #16a34a)',
    borderRadius: '3px',
    transition: 'width 0.4s ease',
  });

  track.appendChild(barEl);
  container.appendChild(track);

  // 失败详情切换按钮（默认隐藏）
  toggleBtnEl = document.createElement('button');
  toggleBtnEl.textContent = '▼ 失败详情';
  Object.assign(toggleBtnEl.style, {
    display: 'none',
    marginTop: '8px',
    width: '100%',
    padding: '3px 0',
    fontSize: '11px',
    fontWeight: '500',
    color: '#dc2626',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '4px',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'background 0.2s ease',
  });
  toggleBtnEl.addEventListener('mouseenter', () => { if (toggleBtnEl) toggleBtnEl.style.background = '#fee2e2'; });
  toggleBtnEl.addEventListener('mouseleave', () => { if (toggleBtnEl) toggleBtnEl.style.background = '#fef2f2'; });
  toggleBtnEl.addEventListener('click', () => {
    detailsExpanded = !detailsExpanded;
    renderFailedDetails();
  });
  container.appendChild(toggleBtnEl);

  // 失败详情列表容器（默认隐藏）
  detailsContainerEl = document.createElement('div');
  Object.assign(detailsContainerEl.style, {
    display: 'none',
    marginTop: '4px',
    maxHeight: '240px',
    overflowY: 'auto',
    borderRadius: '4px',
    border: '1px solid #fecaca',
    background: '#fff',
  });
  container.appendChild(detailsContainerEl);

  // 停止按钮
  stopBtnEl = document.createElement('button');
  stopBtnEl.textContent = '⏹ 停止';
  Object.assign(stopBtnEl.style, {
    marginTop: '10px',
    width: '100%',
    padding: '4px 0',
    fontSize: '12px',
    fontWeight: '500',
    color: '#fff',
    background: '#dc2626',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'background 0.2s ease',
  });
  stopBtnEl.addEventListener('mouseenter', () => { if (stopBtnEl) stopBtnEl.style.background = '#b91c1c'; });
  stopBtnEl.addEventListener('mouseleave', () => { if (stopBtnEl) stopBtnEl.style.background = '#dc2626'; });
  stopBtnEl.addEventListener('click', () => {
    if (stopBtnEl) {
      stopBtnEl.textContent = '⏹ 正在停止...';
      stopBtnEl.style.background = '#9ca3af';
      stopBtnEl.disabled = true;
    }
    browser.runtime.sendMessage({ type: 'STOP_ENABLE' }).catch(() => {});
  });
  container.appendChild(stopBtnEl);

  document.body.appendChild(container);
}

function renderFailedDetails() {
  if (!toggleBtnEl || !detailsContainerEl) return;

  if (failedDetailItems.length === 0) {
    toggleBtnEl.style.display = 'none';
    detailsContainerEl.style.display = 'none';
    return;
  }

  toggleBtnEl.style.display = 'block';
  toggleBtnEl.textContent = detailsExpanded
    ? `▲ 失败详情 (${failedDetailItems.length})`
    : `▼ 失败详情 (${failedDetailItems.length})`;

  detailsContainerEl.style.display = detailsExpanded ? 'block' : 'none';
  if (!detailsExpanded) return;

  detailsContainerEl.innerHTML = failedDetailItems.map(item => `
    <div style="display:flex;gap:8px;padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;line-height:1.4">
      <img src="${escapeHtml(normalizeImageUrl(item.image))}" style="width:30px;height:30px;object-fit:cover;border-radius:3px;flex-shrink:0;background:#f8fafc" alt=""
        onerror="this.style.display='none'">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.itemName)}</div>
        <div style="color:#64748b;font-size:10px">SKU: ${escapeHtml(item.modelName || `#${item.modelId}`)}</div>
        <div style="color:#374151;margin-top:1px">
          限时价: <strong>$${item.promoPrice}</strong>
          &nbsp;|&nbsp; 数量: ${item.stock}
          &nbsp;|&nbsp; 限购: ${item.purchaseLimit}
        </div>
        ${item.errMsg ? `<div style="color:#dc2626;font-size:10px;margin-top:1px">${escapeHtml(item.errMsg)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function updateProgress(data: ProgressData, failedDetails?: FailedItemDetail[]) {
  if (!container) createProgressUI();

  failedDetailItems = failedDetails || [];
  renderFailedDetails();

  if (successEl) {
    successEl.innerHTML = `成功: <strong style="color:#16a34a">${data.successSkus}</strong>`;
  }
  if (failedEl) {
    failedEl.innerHTML = `失败: <strong style="color:#dc2626">${data.failedSkus}</strong>`;
  }
  if (metaEl) {
    metaEl.textContent = `共 ${data.totalSkus} 个 SKU | 第 ${data.currentRound} 轮`;
  }
  if (barEl && data.totalSkus > 0) {
    const pct = Math.round((data.successSkus / data.totalSkus) * 100);
    barEl.style.width = `${Math.min(pct, 100)}%`;
  }
}

function showComplete(data: ProgressData, failedDetails?: FailedItemDetail[]) {
  if (!container) return;

  failedDetailItems = failedDetails || [];
  renderFailedDetails();

  if (headerEl) {
    headerEl.textContent = data.failedSkus === 0
      ? '✅ 限时特卖已完成（全部成功）'
      : `⚠️ 限时特卖已完成（${data.failedSkus} 个失败）`;
    headerEl.style.color = data.failedSkus === 0 ? '#16a34a' : '#dc2626';
  }
  if (successEl) {
    successEl.innerHTML = `成功: <strong style="color:#16a34a">${data.successSkus}</strong>`;
  }
  if (failedEl) {
    failedEl.innerHTML = `失败: <strong style="color:#dc2626">${data.failedSkus}</strong>`;
  }
  if (metaEl) {
    metaEl.textContent = `共 ${data.totalSkus} 个 SKU | 已完成`;
  }
  if (barEl && data.totalSkus > 0) {
    barEl.style.width = '100%';
  }

  // 隐藏停止按钮（已完成）
  if (stopBtnEl) stopBtnEl.style.display = 'none';

  // 3 秒后淡出移除
  if (removeTimer) clearTimeout(removeTimer);
  removeTimer = setTimeout(() => {
    if (container) {
      container.style.opacity = '0';
      setTimeout(() => {
        if (container?.parentNode) container.parentNode.removeChild(container);
        container = null;
        successEl = null;
        failedEl = null;
        metaEl = null;
        barEl = null;
        headerEl = null;
      }, 400);
    }
  }, 3000);
}

function destroyProgress() {
  if (removeTimer) clearTimeout(removeTimer);
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
  successEl = null;
  failedEl = null;
  metaEl = null;
  barEl = null;
  headerEl = null;
  stopBtnEl = null;
  toggleBtnEl = null;
  detailsContainerEl = null;
  failedDetailItems = [];
  detailsExpanded = false;
}

// ===== Copy Progress UI =====
let copyContainer: HTMLDivElement | null = null;
let copyHeaderEl: HTMLElement | null = null;
let copyBodyEl: HTMLElement | null = null;
let copyCountdownTimer: ReturnType<typeof setInterval> | null = null;
let copyRemoveTimer: ReturnType<typeof setTimeout> | null = null;

function createCopyUI() {
  if (copyContainer) return;
  // 清理残留 DOM（内容脚本重新加载后部分变量重置但旧元素仍在页面上）
  const stale = document.getElementById('__flash_sale_copy_progress__');
  if (stale) stale.remove();

  copyContainer = document.createElement('div');
  copyContainer.id = '__flash_sale_copy_progress__';
  Object.assign(copyContainer.style, {
    position: 'fixed',
    right: '0',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: '99999',
    background: 'rgba(255,255,255,0.92)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid #e5e7eb',
    borderRight: 'none',
    borderRadius: '8px 0 0 8px',
    padding: '14px 18px',
    minWidth: '210px',
    maxWidth: '280px',
    boxShadow: '-2px 2px 12px rgba(0,0,0,0.08)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    color: '#374151',
    lineHeight: '1.5',
    transition: 'opacity 0.4s ease',
  });

  // 标题
  copyHeaderEl = document.createElement('div');
  copyHeaderEl.textContent = '📋 复制任务';
  Object.assign(copyHeaderEl.style, {
    fontWeight: '600',
    fontSize: '14px',
    marginBottom: '10px',
    color: '#1f2937',
  });
  copyContainer.appendChild(copyHeaderEl);

  // 分隔线
  const divider = document.createElement('div');
  Object.assign(divider.style, {
    height: '1px',
    background: '#e5e7eb',
    marginBottom: '10px',
  });
  copyContainer.appendChild(divider);

  // 内容区
  copyBodyEl = document.createElement('div');
  Object.assign(copyBodyEl.style, {
    fontSize: '12px',
    color: '#6b7280',
    lineHeight: '1.6',
  });
  copyContainer.appendChild(copyBodyEl);

  document.body.appendChild(copyContainer);
}

function destroyCopyUI() {
  if (copyCountdownTimer) clearInterval(copyCountdownTimer);
  if (copyRemoveTimer) clearTimeout(copyRemoveTimer);
  copyCountdownTimer = null;
  copyRemoveTimer = null;
  if (copyContainer?.parentNode) copyContainer.parentNode.removeChild(copyContainer);
  copyContainer = null;
  copyHeaderEl = null;
  copyBodyEl = null;
}

function showCopyCountdown(targetStartTime: number, sourceName: string) {
  createCopyUI();
  if (copyHeaderEl) copyHeaderEl.textContent = '📋 复制任务已安排';
  if (!copyBodyEl) return;

  // Clear existing countdown timer
  if (copyCountdownTimer) clearInterval(copyCountdownTimer);

  function updateCountdown() {
    if (!copyBodyEl) return;
    const now = Math.floor(Date.now() / 1000);
    const remaining = targetStartTime - now;

    if (remaining <= 0) {
      // Countdown expired — show "等待执行"
      if (copyCountdownTimer) clearInterval(copyCountdownTimer);
      copyCountdownTimer = null;
      copyBodyEl.innerHTML = `
        <div style="margin-bottom:6px">源活动: ${escapeHtml(sourceName)}</div>
        <div style="color:#f59e0b;font-weight:500">等待执行...</div>
      `;
      return;
    }

    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    copyBodyEl.innerHTML = `
      <div style="margin-bottom:6px">源活动: ${escapeHtml(sourceName)}</div>
      <div style="margin-bottom:4px;color:#374151">活动开始还有:</div>
      <div style="font-size:22px;font-weight:700;color:#2563eb;text-align:center;padding:4px 0">
        ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒
      </div>
    `;
  }

  updateCountdown();
  copyCountdownTimer = setInterval(updateCountdown, 1000);
}

function updateCopyStep(currentStep: number, totalSteps: number, description: string) {
  createCopyUI();
  if (copyHeaderEl) copyHeaderEl.textContent = '🚀 正在执行复制任务';

  // Stop countdown timer if running
  if (copyCountdownTimer) {
    clearInterval(copyCountdownTimer);
    copyCountdownTimer = null;
  }

  if (copyBodyEl) {
    copyBodyEl.innerHTML = `
      <div style="margin-bottom:6px">
        <span style="display:inline-block;padding:1px 8px;border-radius:10px;background:#2563eb;color:#fff;font-size:11px;font-weight:500">
          步骤 ${currentStep}/${totalSteps}
        </span>
      </div>
      <div style="color:#374151;font-weight:500">${escapeHtml(description)}</div>
    `;
  }
}

function showCopyComplete(success: boolean, error?: string) {
  if (!copyContainer) return;

  // Stop countdown timer
  if (copyCountdownTimer) {
    clearInterval(copyCountdownTimer);
    copyCountdownTimer = null;
  }

  if (copyHeaderEl) {
    copyHeaderEl.textContent = success ? '✅ 复制完成（全部成功）' : '⚠️ 复制完成（有失败）';
    copyHeaderEl.style.color = success ? '#16a34a' : '#dc2626';
  }

  if (copyBodyEl) {
    copyBodyEl.innerHTML = success
      ? '<div style="color:#16a34a">商品配置已复制到新活动</div>'
      : `<div style="color:#dc2626">${escapeHtml(error || '未知错误')}</div>`;
  }

  // Auto-fade after 3s (same as enable progress)
  if (copyRemoveTimer) clearTimeout(copyRemoveTimer);
  copyRemoveTimer = setTimeout(() => {
    if (copyContainer) {
      copyContainer.style.opacity = '0';
      setTimeout(() => {
        destroyCopyUI();
      }, 400);
    }
  }, 3000);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeImageUrl(image: string): string {
  if (!image) return '';
  if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('data:')) {
    return image;
  }
  return `https://cf.shopee.tw/file/${image}`;
}

// ===== Unified Panel =====
function createPanel() {
  if (panelContainer) return;
  // 清理旧元素
  ['__flash_sale_progress__', '__flash_sale_copy_progress__'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  panelContainer = document.createElement('div');
  panelContainer.id = '__flash_sale_panel__';
  Object.assign(panelContainer.style, {
    position: 'fixed',
    right: '0',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: '99999',
    background: 'rgba(255,255,255,0.94)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid #e5e7eb',
    borderRight: 'none',
    borderRadius: '8px 0 0 8px',
    padding: '10px 14px',
    minWidth: '210px',
    maxWidth: '300px',
    boxShadow: '-2px 2px 12px rgba(0,0,0,0.08)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '12px',
    color: '#374151',
    lineHeight: '1.5',
    transition: 'opacity 0.4s ease',
  });

  // Auto mode section
  autoSectionEl = document.createElement('div');
  autoSectionEl.style.display = 'none';
  panelContainer.appendChild(autoSectionEl);

  // Enable progress section
  progressSectionEl = document.createElement('div');
  progressSectionEl.style.display = 'none';
  panelContainer.appendChild(progressSectionEl);

  // Copy task section
  copySectionEl = document.createElement('div');
  copySectionEl.style.display = 'none';
  panelContainer.appendChild(copySectionEl);

  document.body.appendChild(panelContainer);
}

function renderAutoSection(status: any) {
  createPanel();
  if (!autoSectionEl) return;

  const isRunning = status?.isRunning;
  if (!isRunning) {
    autoSectionEl.style.display = 'none';
    return;
  }

  autoSectionEl.style.display = 'block';
  const phase = status.phase || 'idle';
  const phaseText = ({
    idle: '准备中',
    waiting_create: '等待申报时间',
    creating: '正在创建活动',
    waiting_enable: '等待传递商品',
    enabling: '正在传递商品',
    completed: '已完成',
    stopped: '已停止',
  } as Record<string, string>)[phase] || phase;

  autoSectionEl.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#1f2937">🤖 自动模式 <span style="color:#16a34a;font-size:11px">● 运行中</span></div>
    <div style="font-size:11px;color:#6b7280;margin-bottom:4px">
      第 ${status.currentRound || 0}/${status.totalRounds || 0} 轮 | ${phaseText}
    </div>
    ${status.nextTargetTime ? `<div style="font-size:11px;color:#6b7280;margin-bottom:4px">下一场: ${fmtContentTime(status.nextTargetTime)}</div>` : ''}
    <button id="__auto_stop_btn__" style="
      margin-top:4px;width:100%;padding:3px 0;font-size:11px;font-weight:500;
      color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;
      cursor:pointer;text-align:center;
    ">⏹ 停止自动模式</button>
  `;

  setTimeout(() => {
    const btn = document.getElementById('__auto_stop_btn__');
    if (btn) {
      btn.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'STOP_AUTO_MODE' }).catch(() => {});
      });
    }
  }, 0);
}

function fmtContentTime(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

export default defineContentScript({
  matches: ['https://seller.shopee.tw/*'],
  runAt: 'document_idle',
  main() {
    console.log('[限时特卖助手] Content Script 已加载');

    // ===== 初始化：检测是否有正在进行的 enable 循环或排程倒计时（消息可能丢失，storage 更可靠）=====
    browser.storage.local.get(['_enableProgress', '_copyCountdown', '_autoModeStatus']).then(data => {
      const ep = data._enableProgress as { progress?: ProgressData; running?: boolean } | undefined;
      if (ep?.progress && ep.running && !ep.progress.isComplete) {
        updateProgress(ep.progress);
      }
      const cd = data._copyCountdown as { targetStartTime: number; sourceName: string } | undefined;
      if (cd?.targetStartTime) {
        showCopyCountdown(cd.targetStartTime, cd.sourceName || '');
      }
      const am = data._autoModeStatus as any;
      if (am) {
        renderAutoSection(am);
      }
    });

    // ===== Storage 变更监听（消息丢失时的后备路径）=====
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      // Enable 进度
      const epChange = changes._enableProgress;
      if (epChange) {
        const data = epChange.newValue as { progress?: ProgressData; running?: boolean } | undefined;
        if (data?.progress) {
          if (data.running && !data.progress.isComplete) {
            updateProgress(data.progress);
          } else {
            showComplete(data.progress);
          }
        }
      }

      // 倒计时悬浮 UI（排程复制被创建/触发时同步更新）
      const cdChange = changes._copyCountdown;
      if (cdChange?.newValue) {
        showCopyCountdown(cdChange.newValue.targetStartTime, cdChange.newValue.sourceName || '');
      } else if (cdChange && !cdChange.newValue) {
        destroyCopyUI();
      }

      // 自动模式状态
      const amChange = changes._autoModeStatus;
      if (amChange) {
        if (amChange.newValue) {
          renderAutoSection(amChange.newValue);
        } else {
          if (autoSectionEl) autoSectionEl.style.display = 'none';
        }
      }
    });

    browser.runtime.onMessage.addListener((msg: any) => {
      const type = msg?.type;

      if (type === 'ENABLE_PROGRESS' && msg.progress) {
        updateProgress({
          totalSkus: msg.progress.totalSkus || 0,
          successSkus: msg.progress.successSkus || 0,
          failedSkus: msg.progress.failedSkus || 0,
          currentRound: msg.progress.currentRound || 0,
          isComplete: false,
        }, msg.failedItemDetails);
      }

      if (type === 'ENABLE_COMPLETE' && msg.progress) {
        showComplete({
          totalSkus: msg.progress.totalSkus || 0,
          successSkus: msg.progress.successSkus || 0,
          failedSkus: msg.progress.failedSkus || 0,
          currentRound: msg.progress.currentRound || 0,
          isComplete: true,
        }, msg.failedItemDetails);
      }

      // Copy task progress messages
      if (type === 'COPY_SCHEDULED') {
        showCopyCountdown(msg.targetStartTime, msg.sourceName || '');
      }

      if (type === 'COPY_PROGRESS') {
        updateCopyStep(msg.currentStep || 1, msg.totalSteps || 4, msg.description || '');
      }

      if (type === 'COPY_COMPLETE') {
        showCopyComplete(msg.success, msg.error);
      }

      if (type === 'AUTO_MODE_UPDATE') {
        renderAutoSection(msg.status);
      }

      return false;
    });
  },
});
