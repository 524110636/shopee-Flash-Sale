import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '@/entrypoints/popup/store';

const STEPS = [
  { index: 0, label: '复制模板' },
  { index: 1, label: '创建任务' },
  { index: 2, label: '等待开始' },
  { index: 3, label: '手动开启' },
];

export function ScheduledTaskCard() {
  const { scheduledTaskStatus, hasScheduledCopy, checkScheduledCopy } = useAppStore();

  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1-second tick for live countdown (same pattern as AutoModePanel)
  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Periodically refresh alarm status
  useEffect(() => {
    const timer = setInterval(() => checkScheduledCopy(), 30000);
    return () => clearInterval(timer);
  }, [checkScheduledCopy]);

  if (!hasScheduledCopy || !scheduledTaskStatus?.exists) return null;

  const params = scheduledTaskStatus.params;
  const remainingSeconds = scheduledTaskStatus.remainingSeconds ?? 0;
  const alarmActive = scheduledTaskStatus.alarmActive;

  // Step index: 0=复制模板, 1=创建任务, 2=等待开始(有alarm), 3=手动开启(已触发但尚未ack)
  const currentStepIndex = alarmActive ? 2 : 1;

  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hh}:${mm}`;
  };

  const countdownText = () => {
    const secs = Math.max(0, remainingSeconds);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}时${m}分${s}秒`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  };

  return (
    <div className="bg-gradient-to-r from-blue-50 to-sky-50/60 border border-blue-200 rounded-lg px-3 py-2.5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <span className="font-semibold text-blue-800 text-xs">定时复制任务</span>
        </div>
        <button
          className="text-[10px] text-blue-600 hover:text-blue-800 underline"
          onClick={() => checkScheduledCopy()}
        >
          刷新
        </button>
      </div>

      {/* 4-step progress indicator */}
      <div className="flex items-center mb-2">
        {STEPS.map((step, idx) => (
          <React.Fragment key={step.index}>
            <div className="flex items-center gap-1">
              {idx < currentStepIndex ? (
                /* Completed step: filled circle with checkmark */
                <div className="w-4 h-4 rounded-full bg-shopee-brand flex items-center justify-center shrink-0">
                  <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              ) : idx === currentStepIndex ? (
                /* Current step: pulsing dot */
                <div className="w-4 h-4 rounded-full border-2 border-shopee-brand bg-white flex items-center justify-center shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-shopee-brand animate-pulse-dot" />
                </div>
              ) : (
                /* Future step: empty circle */
                <div className="w-4 h-4 rounded-full border-2 border-gray-300 bg-white shrink-0" />
              )}
              <span className={`text-[10px] leading-none whitespace-nowrap ${
                idx <= currentStepIndex ? 'text-shopee-brand-dark font-medium' : 'text-gray-400'
              }`}>
                {step.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-1 ${
                idx < currentStepIndex ? 'bg-shopee-brand' : 'bg-gray-300'
              }`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Content area */}
      <div className="text-xs text-blue-800 space-y-1">
        {params && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-blue-600">源活动:</span>
              <span className="font-medium text-right ml-2 truncate">
                {params.sourceFlashSaleName || `活动 #${params.sourceFlashSaleId}`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-blue-600">目标时间:</span>
              <span className="font-medium">{fmtTime(params.targetStartTime)}</span>
            </div>
          </>
        )}

        {/* Live countdown */}
        {alarmActive && (
          <div className="mt-1.5 pt-1.5 border-t border-blue-200/60">
            <div className="flex items-center justify-between">
              <span className="text-blue-600">倒计时:</span>
              <span className="font-mono font-bold text-shopee-brand-dark text-sm tracking-wide">
                {countdownText()}
              </span>
            </div>
            <p className="text-[10px] text-blue-500 mt-0.5">
              系统将自动创建场次。场次创建后，需要手动点击「开启限时特卖」提交商品
            </p>
          </div>
        )}

        {/* Alarm inactive warning */}
        {!alarmActive && params && (
          <div className="mt-1.5 pt-1.5 border-t border-blue-200/60">
            <div className="flex items-center gap-1 text-amber-700">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span className="text-xs">定时器未生效，可能已被浏览器清除。请重新创建复制任务。</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
