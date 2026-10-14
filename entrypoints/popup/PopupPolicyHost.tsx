import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkPolicy,
  acknowledgeNotice,
  resolveAssetUrls,
  type PopupPolicyEntry,
} from './popup-policy';
import { reportPopupView } from './popup-views';
import { sanitizeForRender } from './popup-content';

/**
 * 弹窗策略宿主：**只包住登录后已就绪的功能区**。
 *
 * 为什么不再在 main.tsx 包住整个 App：App 在「检查登录」「未登录」「同步店铺」
 * 三处提前 return。宿主放在最外层会让检查遮罩盖在登录表单上、未登录也弹通知 ——
 * 用户已明确要求「登录后进入功能界面才出现」。改成由 App 只在**功能就绪分支**里挂载，
 * 宿主就不需要再猜认证状态，未登录时根本不存在于组件树里：不检查、不展示、
 * 不遮挡登录表单、不上报，也**不触碰缓存与已读存储**（缓存不能因为未登录被当成撤回清掉）。
 *
 * 挂在就绪分支的最外层（页面上方）还保证：首页 ↔ 工作页切换不会重建公告状态，
 * 也不会把同一次查看反复上报。
 *
 * 强制模式**不可取消**的实现：内容包一层 inert + aria-hidden，遮罩自己吃掉
 * 点击与键盘事件，且不响应 Escape、不提供关闭按钮。程序内导航（page 切换）发生在
 * 被 inert 的子树里，用户在升级前点不到。
 */

type Phase = 'checking' | 'done';

const Wrapper: React.FC<{ blocked: boolean; children: React.ReactNode }> = ({ blocked, children }) => (
  <div {...(blocked ? { inert: true } : {})} aria-hidden={blocked ? true : undefined}>
    {children}
  </div>
);

/** 遮罩层：吞掉点击、阻止 Esc 与 Tab 逃逸到下层。 */
const Overlay: React.FC<{
  children: React.ReactNode;
  /** 强制模式禁止任何关闭路径；通知模式允许点按钮关闭，但遮罩本身不关。 */
  cancellable: boolean;
  onRequestClose?: () => void;
}> = ({ children, cancellable, onRequestClose }) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (cancellable) onRequestClose?.();
      return;
    }
    // 只允许在遮罩内部移动焦点，防止 Tab 跑到被 inert 的底层
    if (e.key === 'Tab') {
      e.stopPropagation();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // 点遮罩空白处：强制模式什么都不做（不可取消），通知模式也不当确认
        e.stopPropagation();
      }}
    >
      <div
        className="w-full max-w-[440px] max-h-[80vh] flex flex-col rounded-xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

const PolicyBody: React.FC<{ entry: PopupPolicyEntry; backendUrl: string }> = ({ entry, backendUrl }) => {
  const html = React.useMemo(
    // 先做安全收紧，再把自有资源相对路径补成后端完整 URL（否则图片会去扩展目录找）。
    () => resolveAssetUrls(sanitizeForRender(entry.contentHtml), backendUrl),
    [entry.contentHtml, backendUrl],
  );
  return (
    <>
      {entry.title && (
        <div className="px-5 py-3 bg-gradient-to-r from-shopee-brand to-orange-500 shrink-0">
          <h2 className="text-sm font-semibold text-white break-words">{entry.title}</h2>
        </div>
      )}
      {/* 长正文可滚动；图片自适应宽度不溢出 */}
      <div
        className="px-5 py-4 text-[13px] leading-relaxed text-foreground overflow-y-auto [&_img]:max-w-full [&_img]:h-auto [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_a]:text-blue-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
};

function openDownload(url: string): void {
  // 只跳转，不写任何「已升级」标记，也不调用 runtime.reload。
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const PopupPolicyHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<Phase>('checking');
  const [forced, setForced] = useState<PopupPolicyEntry | null>(null);
  const [notice, setNotice] = useState<PopupPolicyEntry | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState('');

  /**
   * 上报「这条弹窗真的显示了」。
   *
   * 只在**实际渲染**的条目上调用：强制优先时被遮住的通知、已确认后不再显示的
   * 通知、版本已达标而未显示的强制都不会走到这里 —— 这由渲染分支决定，
   * 而不是由上报模块猜测。
   *
   * 补报前的可见性复查用 `visibleRef`：身份补报是异步的，回调执行时组件可能
   * 已经重新渲染（用户点了「我知道了」）。ref 只能在 effect 里写，不能在渲染中写。
   */
  const visibleRef = useRef<PopupPolicyEntry | null>(null);

  useEffect(() => {
    if (phase !== 'done') return;
    const shown = forced ?? notice;
    visibleRef.current = shown;
    if (!shown) return;
    const unsubscribe = reportPopupView(backendUrl, shown.recordId, shown.mode, shown.revision, () => {
      // 补报前复查：身份就绪那一刻这条是否仍然显示（没被确认掉、没被撤下）。
      return visibleRef.current === shown;
    });
    return () => {
      visibleRef.current = null;
      unsubscribe();
    };
  }, [phase, forced, notice, backendUrl]);

  /**
   * 检查 effect 必须可重复执行。
   *
   * 为什么不能用 `started` ref 拦第二次：React 开发模式 StrictMode 会跑
   * 「setup → cleanup → setup」。原来的写法第一次 setup 起了请求、cleanup 把
   * 结果标记为取消，第二次 setup 又被 ref 拦住 —— 两边夹击，界面永远停在
   * 「正在检查通知」。正确做法是允许重复执行，只丢弃**已卸载**那次的结果。
   *
   * 为什么挂载即检查就够了：宿主只在「登录成功且首次功能就绪」的分支里出现，
   * 所以挂载时刻就是「该检查」的时刻。同一个 popup 内登录也会让 App 切进这个分支、
   * 重新挂载宿主，因此不需要额外的「先匿名打开后再登录」触发。
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const decision = await checkPolicy();
      if (cancelled) return;

      setForced(decision.forced);
      setNotice(decision.notice);
      setConnectionError(decision.connectionError);
      // 地址来自 decision：**不能**在这里再 await 一次地址解析，
      // 那一步在 5 秒上限之外，会把「已超时」的结论又拖回无限等待。
      setBackendUrl(decision.backendUrl);
      setPhase('done');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAcknowledge = useCallback(async () => {
    if (!notice) return;
    // 已读写入失败不能把用户困在弹窗里：无论成败都关掉本地展示。
    try {
      await acknowledgeNotice(backendUrl, notice.revision);
    } catch { /* 写不进去也先关掉，下次打开按未读再显示 */ }
    setNotice(null);
  }, [notice, backendUrl]);

  const blocked = phase === 'checking' || forced !== null;

  return (
    <>
      <Wrapper blocked={blocked}>{children}</Wrapper>

      {phase === 'checking' && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-white/70">
          <div className="text-center">
            <div className="animate-spin w-5 h-5 border-2 border-shopee-brand border-t-transparent rounded-full mx-auto" />
            <p className="mt-2 text-xs text-muted-foreground">正在检查通知…</p>
          </div>
        </div>
      )}

      {forced && (
        <Overlay cancellable={false}>
          <PolicyBody entry={forced} backendUrl={backendUrl} />
          <div className="px-5 py-3 border-t bg-muted/30 shrink-0">
            <button
              className="w-full py-2 rounded-md bg-shopee-brand text-white text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => openDownload(forced.downloadUrl || '')}
              disabled={!forced.downloadUrl}
            >
              下载最新版本
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              正在运行的任务与已安排的定时任务会照常执行，不会因为本提示而停止。
              建议等任务结束后再重载扩展。
            </p>
          </div>
        </Overlay>
      )}

      {notice && (
        <Overlay cancellable onRequestClose={handleAcknowledge}>
          <PolicyBody entry={notice} backendUrl={backendUrl} />
          <div className="px-5 py-3 border-t bg-muted/30 shrink-0">
            <button
              className="w-full py-2 rounded-md bg-shopee-brand text-white text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={handleAcknowledge}
            >
              我知道了
            </button>
          </div>
        </Overlay>
      )}

      {/* 连接失败提醒：已知强制要求继续阻挡；无缓存时恢复原界面并提示，不误判为已撤回 */}
      {phase === 'done' && connectionError && (
        <div className="fixed left-0 right-0 bottom-0 z-[9997] mx-3 mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
          <p className="text-[11px] text-amber-800">
            已沿用上次的通知内容：{connectionError}。正在运行的任务不受影响。
          </p>
        </div>
      )}
    </>
  );
};
