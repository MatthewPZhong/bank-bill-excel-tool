# E09-P0 Statement Probes Implementation Notes

## Baseline

- Goal/spec：v3.2.3 Spec §3～§13；TechDoc §1～§12；E09-P0 Statement state footprint/token/current-state golden。
- Exact base：`7577d5ae2f627619ba3f22597505c587be9867b6`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：DTO/resource contract、state/token footprint、固定规模 probe 与 legacy business golden 均有可复现证据；live/production 保持 legacy/false；定向测试、静态检查和自审通过。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| P0 只提供冻结 contract/probe library，不注册 Service/entry/runtime | PR 序列明确 E09-A 才实现 Service import/session，E09-B 才实现 token store/waiting-user | 在 P0 顺手创建 Worker/Service；把本地 Map 当正式 token store | legacy live 行为零变化；后续必须复用本合同 |
| canonical policy 的资源/token 数值只读镜像为冻结常量并做 fixture parity | Platform Contract 与 policy fixture 已是机器权威 | 根据小样本自行缩小/放大预算；允许 Renderer 配置 | probe 只报告样本占用，不解除真实样本/Windows/人工 gate |
| public DTO 与 private context 使用独立 validator/constructor | Main/Renderer 禁止持有 rows/prepared batch；pending token 必须 opaque | 返回 contextId 后让 Renderer回传 rows；把 private object 展开成 status | 可以在 E09-B resource adopt-ack 后安全公开 bounded DTO |
| pending private context 与 persistent state 独立估算、独立对 256 MiB ceiling 判定 | canonical policy 明确两类资源，不能以共享总额掩盖任一超限 | 把两类 graph 合成一个预算；用 JSON byte length 代替 retained graph | E09-A/B 申请 reservation 时可分别 fail closed |
| estimator 固定 50% headroom 并按 4 KiB 向上取整 | 50k probe 的 state+token reservation 44,277,760 B，高于同次 retained heap delta 15,958,864 B；数组 metadata/shared/cycle 已覆盖 | 把单次 RSS 当精确资源值；只算 enumerable JSON | P0 提供可复现保守输入，但仍不宣称真实峰值上界 |
| public interaction 上限采用 Platform command/event 256 KiB，status 独立保持 1 MiB | public prompt 经命令/事件边界；canonical policy 已冻结 statusMaxBytes | 让 prompt 共用 1 MiB status ceiling | E09-B 不得以 status ceiling 放宽 Renderer payload |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| deterministic object-graph estimator + headroom 足以作为 P0 reservation contract | E06 使用相同原则；Statement graph 主要是 plain arrays/objects/Map | 与真实 V8 RSS 比例偏低可能低估 | child-process baseline 校准；偏低则提高 headroom/显式类型成本，不放宽预算 |
| 现有 production core 可在 Node tests 中直接执行足够多的资金 golden | file-service/session/balance modules不依赖 Electron；main-local orchestration可用静态 seam补充 | 某些 handler-only ordering 无法动态驱动 | 只把动态 core结果称为 executable golden；handler-only部分明确标 seam，不伪称端到端 |
| `expiresAt` 使用正安全整数的 epoch milliseconds | canonical TTL 为毫秒且现有平台时间点均以 epoch ms 表示；TechDoc 未另给字符串格式 | E09-B 若定义不同 wire format 会破坏 exact-eight handle | E09-B 必须沿用本 DTO；若权威合同修订，先反向同步 Spec/TechDoc再改 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 暂无 | 暂无 | — | — | 不需要 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / canonical policy probe | HEAD `7577d5ae...`；Statement 五 action production=false；state/token budget 256 MiB；1 token；TTL 900000 ms | 防基线、资源、production gate 漂移 |
| E09-P0 focused tests | 12/12 PASS | 五 action parity、DTO正反/隐私/byte ceiling、footprint、四金额模式、current/all、writer、balance与manual seed |
| impacted unit regressions | 193/193 PASS（31 suites） | seed/file-service、policy/interactive preflight、big-account preview 与新增合同/golden/probe |
| 50k/4批次/1 token standalone probe | retained heap delta 15,958,864 B；RSS delta 37,421,056 B；state raw/estimated 23,607,838/35,414,016 B；pending raw/estimated 5,907,254/8,863,744 B；public DTO 334 B；两类各自低于 268,435,456 B | 固定 generated production-shape graph 的 retained-state量级与 estimator headroom；不代表 parser peak/真实业务/Windows批准 |
| affected ESLint + `node --check` | PASS | 两个production模块 lint；全部新增JS语法检查 |
| static live-path gate | PASS：`src/main.js` 与 background runtime无 `statement-worker` 引用；canonical 五 action仍 production=false | P0未切Main/IPC/Worker/live路径 |

隔离 worktree 没有独立 `node_modules`，直接运行依赖 `xlsx` 的用例会报 `MODULE_NOT_FOUND`。上述所有测试与 probe 均通过只读 `NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules` 使用主仓库已安装依赖执行；这是环境依赖，不是业务断言失败。

## Blindspot Self-review

| 盲区 | 结论 | 证据/处置 |
| --- | --- | --- |
| 入口旁路 | 新模块只被probe/tests引用，未注册Main、IPC、ServiceHost、Worker entry或background index | 静态测试与`rg`；五action production=false/effectiveMode=legacy |
| DTO/private泄露 | token handle exact-eight且拒绝extra/getter/Proxy；public DTO剥离`reservationId/sessionKey`并递归拒绝rows/prepared batch/path/grant/private context；status不含token/reservation | DTO正反测试、getter零读取与256 KiB超限测试 |
| 资源双算/漏算 | persistent与pending独立计费；shared/cycle只计一次；数组enumerable/non-enumerable metadata、Map/Set/Buffer/typed-array均计入；unsupported prototype/accessor/Proxy/function/symbol/weak collection fail closed | footprint unit + 25k child probe + 50k standalone probe |
| 状态生命周期 | P0没有token store、grant/adopt、TTL/replay/stale/crash逻辑，因此不会用本地对象假装resource handshake完成 | E09-B继续保持BLOCK；本PR只冻结DTO/estimator |
| 失败模式 | estimator超预算抛稳定错误且不返回reservation大小；public/status超byte ceiling fail closed | budget/size反例；live未接线所以无半采用状态 |
| legacy等价 | 四金额模式、zero skip/both nonzero检测、writer、current/all/remove、balance计算/多币种writer、manual seed exact bytes均调用真实production core | executable golden；main-local双非零gate用源顺序断言补足，不伪称Main端到端 |
| 可观测性 | probe单行JSON同时记录inputs、heap/RSS、raw/estimated/budget、public DTO bytes、productionEnabled与明确caveat | 50k standalone输出可归档比较 |

未发现需要扩大E09-P0范围的自动Critical缺口。真实parser峰值、Windows packaged长驻、Service adoption、token lifecycle、all-or-none Publisher与seed crash settlement均仍是后续明确门禁。

## Reconciliation Blindspot Self-review

- 主键/状态血缘：golden按真实session key、batch id、entry id冻结current/all成员和稳定顺序；删除当前entry后只回退到上一有效batch。P0未改legacy globals、session mutation或artifact cache。
- 金额/方向/行数：direct、signed、field-conditional、bill split/merge均执行真实`buildMappedRows`；零金额进入`skippedRows`，Credit/Debit双非零进入`simultaneousRows`，并确认Main gate先于writer。没有复制金额算法或改变行去向。
- 币种/余额：多币种balance writer回读保持USD/EUR记录顺序和值；余额计算与manual seed复合键/previous选择/exact file bytes均锁定。未新增币种归一、seed overwrite或fallback。
- 幂等/部分失败：manual seed现状仍为legacy直接写；P0不实现atomic replace、intent/outcome inspector或unknown-state自动续跑，因此不声称已关闭crash window。
- ⚠️ 关联功能 review：现有清单无直接生产变量命中，因为本PR未修改`statementImportSessions`、`lastFileImportContext`、`lastGeneratedExports`、四金额模式标识或`BALANCE_CALCULATED_OPTION`。新`STATEMENT_RESOURCE_CONTRACT`当前production跨度2文件/9次，未过升格数据门槛；语义上属于后续跨进程Critical候选，E09-A接线时必须重新评估。
- 🔴 人工门禁：金额、借贷方向、币种、余额seed、current/all成员与输出仍需资金负责人用脱敏真实样本逐笔复核；自动golden与generated footprint probe不解除production enablement红线。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实业务大文件/parser峰值与Windows packaged长驻RSS | BLOCK（后续） | Release owner用批准脱敏样本与Windows构建验证 | 不阻断P0合同；阻断Statement production enable |
| E09-A Service adoption 与旧 session mutation 等价 | PROBE | E09-A 复用本合同与 golden | 不阻断 P0；阻断 Statement import production |
| E09-B token lifecycle/waiting-user | PROBE | E09-B | 不阻断 P0；阻断所有 interaction production |
| E09-C current/all workbook all-or-none | PROBE | E09-C | 不阻断 P0；阻断 generation production |
| E09-D seed atomic settlement/inspector/Windows | BLOCK（后续） | E09-D + release owner | manual seed 必须保持 legacy/production false |
| 金额/币种/seed/current-all 人工资金复核 | REVIEW | Reviewer / release owner | 自动测试不可解除；阻断 production enable |
