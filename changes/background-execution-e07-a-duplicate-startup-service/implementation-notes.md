# E07-A Duplicate Startup / Single Service Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec §3-§13；TechDoc §1-§6、§10-§12；E07-A Duplicate startup coordinator + single Service。
- Exact base：`ce099b5446b6d18fa41ccf660bd6d55d32f595d4`（E06-A 最终复审冻结 head）。
- Contract SHA-256：Spec `0cdf28e5310733355fb51d92818dde8fd837ee06b521a4694c0c9cc43300d47f`；TechDoc `9fd15a46b482e6801616554978dff67a02676b437b9759e18d15fce29dcff209`；policy fixture `8ab98e4b7a7b0c669892f069881c25eaaf1f8241b1e7d71e5b63eed8b2c38a22`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：startup evidence gate、constructor纯化、active Hold legacy gate、canonical production-false single Service capability与定向证据完成；不接E07-B/C。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 复用通用 StartupRecoveryCoordinator 的 `module-recovery` source | Platform Contract已冻结registry/provider/observation/Hold原子合同 | 新建Duplicate专用恢复表或状态机 | E07-A只提供source/inspector/provider adapter，不造协议方言 |
| constructor只负责依赖与内存状态初始化 | 当前constructor清mirror/side DB会先销毁恢复证据 | constructor内先清理再补inspect | 所有startup mutation只能在持久inspection之后显式发生 |
| E07-A对任何持久residue返回unknown | main mirror尚无共同operation identity，无法唯一判定 | 用month/status/sideRunId猜 committed；沿用隐式expiration | residue进入Hold，E07-B前不自动清理或重跑 |
| module-recovery使用固定source identity，snapshot只进入inspection evidence | active Hold要求下次启动可重新枚举同一source；把变化digest放进source会令Hold失去来源 | 每次按side/mirror digest生成新sourceRef | clean/residue都枚举同一canonical source，证据变化仍可审计 |
| side inspector使用immutable SQLite URI并扫描完整main/WAL/SHM family | 本地探针证明普通`readOnly:true`仍会在WAL库旁创建sidecar，破坏待恢复证据 | 调用现有store opener；只看主文件；读取全表COUNT | Inspector不require Service、不执行DDL/cleanup；查询仅限schema/`EXISTS`，孤立WAL/SHM也会Hold |
| Duplicate三action共用一个Service Worker | frozen `service.duplicate`与single mutable owner合同 | 每action一个Worker；Main/Worker双state | 一次最多一个command，busy reject；完整managed state只在Worker |
| import topology固定1 | paired parser属于E07-C且尚无15%/RSS证据 | 预先spawn双parser；改fixture为thread-single | 保留canonical thread-pool声明与未来扩展点，但本PR无并行 |
| managed result/status只发布exact bounded DTO，artifact hash流式计算 | Main不应持有完整rows/result，导出文件可能很大 | 返回legacy run summary；一次性读完整artifact做hash | import/run只返回count/capability/revision，export只返回单artifact manifest，不复制业务state |
| live IPC不切换 | production=false且E07-B恢复闭环未完成 | 合并即让legacy handler走runtime | 用户路径/资金算法零漂移；capability只做显式本地验证 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| clean snapshot可作为not-committed startup source | 无side/mirror/receipt即无持久mutation事实 | constructor被不必要阻断 | clean/start twice test；失败则只保留fail-closed gate |
| 当前 command-time invalidation语义仍正确 | 既有service tests与Spec §6.2 | 新import/newrun可能暴露旧结果 | 原测试全量保留；仅删除constructor调用 |
| runtime capability不被live handler调用 | production flag与Main wiring均保持legacy | Main/Worker可能产生双owner | wiring/source scan test；发现route即回退runtime接线 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 既有E2E把constructor隐式清理当成重启语义 | 改为断言constructor保留side/main证据，并在显式`invalidateForNewImport()`后验证原清理合同 | 冻结E07-A要求inspector先取证，旧断言与新合同冲突 | 只更新过时验收；命令期失效语义继续覆盖 | 不需要；与冻结Spec一致 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / contract hashes | HEAD与三份权威合同hash已核对 | 防基线/合同漂移 |
| E07-A定向unit：`node --test tests/unit/main-process/duplicate-inbound-match/*.test.js tests/unit/duplicate-inbound-match-wiring.test.js` | 84/84 PASS | constructor纯、严格startup顺序、unknown/failure Hold、legacy gate、policy parity、topology=1、single Service、busy/adoption/revision、real Worker crash/cold start、bounded result |
| Platform Contract回归：policy registry/protocol validator/ServiceHost/Supervisor | 160/160 PASS | canonical policy、generation/control envelope、PersistentReservation replace/adopt/release、close/crash资源收口 |
| Duplicate E2E：`node scripts/integration/duplicate-inbound-match-end-to-end.js` | 31/31 PASS | 真实import/run/export、constructor保留证据、显式import失效仍清side并supersede mirror、BizId/MPT/document与行数守恒 |
| Duplicate store/repository unit | 8/8 PASS | side store持久状态与main mirror repository既有合同未回归 |
| runtime registry旧清单回归 | 10/10 PASS | 通用runtime inventory包含三项canonical Duplicate action，既有Toolbox/FundRecon预算与生命周期不回归 |
| Duplicate 150k benchmark：`npm run benchmark:duplicate-inbound` | PASS；150,000 MPT rows / 6,000 keys，fixture 530.0 ms，query 82.5 ms，RSS 104.1→122.3 MiB | matching与side-store规模回归；未作为E07-C并行收益证据 |
| WAL只读探针与startup recovery tests | PASS；普通readOnly会创建sidecar，immutable URI下bytes/mtime/目录不变；孤立WAL/SHM仍Hold | Inspector零破坏、证据family不遗漏 |
| 全量unit：`NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules npm run test:unit` | 6224/6229 PASS；2项Windows build contract因隔离worktree硬编码的本地`node_modules/app-builder-lib/templates/nsis/multiUser.nsh`不存在而ENOENT，3项SKIP；主仓库对应dependency存在 | 产品/新增回归无失败；2项仅为worktree依赖布局限制，不把全量命令宣称PASS |
| 静态检查 | `git diff --check`及全部触及JS的`node --check`通过 | 语法与补丁格式 |
| 明确未执行 | `release-check`、`check-vars`、`scan:vars` | 按任务冻结约束跳过；不把跳过项宣称PASS |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| side/main common operation identity与receipt retention | BLOCK production / E07-B | E07-B Dev +人工恢复review | 不阻断E07-A production-false capability；阻断enable |
| paired parser收益与RSS | PROBE / E07-C | E07-C benchmark | 不阻断E07-A；阻断worker count>1 |
| Windows packaged worker/native SQLite | PROBE / release evidence | R3.2.2 release owner | 不阻断本PR本地能力；阻断enable |
| BizId/MPT/document lineage与candidate consumption真实样本 | REVIEW | 业务/资金人工复核 | 自动测试不可解除资金红线 |

## Scope And Financial Review

- E07-B：未新增/写入live operation receipt，未给main mirror增加`operationKey/producerTaskRunId`，未实现partial补镜像、CAS、compensation或crash-window判定。
- E07-C：未实现paired parser、spool/reducer或多child；canonical import虽声明thread-pool，运行时`effectiveChildCount=1`。
- Live/production：现有Duplicate IPC仍调用legacy Service；三policy `production.enabled=false`，没有暗切、main merge、push或production enablement。
- ⚠️ 关联功能 review：本PR触及Risk-sensitive Duplicate Service生命周期、side store清理时机与startup wiring；未改matching算法、BizId/MPT/document lineage、candidate consumption、金额/币种或writer行输出。unit/E2E/150k benchmark提供自动证据，真实样本资金复核仍是production人工红线。
