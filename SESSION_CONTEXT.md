# 对话进度摘要（2026-05-22 ~ 2026-05-23）

## 项目概况

Chrome 扩展（MV3）+ 后端（Hono + SQLite），为虾皮台湾卖家后台限时特卖自动化工具。

---

## 当前状态

### 代码
- **分支**: `优化扩展功能`
- **版本**: 1.14.3
- **最新提交**: `5ba3d6c` — 文档更新
- **Lint**: 通过（1 个预存 `no-undef` 错误在 backend，不影响功能）

### 项目路径
- **当前**: `D:\shopee_xm\limited-time-sale`（刚从桌面迁移过来）
- **需运行**: `npm install`（node_modules 约 291MB，已在新目录清理）

### 网络架构（重要变更）
- **原方案**: `https://xp.aluvi.cc` → Nginx → `127.0.0.1:5724`
- **问题**: Cloudflare DNS A 记录丢失，域名解析到 `198.18.1.123`（注册商默认 IP），Nginx 也出现过 502
- **当前方案**: `.env` 改为 `VITE_BACKEND_URL=http://43.99.86.228:5724`（IP 直连），兜底 URL 留空

### 服务器
- IP: `43.99.86.228`，SSH 信息见 `SSH_CONNECT.md`
- 宝塔面板: `http://43.99.86.228:8888/`
- 项目路径: `/www/wwwroot/xp.aluvi.cc/`
- 后端管理: PM2（`pm2 logs limited-time-sale --lines 20 --nostream`）

---

## 本次对话完成的工作

### 1. SW 恢复调度失败（Cannot access contents of the page）
- **原因**: SW 被 alarm 唤醒时无活跃 `seller.shopee.tw` 标签页，`injectedFetch()` → `executeScriptSafe()` 5 次重试 15 秒后失败
- **修复**: `scheduleNextRound()` 恢复路径中复用已有 `nextTargetTime`，跳过 `injectedFetch` 调用
- **提交**: `4a7fb97`

### 2. 传递商品参数失败（没有固化商品参数）
- **原因**: `filterActiveProducts()` 在 START_AUTO_MODE 时过滤掉全部 17 个商品 → `enableParams.products = []`
- **修复**: 全部过滤时安全底线保留原商品 + `logAutoMode` 可追踪
- **提交**: `145668f`

### 3. handleAutoModeEnable 独立过滤也全过滤（itemCount: 0）
- **原因**: `handleAutoModeEnable()` 有第二处独立过滤，`p.status === 0` 严格相等——API 返回字符串 `"0"` 导致 `"0" === 0` → `false`，全部误判
- **修复**: 
  - 两处过滤统一 `Number(p.status)` 转换
  - 安全底线（全部过滤时保留原商品）
  - 诊断日志（过滤前记录 raw status 类型+值）
  - try/catch 包裹过滤逻辑
  - 最终防线（`ep.products` 为空时记录完整诊断并抛错）
- **提交**: `ab1b72a`、`670156a`

### 4. 登录故障排查
- **表面现象**: 扩展无法登录
- **诊断过程**: 直连 5724 正常 → 域名 502 → DNS 解析到 `198.18.1.123`
- **根本原因**: Cloudflare DNS A 记录丢失
- **解决**: 改为 IP 直连

### 5. 项目迁移
- 从 `C:\Users\52411\Desktop\limited-time-sale` → `D:\shopee_xm\limited-time-sale`

---

## 关键技术要点

1. **商品过滤双重保护**: `filterActiveProducts()` 和 `handleAutoModeEnable()` 有**独立的两处过滤**，修改时必须同步
2. **`Number()` 转换**: Shopee GraphQL API `status` 字段可能返回字符串，必须用 `Number(p.status)` 而非直接 `p.status === 0`
3. **安全底线**: 过滤结果为空时保留原商品 + 记录诊断日志
4. **IP 直连优先**: DNS 不可靠，后续建议以 IP 直连为主

---

## 待办

- [ ] 在 `D:\shopee_xm\limited-time-sale` 运行 `npm install`
- [ ] （可选）恢复 Cloudflare DNS A 记录指向 `43.99.86.228`
- [ ] （可选）恢复 Nginx HTTPS 代理后切回域名
