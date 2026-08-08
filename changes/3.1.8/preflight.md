# v3.1.8 实施前核验

## Task Brief

- Goal: 按已锁定的 v3.1.8 Spec 完成 VCC 财务OP校验迭代，并拆成可独立评审、按顺序合并的堆叠 PR。
- Context: 基线为 `main@dff07df11fb94ce84940b474b55ac796f084d241`；版本起点为 3.1.7；Q01～Q12 已全部锁定。
- Constraints: 不改变既有充值清退、费用换汇、通道和 Pending 金额方向/分组口径；金额链路只使用十进制定点字符串；破坏性状态变更必须事务化、二次门禁、审计并提交后断言；人工财务复核是发布门禁。
- Done when: Spec 的 AC-1.1～AC-1.10、自动化回归、模板契约、版本文档和重要变量检查均有证据；Windows 产物与真实财务数据完成人工复核后才可发布。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 当前代码与 Spec baseline 完全一致 | `git rev-parse HEAD` 返回 `dff07df11fb94ce84940b474b55ac796f084d241` | 无需在漂移代码上重放补丁 |
| Pending 金标准资产已位于目标路径且内容正确 | `shasum -a 256 assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx` 返回 `f7967d...a9fc` | PR 1 可直接锁定 46 列契约 |
| 结果模板资产已位于目标路径且内容正确 | `shasum -a 256 assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx` 返回 `f920fd...1f4` | PR 5 必须使用该模板且禁止回退 |
| 精度回归真实样例可用 | `/Users/pzhong/Downloads/财务OP (22).xlsx` 存在 | PR 1 用真实 JPY 单元格验证 raw-first |
| 当前系统财务OP错误地优先显示值 | `system-op-importer.js::systemAmountToken` 先返回 display；现有测试明确断言 `123.45` 按 `0.0` 变成 `123.5` | PR 1 必须反转优先级并更新审计证据 |
| 当前 Pending 是 48 列且计算阶段不要求 Pending | `definitions.js::PENDING_HEADERS`、`calculator.js::REQUIRED_DETAIL_TYPES` | PR 1 同时升级导入契约、历史哈希与运行门禁 |
| 当前有效行唯一键为 `source_type × idempotency_key` | `vcc_fin_op_effective_rows` 的 UNIQUE 约束 | 迁移必须保持同一业务键唯一，不得重插历史事实 |
| 当前工作区含与本迭代无关的用户文件 | `git status -sb` | 所有提交只显式暂存本迭代文件，禁止 `git add -A` |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 历史 Pending `raw_json` 是否可能既非 48 项也非已知 46 项 | 旧库数据形态 | 高 | 困难 | 生产库不可直接假设干净 | PROBE | 用内存库构造 48/46/异常长度迁移 fixture | 异常长度必须整次阻断，零部分迁移 |
| 46 列重放能否与迁移后的 48 列历史事实幂等相等 | 数据契约 | 高 | 一般 | 当前 hash 基于原始全列 JSON | PROBE | 迁移测试后走一次真实分类逻辑 | v2 hash 仅删除两个旧字段，其余原值原序保留 |
| raw number 转稳定十进制 token 是否覆盖科学计数法且不掩盖超精度 | 金额精度 | 高 | 容易 | `canonicalizeVccAmount` 已限制两位小数和 15 位有效数字 | PROBE | 真实样例 + 科学计数法/公式缓存/超精度测试 | 有限安全数值 raw-first；规范化失败即拒绝 |
| 首月旧库存在多个初始化月份 | 历史状态 | 高 | 困难 | 当前 schema 允许多个月份 | PROBE | PR 2 迁移 fixture | 按 Spec fail-closed，绝不自动删改资金值 |
| 新结果模板动态行/合并区能否由现有 SheetJS writer 无损复制 | Excel 样式能力 | 中 | 一般 | 当前 writer 依赖固定行号 | PROBE | PR 5 先做真实模板 contract/round-trip 测试 | 锚点缺失即失败，不做旧模板 fallback |
| GitHub 草稿 PR 能否发布 | 外部认证 | 中 | 容易 | `gh auth status` 显示 token invalid | BLOCK（仅发布） | 用户执行 `gh auth login -h github.com` 后复检 | 不阻塞本地实现与提交；阻塞 push/PR 创建 |
| Windows installer/portable 中模板可读性 | 平台产物 | 高 | 一般 | 当前环境不是 Windows | PROBE/人工门禁 | Windows CI 构建并检查打包资产 | 阻塞最终发布，不阻塞代码 PR 草稿 |

## 保守假设

- 多 PR 使用堆叠分支：每个后续 PR 以直接前序分支为 base，只展示本阶段增量；合并顺序固定，最终再逐个改回 `main` 或顺序合并。
- 用户已放入仓库且哈希匹配的两份 Excel 属于本迭代范围；其他未跟踪文件不纳入任何 PR。
- 自动化通过不能替代 Spec 要求的真实月份财务人工复核。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | PR 1：锁定 raw 金额、Pending v2 契约/迁移和五表预检 | 金额不丢精度；旧事实唯一；输入齐全 | 真实 JPY、模板 SHA/表头、迁移及 preflight 测试 | 推翻后续所有计算可信度 | 不进入状态/UI PR |
| 2 | PR 2：首月状态、调整账本和统一生效结果 | 首月不漂移；基础结果不可变；调整一次性 | DB 迁移、金额公式、revision 测试 | 归档/删除/UI 无可靠状态模型 | 保留 PR 1，撤回新状态层 |
| 3 | PR 3：解归档与两类删除事务 | 跨月血缘、行数守恒、失败零部分成功 | 三月集成场景、token 变化、故障回滚 | 禁止开放破坏性入口 | 移除 IPC/UI，保留底层只读能力 |
| 4 | PR 4：完整结果确认与调整交互 | rowKey 防伪、核对 revision、UI 与后端一致 | renderer contract + service/DB 测试 | 不影响基础导入，可关闭修改入口 | feature UI 回滚 |
| 5 | PR 5：语义模板、着色和月份导出 | 输出可审计；样式来自模板；月份不串 | 真实模板 round-trip、fill、调整行、月份测试 | 阻塞结果导出 | 导出 fail-closed，不回退旧模板 |
| 6 | PR 6：预览、文档、版本与全量发布门禁 | 用户可见契约、重要变量、回归完整 | release-check、check-vars、Windows CI、人工清单 | 不得发布 3.1.8 | 保持全部 PR 草稿 |

## PR6 收口状态（2026-08-08）

### 已完成

- 版本已提升到 `3.1.8`；CHANGELOG、版本历史和用户手册统一保持“Unreleased / 待发布 / 发布候选”，没有宣称已发布或已通过资金人工验收。
- 锁定规范已纳入 `changes/3.1.8/spec.md`；保留 Downloads 原文件 SHA-256，并只把 §10.4 修正为仓库真实文档路径。
- VCC 26 张合成预览已生成并视觉复核，覆盖关键业务状态、100%/125%/150% 和最小窗口；capture hook、窗口参数和假数据均与生产路径隔离，失败或截断 PNG 不会替换旧证据。
- Windows 本地、PR 和 Release 构建命令统一锁定 x64；任意 PR 配置为先跑完整发布检查，再构建 installer/portable 并执行分发守卫；守卫新增两份 VCC 模板和包内版本校验。
- `npm run scan:vars` 已刷新 v3.1.8 报告：`src/` 293 文件、3688 个顶层名字；`npm run check:vars` 仅命中 Runtime-state 的 `MODULES`、`app`、`dialog`、`setStatus`、`state`。`state` 命中来自 preview/既有引用，本轮未改 `src/renderer.js` 全局 state 结构，capture 状态只在隔离的 Promise 和局部 DOM 快照内流转；其余命中也已按 capture-only 或局部变量复核，无 Critical/Risk-sensitive 命中。
- 最终对外术语修复后的单次 `npm run release-check` 通过：lint、smoke、unit `4695/4695`，integration `47/47` 脚本、`2186/2186` 断言全部 PASS；其中 VCC 调整归档 `55/55`、破坏性状态链 `52/52`、历史模板导出 `28/28`。实施记录只在此后补写本组实跑计数，不再改生产代码或对外文档。
- 本机旧 `dist/win-unpacked` 为 3.0.13，分发守卫因缺两份 VCC 模板且版本不等于 3.1.8 正确拒绝；该负向结果没有被当成 Windows 3.1.8 构建成功。

### Reviewer 退回项复核（2026-08-08）

- 已用文件时间线确认：旧“切年后有后续依赖，但删除按钮仍像可点”截图早于 disabled 样式和后续 renderer 改动；生产 picker 的异步状态和后台尾月保护未失效，问题是陈旧截图证据及 capture 缺少异步完成信号。
- 已为 4 个解归档截图状态增加 capture-only 完成信号和 8 秒超时；必须等目标年/月、preview response、真实 `button.disabled` 和状态文案稳定后才允许截图。缺 hook/缺 method/无 Promise/拒绝/悬挂均以非 0 失败，不得用旧 PNG 冒充。
- 已增加行为测试：实际触发切年和非尾月切换，异步完成后直接断言确认按钮 `disabled === true`；执行中同样断言真实 DOM 禁用状态。
- 已重新生成 26/26 张 VCC PNG 并全部解码校验：25 张 2480×1720，最小窗口图 2160×1520。人工检查切年、非尾月、执行中和结果页，禁用按钮均为灰色且不可点，结果页显示“结果版本”。
- 用户手册已明确：较新“已归档”和“已计算”均会阻断更早月；须从最新月开始逐月“解归档→删除全部未归档结果”，修订目标月后再按时间正序重跑、归档；删除不会清理源数据、导入审计或固定首月。
- 公开的 v3.1.8 CHANGELOG/版本历史/手册当前候选切片已改为用户语言，不再使用“金标准/语义模板”，改为“正式模板/结果模板”；Windows 统一表述为“64 位 Windows 安装版和便携版”。VCC 界面不再展示英文 `revision`，内部字段和错误码保持不变；release-docs 对三份当前版本切片增加了术语负断言。
- 最终 `scan:vars/check:vars` 扫描 `src/` 293 文件、3688 个顶层名字；仅命中 Runtime-state 的 `MODULES`、`app`、`dialog`、`setStatus`、`state`，无 Critical/Risk-sensitive。后两者及 `dialog` 为 VCC 局部 DOM/状态，`MODULES` 仅用既有 ID 做 capture 路由，`app` 仅改变 capture 失败的退出码。
- 最终 intended 范围为 56 个文件：33 个 tracked + 23 个 intended untracked（1 份锁定 spec、18 张新 VCC PNG、4 个新单测）。`scripts/scan-vars.js` 的 1 行删除是 PR6 为了消除统计 Markdown 末尾多余空行、保证刷新结果稳定的修复，纳入 tracked 范围。`docs/previews/_general/`、`outputs/`、`.agents/`、`.codex/` 和其他既有未跟踪文件不在本迭代范围，未被更改或纳入。

### 仍阻塞 v3.1.8 正式发布

- 在 Windows CI/目标机实际产出并检查 x64 installer 与 portable，确认两份 VCC 模板存在且可读。
- 用 Windows Excel/WPS 人工检查字体、正常/异常颜色、动态行、长调整原因换行、M/N 可见性及默认 A:L 打印区；需要纸质调整证据时人工扩展打印区。
- 在受保护解归档/删除任务进入关键写入后触发关窗，确认应用等待事务安全收口且不强制终止后台任务。
- 对生产数据库副本做只读扫描，核对 Pending 46/48 列、归档主体/九币种余额及五类数据状态；异常只阻断并人工处理，不自动修复。
- 由财务人员用真实月份逐主体、逐九币种核对基础值、调整值、生效余额、差异、颜色、归档及连续两月期初衔接，并记录签字结论。

结论：PR6 的代码、预览、版本、文档和自动化收口已完成；上述人工门禁完成前，v3.1.8 仍是发布候选，不得发布。
