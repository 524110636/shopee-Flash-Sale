import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import * as api from '../api/admin';
import type { AdminAnalytics, AdminAnalyticsEvent } from '../api/admin';
import { useToken } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

/** 已知事件类型的中文名；未列出的类型原样显示，不臆造含义。 */
const EVENT_LABELS: Record<string, string> = {
  enable_loop: '开启限时特卖',
  copy_flow: '复制活动',
  auto_mode_round: '自动模式',
  auto_mode_stop: '自动模式停止',
};

/** 已知事件类型的数据字段中文名；未列出的字段只显示原键名，不臆造含义。 */
const EVENT_DATA_LABELS: Record<string, Record<string, string>> = {
  enable_loop: { totalSkus: '商品数', successSkus: '成功', failedSkus: '失败', rounds: '轮数' },
  auto_mode_round: { round: '当前轮', totalRounds: '总轮数', flashSaleId: '活动 ID' },
  auto_mode_stop: { currentRound: '当前轮', totalRounds: '总轮数' },
  copy_flow: { flashSaleId: '活动 ID', hasSkuOverrides: '含 SKU 覆盖', source: '来源' },
};

const EVENT_DETAIL_LIMIT = 100;

/**
 * 安全查表：事件名/字段名来自服务端数据，可以是任意字符串。
 * `TABLE[key]` 直接取值会命中对象**继承**来的成员（`constructor`、`__proto__`、
 * `toString` 等），拿到函数或对象，渲染时会崩；必须只取自身条目。
 */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** 事件类型的中文名；未知类型原样显示，不臆造含义。 */
function eventLabel(eventType: string): string {
  return lookup(EVENT_LABELS, eventType) ?? eventType;
}

/** 把脱敏后的事件数据渲染成「键: 值」文本；无数据时说明原因，不冒充零值。 */
function formatEventData(
  eventType: string,
  data: Record<string, string | number | boolean> | null,
): string {
  if (!data) return '无可展示明细';
  const labels = lookup(EVENT_DATA_LABELS, eventType) ?? {};
  return Object.entries(data)
    .map(([key, value]) => {
      const text =
        typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
      return `${lookup(labels, key) ?? key}: ${text}`;
    })
    .join('，');
}

export function AnalyticsPage() {
  const token = useToken();

  const [summary, setSummary] = useState<AdminAnalytics | null>(null);
  const [summaryStale, setSummaryStale] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');

  const [eventsStale, setEventsStale] = useState(false);
  const [events, setEvents] = useState<AdminAnalyticsEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [eventType, setEventType] = useState<string | undefined>(undefined);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError('');
    try {
      setSummary(await api.getAnalytics(token));
      setSummaryStale(false);
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : '加载失败');
      // 读取失败不是「零使用」：保留上一次结果但标明已过期，首次失败则保持未知。
      setSummaryStale(true);
    } finally {
      setSummaryLoading(false);
    }
  }, [token]);

  const loadEvents = useCallback(
    async (type: string | undefined) => {
      setEventsLoading(true);
      setEventsError('');
      try {
        const result = await api.getAnalyticsEvents(token, type);
        setEvents(result.events);
        setEventsStale(false);
      } catch (e) {
        setEventsError(e instanceof Error ? e.message : '加载失败');
        // 保留已加载的旧列表并标明过期；首次失败时列表仍为空，不冒充「暂无记录」。
        setEventsStale(true);
      } finally {
        setEventsLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadEvents(eventType);
  }, [loadEvents, eventType]);

  const eventTypeOptions = useMemo(
    () =>
      (summary?.events ?? [])
        .map((item) => item.eventType)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .map((value) => ({ value, label: eventLabel(value) })),
    [summary],
  );

  const columns: ColumnsType<AdminAnalyticsEvent> = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: (v: string) => formatDateTime(v) },
    { title: '用户', key: 'user', width: 200, render: (_, r) => r.email ?? `用户 #${r.userId}` },
    {
      title: '事件类型',
      key: 'eventType',
      width: 160,
      render: (_, r) => <Tag>{eventLabel(r.eventType)}</Tag>,
    },
    {
      title: '事件数据',
      key: 'eventData',
      render: (_, r) => (
        <Typography.Text
          type={r.eventData ? undefined : 'secondary'}
          style={{ fontSize: 12, wordBreak: 'break-all' }}
        >
          {formatEventData(r.eventType, r.eventData)}
        </Typography.Text>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="使用统计"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void loadSummary();
              void loadEvents(eventType);
            }}
            loading={summaryLoading || eventsLoading}
          >
            刷新
          </Button>
        }
      >
        {summaryError && (
          <Alert
            type="error"
            showIcon
            message={
              summary
                ? `统计读取失败：${summaryError}（下方为上次成功读取的数据，可能已过期）`
                : `统计读取失败：${summaryError}`
            }
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={() => void loadSummary()}>
                重试
              </Button>
            }
          />
        )}

        <Row gutter={16}>
          <Col xs={24} sm={12} md={8}>
            <Card size="small" loading={summaryLoading}>
              {summary ? (
                <Statistic title="注册用户总数" value={summary.totalUsers} />
              ) : (
                <Statistic title="注册用户总数" value="无法读取" />
              )}
            </Card>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Card size="small" loading={summaryLoading}>
              {summary ? (
                <Statistic title="有效绑定数" value={summary.totalBindings} />
              ) : (
                <Statistic title="有效绑定数" value="无法读取" />
              )}
            </Card>
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Card size="small" loading={summaryLoading}>
              {summary ? (
                <Statistic title="已记录事件类型" value={summary.events.length} suffix="类" />
              ) : (
                <Statistic title="已记录事件类型" value="无法读取" />
              )}
            </Card>
          </Col>
        </Row>

        {summaryStale && summary && (
          <Typography.Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
            以上为上次成功读取的数据，可能已过期。
          </Typography.Text>
        )}

        <div style={{ marginTop: 20 }}>
          <Typography.Text strong>按事件类型计数</Typography.Text>
          <div style={{ marginTop: 8 }}>
            {summaryLoading ? (
              <Typography.Text type="secondary">加载中…</Typography.Text>
            ) : !summary ? (
              <Typography.Text type="secondary">
                暂时无法读取统计，不能判断是否有事件记录。
              </Typography.Text>
            ) : summary.events.length === 0 ? (
              <Typography.Text type="secondary">暂无事件记录</Typography.Text>
            ) : (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {summary.events.map((item) => (
                  <div
                    key={item.eventType}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      border: '1px solid #f0f0f0',
                      borderRadius: 6,
                      padding: '6px 12px',
                    }}
                  >
                    <span>{eventLabel(item.eventType)}</span>
                    <Typography.Text type="secondary">{item.count} 次</Typography.Text>
                  </div>
                ))}
              </Space>
            )}
          </div>
        </div>

        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          以上计数来自实际记录，不含模拟数据；这里统计的是功能事件次数，不代表全部业务调用量。
        </Typography.Paragraph>
      </Card>

      <Card
        title="事件明细"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按事件类型过滤"
              style={{ width: 200 }}
              value={eventType}
              onChange={(value) => setEventType(value ?? undefined)}
              options={eventTypeOptions}
            />
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void loadEvents(eventType)}
              loading={eventsLoading}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message={`一次最多返回最近 ${EVENT_DETAIL_LIMIT} 条记录，不代表完整历史。`}
          style={{ marginBottom: 16 }}
        />

        {eventsError && (
          <Alert
            type="error"
            showIcon
            message={
              eventsStale && events.length > 0
                ? `事件明细读取失败：${eventsError}（下方为上次读取结果，可能已过期）`
                : `事件明细读取失败：${eventsError}`
            }
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={() => void loadEvents(eventType)}>
                重试
              </Button>
            }
          />
        )}

        <Table<AdminAnalyticsEvent>
          rowKey="id"
          columns={columns}
          dataSource={events}
          loading={eventsLoading}
          scroll={{ x: 900 }}
          pagination={{
            pageSize: 10,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条（上限 ${EVENT_DETAIL_LIMIT}）`,
          }}
          locale={{
            emptyText: eventsLoading
              ? ' '
              : eventsStale
                ? '读取失败，无法判断是否有记录。'
                : '暂无事件记录',
          }}
        />
      </Card>
    </Space>
  );
}
