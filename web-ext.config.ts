import { defineWebExtConfig } from 'wxt';

/**
 * 开发模式（`npm run dev`）的浏览器启动行为。
 *
 * `disabled: true` → WXT 走「手动 runner」，**不会自动打开任何浏览器**。
 * 依据：`node_modules/wxt/dist/core/runners/index.mjs`
 *   `if (wxt.config.runnerConfig.config?.disabled) return createManualRunner();`
 *
 * 为什么这样设（而不是给开发版建独立 Chromium 配置目录）：
 * - 用户的实际工作方式是**手动**在 `chrome://extensions` 加载 `.output/chrome-mv3`
 *   （见 `PROJECT_STATUS.md` 与用户 2026-10-12 的确认）。他不需要 dev 自动开浏览器。
 * - 自动开浏览器会污染/接管用户日常使用的 Chrome 配置，且会再装一个 dev 扩展，
 *   让 `chrome://extensions` 里出现两份难以分辨的条目（这正是 R4 故障的诱因之一）。
 * - 改 `chromiumProfile` 会新建一个独立配置目录（额外磁盘占用、且需重新登录），
 *   对一个只想手动加载扩展的用户是多余的复杂度。
 *
 * 代价（我作为开发者要接受）：`npm run dev` 不会自动打开浏览器，需要自己
 * 在 `chrome://extensions` 加载/刷新 `.output/chrome-mv3-dev`。
 * dev 版的弹窗**必须保持 `npm run dev` 终端开启**，否则白屏——见 `运维速查.md`。
 */
export default defineWebExtConfig({
  disabled: true,
});
