## Why

管理面板嵌在扩展弹窗中，空间受限且与卖家功能一起发布。用户已确认采用独立管理员网站，先迁移既有能力，避免为未来业务提前开发空后台。

## What Changes

- 新建独立管理网页，采用 React、TypeScript、Vite、Ant Design、ProComponents；默认中文，无需安装扩展或登录虾皮即可管理插件账号。
- 复用 Hono、Drizzle、SQLite 和现有管理员账号，迁移用户、店铺绑定、邀请码、使用统计四项管理能力。
- 使用现有真实数据，不搬入原型模拟数据；不新增 AI、生图、选品、上架、计费或数据采集业务。
- 管理网站独立构建，依赖不进入扩展安装包；本地优先接通 `/admin/` 页面与 `/api/` 接口。
- 管理接口核对数据库当前管理员身份，避免已撤销权限的旧 token 继续访问；绑定响应不得泄露 SPC_CDS 等凭据。
- **BREAKING**：新网站经规划方验收和用户体验确认后，移除扩展原管理面板；扩展可保留打开管理网站的入口。用户已明确选择移除旧面板，不长期维护两套界面。

## Capabilities

### New Capabilities

- `standalone-admin`: 独立登录、四项管理能力、数据真实性、安全隔离及旧入口迁移。

### Modified Capabilities

无既有 OpenSpec 规范可修改；本轮以新能力记录现有管理功能的迁移契约。

## Impact

- 新增 `admin-web/` 独立前端；修改后端页面托管、管理员权限守卫及必要的绑定响应脱敏。
- 迁移现有 `components/product/AdminPanel.tsx` 功能及 `entrypoints/popup/backend-api.ts` 的管理请求，网页不得依赖扩展 storage/runtime API。
- 验收后调整 popup 管理入口并删除不再使用的管理专属组件；不改店铺操作、自动模式、SKU、注册、试用消耗或数据库结构。
- 开发仅连接本地隔离后端，不读取真实凭据、不复制真实数据库、不操作虾皮、不部署、不 seed 真实库、不提交推送。生产网址、HTTPS 和发布另行确认。
- HTML 原型仅作视觉参考，未来模块不纳入本次页面或功能验收。
