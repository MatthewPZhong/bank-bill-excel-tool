# v3.2.6 关联功能 review

检查范围：本分支相对基线的 `src/` 改动。版本号调整前已执行 `npm run scan:vars`、`npm run check:vars`；结论及本地原始日志位置见 [验证记录](verification.md)。check-vars 的退出码 2 表示命中需复核的变量，不表示业务测试失败。

3.2.6 最终状态已重跑 scan:vars 和 check:vars，提 PR 前再次执行 check:vars，命中范围一致。release-check 的 lint、smoke、单测和全部集成脚本均已通过。

## 自动命中

| 层级／变量 | 清单要求 | 本次复核 |
| --- | --- | --- |
| Important-skeleton：normalizeCell | “任何改动都会放大到 reader/writer/migrations 三条链”；必跑 smoke，验证不同格式规范化一致性（rules/important-variables.md:426） | 使用既有函数，未修改清洗实现；新增账号精确集合检查覆盖 trim、前导零、子串近似，既有读取测试继续回归。 |
| Runtime-state：dialog | “改 dialog 调用必须考虑用户取消分支”（:596） | 本次为 renderer 局部 DOM 同名变量，无原生 Electron dialog 改动；提取、完成和取消路径均有定向验证。 |
| Runtime-state：elements | “增删 DOM 节点要同步 cache 初始化”（:611） | 沿用既有 modalRoot，无新增顶层缓存；取消回调仅处理仍属于当前进度框的节点。 |
| Runtime-state：setStatus | “改消息格式要同步所有调用点的语气一致性”（:617） | 取消完成及 IPC 异常提供可见中文状态，测试覆盖失败提示和重试。 |

## 定义文件补充复核

按 skill 要求，定义文件变动也计入 review；自动 diff 符号扫描未列出的以下项手动补入。

| 层级／变量 | 清单要求 | 本次复核 |
| --- | --- | --- |
| Risk-sensitive：runC2Scenario | “reconFields = 0 时无条件赋值”；必跑 smoke C2 全套及真实银行账单 C2 端到端（:992） | 保留单 billType、无对账字段分支；包含匹配、多候选、非法枚举无修改/锁定有测试。脱敏真实账单人工端到端待执行。 |
| Risk-sensitive：config.billTypes / config.conditions | 字段结构变更必须同步引擎、dialog、bundle、默认值；必跑 smoke 与旧结构 bundle 升级（:1003） | 此次只为 reconFields 增加 op，旧 billTypes 迁移继续保留；旧结构读取、保存、bundle 导入及失败事务回滚已纳入回归。 |
| Runtime-state：lastGeneratedExports / statementImportSessions / lastFileImportContext | 导出生命周期与 session key 不能漂移（:622） | 新阻断调用既有当前 context 取消；真实函数测试验证旧 context 拒绝、历史会话和结果不被清除。 |

## ⚠️ 关联功能 review

- Important-skeleton：`normalizeCell`；Runtime-state：`elements`、`setStatus`、当前选择及历史导入状态；Risk-sensitive：`runC2Scenario` 和 C2 配置读写链。
- 自动化结果以 [实施记录](implementation-notes.md) 中的最终运行证据为准。
- ⚠️ 资金红线，请人工复核：使用脱敏银行账单逐笔核对“包含”的命中范围、金额等于旧语义、账号归属和未维护批次的整批取消；自动测试不能替代该验收。
