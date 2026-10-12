import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import * as api from '../api/admin';
import type { AdminBinding } from '../api/admin';
import { useToken } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

export function BindingsPage() {
  const token = useToken();
  const { message } = AntdApp.useApp();

  const [bindings, setBindings] = useState<AdminBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unbindingId, setUnbindingId] = useState<number | null>(null);

  /** 已应用的 userId 过滤；undefined 表示“仅有效绑定”。 */
  const [appliedUserId, setAppliedUserId] = useState<number | undefined>(undefined);
  const [userIdDraft, setUserIdDraft] = useState('');

  const load = useCallback(
    async (userId: number | undefined) => {
      setLoading(true);
      setError('');
      try {
        const result = await api.getBindings(token, userId);
        setBindings(result.bindings);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load(appliedUserId);
  }, [load, appliedUserId]);

  const handleUnbind = async (bindingId: number) => {
    setUnbindingId(bindingId);
    try {
      const result = await api.unbindStore(token, bindingId);
      message.success(result.message);
      await load(appliedUserId);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '解绑失败');
    } finally {
      setUnbindingId(null);
    }
  };

  const columns: ColumnsType<AdminBinding> = [
    {
      title: '归属账号',
      key: 'user',
      render: (_, record) => (
        <Space size={6}>
          <span>{record.userEmail ?? `用户 #${record.userId}`}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ID {record.userId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '店铺信息',
      key: 'shop',
      render: (_, record) => {
        if (record.shopId === null) {
          // 不展示任何凭据前缀，只说明信息缺失。
          return <Typography.Text type="warning">店铺信息待补全</Typography.Text>;
        }
        return (
          <Space size={12} wrap>
            <span>店铺 ID: {record.shopId}</span>
            {record.shopUsername && <span>用户名: {record.shopUsername}</span>}
            {record.shopName && <span>{record.shopName}</span>}
          </Space>
        );
      },
    },
    {
      title: '状态',
      key: 'isActive',
      width: 100,
      render: (_, record) =>
        record.isActive ? <Tag color="green">有效</Tag> : <Tag>已解绑</Tag>,
    },
    {
      title: '限额',
      dataIndex: 'maxStores',
      key: 'maxStores',
      width: 80,
    },
    {
      title: '绑定时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, record) =>
        record.isActive ? (
          <Popconfirm
            title="确认解绑该店铺？"
            description="解绑后该用户需要重新绑定才能继续使用该店铺。"
            okText="确认解绑"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleUnbind(record.id)}
          >
            <Button danger size="small" loading={unbindingId === record.id}>
              解绑
            </Button>
          </Popconfirm>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <Card
      title="绑定管理"
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void load(appliedUserId)}
          loading={loading}
        >
          刷新
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap>
          <Input
            placeholder="按用户 ID 查询（可看到已解绑记录）"
            value={userIdDraft}
            onChange={(e) => setUserIdDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onPressEnter={() =>
              setAppliedUserId(userIdDraft ? Number(userIdDraft) : undefined)
            }
            style={{ width: 260 }}
            allowClear
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => setAppliedUserId(userIdDraft ? Number(userIdDraft) : undefined)}
          >
            查询
          </Button>
          <Button
            onClick={() => {
              setUserIdDraft('');
              setAppliedUserId(undefined);
            }}
          >
            显示全部有效绑定
          </Button>
          <Tag color={appliedUserId === undefined ? 'blue' : 'default'}>
            {appliedUserId === undefined ? '当前：仅有效绑定' : `当前：用户 #${appliedUserId} 的全部记录`}
          </Tag>
        </Space>

        {error && <Alert type="error" showIcon message={error} />}

        <Table<AdminBinding>
          rowKey="id"
          columns={columns}
          dataSource={bindings}
          loading={loading}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条记录` }}
          locale={{ emptyText: loading ? ' ' : '暂无绑定记录' }}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          为保护用户凭据，管理后台不展示、也不传输店铺登录凭据；缺少店铺 ID 的记录只显示“店铺信息待补全”。
        </Typography.Text>
      </Space>
    </Card>
  );
}
