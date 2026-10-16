# Security Policy

## Reporting a Vulnerability

请不要在公开 Issue 里贴漏洞细节、真实密钥、Cookie、店铺凭据或可复现的攻击步骤。

请用 GitHub 的 Private vulnerability reporting（Security 标签页 → Report a vulnerability）提交，写清：影响版本、复现步骤、影响范围、你的联系方式。

我们会在确认后尽快回复、修复并发布新版本。修复前请不要公开披露。

## 安全红线

- 不要把真实 `JWT_SECRET`、管理员密码、邀请码、Cookie、店铺凭据提交到仓库或 Issue。
- 本地 `.env`、后端 `data/`、测试产物不要入库。
- 发现仓库历史里有泄露的密钥，请立即按上条私下报告，并轮换对应密钥，不要只改文件。
