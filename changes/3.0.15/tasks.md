# 3.0.15 Tasks — 重复入金匹配

> 每个 task 尽量小、可验证、可独立完成。
> 状态基线：2026-07-14 实施完成并通过自动化门禁；Windows Excel/WPS 与真实脱敏样本资金复核仍是发布阻塞项。
> 实施约束：不得顺带实现 3.0.16 范围；不得静默修改 spec。

## Task 0 — 规格与未知门禁

- 目标：在业务代码继续实施前锁定资金口径、范围与可验证不变量。
- 涉及文件：`changes/3.0.15/spec.md`、`changes/3.0.15/test-spec.md`、`changes/3.0.15/implementation-notes.md`
- 操作：
  - 逐项确认 AC-01 ～ AC-27 和 P0-01 ～ P0-45。
  - 将 `MPT_CHANNEL_OTHERS`、临时银行对账单、缺渠道账单标记为 3.0.16，不在实现中预埋可见半成品。
  - 对任何会改变金额、键、复用、生命周期或输出列的发现先 reverse-sync spec。
- 验证：Dev 在开始/继续业务实现前确认无 `BLOCK` unknown；PM/Dev 对核心不变量达成一致。
- 状态：done

## Task 1 — 输出资产与固定契约

- 目标：锁定邮件模板和人工 sheet，不让 writer 自行推断列。
- 涉及文件：`assets/重复入金召回邮件模板.xlsx`、`assets/银行对账单.xlsx`、`src/main-process/duplicate-inbound-match/excel-writer.js`
- 操作：
  - 校验邮件模板 10 列、固定备注和两 orderId 的 `、` 连接口径；业务来源取 MPT `oppBu`，Debit Amount 数据行显式使用“常规”格式。
  - 固定两个 sheet 的名称、顺序和表头；空结果由 service 禁止导出。
  - 固定人工 sheet 为 46 标准列 + `人工判定原因`，保留原值。
- 验证：writer 单元测试解析生成工作簿，断言 sheet 数/顺序/表头/映射/样式关键点；service 测试空结果不可导出。
- 状态：done

## Task 2 — 模块注册与 UI 骨架

- 目标：新增默认关闭的独立“重复入金匹配”面板，不改变前置资金对账。
- 涉及文件：`src/backend/database/settings-repository.js`、`index.html`、`src/renderer.js`
- 操作：
  - 注册 `duplicate-inbound-match`，保持既有用户默认模块列表不变。
  - 增加导入、运行、导出、状态/进度控件和单忙碌态。
  - 展示 spec 要求的核心计数；错误与进度脱敏。
- 验证：renderer/unit 或 preview 检查默认隐藏、启用显示、按钮状态和重复点击；前置资金面板回归。
- 状态：done

## Task 3 — 当前启动周期侧库与轻量镜像

- 目标：建立符合 run-scoped policy 的导入/运行存储和重启清理。
- 涉及文件：`src/backend/run-data-store.js`、`src/backend/duplicate-inbound-match-store.js`、`src/backend/database/migrations.js`、`src/backend/database/duplicate-inbound-match-run-repository.js`、`src/backend/database.js`
- 操作：
  - 侧库保存银行原行、来源序号、run、邮件结果、人工结果和完整血缘。
  - 主库只保存运行状态、文件/hash、snapshot 摘要、计数、side path、脱敏错误。
  - 迁移幂等；启动清理遗留 side DB；修复 `running`/missing/expired 状态。
  - 成功新导入替换旧 input/run；开始新 run 即使旧结果失效。
- 验证：store/repository 单元测试覆盖事务回滚、替换、清理、重启、side DB 缺失及主库无敏感 raw。
- 状态：done

## Task 4 — 银行导入与 BizId 强校验

- 目标：只接受单份标准 46 列银行账单，并在持久化前完成 BizId 全文件校验。
- 涉及文件：`src/main-process/bank-statement-io.js` 或模块 reader/validator、模块 service、对应测试
- 操作：
  - 复用 `BANK_STATEMENT_FIELDS` 与 `渠道对账单` reader。
  - BizId 以 trim 后字符串校验非空、大小写敏感唯一，收集全部错误行号。
  - 取消选择保持旧会话；选中新文件即使旧会话失效，后续失败不恢复旧会话。
  - 分配稳定源序号，不改写原 46 列。
- 验证：P0-02 ～ P0-07 单元/集成全部 Green；`.xls/.xlsx` 等价。
- 状态：done

## Task 4A — 双文件导入与单据 side DB

- 目标：同一入口原子导入银行账单和标准 26 列单据对账单，单据采用流式有界内存落库。
- 操作：严格识别一份银行文件和一份单据文件；保存单据业务订单号、用户编号、账户号、业务部门及来源行；主库只镜像文件名/hash；失败整批回滚。
- 验证：双文件识别、错误组合、取消、回滚、9 万行流式导入、重启回收和主库隐私测试。
- 状态：done（双文件识别、原子回滚、逻辑首 sheet、9 万行流式读取、side DB 生命周期和主库隐私均有自动化/真实样本证据）

## Task 5 — 纯分组引擎

- 目标：实现可独立证明的金额、行分类、七元组与 1+2 分类。
- 涉及文件：`src/main-process/duplicate-inbound-match/matching-engine.js` 及单元测试
- 操作：
  - FundType trim 后大小写敏感分类。
  - 方向金额使用十进制字符串规范化，拒绝科学计数/逗号/非法值，不触碰非方向金额。
  - 分组文本不 trim；结构化七元组防碰撞。
  - 分类 1+2、其它 Reversal 人工、纯 Inbound 统计、忽略行统计。
  - 固定组/行排序和银行数量人工原因顺序。
- 验证：P0-08 ～ P0-16、P0-28 ～ P0-30 focused tests Green；金额不使用 JS 浮点。
- 状态：done

## Task 6 — 全保留月份 MPT 只读查询

- 目标：为每条候选银行 Inbound 返回所有保留月份中稳定、完整的 INBOUND 候选。
- 涉及文件：`src/backend/pre-fund-reconciliation-store.js`、相关 store tests
- 操作：
  - 按 trim 后 `Channel + MerchantId + ReconciliationId` 批量收集查询条件。
  - 遍历全部保留月份，仅筛 `MPT_INBOUND_GATEWAY` 且 `tradeType === 'Inbound-VA'`。
  - 返回月份 + 行 ID 的稳定候选 ID、规范字段及 raw；不去重、不按月份择优。
  - 每月份至多打开/扫描一次；不读 OUTBOUND 或 linked gateway pool。
  - 提供只覆盖 INBOUND 的 snapshot/fingerprint 组成信息。
- 验证：P0-17 ～ P0-21、P0-39/40 和 P1-03/09；保留 3.0.14 store 回归。
- 状态：done（每个保留月份以 TEMP ID 集合执行一次 JOIN 批量读取）

## Task 7 — 两阶段 MPT 裁决、血缘与守恒

- 目标：实现唯一、不复用、字段一致且顺序无关的资金裁决。
- 涉及文件：`src/main-process/duplicate-inbound-match/matching-engine.js`、模块 service、对应 tests
- 操作：
  - 第一阶段为两条 Inbound 保留精确候选数并判 0/1/多；多候选只物化稳定前 2 条审计样本，避免重复查询键形成 N×K 对象。
  - 第二阶段检测组内同 ID 和跨组复用；所有共享组人工，不 first-wins。
  - 解析 raw object；非法 raw 硬失败。
  - 只比较 trim 后非空的 `oppBu`；MPT `clientId/accId/business` 不参与；`orderId` 必须非空。
  - 生成稳定组合原因、完整银行/MPT 血缘，并执行三条守恒和 MPT 唯一断言。
- 验证：P0-20 ～ P0-30；输入组顺序置换 property test；故障注入确认 fail closed。
- 状态：done

## Task 7A — 单据唯一匹配、身份校验与血缘

- 目标：以两条 MPT orderId 精确匹配单据，并用单据字段生成客户号/账户号。
- 操作：每个 orderId 唯一命中且两行不同；用户编号/账户号/业务部门非空一致；业务部门等于 oppBu；失败仅当前组人工；审计追加单据文件/行号。
- 验证：零/多候选、同一行、字段空/冲突、业务部门冲突、MPT 旧字段旁路和真实样本 9+1。
- 状态：done（matching/service/store/reader/writer/migration focused 59/59；真实样本 9 成功 + 1 人工）

## Task 8 — 两 sheet writer 与原子发布

- 目标：准确生成业务可用 Excel，不截断、不留半文件。
- 涉及文件：`src/main-process/duplicate-inbound-match/excel-writer.js`、文件服务/模块 service、writer tests
- 操作：
  - 邮件 sheet 按成功组生成 10 列；两个已校验非空的 orderId 按银行 Inbound 源顺序用 `、` 拼接。
  - 人工 sheet 生成 46+1 列，整组全行、原值、同原因。
  - 固定 sheet 名/顺序、默认文件名、本地日期，并在空结果时拒绝导出。
  - 写前检查 Excel 上限；使用临时文件 + 原子替换；写后校验 workbook 结构和行数。
- 验证：P0-31 ～ P0-36、P1-04 ～ P1-06；Windows Excel/WPS 人工打开。
- 状态：done（自动化契约与回滚测试完成；Windows Excel/WPS 视觉检查归 Task 11，仍待人工）

## Task 9 — 服务、IPC、锁与 stale 状态

- 目标：串起导入→运行→导出，并确保输入/MPT snapshot 一致。
- 涉及文件：模块 service、`src/main.js`、`src/preload.js`、`src/renderer.js`、相关 tests
- 操作：
  - 新增 import/status/run/export IPC 和三个进度事件，统一错误返回语义。
  - 运行快照绑定银行/单据 hash、当前导入 revision 和全部保留月份 INBOUND batch identity/hash/row count。
  - 与 MPT INBOUND 导入/替换/删除共享锁；运行前后复核 fingerprint。
  - INBOUND 变化 stale、OUTBOUND-only 不 stale；只允许最新成功且当前周期结果导出。
  - 用户取消不视为失败；运行失败后不恢复旧可导出结果。
- 验证：P0-37 ～ P0-42、P1-07/08 集成测试和手工并发测试。
- 状态：done

## Task 10 — 自动化测试补齐

- 目标：让每条 AC 有可重复证据，不把 concurrent draft 测试误当完成。
- 涉及文件：`tests/unit/main-process/duplicate-inbound-match/**`、`tests/unit/backend/**`、`scripts/integration/**`、必要的 smoke fixture
- 操作：
  - 按 `test-spec.md` 补齐 BizId、金额、键碰撞、全局复用、守恒、MPT all-month、snapshot、writer 和隐私测试。
  - 增加至少一个完整端到端合成 fixture 和一个输入顺序置换 fixture。
  - 对所有硬错误验证“无成功 run/无半文件”，对业务不确定验证“整组人工”。
- 验证：focused tests、`npm run test:unit`、`npm run test:integration` 全 PASS；覆盖率无新增关键分支空洞。
- 状态：done（unit 3563/3563；integration 40 脚本、1870/1870；smoke 与完整 release-check 通过）

## Task 11 — 回归、性能与视觉验证

- 目标：证明新模块不破坏 v3.0.14，且生产规模下可操作。
- 涉及文件：测试/日志/截图证据；不因验证修改业务契约
- 操作：
  - 运行 `npm run smoke`、`npm run release-check`、相关 preview。
  - 回归 MPT 导入/替换/删除、缺网关对账和既有导出。
  - 运行多月份大数据基准，记录耗时、峰值内存、每月份读取次数和 UI 响应。
  - Windows Excel/WPS 检查长数字、中文、空 orderId 人工原因、长原因与两 sheet 样式。
- 验证：AC-26；所有失败和跳过项记录到 implementation notes。
- 状态：partial（smoke/release-check、Electron 预览、6 个月/15 万 MPT/6000 键基准和启动性能已完成；Windows Excel/WPS 人工打开待完成）

## Task 12 — 重要变量与发布准备

- 目标：在 PR 与合并硬节点完成变量关联 review 和发布文档一致性。
- 涉及文件：`rules/important-variables.md`、扫描报告；发布阶段的 `package.json`、`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`
- 操作：
  - 每次改 `src/**/*.js` 后汇报命中的 Minor 以上变量和关联功能 review。
  - 版本 bump/合并受保护分支/提 PR 前运行 `npm run scan:vars`、`npm run check:vars`。
  - 发布时三份版本文档与 package version 同步，且明确三项顺延 3.0.16。
- 验证：check-vars 报告、PR body 的关联功能 review、发布文档 diff 与版本一致。
- 状态：in progress（版本与三份文档已同步；PR #88 已建立并完成一次 check-vars；合并前硬节点待最终重跑）

## Task 13 — 资金人工复核与 Dev 交接

- 目标：完成人工资金红线检查并形成可审计交接。
- 涉及文件：`changes/3.0.15/implementation-notes.md`
- 操作：
  - 业务负责人逐项执行 `test-spec.md` §8，记录样本、计数、血缘反查和签字结论。
  - Dev 汇总实际改动、测试日志、重要变量、偏差、剩余风险和回滚步骤。
  - 若有行为偏差，先 reverse-sync spec/test/tasks，再请求 PM/用户复核。
- 验证：AC-27 通过；Evidence 有真实命令、日志和人工签字，不以“代码已写”代替验证。
- 状态：blocked（实现证据和自动化交接已完成；待业务负责人按 `test-spec.md` §8 使用脱敏真实样本复核并签字）

## 完成定义

- [ ] Task 0 ～ 13 所有适用项为 done：Task 11 的 Windows Excel/WPS 检查及 Task 13 人工资金复核仍阻塞发布。
- [ ] AC-01 ～ AC-27 全部有证据：AC-01 ～ AC-26 自动证据已完成，AC-27 待人工签字。
- [x] 无 `MPT_CHANNEL_OTHERS`、临时银行对账单、缺渠道账单的 3.0.15 可见实现。
- [ ] 银行行守恒、MPT 候选全局唯一、金额/币种/血缘的自动断言已通过，仍待真实脱敏样本人工复核。
- [x] Dev 实施与自动化证据已回填本文档；PR #88 已创建并进入 self-review。
