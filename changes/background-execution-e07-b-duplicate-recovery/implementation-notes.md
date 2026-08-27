# E07-B Duplicate Receipt / Mirror Recovery Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec §6、§8、§10-§13；TechDoc §4-§5、§10-§12；Platform RecoverySource/Startup Coordinator；E07-B frozen scope。
- Exact base / parent E07-A：`e36dfe33a22d6d821fa3792a70a2580de7af45af`。
- Contract SHA-256：Spec `0cdf28e5310733355fb51d92818dde8fd837ee06b521a4694c0c9cc43300d47f`；TechDoc `9fd15a46b482e6801616554978dff67a02676b437b9759e18d15fce29dcff209`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：receipt同事务、duplicate replay、Main identity、exact inspector、approved CAS complete-mirror、durable audit/crash matrix完成；production/live/E07-C保持关闭。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| managed command从canonical envelope显式传 `actionKey/operationKey/producerTaskRunId` | receipt/mirror不能从文件名、月份或jobId猜owner | 在Service生成UUID；复用jobId | identity跨attempt/重启稳定，legacy调用不带identity仍走旧路径 |
| import/run receipt分别写入`createImportBundle`/`finishRun`的既有side事务 | 这是两类业务mutation唯一COMMIT边界 | COMMIT后补receipt；Main单独记side成功 | receipt存在即authoritative committed-side证据，rollback不留假阳性 |
| Main mirror identity migration采用nullable历史兼容 + managed严格非空 | 旧行没有operation/task，强制NOT NULL会不可逆回填/猜值 | 给旧行生成伪operation；重建全表 | 历史行只可unknown，新增managed行可exact判定 |
| Duplicate complete-mirror的CAS pre-image限定为本operation mirror absent/exact post-image | 当前Duplicate mirror为多run记录，不是BankBU同月单槽 | 删除/覆盖同月所有mirror；按month猜最新 | 不触碰其它历史run；operation collision fail closed |
| partial只创建Hold，provider能力仅在显式批准后调用 | Platform Coordinator对partial固定Hold，冻结合同禁止自动重跑/暗补 | inspector把partial伪报committed；startup自动调用provider | 本PR不扩公共协议；production/manual gate仍存在 |
| complete-mirror与recovery audit同一Main事务 | crash不能留下“mirror已补但无durable recovery audit” | 两次独立提交；仅依赖generic event | provider重放按operation幂等，任一写失败整体回滚 |
| 无identity历史residue继续走E07-A legacy source | 不能安全关联side/mirror/task | latest-row、month、sideRunId猜owner | 兼容历史且fail closed，不误补或清理 |
| exact Inspector evidence绑定完整side/mirror post-image hash | 仅绑定receipt identity会漏掉复检后summary/result变化 | 只比较sideRunId/snapshot；相信启动期无并发 | TOCTOU或数据损坏在补镜像前终止，不把变化后的结果写入Main |
| import/run分别使用policy冻结的Inspector key | `duplicate:import`与`duplicate:run`各有独立policy inspector key | import source复用run key | 共享同一个只读实现但registry identity不混用 |
| managed新import/run保留旧authoritative side receipt/result | operation replay和重启恢复需要原target；side与Main无法跨库原子“审计后删除” | 沿用legacy `clearAll/clearRuns`；先记Main expiration再删side | production-false managed路径append-only保留，legacy清理语义完全不变；容量/retention列production gate |
| Duplicate managed side path统一写POSIX，历史path只做separator canonical comparison | Windows持久值`\\`与provider POSIX值是同一文件identity；全局修改`runDataStore`会扩大legacy行为 | 全局normalize/resolve；折叠`.`/`..`/重复separator/大小写 | 新writer跨平台稳定；历史Windows mirror可exact replay/inspect，非separator差异仍identity conflict |
| side commit后Main CAS前后均authoritative重读并维护generation latch | writer exception既可能pre-commit，也可能commit-after-reply；同进程若继续import/run/export会删除或旁路partial证据 | 只在catch设布尔flag；盲重试matching；允许其它command | latch绑定action/operation/task/evidence/month/import/sideRun与result digest；仅exact receipt replay可补mirror，partial/unknown时其它command全部fail closed |
| `finishRun`同side事务持久化完整result post-image SHA-256 | 三路row count无法发现同计数金额/币种/raw/reason/lineage/snapshot变化 | Startup recovery复制/重跑matching；Main保存敏感结果行 | digest覆盖稳定排序的mail/manual/audit实际JSON、snapshot/summary及五路count/disposition守恒；Main仅保存digest、summary/count，不保存raw行 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| Duplicate mirror是operation级append-only记录，CAS无需BankBU previous-month pre-image | repository按run insert多行，冻结Duplicate inspector只区分matching/absent | 误覆盖同月并发mirror | repository测试锁定只查询本operation；若合同改变则停止provider |
| explicit approved recovery/Hold resolution由后续production control接入 | E07-B冻结范围不接live且production=false | capability无法由用户路径调用 | direct provider + durable audit证据；final列manual gate |
| startup阶段不存在并行Duplicate side writer | recovery初始化严格先于Service constructor，single-instance gate已由E07-A冻结 | snapshot family复制仍可能跨写事务不一致 | WAL原family bytes/mtime测试；若未来开放并行startup writer必须增加side snapshot锁 |

## Deviations

| 偏差 | 原计划 | 实际实现 | 合同影响 |
| --- | --- | --- | --- |
| managed replacement不在本PR执行expiration+物理删除 | preflight曾计划Main先记compensated/expired audit，再允许清理side | 复核发现Main audit与side删除无法原子提交，audit后crash会造成“已补偿”但live receipt仍在；因此managed path保留旧receipt/result，且compensation audit与live residue一律判`unknown` | 不偏离E07-B receipt/replay/recovery验收；增加磁盘retention production gate，不影响legacy IPC |
| no live compensation writer | preflight把expiration列入生命周期实施步骤 | E07-B只冻结exact outcome与durable audit schema；没有安全的批准/Hold resolution入口，故仅测试已完成compensation audit的读取语义 | 符合“不接live/production=false”；production enable前必须补控制面与原子清理协议 |

## Evidence

### Done-when mapping

| 冻结验收 | 实现证据 | 测试证据 |
| --- | --- | --- |
| Duplicate import/run operation receipt与side mutation同事务 | `duplicate-inbound-match-store.js`在`createImportBundle`/`finishRun`的既有事务COMMIT前写receipt；`operation-receipt-repository.js`冻结exact identity | `v322-operation-receipt-e06-p0.test.js` writer fault整体rollback；`service.test.js`真实import/run receipt |
| duplicate replay不重复业务mutation | `service.js`在invalidate/clear/matching前查receipt；Main writer异常后authoritative重读并以完整owner/op/evidence/side identity建立generation latch | `service.test.js`partial latch阻断import/different run/export；same replay只补mirror，matching lookup/side run/mirror计数不增长；conflicting mirror保持unknown |
| Main mirror保留operationKey/producerTaskRunId与exact post-image | nullable历史migration；managed writer强校验；operation CAS比较owner/input/side/files/summary/result digest；新side path固定POSIX，历史path只做separator comparison | repository Windows `\\`→POSIX exact replay/CAS与重复separator/不同month冲突；service owner lineage、commit-after-reply authoritative成功 |
| exact inspector五态 | `startup-recovery.js`枚举receipt source、复制DB/WAL/SHM只读证据，校验完整result digest、五路count/disposition守恒与mirror | committed/not-committed/partial/compensated/unknown、历史backslash、owner/mirror冲突、孤立sidecar、WAL零写测试 |
| 仅committed-side执行CAS complete-mirror | provider复检相同evidence与完整side post-image；只把持久digest/summary/count写Main，不导入或调用matching engine | 同计数金额/币种内容变化TOCTOU fail closed；敏感结果不进入mirror/audit；partial由Platform Hold且不自动recover |
| durable recovery audit/crash matrix | Main `BEGIN IMMEDIATE`内mirror CAS+append-only audit；source/result hash支持exact replay | CAS后audit前fault整体rollback、provider replay单mirror/单audit、mirror后reply丢失replay |
| production/live/E07-C不启用 | 只在既有startup boundary注册import/run inspector/provider；`policies.js`未改且三项`production.enabled=false`；无IPC/preload/renderer/parser改动 | policy冻结fixture、wiring、真实Worker crash/restart/active Hold与重复generation gate零写测试 |

### Blindspot passes

- `blindspot-pass`：独立review新增发现并修复跨平台path identity、Main异常后的同进程partial窗口、count-only post-image三项；复核startup模块仅做DB family复制、receipt/result/mirror检查与Main CAS/audit，没有matching算法或E07-C parser入口。
- `reconciliation-blindspot-pass`：operation/task/import/sideRun/mirror血缘可追溯；digest覆盖mail金额币种/输出、manual raw/reason/order、audit disposition/reason与Bank/MPT/document lineage、snapshot及五路守恒；partial/unknown不重跑算法；资金红线保留真实样本人工复核。

### Automated evidence

- Focused/affected unit：137/137 PASS（Duplicate全部unit、digest/store/repository/wiring、E06 receipt fault）。
- Integration：`duplicate-inbound-match-end-to-end.js` 31/31 PASS；`background-execution-recovery-control.js` 27/27 PASS。
- Full unit：6245/6250 PASS、3 SKIP；仅2项`windows-build-contract.test.js`因隔离worktree没有本地`node_modules/app-builder-lib/templates/nsis/multiUser.nsh`而ENOENT，非业务断言失败；相关测试以上述focused/integration覆盖。
- Static：所有改动JS `node --check` PASS；ESLint 9.39.4 `src/` PASS；`git diff --check` PASS。
- 未运行（明确禁止）：`release-check`、`check-vars`、`scan:vars`。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| complete-mirror人工批准与Hold resolution live UX | BLOCK production | R3.2.2 release/control owner | 不阻断production-false E07-B；阻断enable |
| E07-C paired parser收益/RSS | PROBE | E07-C | 不阻断E07-B；worker child count保持1 |
| Windows packaged native SQLite/WAL/CAS | PROBE | R3.2.2 release evidence | 阻断enable |
| BizId/MPT/document/candidate与恢复真实样本 | REVIEW | 业务/资金人工复核 | 自动测试不能解除资金红线 |
| managed receipt/result磁盘retention与安全expiration协议 | BLOCK production | R3.2.2 recovery/control owner | 不阻断production-false E07-B；启用前需容量策略、补偿原子性与人工样本 |
| 历史managed side/mirror无`result_digest` | HOLD compatibility | recovery/control owner决定是否离线人工迁移；当前不猜测内容 | 不阻断本PR；exact Inspector保持unknown/Hold，禁止自动补镜像 |
