# Implementation Notes

## Baseline

- Goal/spec:
  - `changes/3.1.1/spec.md`
  - `changes/3.1.1/spec-position-side-db.md`
  - `changes/3.1.1/spec-fund-transfer-direction-date.md`
- Initial plan: 先完成并发布收尾 v3.1.1；之后才启动 v3.1.2。
- Done when: 两个子规范通过定向与完整发布检查，版本文档同步，资金与隔离旧库人工复核项明确完成或明确阻断发布。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 原 3.1.1 兼容修复与资金方向专项合并为 v3.1.1 | 用户于 2026-07-29 明确版本边界 | 资金方向专项顺延 3.1.3 或与工具箱专项同版 | 同版发布、分别验收 |
| 工具箱格式保真 Spec B 独立为 v3.1.2，严格等待 v3.1.1 发布收尾 | 用户要求两个版本分开实现 | 同工作树并行实现两版 | 本阶段不改工具箱生产代码 |
| 空旧侧库只接受可证明的旧十表空结构 | 当前实现会统一阻断；仅文件名、大小或 marker 不能证明安全 | 自动接管所有旧库 | 任一历史行、缺表、未知对象或检查异常继续阻断 |
| 方向必须属于 eligible candidate | 当前 R3.5/R5 候选会在真实方向校验前统计和消费 | 选中后再二次拒绝 | 错误方向不污染候选、消费和保护集合 |
| 日期继续双向 `±N`、全局同日优先、绝对差后按银行原序 | 既有 R5 契约与用户已确认示例 | 未经业务证据增加“未来侧优先” | 保持现有日期业务语义 |
| 日期策略仍存 canonical R5s2 内置场景，但读取不依赖 enabled | 避免新增第二套持久化和双存储一致性问题 | 新建独立设置表 | R5 停用时 R3.5 仍读取已保存值 |
| R4 复用共享方向校验器但保持既有审计口径 | R4 已有严格方向逻辑与 warning golden | 直接暴露共享内部 code | warning 数量、文本和 matchedPairs 不漂移 |
| canonical 管理页把日期策略和优先级放在同一横排，并把日期勾选项右移 4px | 用户于 2026-07-29 明确要求日期在左、优先级在右，且日期勾选框/文本与下一行首项对齐；实机截图测得两者左起点相差 4px | 保持日期独占一行；凭感觉使用较大通用间距 | 只改布局，不改配置或保存语义；其它 builtin-fixed 布局保持银行渠道在左 |
| canonical seed 的功能说明改为来源/日期均按配置 | 旧系统文案写死“网关 + ±1 日”，与 `reconSourceMid`、日期开关和 `±N` 不一致 | 保留误导性审计文案；覆盖所有存量自定义说明 | fresh/恢复 owner 使用准确说明；存量仅精确旧系统文案幂等更新，其它 config 和自定义文案不动 |
| 空旧侧库在取得写锁后重复完整证明 | 首轮 self-review 复现第二连接可在事务前预检后插入 `position_meta` 行 | 只依赖单实例锁；只在写入前检查部分表 | `BEGIN IMMEDIATE` 后、`SCHEMA` 前复检；失败回滚，关闭 TOCTOU 竞态 |
| M2M 调拨审计使用独立只读 context | 首轮 self-review 复现 R5 关闭、R3.5 开启时 R3.5 已改写但调拨 M2M 漏报 | 为审计重新启用 R5 输入；继续只看 R5 context | 审计复用实际已加载的 R3.5/R5 调拨副本，绝不接入 R5 写入 |
| 全新建库候选也执行锁内无用户 schema 证明 | 第二轮 self-review 复现 `exists=false` 后外部进程可在 Store 打开前创建用户库 | 只保护已有旧库；看到初次不存在就无条件写 schema | 外部抢先创建的表/数据原样保留并阻断，只有 Store 自建的空候选可初始化 |
| 日期失败告警按银行行/方向/原因去重 | 第二轮 self-review 用 25 来源×25 银行复现每个引擎 625 条近似重复告警 | 按来源×银行逐对输出；只截断报告 | 同原因收敛为 25 条，Phase1/Phase2 不重复；不同原因/方向/银行行仍保留，资金结果不变 |
| 正式 WAL 切换延后到受保护初始化提交后 | 最终 staged diff 复审发现拒绝外部抢占库前已执行持久 `journal_mode=WAL` | 只保证表/数据不变；接受拒绝时修改日志模式 | 拒绝接管对外部库零持久改动；正常新建/空旧升级提交后仍进入 WAL |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 支持的空旧侧库结构以 checkpoint 上线前的 v3.1.0 十表 schema 为准 | Git 历史 `e02e9b5^` 与异常描述一致 | 其它未登记旧结构仍会被阻断 | 保持 fail-closed；另立迁移规范 |
| canonical owner 正常情况下唯一 | seed 设计意图 | 重复 owner 会产生策略歧义 | resolver 多条直接阻断，不 first-wins |
| 真实问题样本位于用户提供的 `渠道账单_2026-07-27_303381.xlsx` | 已按订单号定位两条原始银行行，并只读查询实际调拨来源 | 若文件内容变化需重新复核 | 本轮结果已记录在 Evidence |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 资金方向专项 / 工具箱格式保真专项作为相邻版本推进 | 原 3.1.1 兼容修复 + 资金方向专项为 3.1.1；工具箱 Spec B 为 3.1.2 | 用户最终确认 | 版本严格串行 | 是 |
| 旧 M2M 集成夹具从场景 config 隐式读取日期容差 | 改为 canonical owner + 完整 directions，并显式注入共享 policy；非法 `N=0` 改成合法 `N=1` 对照 `N=3` | v3.1.1 已把策略解析移到主流程，写入引擎对显式缺失 directions 失败关闭 | 只更新测试契约，未放宽生产规则 | 是 |
| repository 统一用 camelCase 身份错误提示 | 对旧 `is_builtin` 入参保留既有 snake_case 错误文案，`isBuiltin` 继续独立拒绝 | smoke 锁定公开仓储错误契约 | 仅错误文案兼容，不改变身份保护 | 不涉及行为规范 |
| 空旧库最初仅在事务前完成全空证明 | 在写锁后增加同一完整 proof，并新增初始化 mode/code/reason 日志 | 首轮自审发现可复现并发写入竞态与取证缺口 | 收紧准入，不放宽任何旧库；日志不含路径或业务明细 | 是 |
| M2M 最初只读取 R5s2 调拨 context | 新增独立 audit context，缺省时兼容回退旧 context | 首轮自审发现 R5 disabled + R3.5 enabled 漏审计 | 只增加实际修改行的只读审计，不改变 R5 执行/消费 | 是 |
| 新建侧库最初依据调用前 `exists=false` 直接初始化 | 新建分支与空旧库分支统一先取写锁；新建分支锁内证明没有用户 schema | 第二轮自审发现路径检查与 Store 打开之间仍有 TOCTOU | 只收紧可接管候选；外部抢先创建时 fail-closed | 是 |
| 日期失败最初按每个来源—银行 near pair 生成 warning | 三个写入引擎改为每银行原始行/方向/原因一条 | 第二轮自审复现密集数据 N×M 审计放大 | 仅改变告警基数，不改变匹配、消费或改写 | 是 |
| 新建/空旧受保护分支最初在锁内 proof 前切换 WAL | WAL 只在 schema/checkpoint 初始化事务提交后切换 | 最终自审发现拒绝接管仍会持久改变外部库 journal mode | 拒绝路径外部表、数据和 journal mode 均保持；成功路径运行模式不变 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| v3.1.1 实施前定向基线 | position 45/45、资金 181/181、工具箱 165/165 通过 | 证明改动前基线稳定 |
| `PositionReconciliationStore` 现有初始化分支 | 已有文件缺现代 checkpoint/history 即在 schema 补齐前统一阻断 | 空旧侧库兼容尚未实现 |
| R3.5/R5 引擎只读检查 | R3.5 Step1/Stage B 与 R5s2 写入候选缺真实方向门禁 | 误改根因成立 |
| R4 引擎只读检查 | 已在完整候选前校验主侧非零、对侧零、金额/手续费/账号/币种 | 共享 validator 需兼容映射 |
| 平盘定向单测 | `50/50 PASS` | 旧十表成功/阻断矩阵、结构签名、重启和现代库回归 |
| 平盘 side DB parity | `38/38 PASS` | 跨库 checkpoint、generation、父链和旧空库原地升级 |
| 资金与策略关联定向测试 | `320/320 PASS`；builder `5/5`；网关渠道等价集成 `23/23` | R3.5/R4/R5 两来源、方向、日期、owner、快照和 warning |
| canonical owner 生命周期与兼容测试 | 生命周期 `58/58 PASS`；兼容矩阵 `107/107 PASS` | migration/repository/bundle/UI 旁路和旧配置兼容 |
| 管理页横排布局定向测试与预览 | `22/22 PASS`；重新生成并目检 `docs/previews/builtin-fixed-channel-manage-payment.png`：标题为“调拨回填功能管理”，顶部无银行渠道下拉框，日期在左、优先级在右且同一行，上下两行复选框和文本起点对齐 | 日期与优先级横排及左右顺序、视觉对齐；Payment/来源配置、浅合并和非 owner 行为不回归 |
| canonical function 窄迁移测试 | `6/6 PASS`；精确旧系统文案更新为当前 seed 说明，二次执行不改写；自定义文案和其它嵌套 config 保留 | 防止审计说明继续写死网关/±1 日，同时避免覆盖用户配置 |
| 空旧库竞态与初始化结果定向测试 | position `53/53 PASS`、side DB parity `38/38 PASS`；第二连接在预检后插入行被锁内复检拒绝，未补现代 schema；新建候选被抢占同样阻断；三种 mode 均锁定 | 关闭已有空旧库及不存在路径两类 TOCTOU，并提供非敏感初始化取证 |
| R3.5 独立 M2M 审计测试 | R3.5 编排器 `12/12 PASS`；R5 disabled、R3.5 enabled、N=7 的 2×2 两行均有调拨审计，R5 计数/改写为 0，源行不变 | 关闭 R5 停用时的调拨审计漏报，保持行数守恒 |
| 全新建库候选竞态定向测试 | 路径初检不存在后注入外部表/数据，Store 锁内拒绝；外部表、数据、journal mode 保持且无任何平盘 schema/checkpoint；正常新建/空旧升级提交后均为 WAL | 关闭不存在路径的接管 TOCTOU，并保证拒绝路径无持久副作用 |
| 三写入引擎密集日期告警测试 | 每个引擎 25×25 同原因由 625 收敛为 25；Phase1/Phase2 不重复；不同原因及缺失 `_rowId` 的不同银行行仍分别保留 | 控制错误报告规模并保持逐银行行审计，候选/消费/改写不变 |
| 两条真实问题样本只读复核 | `0016RF1210576`：Credit 1000 SGD；`20260721UOVBSGSGBRT8522830`：Credit 80000 SGD；实际调拨来源存在同账号/币种/金额的 `FundTransfer-out` | 当前 R3.5 回放两行均保持 `Inbound`，ReconciliationId 不变、modifications 为空，并产生 expected DEBIT 的方向失败告警 |
| 真实旧侧库隔离副本复核 | 正式库只读；副本 `quick_check=ok`，受支持旧十表全为 0 行；升级保持同 inode，补齐现代表/列，checkpoint history=1、operation inputs=0、九张业务表=0，关闭重开成功 | 证明窄兼容分支可用且未生成业务数据 |
| `npm run scan:vars` | v3.1.1：221 个 JS 文件、2604 个顶层名字；A-share 382 / A-pair 643 / A-local 1435 / B 1025 | 已刷新两份自动统计报告 |
| `npm run check:vars -- --include-minor` | 命中 Critical 1、Runtime-state 2、Risk-sensitive 3；同名误报与真实迁移/资金项已逐项复核，按要求执行 smoke | 关联功能 review 见最终交付摘要 |
| `npm run release-check` | lint PASS；smoke PASS；unit `4101/4101 PASS`（`logs/unit-tests/unit-20260729-125617.log`）；44 个 integration 脚本 `2016/2016 PASS` | 包含两类侧库竞态及拒绝路径 journal mode 不变、独立 M2M 审计、密集日期告警去重、初始化日志、canonical 文案和最新横排预览后的完整发布自动门禁 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| v3.1.2 `.xls` 样式读取/写出能力 | BLOCK（仅下一版本） | 启动 v3.1.2 后先做独立 capability probe | 不影响 v3.1.1；禁止提前实现 |
| PR、合并、tag、GitHub Release | 不在本 spec | 需用户另行授权后执行 | 不影响本地实现验收，不得宣称已外部发布 |
| Windows Excel/WPS 人工打开 | 本版本不适用 | v3.1.1 未改 writer/输出格式；v3.1.2 格式专项另设门禁 | 不阻塞 v3.1.1 |
