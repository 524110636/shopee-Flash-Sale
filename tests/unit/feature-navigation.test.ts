import { describe, it, expect } from 'vitest';
import { Zap, PackageSearch } from 'lucide-react';
import {
  FEATURES,
  FEATURE_CATEGORIES,
  FLASH_SALE_FEATURE_ID,
  SHIPPING_FEATURE_ID,
  groupFeaturesByCategory,
  type FeatureDefinition,
} from '@/components/product/feature-catalog';
import {
  buildTaskSummaries,
  formatTaskTime,
  type TaskSummaryInput,
} from '@/components/product/task-summary';

/** 卡片图标必须是 lucide 组件，不能是 emoji 字符串（用户 2026-10-13 要求） */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('feature catalog', () => {
  it('registers only the real tool cards', () => {
    expect(FEATURES.map(f => f.id)).toEqual([FLASH_SALE_FEATURE_ID, SHIPPING_FEATURE_ID]);
    expect(FEATURES[0].title).toBe('限时特卖');
    expect(FEATURES[0].categoryId).toBe('shop-operations');
    expect(FEATURES[1].title).toBe('商品备货与物流');
    expect(FEATURES[1].categoryId).toBe('shop-operations');
  });

  it('keeps the required definition fields for future tools', () => {
    for (const feature of FEATURES) {
      expect(feature.id).toBeTruthy();
      expect(feature.categoryId).toBeTruthy();
      expect(feature.title).toBeTruthy();
      expect(feature.description).toBeTruthy();
      expect(feature.entry).toBeTruthy();
      expect(typeof feature.Icon).toBe('object');
    }
  });

  it('uses a component icon instead of emoji anywhere in the card fields', () => {
    const icons = new Set([Zap, PackageSearch]);
    for (const feature of FEATURES) {
      expect(icons.has(feature.Icon)).toBe(true);
      for (const text of [feature.title, feature.description, feature.entry, feature.id]) {
        expect(EMOJI_RE.test(text), `功能定义里不应出现 emoji：${text}`).toBe(false);
      }
    }
  });

  it('describes creating, copying and the automatic loop without leaking mode split', () => {
    const description = FEATURES[0].description;
    expect(description).toContain('复制');
    expect(description).toContain('自动');
    expect(description).not.toContain('手动模式');
    expect(description).not.toContain('自动模式');
  });

  it('describes the shipping tool without promising the excluded 满额赠 features', () => {
    const description = FEATURES[1].description;
    expect(description).toContain('备货天数');
    expect(description).toContain('物流');
    expect(description).toContain('安排');
    // 满额赠明确不在迁移范围，卡片文案也不能暗示它
    expect(description).not.toContain('满额赠');
    // 第 53.4 节 U15：主路径只剩单次成对安排，不能再承诺旧的"至多两项定时计划"
    expect(description).not.toContain('至多两项');
  });

  it('groups features under their category and drops empty categories', () => {
    const groups = groupFeaturesByCategory(FEATURES, [
      ...FEATURE_CATEGORIES,
      { id: 'ai', title: 'AI 工具' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category.id).toBe('shop-operations');
    expect(groups[0].features.map(f => f.id)).toEqual([FLASH_SALE_FEATURE_ID, SHIPPING_FEATURE_ID]);
  });

  it('supports a fixture with many cards without changing entry semantics', () => {
    const fixture: FeatureDefinition[] = Array.from({ length: 14 }, (_, i) => ({
      id: `fixture-${i}`,
      categoryId: 'shop-operations',
      title: `夹具工具 ${i}`,
      description: '隔离测试用虚构卡片',
      Icon: Zap,
      entry: `fixture-entry-${i}`,
    }));
    const groups = groupFeaturesByCategory(fixture);
    expect(groups[0].features).toHaveLength(14);
  });
});

const baseInput: TaskSummaryInput = { statusReady: true };

describe('task summaries', () => {
  it('shows a loading summary instead of claiming idle while status is pending', () => {
    const summaries = buildTaskSummaries({ statusReady: false, autoModeRunning: false });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('loading');
    expect(summaries[0].actionLabel).toBe('');
  });

  it('returns no summary when nothing is running', () => {
    expect(buildTaskSummaries(baseInput)).toEqual([]);
  });

  it('does not treat the auto tab selection as a running task', () => {
    // 旧记录恢复只写入 autoModeStatus，isRunning=false 时不得标记运行中
    const summaries = buildTaskSummaries({
      ...baseInput,
      autoModeRunning: false,
      autoModeRound: 3,
      autoModePhase: 'waiting_enable',
    });
    expect(summaries).toEqual([]);
  });

  it('shows a running auto summary with round and phase', () => {
    const summaries = buildTaskSummaries({
      ...baseInput,
      autoModeRunning: true,
      autoModeRound: 2,
      autoModePhase: 'creating',
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('auto');
    expect(summaries[0].tone).toBe('running');
    expect(summaries[0].detail).toContain('第 2 轮');
    expect(summaries[0].detail).toContain('正在创建活动');
  });

  it('shows manual enable progress', () => {
    const summaries = buildTaskSummaries({
      ...baseInput,
      isEnabling: true,
      enableRound: 1,
      enableMaxRounds: 10,
    });
    expect(summaries[0].kind).toBe('manual');
    expect(summaries[0].detail).toBe('第 1/10 轮');
  });

  it('shows a pending scheduled task with its target time', () => {
    const target = Math.floor(new Date(2026, 9, 13, 10, 30).getTime() / 1000);
    const summaries = buildTaskSummaries({
      ...baseInput,
      scheduledCopyExists: true,
      scheduledCopyTargetTime: target,
    });
    expect(summaries[0].kind).toBe('scheduled');
    expect(summaries[0].tone).toBe('pending');
    expect(summaries[0].detail).toBe(`目标 ${formatTaskTime(target)}`);
  });

  it('reports a scheduled enable task even when no scheduled copy exists', () => {
    // R2：只有 _scheduledEnable（定时加入）时也必须显示摘要与查看入口
    const target = Math.floor(new Date(2026, 9, 14, 9, 0).getTime() / 1000);
    const summaries = buildTaskSummaries({
      ...baseInput,
      scheduledCopyExists: false,
      scheduledEnableExists: true,
      scheduledEnableTargetTime: target,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('scheduled');
    expect(summaries[0].title).toBe('定时加入待执行');
    expect(summaries[0].actionLabel).toBe('查看任务');
    expect(summaries[0].detail).toBe(`目标 ${formatTaskTime(target)}`);
  });

  it('keeps scheduled copy and scheduled enable summaries independent', () => {
    const summaries = buildTaskSummaries({
      ...baseInput,
      scheduledCopyExists: true,
      scheduledCopyTargetTime: Math.floor(Date.now() / 1000) + 600,
      scheduledEnableExists: true,
      scheduledEnableTargetTime: Math.floor(Date.now() / 1000) + 1200,
    });
    expect(summaries.map(s => s.title)).toEqual(['定时复制待执行', '定时加入待执行']);
    expect(summaries.every(s => s.actionLabel === '查看任务')).toBe(true);
  });

  it('keeps multiple tasks reachable at the same time', () => {
    const summaries = buildTaskSummaries({
      ...baseInput,
      autoModeRunning: true,
      autoModeRound: 1,
      isEnabling: true,
      scheduledCopyExists: true,
      scheduledCopyTargetTime: Math.floor(Date.now() / 1000) + 600,
      scheduledEnableExists: true,
      scheduledEnableTargetTime: Math.floor(Date.now() / 1000) + 900,
      copyCompleted: true,
    });
    expect(summaries.map(s => s.kind)).toEqual(['auto', 'manual', 'scheduled', 'scheduled', 'copy-completed']);
    expect(summaries.every(s => s.actionLabel)).toBe(true);
  });
});
