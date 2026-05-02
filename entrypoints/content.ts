import { defineContentScript } from 'wxt/utils/define-content-script';

interface ProgressData {
  totalSkus: number;
  successSkus: number;
  failedSkus: number;
  currentRound: number;
  isComplete: boolean;
}

let container: HTMLDivElement | null = null;
let successEl: HTMLElement | null = null;
let failedEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let barEl: HTMLElement | null = null;
let headerEl: HTMLElement | null = null;
let stopBtnEl: HTMLElement | null = null;
let removeTimer: ReturnType<typeof setTimeout> | null = null;

function createProgressUI() {
  if (container) return;

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

function updateProgress(data: ProgressData) {
  if (!container) createProgressUI();

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

function showComplete(data: ProgressData) {
  if (!container) return;

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
}

export default defineContentScript({
  matches: ['https://seller.shopee.tw/*'],
  runAt: 'document_idle',
  main() {
    console.log('[限时特卖助手] Content Script 已加载');

    browser.runtime.onMessage.addListener((msg: any) => {
      const type = msg?.type;

      if (type === 'ENABLE_PROGRESS' && msg.progress) {
        updateProgress({
          totalSkus: msg.progress.totalSkus || 0,
          successSkus: msg.progress.successSkus || 0,
          failedSkus: msg.progress.failedSkus || 0,
          currentRound: msg.progress.currentRound || 0,
          isComplete: false,
        });
      }

      if (type === 'ENABLE_COMPLETE' && msg.progress) {
        showComplete({
          totalSkus: msg.progress.totalSkus || 0,
          successSkus: msg.progress.successSkus || 0,
          failedSkus: msg.progress.failedSkus || 0,
          currentRound: msg.progress.currentRound || 0,
          isComplete: true,
        });
      }

      return false;
    });
  },
});
