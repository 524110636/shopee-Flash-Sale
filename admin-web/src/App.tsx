import { useMemo, useState } from 'react';
import { Layout, Menu, Typography, Button, Tag } from 'antd';
import {
  TeamOutlined,
  LinkOutlined,
  BarChartOutlined,
  KeyOutlined,
  LogoutOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { BindingsPage } from './pages/BindingsPage';
import { InviteCodesPage } from './pages/InviteCodesPage';
import { AnalyticsPage } from './pages/AnalyticsPage';

type MenuKey = 'users' | 'bindings' | 'invite-codes' | 'analytics';

const MENU_ITEMS = [
  { key: 'users', icon: <TeamOutlined />, label: '用户管理' },
  { key: 'bindings', icon: <LinkOutlined />, label: '绑定管理' },
  { key: 'invite-codes', icon: <KeyOutlined />, label: '邀请码' },
  { key: 'analytics', icon: <BarChartOutlined />, label: '使用统计' },
];

export function App() {
  const { user, logout } = useAuth();
  const [active, setActive] = useState<MenuKey>('users');

  const content = useMemo(() => {
    switch (active) {
      case 'users':
        return <UsersPage />;
      case 'bindings':
        return <BindingsPage />;
      case 'invite-codes':
        return <InviteCodesPage />;
      case 'analytics':
        return <AnalyticsPage />;
      default:
        return null;
    }
  }, [active]);

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider theme="light" width={216} breakpoint="lg" collapsedWidth={0}>
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 16px',
            borderBottom: '1px solid #f0f0f0',
            fontWeight: 600,
          }}
        >
          <ShopOutlined style={{ color: '#ee4d2d' }} />
          <span>限时特卖管理</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[active]}
          items={MENU_ITEMS}
          onClick={({ key }) => setActive(key as MenuKey)}
          style={{ borderInlineEnd: 0 }}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            background: '#fff',
            borderBottom: '1px solid #f0f0f0',
            paddingInline: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 56,
            lineHeight: '56px',
          }}
        >
          <Typography.Text strong>
            {MENU_ITEMS.find((item) => item.key === active)?.label}
          </Typography.Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>
              <Typography.Text>{user.email}</Typography.Text>{' '}
              <Tag color="orange" style={{ marginInlineStart: 4 }}>
                管理员
              </Tag>
            </span>
            <Button icon={<LogoutOutlined />} onClick={logout} size="small">
              退出登录
            </Button>
          </div>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{content}</Layout.Content>
      </Layout>
    </Layout>
  );
}
