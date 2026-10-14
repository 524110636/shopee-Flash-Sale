import { Collapse, Typography } from 'antd';

/**
 * 「如何修改版本与测试升级」指引。
 *
 * 为什么把行号写在页面上：用户按指引去改源码，找不到位置就卡住。行号会随源码变化，
 * 所以同时给出「搜哪个字段」这条不会失效的说法，并注明行号以本次交付为准。
 *
 * 行号核对方式（交付时实测）：`package.json` 的 `"version"` 在第 3 行，
 * `wxt.config.ts` 的 `version:` 在第 18 行。
 *
 * 步骤顺序必须与用户实际做事的顺序一致：**先备份旧包，再发布更高要求，再改版本构建**。
 * 反了就会出问题 —— 先改版本再「备份旧包」，复制到的其实是新包，旧版阻挡那一步没法复现。
 */

/**
 * 示例的版本值。
 *
 * 当前源码是 1.15.2，所以例子必须示范**改到更高的新值**（1.15.3），
 * 不能用两个相同值 —— 照做的用户会以为「改了版本」却没真的升级。
 * 源码版本变化后要同步这三个值。
 */
const CURRENT_VERSION = '1.15.2';
const REQUIRED_VERSION = '1.15.3';
const NEW_VERSION = '1.15.3';

const STEPS = [
  {
    step: '1',
    title: `先备份现在的旧包（还没改版本时做）`,
    lines: [
      `当前源码与构建产物是 ${CURRENT_VERSION}。先确认要用的输出目录，再整个复制一份留作旧包：`,
      '· 生产配置输出目录：`.output/chrome-mv3`（`npm run build` 生成）',
      '· 开发模式输出目录：`.output/chrome-mv3-dev`（`npm run build -- --mode development` 生成）',
      '把它复制到别处（例如 `D:\\backup\\chrome-mv3-旧版`），这就是后面用来验证「旧版会被挡」的那一份。',
      '顺序很重要：先复制再改版本，否则复制到的是新包，旧版阻挡这一步就没法验证了。',
    ],
  },
  {
    step: '2',
    title: `在管理网站发布更高的要求版本，并保持发布`,
    lines: [
      `新建一条「强制更新」，要求版本填 ${REQUIRED_VERSION}（比旧包 ${CURRENT_VERSION} 高），`,
      '下载地址填能真正下载到新包的地址，然后点「发布」。',
      '发布后**不要撤回、不要降低要求**，一直保持到第 5 步验证完成。',
    ],
  },
  {
    step: '3',
    title: `用第 1 步备份的旧包确认会被阻挡`,
    lines: [
      '在 `chrome://extensions` 用「加载已解压的扩展程序」指向第 1 步备份的旧包目录。',
      '只在**没有业务任务的测试扩展**上做这件事；重载会改变后台 worker 生命周期，不要自动重载日常扩展。',
      `打开扩展，应看到不可取消的强制提示，点「下载最新版本」会跳到第 2 步填的地址。此时版本仍是 ${CURRENT_VERSION}，提示不会消失。`,
    ],
  },
  {
    step: '4',
    title: `改两处版本号并构建新包`,
    lines: [
      `package.json 第 3 行："version": "${NEW_VERSION}"`,
      `wxt.config.ts 第 18 行：version: '${NEW_VERSION}'`,
      '行号可能随源码变化；可直接搜索 version 字段定位，不依赖固定行号。',
      '只改这两处即可。不要手改 .output 里生成的 manifest.json 代替源码修改。',
      `改完执行 npm run build，产出在 .output/chrome-mv3（开发模式：npm run build -- --mode development → .output/chrome-mv3-dev）。`,
    ],
  },
  {
    step: '5',
    title: `下载、解压、加载新包，核对实际版本并确认解除`,
    lines: [
      '下载、解压、加载是三个独立动作；只下载不解压不加载，不会升级。',
      '在 `chrome://extensions` 用「加载已解压的扩展程序」指向解压后的新目录，或对已加载的扩展点「重新加载」。',
      `打开扩展卡片，确认显示的版本是 ${NEW_VERSION}（本页顶部的后端设置不参与判定，扩展只读自己实际加载的包版本）。`,
      '重新打开扩展：实际版本达到要求后，强制提示应自行消失。',
      `前提是第 2 步的记录仍在发布、要求仍是 ${REQUIRED_VERSION} —— 不能靠撤回记录或降低要求来「让提示消失」。`,
    ],
  },
];

export function PopupVersionGuide() {
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'version-guide',
          label: '如何修改版本与测试升级（点开看步骤）',
          children: (
            <div style={{ fontSize: 12, lineHeight: 1.9 }}>
              <Typography.Paragraph style={{ fontSize: 12, marginBottom: 8 }}>
                按顺序做这五步即可。示例：旧包 <strong>{CURRENT_VERSION}</strong> →
                要求 <strong>{REQUIRED_VERSION}</strong> → 新包 <strong>{NEW_VERSION}</strong>。
              </Typography.Paragraph>
              {STEPS.map((s) => (
                <div key={s.step} style={{ marginBottom: 12 }}>
                  <Typography.Text strong>
                    {s.step}. {s.title}
                  </Typography.Text>
                  <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                    {s.lines.map((line) => (
                      <li key={line}>
                        <Typography.Text style={{ fontSize: 12 }}>{line}</Typography.Text>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}
