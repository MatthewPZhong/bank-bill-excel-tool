# Implementation Notes

## Baseline

- Goal/spec: `/Users/pzhong/Downloads/v3.1.8-codex-spec-final.md`，SHA-256 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；Q01～Q12 全部锁定。
- Initial plan: 按 Spec Phase 0～6 建立六个堆叠草稿 PR，分别覆盖输入契约、状态模型、破坏性事务、调整 UI、模板导出与发布收口。
- Done when: `changes/3.1.8/preflight.md` 的 Done when 与 Spec §15 同时满足；人工财务核对门禁保持开启。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用堆叠 PR，后续分支以直接前序分支为 base | 数据库和 UI 阶段存在真实依赖，同时需要每个 PR diff 可独立评审 | 一个大 PR；每个 PR 都从 main 重复带依赖 | 合并顺序必须固定，PR body 标明依赖 |
| PR 1 同时包含 Pending 资产、代码契约、历史 hash 迁移与运行门禁 | 单独只改表头会制造历史同键异内容冲突；只改门禁会让合法新模板仍无法导入 | 将资产/迁移/门禁拆散 | 这一 PR 是后续资金计算的输入可信基座 |
| 系统财务OP数据管理导出以 `balances_json` 为九币种财务余额唯一权威源，`raw_json.rows[].displayValues` 仅保留其余 15 列展示血缘 | PR #124 review 用真实精度反例证明显示值 `135886024.6` 会覆盖 canonical `135886024.59`；Spec §4.7.3 要求数据管理全链路保持原精度 | 继续从 `displayValues` 导出全行；在 writer 内重算余额 | 仅“财务余额”按 `normalizedCurrency` 覆盖为 canonical；九币种集合、金额或读取证据损坏时 `invalid-export-lineage` 失败关闭，不回退显示值 |
| 两份已在工作区且哈希匹配的模板视为用户提供的本迭代资产 | 哈希与 Spec §2.3/§2.4 精确一致 | 重新生成或肉眼复制模板 | 保留用户原始工作簿字节，测试不得改写 golden |
| 极老残缺审计表为空时允许补列；若已有 Pending 行却缺少 `raw_json` 等重算证据则失败关闭 | 无原始 46/48 列载荷无法证明新 hash，静默跳过会制造同键异内容 | 猜测列序或沿用旧 hash | 空旧库兼容升级；有事实但无血缘的旧库必须人工处理 |
| GitHub 认证问题不阻塞本地实现 | `gh` 已安装但 token 失效；代码和测试均可离线推进 | 等待登录后才开始编码 | push/PR 创建仍明确阻塞，不能声称已发布 |
| PR 2 将首月事实诊断拆到无迁移依赖的 `state-model.js` | 运行时 repository 不应反向依赖 migrations；迁移和运行门禁必须共享同一严格月份诊断 | repository 直接导入 migrations；复制两套判断 | 避免依赖环和迁移副作用，旧库诊断与运行门禁口径一致 |
| 多期初月份/畸形月份只记录幂等诊断并阻断 VCC 功能，不让 `AppDatabase.init()` 整体失败 | Spec 要求不自动删改资金事实；桌面应用仍需启动供诊断和其他模块使用 | 启动抛错；自动选择最早月份并覆盖 | 资金事实原样保留；preflight/calculate/initialize fail-closed |
| 首次人工期初写入和 `first_month` claim 放在同一 `BEGIN IMMEDIATE` 事务 | 首月是全局永久事实，不能出现余额已写但首月为空或反向状态 | 先写余额后单独更新状态；只靠 UI 串行 | claim 失败时余额与状态同时回滚；同月同内容重放幂等 |
| 首月期初提交完整性只检查 `subjects - opening.balances` 的真正缺失主体 | PR #125 review 证明 preflight/renderer 只向用户收集 `missingOpeningSubjects`；要求重复提交已初始化主体会阻断同月新增主体 | 每次提交全部主体；跳过完整性检查 | 已初始化主体无需重复提交；主动重放已初始化主体仍按 content hash 幂等跳过或拒绝改写，真正漏交的新主体仍整事务回滚；属于既定契约缺陷修复，不改 Spec |
| `rowKey` 固定为 `v1:sha256(JSON.stringify([row_kind, subject, source_type, category_major || '', category_minor || '']))` | 调整坐标必须跨币种稳定，又不能受 run/id/金额/展示顺序影响 | 使用数据库行 id；把币种或金额纳入 key | 同一逻辑行不同币种共享 rowKey，以 `rowKey × currency` 构成调整坐标 |
| PR 2 的 `getEffectiveRunResult()` 仅做只读统一重算，并严格核对 sequence/revision/基础公式/坐标 | 基础 `run_rows`、`run_balances` 必须不可变；损坏的调整账本不得静默参与归档 | 就地覆盖基础表；遇到损坏记录跳过 | 后续 PR 4 复用同一 reader 接入调整写入与归档；任何事实不一致均结构化失败 |
| 生效结果的基础行与不可变调整先用 `DecimalAccumulator` 无损聚合，仅在每个最终可见字段分别执行 15 位有效数字校验 | PR #125 review 证明 `999999999999999 + 1 - 1` 的合法抵消链会被中间值校验误拒；计算器既有契约也是“全量聚合后再校验最终值” | 每一步调用 `canonicalizeVccAmount`；改用 `Number`；对整个 DTO 只做一次总校验 | 合法抵消可通过，真实最终溢出继续 fail-closed；`base-period`、`adjustment-total`、行级和余额级字段各自独立封顶，不允许跨字段掩盖溢出 |
| 最终金额溢出统一返回 `result-amount-out-of-range`，稳定坐标放入 JSON-safe `error.context` | worker 的 `serializeError()` 只保留 `code/detailLines/context`；仅挂顶层 `scope/field/rowKey/value` 会在跨线程后丢失 | 只依赖错误 message；只保留任意顶层属性 | 调用方跨 worker 仍可读取 scope、field、rowKey/summary 坐标和原始十进制值；真实错误已做 `serializeError → deserializeError` 往返回归 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 未跟踪的其他 change、预览和输出文件不属于 v3.1.8 | 与 Spec 文件清单和目标模块无关 | 误提交用户资料 | 始终显式暂存；每次 commit 前检查 staged diff |
| 后续 PR 可暂时保持草稿和堆叠 base | 用户要求“按 Spec 里的多 PR 推进”且未要求每个立即合入 main | GitHub 展示/合并顺序需维护 | PR body 标明前序；前序合并后再重设 base |
| 旧结果行的 `category_major` 可能为空，不能在 PR 2 reader 中新增非空限制 | 当前 recharge/fee 取 `business_sub_type || ''`，channel 取 `mid || ''`，现有持久化契约允许空字符串 | 若生产事实始终非空则校验可更严格 | 继续将空值规范编码进 rowKey；未知/错配 `source_type` 仍严格拒绝 |
| 余额表存在“主体有九币种余额但本月无基础发生额行”是合法延续场景 | 上月归档主体本月无发生额仍必须进入结果与系统余额核对 | 若来源链路改变则可能掩盖孤儿余额 | 允许 balance-only 主体；反向要求每个基础行 subject+currency 必须存在 balance |
| 不可变调整账本的 `result_revision` 等于连续 sequence `1..N` 的记录数 | 每次新增调整只允许追加一次且 revision 加一；没有删除/编辑 API | PR 4 若引入不同 revision 语义会触发 reader 门禁 | PR 4 写入必须在单事务内追加 sequence=N+1 并 revision+1 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Spec 建议六个提交 | 六个堆叠 PR，每个 PR 内可含少量聚焦提交 | 用户明确要求多 PR 推进 | 评审与回滚粒度更细，功能口径不变 | 是（本实施记录） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD` | `dff07df11fb94ce84940b474b55ac796f084d241` | 基线无漂移 |
| 两份模板 `shasum -a 256` | 分别匹配 `f7967d...a9fc`、`f920fd...1f4` | 用户资产身份 |
| PR 1 定向单测 | `104/104 PASS` | Pending 46/48 列契约与迁移、五表预检、原始数值精度、审计/导出兼容、renderer 接线 |
| PR #124 review 导出精度定向回归 | `node --test tests/unit/main-process/vcc-financial-op-dataset-writer.test.js` 返回 `6/6 PASS` | 原表/校验表重新打开后 JPY 为 `135886024.59`；其余显示列及 CNY→CNH 展示血缘不变；`balances_json` 缺失/非对象/币种缺失或重复/金额非法/读取证据不一致均结构化失败关闭 |
| 极老审计表回归 | 空残缺表可幂等补审计列；存在 Pending 行但缺 `raw_json` 时事务回滚且历史 hash 不变 | 迁移兼容与失败关闭 |
| 真实样本 `/Users/pzhong/Downloads/财务OP (22).xlsx` | PPHK JPY 读取为 `135886024.59`；检测到显示值 `135886024.6` 与原始值不一致并保留审计证据 | 原始数值优先及大额两位小数不被显示格式截断 |
| PR 1 `npm run release-check` | lint 通过；smoke 通过；unit `4587/4587 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、核心业务回归、迁移/大文件/side DB 集成门禁 |
| `gh auth status` | 默认账号 token invalid | 仅 GitHub 发布被阻塞 |
| PR 2 定向单测 | `39/39 PASS`（calculator 22、state/migration 8、effective result 9） | 首月 claim 原子回滚、同月新增主体增量初始化与漏交回滚、迁移诊断启动隔离、非首月/早于首月门禁、多失败 code/message 同源、run fingerprint/revision/timestamp、rowKey 稳定、防伪/金额边界、跨币种调整及基础表不可变 |
| `AppDatabase.init()` 多期初旧库回归 | 二次启动成功；`first_month` 保持 `NULL`；幂等诊断仅 1 条 | 诊断不扩大为全应用不可启动，同时 VCC 运行层保持失败关闭 |
| effective result 篡改矩阵 | forged rowKey/metadata、未知来源/币种、0/三位小数/NaN/Infinity/16 位金额、sequence/revision、重复坐标、空基础事实、余额脱节和公式篡改均按专用 code 阻断 | 调整账本、金额/币种语义、行数与余额血缘 |
| PR 2 `npm run release-check` | lint 通过；smoke 通过；unit `4609/4609 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、资金模块回归、大文件/side DB/迁移集成门禁 |
| PR 2 `npm run check:vars` | 仅命中通用词 `state`；实际未改 `src/renderer.js` 顶层 UI state，判定为扫描误报 | 已复核 UI 模块/模板列表/导出状态均无改动；PR body 仍保留关联功能 review 说明 |
| PR 2 reconciliation blindspot pass | 主键血缘、九币种、月份边界、幂等、事务回滚、基础表不可变和行/余额坐标守恒均有代码与测试证据 | 未发现自动删改或静默补零；首月期初与生效金额仍需发布前人工财务复核 |
| PR #125 review 增量主体回归 | calculator `22/22 PASS`；首月既有 PPHK 后新增 NEW 时 preflight/calculate 仅返回 NEW，仅提交 NEW 成功，PPHK 的金额/hash/说明与 `first_month` 不变；新增 NEW+NEW2 仅提交 NEW 时 NEW 写入回滚 | 修复已初始化主体被误判 omitted，同时锁定真正缺失主体、九币种和事务完整性 |
| PR #125 review 链路与变量门禁 | service/renderer `21/21 PASS`；`npm run check:vars` 扫描本次唯一 src 改动，未命中重要变量 | renderer 仍只提交缺失主体；未改 IPC/用户流程，未触及既有重要变量清单 |
| PR #125 review 金额抵消与最终封顶定向回归 | result-adjustments、calculator、state migration、serialize-error 合计 `59/59 PASS`；其中 effective result `14/14 PASS` | 基础行和 adjustment 的“先越界后抵消”合法；基础汇总、调整汇总、行级 effectiveAmount、跨行 balance 的真实最终溢出均返回稳定 code/context，不返回部分 DTO，数据库/归档/调整账本不变；sequence、revision 与九币种契约保持 |
| PR #125 review 生效结果真实 SQLite 集成 | `scripts/integration/vcc-financial-op-effective-result.js` 返回 `19/19 PASS`，数据库关闭重开后读取 | 锁定合法抵消、精确字符串、归档只读和真实最终溢出；失败前后 run/row/balance/adjustment/archive 快照一致 |
| PR #125 review 静态与变量门禁 | 变更源文件 ESLint、3 个 JS 文件 `node --check`、`git diff --check` 全部通过；`npm run check:vars` 未命中任何重要变量 | 未引入语法/格式问题；本次金额聚合修复未触及 `rules/important-variables.md` 中的重要变量 |
| PR #125 review reconciliation blindspot pass | 已复核 rowKey×currency 血缘、币种隔离、精确十进制、逐可见字段封顶、只读生命周期、失败原子性与跨 worker 可观测性 | 未发现 P3+ 新缺口；金额规则属于资金红线，自动化证据不能替代发布前真实财务样本人工复核 |
| PR #125 review 全仓 `npm run release-check` | lint、smoke 通过；unit `4618/4618 PASS`；integration `45/45` 脚本、`2070/2070` 断言通过 | 新增集成脚本已被 runner 自动发现并同步 `rules/integration-test-policy.md`；全仓资金、迁移、大文件和 side DB 回归无失败 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 生产历史 Pending raw_json 是否有未知列数 | PROBE | Codex 在 PR 1 建 dry-run 迁移测试；运行时异常 fail-closed | 阻塞 PR 1 合并 |
| Windows 打包资产与 Excel/WPS 实际显示 | PROBE + 人工门禁 | PR 6 Windows CI 与财务人员 | 阻塞版本发布 |
| GitHub 登录恢复 | BLOCK（发布） | 用户执行 `gh auth login -h github.com`，Codex 复检 | 阻塞 push/PR，不阻塞实现 |
| 真实月份逐主体逐币种复核 | BLOCK（发布） | 财务人员按最终核对清单执行 | 阻塞 3.1.8 发布 |
| 生产存量 calculated run 是否存在空分类或被手工改写的非规范金额 | PROBE | PR 4 接线前用真实数据库只读扫描；reader 已 fail-closed | 可能要求旧 run 重新运行，不允许静默归档 |
| PR 4 调整写入事务能否始终保持 `sequence=N+1` 与 `result_revision=N+1` | PROBE | PR 4 用并发/故障注入单测锁定追加事务；PR 2 已锁定 reader 与跨 worker 错误 context 契约 | 阻塞人工调整入口和 effective 归档接线 |
