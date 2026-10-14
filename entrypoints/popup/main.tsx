import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

// 弹窗策略宿主（PopupPolicyHost）**不在**这里包住 App。
// 它只应包住「登录成功、首次功能就绪」之后的功能区，所以由 App 在自己的就绪分支里挂载。
// 放在这里会让检查遮罩盖住登录表单、未登录也弹通知 —— 用户已明确要求登录后才出现。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
