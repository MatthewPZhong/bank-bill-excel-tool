# v3.1.1 版本总规范

> status: implemented（代码、自动发布门禁及两项人工红线复核已完成；PR、合并、tag、GitHub Release 不在本 spec）
> updated: 2026-07-29
> release order: v3.1.1 完成发布收尾后，方可启动 v3.1.2

## 1. 版本目标

v3.1.1 同版交付两项相互独立、分别可验收的修复：

1. 平盘对账允许“结构可识别且十张相关表全部为空”的旧侧库，在合法 generation 0 bootstrap 下安全完成首次绑定。
2. 资金对账的 R3.5、R4、R5s2 统一执行真实银行借贷方向校验，并为调拨回填提供可配置的同日优先、前后 `±N` 天日期策略。

两项修复共享版本号和发布检查，但不得共享隐式 fallback：任一兼容证明、方向条件、日期 owner 或配置身份无法确定时均须 fail-closed。

## 2. 规范正文

- [子规范 1：平盘空旧侧库初始化兼容修复](./spec-position-side-db.md)
- [子规范 2：调拨方向与日期防误匹配](./spec-fund-transfer-direction-date.md)

上述两份子规范均为 v3.1.1 的强制组成部分；发生冲突时，以更严格的防丢、方向和审计约束为准，不得以“保持兼容”为由放宽资金或持久化安全条件。

## 3. 统一约束

- 不删除、清空或替换用户现有平盘侧库。
- 不迁移任何含历史业务行、运行草稿、差异或消费关系的旧侧库。
- 方向校验必须在候选生成阶段完成；方向失败行不得参与多候选、选择、消费、配对、保护集或字段改写。
- 账号、币种、金额、日期（启用时）和方向任一失败均不得静默降级。
- `FundTransfer-in/out` 日期策略由唯一 canonical 内置场景持有；R5s2 停用不影响 R3.5 读取该策略。
- R4 的既有 warning、具体 `matchedPairs` 和 no-op 消费语义保持稳定。
- 实际字段修改、完整命中、消费、标黄和告警继续分离并可审计。
- `modifiedRows + unmatchedRows === bankRows.length` 行数守恒必须保持。
- 不包含工具箱合并/拆分格式保真；该范围归 v3.1.2。

## 4. 完成标准

只有同时满足以下条件，v3.1.1 才可进入发布收尾：

1. 两份子规范的自动化验收全部通过。
2. 旧侧库成功/阻断矩阵均有定向测试，现代侧库回归通过。
3. R3.5、R4、R5s2、日期策略、canonical owner 生命周期和运行/导出快照均有定向测试。
4. 问题样本 `0016RF1210576`、`20260721UOVBSGSGBRT8522830` 使用真实或脱敏数据逐笔人工复核。
5. `package.json.version` 更新为 `3.1.1`，并同步更新：
   - `CHANGELOG.md`
   - `docs/VERSION_FEATURE_HISTORY.md`
   - `docs/USER_GUIDE.md`
6. 完成 `npm run scan:vars`、`npm run check:vars -- --include-minor` 和 `npm run release-check`。
7. 记录未完成的人工复核、构建或发布动作；存在资金红线未确认时不得宣称版本可发布。

## 5. 发布边界

- 本版本代码与文档完成、自动检查通过后，先完成 v3.1.1 发布收尾。
- 未完成 v3.1.1 发布收尾前，不修改 v3.1.2 的生产代码、版本号或发布文档。
- v3.1.2 的工具箱格式保真规范继续保留在 `changes/3.1.x-2-toolbox-format-fidelity/spec.md`，待下一阶段重新基线化。

## 6. 人工复核

⚠️ 本版本同时改变平盘侧库首次绑定分支，以及资金候选的借贷方向、日期和消费边界。自动测试不能替代：

- 对隔离旧侧库副本的升级前后行数、schema 与 checkpoint 核对；
- 对真实或脱敏资金样本逐笔核对 FundType、ReconciliationId、消费集合、告警和未命中去向。

上述两项已于 2026-07-29 使用真实文件的隔离副本/只读数据完成，详细证据见
[`implementation-notes.md`](./implementation-notes.md)。未修改正在使用的正式数据库。
