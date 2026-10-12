import { useState } from 'react';
import { Button, Card, Form, Input, Typography, Alert } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';

const { Title, Paragraph, Text } = Typography;

export function LoginPage() {
  const { login } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    setError('');
    try {
      await login(values.email.trim(), values.password);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
        padding: 16,
      }}
    >
      <Card style={{ width: 380 }} styles={{ body: { padding: 28 } }}>
        <Title level={4} style={{ marginBottom: 4 }}>
          虾皮限时特卖 · 管理后台
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 20 }}>
          使用现有管理员账号登录，无需安装浏览器扩展。
        </Paragraph>

        {error && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
        )}

        <Form layout="vertical" onFinish={handleSubmit} disabled={submitting} requiredMark={false}>
          <Form.Item
            label="账号"
            name="email"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="管理员邮箱或用户名"
              autoComplete="username"
              autoFocus
            />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>

        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
          出于安全考虑，登录状态只保存在当前页面内存中；刷新或关闭页面后需要重新登录。
        </Text>
      </Card>
    </div>
  );
}
