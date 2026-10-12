import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { AuthProvider } from './auth/AuthContext';
import { App } from './App';

dayjs.locale('zh-cn');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{ token: { colorPrimary: '#ee4d2d' } }}
    >
      <AntdApp>
        <AuthProvider>
          <App />
        </AuthProvider>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);
