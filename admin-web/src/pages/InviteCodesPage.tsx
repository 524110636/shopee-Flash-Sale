import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import * as api from '../api/admin';
import type { AdminInviteCode } from '../api/admin';
import { useToken } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

const COUNT_MIN = 1;
const COUNT_MAX = 20;

export function InviteCodesPage() {
  const token = useToken();
  const { message } = AntdApp.useApp();

  const [codes, setCodes] = useState<AdminInviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [count, setCount] = useState(1);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getInviteCodes(token);
      setCodes(result.inviteCodes);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await api.createInviteCodes(token, count);
      message.success(`已生成 ${result.count} 个邀请码`);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '生成失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      const result = await api.deleteInviteCode(token, id);
      message.success(result.message);
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  const unusedCount = codes.filter((item) => item.isUsed === 0).length;

  const columns: ColumnsType<AdminInviteCode> = [
    {
      title: '邀请码',
      dataIndex: 'code',
      key: 'code',
      render: (code: string) => (
        <Typography.Text code copyable>
          {code}
        </Typography.Text>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_, record) =>
        record.isUsed ? <Tag>已使用</Tag> : <Tag color="green">未使用</Tag>,
    },
    {
      title: '使用人',
      key: 'usedBy',
      width: 220,
      render: (_, record) =>
        record.isUsed ? record.userEmail ?? `用户 #${record.usedBy ?? '未知'}` : '—',
    },
    {
      title: '使用时间',
      dataIndex: 'usedAt',
      key: 'usedAt',
      width: 180,
      render: (value: string | null) => formatDateTime(value),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, record) =>
        record.isUsed ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已使用不可删除
          </Typography.Text>
        ) : (
          <Popconfirm
            title="确认删除该邀请码？"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button danger size="small" loading={deletingId === record.id}>
              删除
            </Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Card
      title="邀请码"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap>
          <span>生成数量</span>
          <InputNumber
            min={COUNT_MIN}
            max={COUNT_MAX}
            value={count}
            onChange={(value) =>
              setCount(Math.min(COUNT_MAX, Math.max(COUNT_MIN, Number(value) || COUNT_MIN)))
            }
            disabled={creating}
          />
          <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={handleCreate}>
            生成邀请码
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每次可生成 {COUNT_MIN}–{COUNT_MAX} 个
          </Typography.Text>
        </Space>

        <Typography.Text type="secondary">
          共 {codes.length} 个邀请码 · 未使用 {unusedCount} 个
        </Typography.Text>

        {error && <Alert type="error" showIcon message={error} />}

        <Table<AdminInviteCode>
          rowKey="id"
          columns={columns}
          dataSource={codes}
          loading={loading}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 个邀请码` }}
          locale={{ emptyText: loading ? ' ' : '暂无邀请码，点击上方按钮生成' }}
        />
      </Space>
    </Card>
  );
}
