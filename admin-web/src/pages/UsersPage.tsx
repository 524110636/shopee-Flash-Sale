import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import * as api from '../api/admin';
import type { AdminUser } from '../api/admin';
import { useToken } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

/** 正在提交的行操作，用于禁用重复点击。 */
type PendingAction =
  | 'auto-mode'
  | 'trial'
  | 'trial-enabled'
  | 'limit'
  | 'delete'
  | null;

export function UsersPage() {
  const token = useToken();
  const { message } = AntdApp.useApp();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [pending, setPending] = useState<{ id: number; action: Exclude<PendingAction, null> } | null>(
    null,
  );

  const [limitEditingId, setLimitEditingId] = useState<number | null>(null);
  const [limitDraft, setLimitDraft] = useState<number>(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getUsers(token);
      setUsers(result.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (
    userId: number,
    action: Exclude<PendingAction, null>,
    fn: () => Promise<{ message: string }>,
  ): Promise<boolean> => {
    setPending({ id: userId, action });
    try {
      const result = await fn();
      message.success(result.message);
      await load();
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
      return false;
    } finally {
      setPending(null);
    }
  };

  const columns: ColumnsType<AdminUser> = [
    {
      title: '账号',
      dataIndex: 'email',
      key: 'email',
      render: (email: string, record) => (
        <Space size={6}>
          <span>{email}</span>
          {record.role === 'admin' && <Tag color="orange">管理员</Tag>}
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_, record) =>
        record.isActive ? <Tag color="green">已激活</Tag> : <Tag>未激活</Tag>,
    },
    {
      title: '绑定店铺',
      dataIndex: 'bindingCount',
      key: 'bindingCount',
      width: 100,
      render: (count: number, record) => (
        <Space size={4}>
          <span>{count}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            / 限额 {record.maxStores}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '自动模式',
      key: 'autoMode',
      width: 110,
      render: (_, record) => (
        <Switch
          checked={record.autoModeEnabled === 1}
          loading={pending?.id === record.id && pending.action === 'auto-mode'}
          disabled={pending?.id === record.id}
          checkedChildren="已开"
          unCheckedChildren="未开"
          onChange={(checked) =>
            runAction(record.id, 'auto-mode', () =>
              api.toggleAutoMode(token, record.id, checked ? 1 : 0),
            )
          }
        />
      ),
    },
    {
      title: '店铺限额',
      key: 'limit',
      width: 170,
      render: (_, record) =>
        limitEditingId === record.id ? (
          <Space size={4}>
            <InputNumber
              size="small"
              min={1}
              value={limitDraft}
              onChange={(value) => setLimitDraft(Math.max(1, Number(value) || 1))}
              style={{ width: 72 }}
              disabled={pending?.id === record.id}
            />
            <Button
              size="small"
              type="primary"
              loading={pending?.id === record.id && pending.action === 'limit'}
              onClick={async () => {
                const ok = await runAction(record.id, 'limit', () =>
                  api.updateStoreLimit(token, record.id, limitDraft),
                );
                if (ok) setLimitEditingId(null);
              }}
            >
              确认
            </Button>
            <Button size="small" onClick={() => setLimitEditingId(null)}>
              取消
            </Button>
          </Space>
        ) : (
          <Button
            size="small"
            onClick={() => {
              setLimitEditingId(record.id);
              setLimitDraft(record.maxStores);
            }}
          >
            调整
          </Button>
        ),
    },
    {
      title: '试用状态',
      key: 'trial',
      width: 150,
      render: (_, record) => (
        <Space size={6}>
          <Tooltip
            title={
              record.trialUsed
                ? '点击后把该用户恢复为“试用未使用”'
                : '点击后把该用户标记为“试用已使用”'
            }
          >
            <Button
              size="small"
              loading={pending?.id === record.id && pending.action === 'trial'}
              disabled={pending?.id === record.id}
              onClick={() =>
                runAction(record.id, 'trial', () =>
                  api.setTrialUsed(token, record.id, record.trialUsed ? 0 : 1),
                )
              }
            >
              {record.trialUsed ? '试用已用 · 点此重置' : '试用未用 · 点此标记'}
            </Button>
          </Tooltip>
          <Tooltip title="关闭后该用户不再受手动试用次数限制；不影响其他功能">
            <Tag color={record.trialEnabled === 0 ? 'default' : 'blue'}>
              {record.trialEnabled === 0 ? '试用限制已关闭' : '试用限制开启'}
            </Tag>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '试用限制',
      key: 'trialEnabled',
      width: 110,
      render: (_, record) => (
        <Switch
          checked={record.trialEnabled === 1}
          loading={pending?.id === record.id && pending.action === 'trial-enabled'}
          disabled={pending?.id === record.id}
          checkedChildren="开启"
          unCheckedChildren="关闭"
          onChange={(checked) =>
            runAction(record.id, 'trial-enabled', () =>
              api.setTrialEnabled(token, record.id, checked ? 1 : 0),
            )
          }
        />
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Popconfirm
          title="确认删除该用户？"
          description={
            <div style={{ maxWidth: 260 }}>
              将同时永久删除该用户的店铺绑定、操作事件与验证码记录，操作不可撤销。
            </div>
          }
          okText="确认删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() =>
            runAction(record.id, 'delete', () => api.deleteUser(token, record.id))
          }
        >
          <Button
            danger
            size="small"
            loading={pending?.id === record.id && pending.action === 'delete'}
            disabled={pending?.id === record.id}
          >
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card
      title="用户管理"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Table<AdminUser>
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        scroll={{ x: 1180 }}
        pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 个用户` }}
        locale={{ emptyText: loading ? ' ' : '暂无用户' }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        此表格仅对当前已加载的用户列表进行搜索与分页，不代表全量查询。
      </Typography.Text>
    </Card>
  );
}
