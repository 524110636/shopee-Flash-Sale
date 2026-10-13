import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TriangleAlert } from 'lucide-react';
import {
  FEATURES,
  FEATURE_CATEGORIES,
  groupFeaturesByCategory,
  type FeatureDefinition,
} from './feature-catalog';
import type { TaskSummary } from './task-summary';

interface FeatureHomeProps {
  /** 首页卡片定义，默认取正式功能表；测试夹具可传入虚构卡片 */
  features?: FeatureDefinition[];
  /** 任务摘要，来自真实状态派生 */
  summaries: TaskSummary[];
  /** 未绑定／同步失败等公共状态提示，可为空 */
  bindingNotice?: string | null;
  bindingNoticeAction?: { label: string; onClick: () => void } | null;
  /** 卡片普通入口 → 固定进入手动模式 */
  onEnterFeature: (featureId: string) => void;
  /** 任务摘要查看入口 → 直达对应模式 */
  onViewTask: (summary: TaskSummary) => void;
}

/** 功能首页：先选工具，再进入具体工作页。只做展示与导航，不执行业务动作。 */
export function FeatureHome({
  features = FEATURES,
  summaries,
  bindingNotice,
  bindingNoticeAction,
  onEnterFeature,
  onViewTask,
}: FeatureHomeProps) {
  const groups = groupFeaturesByCategory(features, FEATURE_CATEGORIES);

  return (
    <div className="space-y-4">
      {bindingNotice && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden='true' />
            <span className="min-w-0 flex-1">{bindingNotice}</span>
            {bindingNoticeAction && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 shrink-0 border-amber-300 px-2 text-[10px] text-amber-800"
                onClick={bindingNoticeAction.onClick}
              >
                {bindingNoticeAction.label}
              </Button>
            )}
          </div>
        </div>
      )}

      {groups.map(group => (
        <div key={group.category.id} className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">{group.category.title}</h2>
          <div className="grid grid-cols-2 gap-3">
            {group.features.map(feature => (
              <Card
                key={feature.id}
                role="button"
                tabIndex={0}
                aria-label={feature.title}
                data-feature-id={feature.id}
                className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onEnterFeature(feature.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onEnterFeature(feature.id);
                  }
                }}
              >
                <CardContent className="space-y-1.5 p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-shopee-brand-light">
                      <feature.Icon className="h-4 w-4 text-shopee-brand" aria-hidden='true' />
                    </span>
                    <span className="text-sm font-medium">{feature.title}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      <div className="space-y-2">
        <h2 className="text-xs font-medium text-muted-foreground">已有任务</h2>
        {summaries.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">当前没有进行中的任务</p>
        ) : (
          <div className="space-y-1.5">
            {summaries.map((summary, index) => (
              <div
                key={`${summary.kind}-${index}`}
                className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {summary.tone === 'loading' ? (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/50" />
                  ) : (
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        summary.tone === 'running'
                          ? 'animate-pulse-dot bg-shopee-green'
                          : summary.tone === 'pending'
                            ? 'bg-shopee-blue'
                            : summary.tone === 'interrupted'
                              ? 'bg-destructive'
                              : 'bg-shopee-brand'
                      }`}
                    />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{summary.title}</div>
                    {summary.detail && <div className="truncate text-[10px] text-muted-foreground">{summary.detail}</div>}
                  </div>
                </div>
                {summary.actionLabel && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[10px] font-normal"
                    onClick={() => onViewTask(summary)}
                  >
                    {summary.actionLabel}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
