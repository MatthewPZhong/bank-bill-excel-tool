# Implementation Notes

## Baseline

- Goal/spec:
  - 原始合并 Spec：`changes/r35-r5-fund-transfer-direction-guard/spec.md`（现为拆分索引）
  - 资金 Spec：`changes/3.1.x-1-fund-transfer-direction-date-guard/spec.md`
  - 工具箱 Spec：`changes/3.1.x-2-toolbox-format-fidelity/spec.md`
- Initial plan: 同一迭代同时修改 R3.5/R4/R5、调拨配置页和工具箱格式引擎。
- Done when: 两个独立范围分别满足各自验收；资金改动完成人工复核；工具箱完成 XLS 能力门禁和全路径格式验收。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 原 Spec 拆成 Spec A / Spec B、独立 PR | 资金引擎与 Excel 底层没有共同发布原子；同时改动会放大回归面 | 单 PR 一次实现 | 可分别回滚、测试和 review |
| 方向必须属于 `eligibleCandidates` | R3.5/R5 当前在候选统计和消费前没有真实方向门控 | chosen 后二次 reject | 错误方向行不污染多候选、消费集、保护集和改写 |
| 新增共享 `validateBankDirection` | R4 已有严格方向语义；散落实现容易漂移 | 每个引擎手写 Debit/Credit | 六类固定规则共享同一解析和失败代码 |
| 方向是代码级安全常量 | R4 已按 subCategory 固定规则；安全闸门不能被配置关闭 | `directionRequired:false` | 未知配置 fail-closed |
| R5 `directions[]` 只接受两个唯一同名 in/out 配对 | 各 direction 当前拥有独立消费集，重复或已知值错配可让同一银行行重复参与 | 逐项“能识别就执行” | 建池前整体验证，异常零消费并只告警一次 |
| 日期继续双向 `±N`、绝对差+原序 | 当前 R5、用户手册和历史 PR 都锁定该语义；相邻 Payment 调拨还存在合法负日期差 | 未经样本直接改成未来侧优先 | 避免引入未证实资金口径 |
| 日期配置保留在 canonical R5 场景，运行时 resolver 与 enabled 解耦 | 最小兼容路径；独立 app_settings 会引入迁移、IPC、双存储原子性、bundle 和降级问题 | 本次迁独立持久化 | R5 disabled 时 R3.5 仍读已保存策略 |
| R5s2 执行身份与 policy owner 绑定为同一个 canonical id | 当前分桶只看 `category/config`，配置包可创建 `isBuiltin=false` 伪内置场景 | 读取 canonical policy、执行任意同签名场景 | 保留签名冲突 fail-closed，且不能漏入 R2 |
| 旧伪内置冲突提供 UI“删除冲突”修复动作 | 当前 `builtin-fixed` UI 会把非内置克隆锁进不可删除、不可改签名的页面 | 只报错但让用户永久无法运行 | 冲突 id/name 可定位，删除后恢复 |
| public create 不接受 `isBuiltin=true` | repository 当前信任 payload，可由直接 IPC 造第二 owner | 只在 resolver 末端发现重复 | canonical 创建权限只留给 migration/seed 内部路径 |
| policy 纳入 run/export 快照 | disabled owner 的 config 仍影响 R3.5；现快照只含 enabled 场景 | 只依赖 setter 清缓存 | 防直接改库或旁路造成旧结果导出 |
| policy 在 `main.js` 解析并把告警并入 `processingResult.errorReport` | 场景查询、run/export 快照和最终错误报告都由 main handler 持有 | orchestrator 自行查库或只写日志 | 同一 resolver 同时约束运行、导出和审计输出 |
| canonical owner 从本版本起保护删除/转移/身份改写并可幂等恢复 | owner 承担 R3.5 即使 R5 disabled 仍需读取的全局 policy，现有删除终态会让管理页永久消失 | 长期依赖 owner=0 fallback | 缺失时恢复为 disabled+默认值；冲突/重复 fail-closed |
| 多对多检测器保持方向宽口径 | 当前模块被明确设计为 R5 后置只读宽审计，不是写入候选 | 与写入引擎一起收窄方向 | 只同步日期策略，不改变既有审计覆盖 |
| 工具箱合并跳过隐藏 Sheet，拆分保持隐藏 Sheet 参与 | 当前两条入口语义不同；统一套“可见”会静默改变拆分输出行数 | 合并/拆分统一只读可见 Sheet | 锁住既有行为 |
| 主题色先解析为 ARGB | 多工作簿 theme index 含义不同 | 原样复制 theme index | 防跨文件颜色串线 |
| 日期内部使用 serial+dateSystem | 本地 `Date` 会受时区影响；流式 writer 对 date1904 支持不可靠 | JS Date 中转、输出沿源 date1904 | 输出统一 1900，1904 serial +1462 |
| 样式预算以预计最终组件数为唯一口径 | writer 会额外生成 default/base XF；只限 cellXfs 也挡不住 component 膨胀 | 仅统计来源有效样式或写后才发现 | cellXfs/font/fill/border/custom numFmt 均含 writer 项并在 prepare 阶段失败 |
| R4 共享 validator 通过兼容适配器映射旧告警 | 当前 R4 仅把另一侧非零/非法单列为 direction warning | 所有 validator failure 都新增 direction warning | 保持现有 warning code、数量和失败原因 |
| 工具箱承诺枚举范围内的静态基础样式，不宣称完整视觉等价 | 条件格式、rich text、渐变等已排除但仍影响最终显示 | 保留“完整视觉”口号 | 验收范围与数据模型一致 |
| Worker 内部使用 registry/ref，IPC 不传逐行数据 | 当前 worker 自己完成 reader→filter→writer | 把 ToolboxCell 深对象逐行 postMessage | 保持 30 万行路径的内存与背压边界 |
| style ref 使用 `{sourceRegistryId,styleRef}`，输出另建 registry | 多工作簿各自从小整数编号，裸 ref 必然碰撞 | 跨文件直接复用 source ref | writer 解引用后按最终签名进入每个 output registry |
| 拆分使用 matchValue/outputValue 双轨 | 现有 UI 去重与过滤依赖 `normalizeCell`，原生输出值不能替代该口径 | 单一 raw/value 字段承担所有语义 | read/export 两遍仍能稳定命中 |
| 发布语义定义为整批可回滚，不宣称多路径文件系统原子 | 多文件只能顺序 rename + rollback，恢复失败必须保留旧文件 backup | 承诺真正一次性多文件提交 | journal 负责崩溃恢复，单/多输出共用 helper |
| 固定 `{userData}` index 索引外部 publish journal | 输出目录由用户任意选择，启动时无法遍历发现残留 journal | 只把 journal 放输出目录 | 启动/下次任务可定位并恢复任意历史输出目录 |
| CSV 不纳入 30 万行流式承诺 | 当前 CSV 会整文件、整表加载；流式 CSV 是独立解析器项目 | 本 PR 顺带实现跨 chunk CSV parser | 格式 PR 聚焦 XLSX；CSV 兼容现状并明确限制 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| canonical R5 内置场景正常情况下唯一 | seed 和 is_builtin 约束设计意图 | 重复 owner 可能产生不同日期策略 | resolver 对多条直接阻断，不做 first-wins |
| 非内置场景不应复用 R5s2 保留签名 | 普通 bundle 创建时 `isBuiltin=false`，但当前分桶未检查该字段 | 伪场景可能执行不同配置却读取 canonical 日期策略 | create/update/import 拒绝；旧库冲突阻断运行 |
| 日期策略是本机设置，不要求普通场景包覆盖 | 当前导入遇同名场景会 conflict 跳过 | 跨机器导入后日期值不同 | Spec A 明示；若需同步另立 bundle 契约 |
| `.xls` 依赖可能暴露足够 BIFF 静态样式 | 尚未运行 fixture probe | 无法达到 Spec B 枚举范围 | Spec B 第一步 probe；失败即停止并请用户决定降级方案 |
| 改造前 `raw:false` 匹配投影可由 fixture 固定重现 | 现有表头、UI 去重与筛选都依赖该投影 | 失败会改变拆分选项或命中行 | 开发前生成 golden；若无法一致则作为行为变更另行确认 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 一份 Spec、一个实现范围 | 拆成资金 Spec A 与工具箱 Spec B | review 证明范围跨两套系统 | 两次独立开发/合并 | 是 |
| 日期等绝对差按原序，但 review 建议未来侧优先 | 保持现有原序，不增加正负偏好 | 缺少业务依据，且存在合法负日期差反例 | 行为与当前 R5 兼容 | 是 |
| 可考虑独立全局持久化 | 本轮只做独立运行时 policy resolver | 降低迁移、bundle 和原子保存风险 | 存储 owner 仍是 canonical 场景 | 是 |
| 原计划让 bundle 写入旁路归一 canonical 渠道 | bundle 不会更新 canonical owner，实际只会创建非内置克隆 | 避免写一个不可达的伪保护 | 保留签名克隆改为拒绝；直接 id 写入仍归一 | 是 |
| 沿用内置场景“删除终态” | canonical policy owner 改为受保护且缺失时恢复 disabled | 否则 R3.5 的全局日期策略无可配置入口 | 这是本专项唯一的内置场景生命周期特例 | 是 |
| owner=0 只按日期字段拼最小 config | 深拷贝当前完整 canonical seed，再以 disabled 恢复 | 残缺 owner 启用后会丢 directions/reconSource/Payment 默认 | 恢复行与 seed 做深相等契约测试 | 是 |
| 工具箱所有路径统一“可见非空 Sheet” | 仅合并跳隐藏；拆分保持旧语义 | 当前拆分会消费隐藏续页 | 防止静默丢行 | 是 |
| XLS/XLSX 直接承诺同级枚举样式 | XLS 先设能力门禁 | 当前依赖能力未经 fixture 证明 | XLS 实现可能产生后续用户决策 | 是 |
| 多输出宣称整次原子发布 | 改为 prepare 不触目标 + publish 可回滚 + journal 恢复 | 文件系统不支持多个任意路径原子 rename | 崩溃窗口可能短暂见部分 target，但不会报告成功且下次恢复 | 是 |
| 所有路径用一个 `raw:false` golden | 普通 XLSX、Worker 与 fallback 当前投影并不完全同源 | 让实现者自行决定 | 普通 XLSX 为权威，Worker 有意收敛；CSV/XLS 各守 fallback | 是 |
| 每个 Cell 携带深 `effectiveStyle` | Cell 只带 pass-local `effectiveStyleRef` | 避免逐行对象复制与 Worker IPC 膨胀 | StyleRegistry 成为单一去重/预算入口 | 是 |
| CSV 与 XLSX 共用 30 万行承诺 | 仅 XLSX 保证；CSV 保持既有全量路径 | 新增 streaming CSV 会扩大协议和测试范围 | 大 CSV 风险显式记录 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `dbs-charge-fund-check.js` Step1 / Stage B | 候选无真实方向和日期；Stage B 无方向守卫 | Inbound 误改主因 |
| `r4-fund-nature-check.js::evaluateR4Candidate` | R4 已在进入 matched 前校验方向和完整字段 | 共享 validator 的黄金基线 |
| R5 两个 backfill 引擎 | bankPool 只信 FundType；真实方向未校验 | R5 候选污染与错误消费 |
| `engine-date-utils.js` 与 R5 日期两阶段 | `dayDiffWithin` 使用绝对差，Phase2 稳定排序 | 双向 `±N` 现状 |
| Payment 线下调拨规则 | 存在银行日期早于交易时间的合法容差路径 | 反证“未来侧优先”不是通用事实 |
| `reconciliation-orchestrator.js` | 当前只详情化 enabled 场景，快照也只含 enabled config | disabled owner policy 需独立解析和快照 |
| `main.js` bank-statement run/export handlers | 全场景读取、快照、`processingResult.errorReport` 和导出拒绝均在 main 层 | policy 必须在 main 解析并传入 orchestrator |
| 内置 seed marker / delete / batchDelete / transfer | 当前 owner 可永久删除或搬离，bundle 不能恢复 `isBuiltin=true` | canonical policy owner 需 repository 级保护与幂等恢复 |
| `bucketScenarios` 与 `createScenario` | 前者不检查 `isBuiltin`；后者会把普通/bundle 场景写成 `is_builtin=0` | policy owner 与实际 R5 执行场景可能错位 |
| R5 两条 source pool | 来源 ReconID 非空才进池；银行目标 ReconID 可空/覆盖；同值命中仍消费 | 必须区分来源 ID 与银行目标 ID |
| R4 warning adapter | 主侧空/非法/零只进总 mismatch，只有另一侧非法/非零另发 direction mismatch | 共享 validator 不得改变报告口径 |
| R5/position-reconciliation 分桶与常量 | Others/Revenue Clear/Treasury 属另一模块 | 防 R5 范围误扩 |
| 工具箱 reader/writer | 行载荷仅 string[]；writer 按英文列名重新套格式 | Spec B 必须升级读写契约 |
| 工具箱合并/拆分多 Sheet reader | 合并跳隐藏，拆分保留隐藏续页 | Sheet 可见规则不能统一套用 |
| `toolbox-multi-split.js` / 单输出 handler | 多文件是顺序 rename+rollback；单输出仍有 direct copy | 只能承诺可回滚发布，且需统一 publish helper |
| 大文件 Worker dispatch/entry | parent 只传控制参数，reader/filter/writer 均在 worker 内 | 不应逐行跨 IPC 传 Cell/style |
| `toolbox.js` 与 split 两阶段 IPC | `normalizeCell` 同时定义表头、UI 值和过滤命中；read/export 会重新扫描 | 需要 matchValue/outputValue 双轨和 golden |
| SheetJS CSV reader与大文件路由 | CSV 整文件/整表加载且不进大文件 worker | 30 万行流式承诺必须限定 XLSX |
| Microsoft Excel specifications and limits | 唯一单元格格式/样式上限 65,490 | 50,000 仅为应用安全预算 |
| 2026-07-29 最终三路只读闸门 | 方向/日期、R5 配置/owner、工具箱 4 个既定阻塞项均返回 PASS | 两份 Spec 的已知执行阻塞已闭环 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实调拨样本是否支持未来侧日期偏好 | PROBE | 业务后续若要改变，先统计正负日期差并逐笔复核 | 不阻塞 Spec A；本次保持现状 |
| `.xls` 能否读出完整有效样式和行列元数据 | BLOCK（仅 Spec B 的 XLS 部分） | Spec B 第一步建立 fixture probe | 未证明前不得宣布 Spec B 完成 |
| Windows Excel / WPS 对混合主题、50k 样式和 serial 60 的实际表现 | PROBE | Spec B 人工打开验收 | 阻塞 Spec B 合并 |
| 真实问题样本修复结果 | BLOCK（Spec A merge） | 业务逐笔人工复核 | 阻塞资金 PR 合并 |
