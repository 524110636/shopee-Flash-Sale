# M02.1 独立规范／解耦只读复核

基线：`0b5f75563d68c0cd5b522a687e3b89b2abed77bd`。审查范围为该基线后的工作区源码、相关单测及 M02.1 任务书／手册。只做静态只读检查；未启动服务、浏览器、构建、测试或网络请求。下述均为源码审查发现，不代表真实运行故障已经复现。

## 硬规范违例／明确要求缺口

### H1：任务执行时未校验后端账号是否仍与任务锚相同

- 标准：`.claude/tasks/2026-10-14-08-商品备货物流与定时修改-任务书.md` 第 6 节「身份、互斥与公共门控」要求写前现读店铺与后端账号并匹配任务锚，换账号不继续写；S8 也包括换账号场景。
- 源码：`features/shipping/runner.ts` `assertOwnership`（263–268）读取 `userId` 后只判 `userId === null`，没有判 `userId !== current.ownerUserId`。`current.ownerUserId` 已在任务接受时写入（`features/shipping/background.ts` 317–322）。
- 影响：若店铺 `shopId` 不变而本地后端登录账号换成另一个非空账号，商品批改前的归属检查仍通过，后续写请求可继续。当前单测“账号失效时停止写”只覆盖 null（`tests/unit/shipping-runner.test.ts` 404–408），未覆盖任务账号 1、当前账号 2。
- 同类缺口：手动恢复物流走 `restorePendingLogistics`（`features/shipping/runner.ts` 835–851），仅核对 shopId，没有读取／比较 `ownerUserId`。这会让“恢复物流”绕过上述账号归属核验。

## 需运行证据确认的风险

### R1：跨功能冲突读取失败时按“无冲突”放行

- 标准：任务书第 6 节 128 行要求 shipping 与修复／特卖／复制双向互斥，覆盖第一条写请求时刻。
- 源码：`entrypoints/background.ts` `findShippingWriteConflict`（874–885）和 `findOtherWritesForShipping`（946–970）在读取 storage 等异常时 catch 后返回 `null`。
- 影响条件：若 Chrome storage 读取异常，这两个守卫无法确认旧任务是否活跃，却仍允许开始新写任务；潜在结果是两个店铺写流程并行。源码只能证明失败关闭策略缺失，不能证明本轮实际发生过 storage 故障。建议运行验收注入 storage.get 拒绝，确认是否应 fail-closed。

### R2：任务错误和日志使用原始异常文本，脱敏保证不足

- 标准：手册 `docs/手册/01-红线.md`「一键修复：日志与诊断里不得出现登录凭据」要求底层日志先对 URL 中 SPC_CDS 打码；任务书第 7 节 S8 要求错误脱敏且可定位。
- 源码：`features/shipping/background.ts` 348–359 把 `e.message` 同时传给日志并写入 `_shippingTask.error`；`features/shipping/runner.ts` 450–466 将原异常文本保存为任务错误。Shipping URL 由 `features/shipping/api.ts` `withCredential`（32–45）拼入 SPC_CDS／SPC_CDS_VER。
- 影响与证据边界：正常入口日志 `injectedFetch` 会对 URL 字符串调用 `redactSpcCds`（`entrypoints/background.ts` 445），所以不能仅凭静态代码断言已泄露；但异常文本未经通用脱敏就持久化／记录，若异常或平台返回内容包含敏感参数，错误会进入扩展 storage、界面或控制台。建议把可持久化错误限制为脱敏后的阶段／HTTP／业务码和安全原因，并用敏感字串夹具验证。

## 结构建议（非阻断）

- `features/shipping/types.ts` 同时含商品、物流、任务、计划和消息契约，属于较大的领域契约文件；本任务明确要求它做消息契约与专属键的单一来源，因此不据此判定拆分违例。后续类型增长造成多人频繁冲突时再按领域拆分。
- `entrypoints/background.ts` 新增约 104 行接线／冲突检查，旧入口仍承载共享浏览器身份与卖家请求。任务书明确允许必要导航、注册、适配及双向互斥；已有依赖注入是业务模块复用能力的边界，不属于纯转发 Middle Man。当前不建议为了启发式行数限制抽象层。
- 新模块的职责边界整体符合任务书：规则、任务、调度、runner 不依赖 React／Zustand／DOM，局部 store 和 shipping 专属 key/alarm 分离。静态代码中未见对 `_scheduledCopy`、`auto_mode_*` 的清理调用；旧入口读取相关键用于互斥属于必要共享，不是误清。

## 结论

静态规范复核发现一个明确身份锚缺口（账号不相等仍放行，且手动物流恢复未核账号）；建议独立验收将“同店换后端账号后，下一项商品写／物流恢复均停止”列为阻断确认项。互斥读取失败策略与错误文本脱敏另需针对性运行证据；此报告未运行主代理负责的复现。隔离构建配置、共享 `.output` 是否未覆盖、及开发者的构建／验收声称，由主代理依据已有证据核对，本审查未执行任何命令。
