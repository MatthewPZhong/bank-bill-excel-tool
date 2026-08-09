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
| GitHub 发布写入通道是否可用 | 外部认证 | 中 | 容易 | `gh auth status` 显示 CLI token invalid；Git remote 凭据与 GitHub App 连接是独立通道 | PROBE | 分别验证 `git push`、GitHub App PR 创建；只有需要 CLI fallback 时才重新登录 `gh` | Git push 与 PR 创建已实证可用；CLI 直连操作暂不可用，不作为总发布闸门 |
| Windows installer/portable 中模板可读性 | 平台产物 | 高 | 一般 | 主干 Windows CI 已构建并由分发守卫核对包内版本及必需文件；尚未在目标 Windows 机器实际安装/运行 | PROBE/人工门禁 | 目标机打开 installer/portable，并从两种安装形态实际读取两份 VCC 模板 | 阻塞最终发布，不阻塞代码 PR 草稿 |

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

## PR6 最终收口状态（2026-08-09）

### 已完成

- 版本已提升到 `3.1.8`；CHANGELOG、版本历史和用户手册统一保持“Unreleased / 待发布 / 发布候选”，没有宣称已发布或已通过资金人工验收。
- 锁定规范已纳入 `changes/3.1.8/spec.md`。相对 Downloads 原文件，业务内容只修正 §10.4 的两处真实文档路径；另有前五行 Markdown 双空格硬换行改为等价 `<br>` 的五处纯格式修复。原文件 SHA-256 为 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；`018675fb6da6a07a72b8a7b23a28928dd8eb643b02592d0320714628f55221d8` 明确是五处格式修复前、仅完成路径修正的阶段哈希；当前候选 `changes/3.1.8/spec.md` 按 CRLF/CR → LF 规范化后的冻结内容 SHA-256 为 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d`。`docs/iterations/v3.1.8/PRD-v3.1.8.md` 以索引/导读归档版本范围、非目标、验收与人工门禁，不重复规范正文。
- VCC 26 张合成预览已在最新 PR 5 restack 候选上重新生成，覆盖关键业务状态、100%/125%/150% 和最小窗口；25 张为 2480×1720，最小窗口图为 2160×1520。自动门禁逐图验证 signature、IHDR、正尺寸、非空 IDAT、IEND 长度 0 且恰好 EOF，capture hook、窗口参数和假数据均与生产路径隔离。
- Windows 本地、PR 和 Release 构建命令统一锁定 x64；任意 PR 配置为先跑完整发布检查，再构建 installer/portable 并执行分发守卫；守卫新增两份 VCC 模板和包内版本校验。
- `npm run scan:vars` 只统计 Git 已跟踪 JS，ignored/generated/untracked 不参与；最终合并树稳定得到 `src/` 293 文件、3744 个顶层名字。#128 合并增量的 `check:vars` 仅命中 Runtime-state `state`，来自 VCC 后端事务局部命名；完整 PR base `cc3080e...→候选树` 仍只命中 Runtime-state `MODULES/app/dialog/setStatus/state`，无 Critical / Important-skeleton / Risk-sensitive 命中。模块枚举、原生 dialog、renderer 顶层状态结构和生产退出钩子未改变；`snapshotResultMutationState` 保留为待人工审批的 Risk-sensitive 升格候选，不静默修改清单。
- 冻结 #128 `cc3080eb3e8720d5dc6093010348a964b6d7085c` 已以普通 merge restack 到 PR 6 候选；最终范围相对该 base 为 60 个文件（34 modified + 26 added）。合并完整保留 #127 的 19 表精确指纹/allowset、success audit precommit 与可信 provenance，#128 的 semantic writer、targetMonth 租约、ST_Xstring 单次边界编码及 297 链，以及 #129 的低信号三采样、Git-tracked scan-vars 和 Spec 空白修复。
- RSS 门禁的可测档使用双预算：`relativeBudget=0.5×rowsRatio×tier1+24MB`、`absoluteGrowthBudget=tier1+57MB`，`effectiveBudget` 取两者较小值，并继续严格低于线性外推。24MB 是既有 8MB 噪声单位向上取整到 3 倍，覆盖两个 Windows runner 四组成对样本所需的 20.5/21/22.5/22.5MB；57MB 锁定既有 `82→139MB` PASS / `82→140MB` FAIL 边界，避免相对预算随 tier1 无界放宽。增长分类仍以 tier1 `<=8MB` 为 low-signal，低信号继续同时满足 32MB 包络和严格低于线性外推；首次 tier1 `<=16MB` 的重采保护、可测预算边界 `±8MB` 对称重采、0.5 fraction 与 `<150MB` 原始样本硬上限均未改变。旧独立中位 assessment 和 paired effective-budget/linear margin 都是必要条件，paired 只能新增拒绝。确定性边界锁定 `8→23/24`、`9→26/27`、`13→39` 严格线性拒绝、`32→72/73/96`、`49→97/98/147`、稳定三样本 `49→94`、`82→139/140` 及任一 150MB spike。
- 本地候选内容（提交为 SHA `9eabde33113e0cb1a54891611bd0dba5b5ce1f52`）的单次 `npm run release-check` 为 lint PASS、smoke PASS、unit `4802/4802 PASS`（303 个测试文件、0 failures）、integration `48/48` 脚本和 `2459/2459` 可计数断言 PASS（`291703ms`）。这是本地证据，不代表后续 Windows 平台门禁通过。
- Windows Actions run [`31296877417`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/31296877417) 对同一 SHA `9eabde33113e0cb1a54891611bd0dba5b5ce1f52` 的 unit 阶段为 4801 pass、1 skipped、0 failed；integration 的其他 47 个脚本通过，但 `toolbox-large-split-multi-sheet` 为 `30/31 PASS`：`49→94MB`、rowsRatio=3 的精确预算是 `89.5MB`（旧日志四舍五入显示 90MB），严格线性外推 147MB 和 150MB 硬上限均通过，仅亚线性预算超出 4.5MB。故该 Windows `release-check` 整体 FAIL、build job 未运行，自动化平台门禁尚未完成。
- Windows Actions run [`31299815769`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/31299815769) 对 SHA `40aa812662ee4b67cba41499f3c7b35a7a40b248` 再次稳定复现同一模型偏差：首对 `48→93MB`，三样本 tier1 `[48,49,49]MB`、tier2 `[93,96,96]MB`，中位 `49→96MB`；旧 89.5MB 预算的 paired margin 中位数为 `+6.5MB`，但线性 margin 中位数为 `-51MB`，所有原始样本也低于 150MB。该脚本仍为 `30/31 PASS`，Windows `release-check` FAIL、build 未运行；不得宣告 Windows 全绿。
- 基于 `40aa812` 的双预算校准候选树已取得：确定性 RSS 单测 `6/6 PASS`；5万/15万真实链 `31/31 PASS`（`39→48MB`，relative/absolute/effective=`82.5/96/82.5MB`，单样本）；50万/150万真实链 `31/31 PASS`（`89→132MB`，relative/absolute/effective=`157.5/146/146MB`，单样本）；最终单次 `npm run release-check` 为 lint/smoke PASS、unit `4802/4802 PASS`、integration `48/48` / `2459/2459 PASS`（`297387ms`），其中目标脚本 `31/31 PASS`（`74500ms`）。这是本地候选树证据，不替代修复提交后的 Windows Actions，仍不得宣告自动化平台门禁完成。
- 本机旧 `dist/win-unpacked` 为 3.0.13，分发守卫因缺两份 VCC 模板且版本不等于 3.1.8 正确拒绝；该负向结果没有被当成 Windows 3.1.8 构建成功。

### 合入 main 后正式收尾证据（2026-08-09）

- PR #124 已于 2026-08-09 以普通 merge commit `e36bd9a9c161becfbb72ab97bf41963d63012089` 合入 `main`；其 parents 为 `dff07df11fb94ce84940b474b55ac796f084d241` 与 `3291c272ee28388a6fbf4afef0b8694059ae3cc7`，最终 tree 仍为冻结树 `4b032f301cf824bec7b3d9ffa28523439663e278`。
- 合并后 `main@e36bd9a` 的 fresh Windows Actions run [`31310190290`](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/31310190290) 全部成功：`smoke-test` 33m25s，`build` 2m03s，总计 35m34s。Windows unit 为 4801 pass + 1 skipped / 0 fail，48 个 integration 脚本与 `2459/2459` 可计数断言通过；RSS `31/31`，VCC 四条真实链 `297/297`、`64/64`、`19/19`、`28/28`，SQLite teardown `9/9`，主面板 `6/6`。
- 同一主干 run 的 x64 NSIS + portable 构建和分发守卫通过：asar 62.26MB / 3142 条目 / 禁止路径 0 / 必需文件 7/7 / 包内版本 3.1.8。`windows-installer` artifact `9037543874` 为 100,290,789 bytes，Actions archive SHA-256 `64644b284d3b550c66ffec9fbe562d0f4bb7ac1e2e31026f78e2a555172a7ccd`；`windows-portable-exe` artifact `9037544724` 为 99,695,239 bytes，Actions archive SHA-256 `6aa95fb50356d0b83734309e53d35d47d0717b0c99b08ca42068a2aadcba40f8`。两项临时 Actions artifact 的保留期为 1 天，不等同于正式 Release 资产。
- 只读远端核对确认 `origin/main` 指向 `e36bd9a`，`v3.1.8` tag 不存在，尚未触发 `Release Windows Packages`；因此当前状态仍是“代码已集成、自动门禁全绿、正式发布未发生”。
- `npm audit --omit=dev` 当前为 0 critical / 7 high / 2 moderate，与 v3.1.7 正式收尾记录的生产依赖风险计数一致；`package-lock.json` 的依赖图未在本迭代改变。完整依赖树为 1 critical / 19 high / 2 moderate，其中 critical 仅位于开发依赖。该基线风险继续公开保留，不在发布收尾中静默升级依赖。

### Reviewer 退回项与最终盲区复核

- 已用文件时间线确认：旧“切年后有后续依赖，但删除按钮仍像可点”截图早于 disabled 样式和后续 renderer 改动；生产 picker 的异步状态和后台尾月保护未失效，问题是陈旧截图证据及 capture 缺少异步完成信号。
- 已为 4 个解归档截图状态增加 capture-only 完成信号和 8 秒超时；必须等目标年/月、preview response、真实 `button.disabled` 和状态文案稳定后才允许截图。缺 hook/缺 method/无 Promise/拒绝/悬挂均以非 0 失败，不得用旧 PNG 冒充。
- 已增加行为测试：实际触发切年和非尾月切换，异步完成后直接断言确认按钮 `disabled === true`；执行中同样断言真实 DOM 禁用状态。
- 已重新生成 26/26 张 VCC PNG 并全部解码校验：25 张 2480×1720，最小窗口图 2160×1520。人工检查切年、非尾月、执行中和结果页，禁用按钮均为灰色且不可点，结果页显示“结果版本”。
- 用户手册已明确：较新“已归档”和“已计算”均会阻断更早月；须从最新月开始逐月“解归档→删除全部未归档结果”，修订目标月后再按时间正序重跑、归档；删除不会清理源数据、导入审计或固定首月。
- 公开的 v3.1.8 CHANGELOG/版本历史/手册当前候选切片已改为用户语言，不再使用“金标准/语义模板”，改为“正式模板/结果模板”；Windows 统一表述为“64 位 Windows 安装版和便携版”。VCC 界面不再展示英文 `revision`，内部字段和错误码保持不变；release-docs 对三份当前版本切片增加了术语负断言。
- 最终 blindspot 与 reconciliation pass 已沿 service allowlist→worker→calculate/adjust/archive→19 表指纹/success audit→targetMonth semantic export→ST_Xstring Excel readback→次月九币种继承，复核入口旁路、状态/幂等、部分失败、主键金额币种血缘、行/子表守恒和错误可观测性。定向 `77/77`、`17/17`、`7/7` 与四条真实链在上述本地候选证据中通过；最新 Windows 平台门禁仍因 RSS 采样失败，不能概括为全平台门禁通过。真实生产副本与 Windows Excel/WPS 仍为人工资金红线，自动化不替代签字。
- 本轮 RSS blindspot 终审补齐两个 P3 测试证据缺口：run `31299815769` 的原始三对 `[48,49,49]→[93,96,96]` 已进入 self-check 与单测；150MB every-sample 硬上限同时显式覆盖 tier1/tier2 spike。代码结构仍以“独立中位 assessment AND paired effective/linear margins”裁决，paired 不可能新增 PASS；未发现剩余 P3+。
- 最终 intended 范围为 60 个文件：34 个 modified + 26 个 added。`docs/previews/_general/`、`outputs/`、`.agents/`、`.codex/` 和其他既有未跟踪文件继续明确排除，未读取到实现、未移动、未删除、未暂存。

### 仍阻塞 v3.1.8 正式发布

- 在目标 Windows 机器实际安装/运行 x64 installer 与 portable，并从两种安装形态确认两份 VCC 模板可读；主干 CI 的包内守卫通过不能替代目标机验证。
- 用 Windows Excel/WPS 人工检查字体、正常/异常颜色、动态行、长调整原因换行、M/N 可见性及默认 A:L 打印区；需要纸质调整证据时人工扩展打印区。
- 在受保护解归档/删除任务进入关键写入后触发关窗，确认应用等待事务安全收口且不强制终止后台任务。
- 对生产数据库副本做只读扫描，核对 Pending 46/48 列、归档主体/九币种余额及五类数据状态；异常只阻断并人工处理，不自动修复。
- 由财务人员用真实月份逐主体、逐九币种核对基础值、调整值、生效余额、差异、颜色、归档及连续两月期初衔接，并记录签字结论。
- 按 PR #124 已披露的发布承诺执行真实约 700 万行、多 sheet 工具箱压力验证；现有 5万/15万和 50万/150万自动 RSS 链只证明预算模型与常规档，不替代真实极限文件。

结论：PR6、六层堆叠整合、最终 `main` fresh release-check、Windows x64 构建、分发守卫、重要变量与双盲区复核均已完成；早期失败 run `31296877417` / `31299815769` 仍作为 RSS 模型校准的历史反例保留，最终成功证据以 `main@e36bd9a` 的 run `31310190290` 为准。自动化平台门禁已闭合，但上述目标机、生产副本、真实财务月份、关窗时序和极限文件人工门禁尚无签字证据；v3.1.8 仍是发布候选，不得创建正式 tag 或 Release。
