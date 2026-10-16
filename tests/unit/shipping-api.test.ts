/**
 * shipping REST 适配层的隔离单测。
 *
 * 这层是本轮返工 R1（特卖排除必须 fail closed、要翻页）与 R2（缺 code 不得当成功、
 * 传输未知不得重试）的落点，所以这些契约单独钉在这里。
 */
import { describe, it, expect } from 'vitest';
import {
  fetchFlashSaleExcludeIds,
  isRateLimitError,
  parseBatchWriteResponse,
  redactSensitiveText,
  updateChannelToggle,
  updateProductBatch,
} from '@/features/shipping/api';

const credential = { spcCds: 'iso-cred', spcCdsVer: '2' };
const NOON = 1_800_000_000;

/** 统一的假请求实现：测试只关心"某 URL 返回什么"，泛型由这里收口。 */
type Handler = (url: string) => unknown | Promise<unknown>;

function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return await handler(url);
  };
  return { fn: fn as unknown as Parameters<typeof updateProductBatch>[0], calls };
}

function listResponse(sales: unknown[], extra: Record<string, unknown> = {}) {
  return { code: 0, data: { flash_sale_list: sales, ...extra } };
}

describe('R2 批量写响应解析', () => {
  it('缺逐项 code 时记 null，不默认成 0（成功）', () => {
    const parsed = parseBatchWriteResponse({ code: 0, data: { result: [{ id: 101 }] } });
    expect(parsed.itemResults).toEqual([{ id: '101', code: null }]);
    expect(parsed.hasItemResults).toBe(true);
  });

  it('明确 code 0 仍是成功，非 0 保留原码', () => {
    const parsed = parseBatchWriteResponse({
      code: 0,
      data: {
        result: [
          { id: 1, code: 0 },
          { id: 2, code: 1000100252 },
          { id: 3, code: 10001 },
        ],
      },
    });
    expect(parsed.itemResults).toEqual([
      { id: '1', code: 0 },
      { id: '2', code: 1000100252 },
      { id: '3', code: 10001 },
    ]);
  });

  it('没有逐项结果数组时 hasItemResults 为 false（与空数组区分）', () => {
    expect(parseBatchWriteResponse({ code: 0 }).hasItemResults).toBe(false);
    expect(parseBatchWriteResponse({ code: 0, data: { result: [] } }).hasItemResults).toBe(true);
    expect(parseBatchWriteResponse({ code: 0, data: {} }).hasItemResults).toBe(false);
  });

  it('顶层非 0 时记录错误信息与错误码', () => {
    const parsed = parseBatchWriteResponse({ code: 409, message: 'busy' });
    expect(parsed.topLevelSuccess).toBe(false);
    expect(parsed.topCode).toBe(409);
    expect(parsed.error).toBe('busy');
  });
});

describe('R2 传输未知与限流区分', () => {
  const payload = [{ id: 101, category_path: 'a/b', pre_order: false, days_to_ship: 1 }];

  it('传输异常标记 transportUnknown，不标记限流（调用方据此不重发）', async () => {
    const { fn } = fakeFetch(() => {
      throw new Error('socket hang up');
    });
    const result = await updateProductBatch(fn, credential, payload);
    expect(result.transportUnknown).toBe(true);
    expect(result.rateLimited).toBe(false);
  });

  it('HTTP 429 → 限流（可退避重试），不是传输未知', async () => {
    const { fn } = fakeFetch(() => {
      throw new Error('HTTP 429: Too Many Requests');
    });
    const result = await updateProductBatch(fn, credential, payload);
    expect(result.rateLimited).toBe(true);
    expect(result.transportUnknown).toBe(false);
  });

  it('平台业务码 1000100006 → 限流', async () => {
    const { fn } = fakeFetch(() => ({ code: 1000100006, message: 'rate limited' }));
    const result = await updateProductBatch(fn, credential, payload);
    expect(result.rateLimited).toBe(true);
    expect(result.topLevelSuccess).toBe(false);
  });

  it('限流识别不误伤普通错误文本', () => {
    expect(isRateLimitError('HTTP 429')).toBe(true);
    expect(isRateLimitError('HTTP 409')).toBe(true);
    expect(isRateLimitError('code 1000100006')).toBe(true);
    expect(isRateLimitError('product 4291234 not found')).toBe(false);
    expect(isRateLimitError('socket hang up')).toBe(false);
  });
});

describe('R1 特卖排除调查 fail closed 与分页', () => {
  it('部分活动商品读取失败 → 整体失败（不能当成没有排除）', async () => {
    const { fn } = fakeFetch(url => {
      if (url.includes('get_shop_flash_sale_list')) {
        return listResponse([
          { flash_sale_id: 1, start_time: 1, end_time: 9_999_999_999 },
          { flash_sale_id: 2, start_time: 1, end_time: 9_999_999_999 },
        ]);
      }
      if (url.includes('flash_sale_id=1')) return { code: 0, data: { item_ids: [201] } };
      throw new Error('second activity unavailable');
    });
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok, '部分失败被当成成功（fail open）').toBe(false);
    expect(result.error).toContain('商品读取失败');
  });

  it('活动列表响应缺字段 → 整体失败', async () => {
    const { fn } = fakeFetch(() => ({ code: 0, data: {} }));
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('flash_sale_list');
  });

  it('活动商品响应缺 item_ids → 整体失败', async () => {
    const { fn } = fakeFetch(url =>
      url.includes('get_shop_flash_sale_list')
        ? listResponse([{ flash_sale_id: 1, start_time: 1, end_time: 9_999_999_999 }])
        : { code: 0, data: {} },
    );
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('item_ids');
  });

  it('活动缺少 flash_sale_id → 整体失败', async () => {
    const { fn } = fakeFetch(() => listResponse([{ start_time: 1, end_time: 9_999_999_999 }]));
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('flash_sale_id');
  });

  it('活动列表要翻页读取（只看第一页会漏掉后面的活动）', async () => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('get_shop_flash_sale_list')) {
        return listResponse(
          Array.from({ length: 50 }, (_, i) => ({ flash_sale_id: i + 1, start_time: 1, end_time: 9_999_999_999 })),
          { total: 51, has_more: true },
        );
      }
      return { code: 0, data: { item_ids: [201] } };
    });
    await fetchFlashSaleExcludeIds(fn, credential, NOON);
    const listCalls = calls.filter(u => u.includes('get_shop_flash_sale_list'));
    expect(listCalls.length, '没有读取特卖活动列表的后续页').toBeGreaterThan(1);
    expect(listCalls[1]).toContain('offset=50');
  });

  it('有 total 时按 total 判定结束，不多读', async () => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('get_shop_flash_sale_list')) {
        return listResponse([{ flash_sale_id: 1, start_time: 1, end_time: 9_999_999_999 }], {
          total: 1,
          has_more: false,
        });
      }
      return { code: 0, data: { item_ids: [201] } };
    });
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(true);
    expect(calls.filter(u => u.includes('get_shop_flash_sale_list'))).toHaveLength(1);
  });

  it('没有进行中／即将开始的活动时不发商品读取请求', async () => {
    const { fn, calls } = fakeFetch(url =>
      url.includes('get_shop_flash_sale_list')
        ? listResponse([{ flash_sale_id: 1, start_time: NOON - 1000, end_time: NOON - 500 }])
        : { code: 0, data: { item_ids: [] } },
    );
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(true);
    expect(calls.filter(u => u.includes('get_shop_flash_sale_item_id_list'))).toHaveLength(0);
    expect(result.itemIds.size).toBe(0);
  });

  it('成功时汇总去重后的商品 ID', async () => {
    const { fn } = fakeFetch(url => {
      if (url.includes('get_shop_flash_sale_list')) {
        return listResponse([
          { flash_sale_id: 1, start_time: 1, end_time: 9_999_999_999 },
          { flash_sale_id: 2, start_time: 1, end_time: 9_999_999_999 },
        ]);
      }
      if (url.includes('flash_sale_id=1')) return { code: 0, data: { item_ids: [1, 2] } };
      return { code: 0, data: { item_ids: [2, 3] } };
    });
    const result = await fetchFlashSaleExcludeIds(fn, credential, NOON);
    expect(result.ok).toBe(true);
    expect([...result.itemIds].sort()).toEqual(['1', '2', '3']);
  });
});

describe('渠道开关结果区分', () => {
  it('传输异常标记 unknown（可能已生效）', async () => {
    const { fn } = fakeFetch(() => {
      throw new Error('timeout');
    });
    const result = await updateChannelToggle(fn, credential, 9, false);
    expect(result.success).toBe(false);
    expect(result.unknown).toBe(true);
  });

  it('响应无法解析 → unknown', async () => {
    const { fn } = fakeFetch(() => 'not an object');
    const result = await updateChannelToggle(fn, credential, 9, false);
    expect(result.unknown).toBe(true);
  });

  it('明确非 0 业务码 → 确定失败（不是 unknown）', async () => {
    const { fn } = fakeFetch(() => ({ code: 1001, message: 'rejected' }));
    const result = await updateChannelToggle(fn, credential, 9, false);
    expect(result.success).toBe(false);
    expect(result.unknown).toBeUndefined();
    expect(result.error).toBe('rejected');
  });

  it('code 0 → 成功', async () => {
    const { fn } = fakeFetch(() => ({ code: 0 }));
    const result = await updateChannelToggle(fn, credential, 9, true);
    expect(result.success).toBe(true);
  });
});

describe('R7 脱敏', () => {
  it('覆盖查询参数、Bearer、JWT、Cookie 头', () => {
    expect(redactSensitiveText('x?SPC_CDS=abc&SPC_CDS_VER=2')).toBe('x?SPC_CDS=***&SPC_CDS_VER=***');
    expect(redactSensitiveText('access_token=abcdef123456')).toBe('access_token=***');
    expect(redactSensitiveText('Authorization: Bearer abcdefghijklmnop')).toContain('***');
    expect(redactSensitiveText('eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('***');
    expect(redactSensitiveText('Cookie: SPC_CDS=abc; other=1')).toContain('***');
  });

  it('保留可定位信息（动作与状态码）', () => {
    const out = redactSensitiveText('update_product failed with HTTP 500 (SPC_CDS=abc)');
    expect(out).toContain('update_product');
    expect(out).toContain('500');
    expect(out).not.toContain('abc');
  });

  it('非字符串输入也能安全处理', () => {
    expect(redactSensitiveText(undefined)).toBe('');
    expect(redactSensitiveText(new Error('boom SPC_CDS=secret'))).toBe('boom SPC_CDS=***');
  });
});
