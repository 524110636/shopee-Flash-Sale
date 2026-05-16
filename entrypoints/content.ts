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

let panelContainer: HTMLDivElement | null = null;
let autoSectionEl: HTMLElement | null = null;
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

// Minimize / countdown state
let panelMinimized = false;
let minimizedBarEl: HTMLElement | null = null;
let minimizeBtnEl: HTMLElement | null = null;
let autoCountdownTimer: ReturnType<typeof setInterval> | null = null;
let autoStatusData: any = null;
let wasAutoVisible = false;
let wasProgressVisible = false;
let wasCopyVisible = false;

function buildProgressSection() {
  if (!progressSectionEl || headerEl) return; // 已构建

  // 标题
  headerEl = document.createElement('div');
  headerEl.textContent = '🚀 限时特卖进度';
  Object.assign(headerEl.style, {
    fontWeight: '600',
    fontSize: '14px',
    marginBottom: '10px',
    color: '#1f2937',
  });
  progressSectionEl.appendChild(headerEl);

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
  progressSectionEl.appendChild(row);

  // 元信息行
  metaEl = document.createElement('div');
  Object.assign(metaEl.style, {
    fontSize: '12px',
    color: '#6b7280',
    marginBottom: '8px',
  });
  progressSectionEl.appendChild(metaEl);

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
  progressSectionEl.appendChild(track);

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
  progressSectionEl.appendChild(toggleBtnEl);

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
  progressSectionEl.appendChild(detailsContainerEl);

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
  progressSectionEl.appendChild(stopBtnEl);
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
  createPanel();
  buildProgressSection();

  failedDetailItems = failedDetails || [];
  renderFailedDetails();

  if (stopBtnEl) stopBtnEl.style.display = '';
  if (headerEl) {
    headerEl.textContent = '🚀 限时特卖进度';
    headerEl.style.color = '#1f2937';
  }
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

  // Show or hide based on minimize state
  if (panelMinimized) {
    if (progressSectionEl) progressSectionEl.style.display = 'none';
    updateMinimizedContent();
  } else {
    if (progressSectionEl) progressSectionEl.style.display = 'block';
  }

  // 清除旧的自动消失定时器
  if (removeTimer) clearTimeout(removeTimer);
  removeTimer = null;
}

function showComplete(data: ProgressData, failedDetails?: FailedItemDetail[]) {
  createPanel();
  buildProgressSection();
  if (!progressSectionEl || !headerEl) return;

  if (!panelMinimized) {
    progressSectionEl.style.display = 'block';
  }
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

  if (panelMinimized) updateMinimizedContent();

  // 3 秒后淡出进度区域
  if (removeTimer) clearTimeout(removeTimer);
  removeTimer = setTimeout(() => {
    if (progressSectionEl) {
      progressSectionEl.style.display = 'none';
    }
    // 若无其他区域活跃则移除面板
    const autoVisible = autoSectionEl && autoSectionEl.style.display !== 'none';
    const copyVisible = copySectionEl && copySectionEl.style.display !== 'none';
    if (!autoVisible && !copyVisible && panelContainer?.parentNode) {
      // Clean up timers and reset state
      if (autoCountdownTimer) {
        clearInterval(autoCountdownTimer);
        autoCountdownTimer = null;
      }
      autoStatusData = null;
      panelMinimized = false;
      panelContainer.parentNode.removeChild(panelContainer);
      panelContainer = null;
      autoSectionEl = null;
      progressSectionEl = null;
      copySectionEl = null;
      successEl = null;
      failedEl = null;
      metaEl = null;
      barEl = null;
      headerEl = null;
      stopBtnEl = null;
      toggleBtnEl = null;
      detailsContainerEl = null;
      minimizedBarEl = null;
      minimizeBtnEl = null;
    }
  }, 3000);
}



// ===== Copy Progress UI =====
let copyContainer: HTMLDivElement | null = null;
let copyHeaderEl: HTMLElement | null = null;
let copyBodyEl: HTMLElement | null = null;
let copyCountdownTimer: ReturnType<typeof setInterval> | null = null;
let copyRemoveTimer: ReturnType<typeof setTimeout> | null = null;
let copyMinimized = false;
let copyMinimizeBtnEl: HTMLElement | null = null;
let copyMinimizedBarEl: HTMLDivElement | null = null;
let copyLastTargetTime = 0;

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
    transition: 'all 0.3s ease',
  });

  // Minimize button
  copyMinimizeBtnEl = document.createElement('button');
  copyMinimizeBtnEl.textContent = '−';
  copyMinimizeBtnEl.title = '最小化';
  Object.assign(copyMinimizeBtnEl.style, {
    position: 'absolute',
    top: '2px',
    right: '6px',
    width: '20px',
    height: '20px',
    padding: '0',
    fontSize: '14px',
    fontWeight: '700',
    lineHeight: '18px',
    color: '#9ca3af',
    background: 'none',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'color 0.2s ease',
    zIndex: '1',
  });
  copyMinimizeBtnEl.addEventListener('mouseenter', () => { if (copyMinimizeBtnEl) copyMinimizeBtnEl.style.color = '#374151'; });
  copyMinimizeBtnEl.addEventListener('mouseleave', () => { if (copyMinimizeBtnEl) copyMinimizeBtnEl.style.color = '#9ca3af'; });
  copyMinimizeBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCopyMinimize();
  });
  copyContainer.appendChild(copyMinimizeBtnEl);

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

  // Minimized bar (hidden by default)
  copyMinimizedBarEl = document.createElement('div');
  copyMinimizedBarEl.style.display = 'none';
  Object.assign(copyMinimizedBarEl.style, {
    cursor: 'pointer',
    textAlign: 'center',
    padding: '4px 0',
    fontSize: '11px',
    color: '#374151',
    lineHeight: '1.3',
    userSelect: 'none',
  });
  copyMinimizedBarEl.addEventListener('click', () => toggleCopyMinimize());
  copyContainer.appendChild(copyMinimizedBarEl);

  document.body.appendChild(copyContainer);
}

function destroyCopyUI() {
  if (copyCountdownTimer) clearInterval(copyCountdownTimer);
  if (copyRemoveTimer) clearTimeout(copyRemoveTimer);
  copyCountdownTimer = null;
  copyRemoveTimer = null;
  copyMinimized = false;
  copyMinimizeBtnEl = null;
  copyMinimizedBarEl = null;
  if (copyContainer?.parentNode) copyContainer.parentNode.removeChild(copyContainer);
  copyContainer = null;
  copyHeaderEl = null;
  copyBodyEl = null;
}

function toggleCopyMinimize() {
  if (!copyContainer || !copyMinimizedBarEl || !copyMinimizeBtnEl) return;

  copyMinimized = !copyMinimized;

  if (copyMinimized) {
    // Hide main content
    if (copyHeaderEl) copyHeaderEl.style.display = 'none';
    if (copyBodyEl) copyBodyEl.style.display = 'none';
    // Hide divider (second child after minimize button)
    const children = copyContainer.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i] as HTMLElement;
      if (c !== copyMinimizeBtnEl && c !== copyMinimizedBarEl) {
        c.style.display = 'none';
      }
    }

    // Shrink panel
    copyContainer.style.padding = '4px 8px';
    copyContainer.style.minWidth = 'auto';
    copyContainer.style.maxWidth = '180px';

    // Show minimized bar
    copyMinimizeBtnEl.textContent = '▶';
    copyMinimizeBtnEl.title = '展开';
    copyMinimizedBarEl.style.display = 'block';
    updateCopyMinimizedContent();
  } else {
    // Restore
    if (copyHeaderEl) copyHeaderEl.style.display = '';
    if (copyBodyEl) copyBodyEl.style.display = '';
    const children = copyContainer.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i] as HTMLElement;
      if (c !== copyMinimizeBtnEl && c !== copyMinimizedBarEl) {
        c.style.display = '';
      }
    }

    // Restore panel size
    copyContainer.style.padding = '14px 18px';
    copyContainer.style.minWidth = '210px';
    copyContainer.style.maxWidth = '280px';

    // Hide minimized bar
    copyMinimizeBtnEl.textContent = '−';
    copyMinimizeBtnEl.title = '最小化';
    copyMinimizedBarEl.style.display = 'none';
  }
}

function updateCopyMinimizedContent() {
  if (!copyMinimizedBarEl || !copyMinimized) return;

  const now = Math.floor(Date.now() / 1000);
  let text = '📋 复制任务';

  if (copyLastTargetTime > 0) {
    const remaining = copyLastTargetTime - now;
    if (remaining > 0) {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      text = `📋 ${m}:${String(s).padStart(2, '0')}`;
    } else {
      text = '📋 等待执行';
    }
  }

  copyMinimizedBarEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap">◀ ${text}</div>`;
}

function showCopyCountdown(targetStartTime: number, sourceName: string) {
  createCopyUI();
  if (copyHeaderEl) copyHeaderEl.textContent = '📋 复制任务已安排';

  // Store for minimized display
  copyLastTargetTime = targetStartTime;

  // Clear existing countdown timer
  if (copyCountdownTimer) clearInterval(copyCountdownTimer);

  function updateCountdown() {
    const now = Math.floor(Date.now() / 1000);
    const remaining = targetStartTime - now;

    if (remaining <= 0) {
      if (copyCountdownTimer) clearInterval(copyCountdownTimer);
      copyCountdownTimer = null;
      copyLastTargetTime = 0;
      if (copyBodyEl && !copyMinimized) {
        copyBodyEl.innerHTML = `
          <div style="margin-bottom:6px">源活动: ${escapeHtml(sourceName)}</div>
          <div style="color:#f59e0b;font-weight:500">等待执行...</div>
        `;
      }
      if (copyMinimized) updateCopyMinimizedContent();
      return;
    }

    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    if (copyBodyEl && !copyMinimized) {
      copyBodyEl.innerHTML = `
        <div style="margin-bottom:6px">源活动: ${escapeHtml(sourceName)}</div>
        <div style="margin-bottom:4px;color:#374151">活动开始还有:</div>
        <div style="font-size:22px;font-weight:700;color:#2563eb;text-align:center;padding:4px 0">
          ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒
        </div>
      `;
    }

    // Update minimized bar on every tick
    if (copyMinimized) updateCopyMinimizedContent();
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
  copyLastTargetTime = 0;

  if (copyBodyEl && !copyMinimized) {
    copyBodyEl.innerHTML = `
      <div style="margin-bottom:6px">
        <span style="display:inline-block;padding:1px 8px;border-radius:10px;background:#2563eb;color:#fff;font-size:11px;font-weight:500">
          步骤 ${currentStep}/${totalSteps}
        </span>
      </div>
      <div style="color:#374151;font-weight:500">${escapeHtml(description)}</div>
    `;
  }

  if (copyMinimized) updateCopyMinimizedContent();
}

function showCopyComplete(success: boolean, error?: string) {
  if (!copyContainer) return;

  // Stop countdown timer
  if (copyCountdownTimer) {
    clearInterval(copyCountdownTimer);
    copyCountdownTimer = null;
  }
  copyLastTargetTime = 0;

  if (copyHeaderEl) {
    copyHeaderEl.textContent = success ? '✅ 复制完成（全部成功）' : '⚠️ 复制完成（有失败）';
    copyHeaderEl.style.color = success ? '#16a34a' : '#dc2626';
  }

  if (copyBodyEl && !copyMinimized) {
    copyBodyEl.innerHTML = success
      ? '<div style="color:#16a34a">商品配置已复制到新活动</div>'
      : `<div style="color:#dc2626">${escapeHtml(error || '未知错误')}</div>`;
  }

  if (copyMinimized) updateCopyMinimizedContent();

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
  // 清理残留 DOM（内容脚本重新加载后部分变量重置但旧元素仍在页面上）
  const stale = document.getElementById('__flash_sale_panel__');
  if (stale) stale.remove();

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
    transition: 'all 0.3s ease',
  });

  // Minimize button (top-right corner)
  minimizeBtnEl = document.createElement('button');
  minimizeBtnEl.textContent = '−';
  minimizeBtnEl.title = '最小化';
  Object.assign(minimizeBtnEl.style, {
    position: 'absolute',
    top: '2px',
    right: '6px',
    width: '20px',
    height: '20px',
    padding: '0',
    fontSize: '14px',
    fontWeight: '700',
    lineHeight: '18px',
    color: '#9ca3af',
    background: 'none',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'color 0.2s ease',
    zIndex: '1',
  });
  minimizeBtnEl.addEventListener('mouseenter', () => { if (minimizeBtnEl) minimizeBtnEl.style.color = '#374151'; });
  minimizeBtnEl.addEventListener('mouseleave', () => { if (minimizeBtnEl) minimizeBtnEl.style.color = '#9ca3af'; });
  minimizeBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMinimize();
  });
  panelContainer.appendChild(minimizeBtnEl);

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

  // Minimized bar (hidden by default)
  minimizedBarEl = document.createElement('div');
  minimizedBarEl.style.display = 'none';
  Object.assign(minimizedBarEl.style, {
    cursor: 'pointer',
    textAlign: 'center',
    padding: '4px 0',
    fontSize: '11px',
    color: '#374151',
    lineHeight: '1.3',
    userSelect: 'none',
  });
  minimizedBarEl.addEventListener('click', () => toggleMinimize());
  panelContainer.appendChild(minimizedBarEl);

  document.body.appendChild(panelContainer);
}

function toggleMinimize() {
  if (!panelContainer || !minimizedBarEl || !minimizeBtnEl) return;

  panelMinimized = !panelMinimized;

  if (panelMinimized) {
    // Save current visibility
    wasAutoVisible = autoSectionEl?.style.display === 'block';
    wasProgressVisible = progressSectionEl?.style.display === 'block';
    wasCopyVisible = copySectionEl?.style.display === 'block';

    // Hide sections
    if (autoSectionEl) autoSectionEl.style.display = 'none';
    if (progressSectionEl) progressSectionEl.style.display = 'none';
    if (copySectionEl) copySectionEl.style.display = 'none';

    // Shrink panel
    panelContainer.style.padding = '4px 8px';
    panelContainer.style.minWidth = 'auto';
    panelContainer.style.maxWidth = '180px';

    // Show minimized bar
    minimizeBtnEl.textContent = '▶';
    minimizeBtnEl.title = '展开';
    minimizedBarEl.style.display = 'block';
    updateMinimizedContent();
  } else {
    // Restore sections
    if (autoSectionEl) autoSectionEl.style.display = wasAutoVisible ? 'block' : 'none';
    if (progressSectionEl) progressSectionEl.style.display = wasProgressVisible ? 'block' : 'none';
    if (copySectionEl) copySectionEl.style.display = wasCopyVisible ? 'block' : 'none';

    // Restore panel size
    panelContainer.style.padding = '10px 14px';
    panelContainer.style.minWidth = '210px';
    panelContainer.style.maxWidth = '300px';

    // Hide minimized bar
    minimizeBtnEl.textContent = '−';
    minimizeBtnEl.title = '最小化';
    minimizedBarEl.style.display = 'none';
  }
}

function updateMinimizedContent() {
  if (!minimizedBarEl || !panelMinimized) return;

  const lines: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  // Auto mode countdown
  if (autoStatusData?.isRunning) {
    const targetTime = autoStatusData.nextActionTime || autoStatusData.nextTargetTime;
    if (targetTime) {
      const remaining = targetTime - now;
      if (remaining > 0) {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        lines.push(`🤖 ${m}:${String(s).padStart(2, '0')}`);
      } else {
        lines.push('🤖 即将执行');
      }
    } else {
      lines.push(`🤖 第${autoStatusData.currentRound || 0}/${autoStatusData.totalRounds || 0}轮`);
    }
  }

  // Enable progress
  if (wasProgressVisible && !autoStatusData?.isRunning) {
    lines.push('🚀 修复中...');
  }

  if (lines.length === 0) {
    lines.push('⏳ 运行中');
  }

  minimizedBarEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap">◀ ${lines.join(' · ')}</div>`;
}

function updateAutoCountdown() {
  if (!autoStatusData?.isRunning) {
    if (autoCountdownTimer) {
      clearInterval(autoCountdownTimer);
      autoCountdownTimer = null;
    }
    return;
  }

  const targetTime = autoStatusData.nextActionTime || autoStatusData.nextTargetTime;
  const el = document.getElementById('__auto_countdown__');
  if (!el || !targetTime) return;

  const now = Math.floor(Date.now() / 1000);
  const remaining = targetTime - now;

  if (remaining <= 0) {
    el.innerHTML = '<span style="color:#f59e0b">即将执行...</span>';
  } else {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.innerHTML = `${m} 分 <span style="font-size:16px">${String(s).padStart(2, '0')}</span> 秒`;
  }

  // Also update minimized bar
  if (panelMinimized) updateMinimizedContent();
}

function renderAutoSection(status: any) {
  createPanel();
  if (!autoSectionEl) return;

  // Store status for countdown / minimized bar
  autoStatusData = status;

  const isRunning = status?.isRunning;
  if (!isRunning) {
    autoSectionEl.style.display = 'none';
    // Clear countdown timer
    if (autoCountdownTimer) {
      clearInterval(autoCountdownTimer);
      autoCountdownTimer = null;
    }
    // Update minimized bar (may still show progress)
    if (panelMinimized) updateMinimizedContent();
    return;
  }

  if (!panelMinimized) {
    autoSectionEl.style.display = 'block';
  }
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

  const targetTime = status.nextActionTime || status.nextTargetTime;
  const countdownHtml = targetTime
    ? `<div id="__auto_countdown__" style="font-size:20px;font-weight:700;color:#2563eb;text-align:center;padding:6px 0">--</div>`
    : '';

  autoSectionEl.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#1f2937">🤖 自动模式 <span style="color:#16a34a;font-size:11px">● 运行中</span></div>
    <div style="font-size:11px;color:#6b7280;margin-bottom:4px">
      第 ${status.currentRound || 0}/${status.totalRounds || 0} 轮 | ${phaseText}
    </div>
    ${status.nextTargetTime ? `<div style="font-size:11px;color:#6b7280;margin-bottom:2px">下一场: ${fmtContentTime(status.nextTargetTime)}</div>` : ''}
    ${countdownHtml}
    <button id="__auto_stop_btn__" style="
      margin-top:4px;width:100%;padding:3px 0;font-size:11px;font-weight:500;
      color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;
      cursor:pointer;text-align:center;
    ">⏹ 停止自动模式</button>
  `;

  // Start / restart countdown timer
  if (autoCountdownTimer) {
    clearInterval(autoCountdownTimer);
  }
  if (targetTime) {
    updateAutoCountdown();
    autoCountdownTimer = setInterval(updateAutoCountdown, 1000);
  }

  // Update minimized bar
  if (panelMinimized) updateMinimizedContent();

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

    // Harness injection marker (for extension-harness content script detection)
    document.documentElement.dataset.extensionRoot = 'limited-time-sale';
    (window as any).__EXTENSION_HARNESS_READY__ = true;

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
