# E10-B Blindspot Checklist

## 实施前

- [x] exact parent/merge-base 为 `d073ced023b40feb477cf7557801a2899b433500`。
- [x] 读取 v3.2.3 spec/techdoc、Platform Publisher/main-settlement/lifecycle、E10-A 与 E09-C seam。
- [x] 确认 action binding 仍为 `new-account:save-as → new-account:export`。
- [x] 确认既有 Publisher 默认 dispatcher 是 module singleton FIFO，core journal 可恢复。

## 入口与所有权

- [x] live IPC 未切换；legacy `new-account:export` 行为未改。
- [x] Worker/inline entry 永不接 final target；`copyFile` destination 只能由 staging root + resource id 派生。
- [x] FilePlan exact 1 source/1 target，source/target operation/artifact identity 逐项绑定。
- [x] E10-B只assert进程内branded normalized FilePlan，不重新normalize/resnapshot；用户确认时的原target snapshot贯穿copy/handoff/Publisher前复核。
- [x] source/target/staging 相互不 alias；symlink、hardlink、ancestor symlink、platform case/Unicode alias fail closed。
- [x] cleanup 只处理通过 task-owned validation 的 staging resource；outside manifest 不获得删除权。

## TOCTOU / 失败 / 生命周期

- [x] source copy 前后 canonical path、device/inode、snapshot、content hash 全部复核。
- [x] 同 size/mtime replacement、during-copy drift、after-copy drift 全部 Publisher=0。
- [x] staging partial/collision/tamper/replace、copy error 全部 Publisher=0 并安全清理。
- [x] target absent→created、existing→replacement（含相同metadata）与unbranded clone均在copy前Publisher=0。
- [x] 用户已授权最小公共合同增量：FilePlan/Publisher/journal冻结并复核resolved direct parent identity；只覆盖direct parent，不实现整条ancestor chain。
- [x] required guarded target parent与fixed Publisher recovery root相等/inside/ancestor均在任何journal/index/target写入前整批拒绝；sibling/外部目录不受影响。
- [x] Publisher 调用前再次复核现有FilePlan target snapshot、symlink/alias、staging ownership/identity/hash与Main-owned业务 evidence。
- [x] Publisher failure 不 blind retry；committed保持archive-handoff journal，settlement失败/回包丢失只走既有recovery并保留RecoverySource/Hold evidence。
- [x] cancel/quit在copy前后safepoint生效；inline terminate/close等待实际execution，deadline显式transport leak；Publisher committed不伪报cancelled。
- [x] I/O lease acquire/release/reject 可证明；CPU slot/Worker slot 均为 0。
- [x] Windows长`stagingSnapshot.ino`只在精确`/payload/result/artifact/stagingSnapshot/ino`、合法四字段snapshot与canonical uint64边界放行；附近路径、额外字段、非canonical/负数/小数/越界值及其他12～32位数字仍由finance-safe拒绝。

## 资金与业务不变量

- [x] E10-A合法sheet/header/rowCount/template/records/date/account/currency digests未改变；恶意Worker自洽业务与附加Sheet由Main authority拒绝。
- [x] Main authority冻结exact columns/used range/dimension；extra header/data/styled blank/merge/dimension全部拒绝，不再静默slice。
- [x] Main authority路径拒绝formula cached账户/金额、calcChain、externalLink、hyperlink；generic cached-formula oracle兼容保持。
- [x] 233536行authority分批让出event loop；dispatch前cancel/app quit不spawn Worker、不留staging，digest与同步oracle逐字节一致。
- [x] Main strict readback 不引入 raw rows DTO，不改变 E10-A generation/readback/golden。
- [x] source 有数据时不能在未验证业务 evidence 下发布；任一 digest mismatch Publisher=0。
- [x] production 保持 `false/legacy/0`；不新增 fallback、receipt、retry、Publisher 或 live flag。

## 最终门禁

- [x] Direct-parent授权轮RED为`123/138 PASS, 15 FAIL`；核心FilePlan/E10-B/Publisher修复后`141/141 PASS`，交叉聚焦与archive repository/public DTO均全绿。
- [x] Round4 recovery-root overlap真实FS RED `3/7 PASS, 4 FAIL` → GREEN `7/7 PASS`；Publisher完整`76/76`、交叉`500/500`，committed-before-settle fresh recovery与旧journal兼容控制通过。
- [x] Round4仓库回归：integration `51/51 scripts, 2455/2455 assertions`、最终新场景`8/8`、smoke/lint/node-check/diff-check PASS；默认unit `6413/6418 PASS, 3 SKIP, 2 FAIL`，串行unit `6414/6418 PASS, 3 SKIP, 1 FAIL`。稳定剩余为既知NSIS依赖；archive负载时序项经单文件`46/46`和串行全量排除本轮回归，均未豁免或伪报全绿。
- [x] Direct-parent最终全量：unit `6406/6410 PASS, 3 SKIP`（仅已知NSIS baseline 1 FAIL）；integration `51/51 scripts, 2455/2455 assertions`；smoke/lint/node-check/diff-check PASS。
- [x] Round2定向：E10-A `25/25`、E10-B `47/47`、strict `18/18`，交叉聚焦 `189/189` PASS。
- [x] Round2全量：unit `6390/6394 PASS, 3 SKIP`（仅 exact-parent 已知 NSIS baseline）；integration `51/51 scripts, 2455/2455 assertions`；smoke/lint/node-check/diff-check PASS。
- [x] E10-A、strict readback、Publisher、Governor/recovery 聚焦回归。
- [x] 全 integration、smoke、ESLint、node --check、git diff --check；全 unit 为 `6369/6373 PASS, 3 SKIP`，仅剩 exact-parent 可复现的 Windows NSIS 依赖模板基线失败，未豁免。
- [ ] ⚠️ 资金红线：真实资金样本需人工复核。
- [ ] Windows Setup/portable 与 durable restart recovery 需人工门禁。
- [ ] 旧二进制回滚前release gate必须证明open Publisher journal=0；本轮不新增迁移器。
- [ ] 新exact Windows CI需证明E10-B unit与首次到达的integration均通过；旧job `99731507623` 未打印实际inode值，不能把本地构造值当作已观测Windows值。

## 关联功能 review

- 命中`ArchiveRepository` / `ArchiveService` Risk-sensitive审计血缘：本轮不改十四表schema/批号/状态/删除/Blob合同，只在内部artifact metadata持久FilePlan已冻结的bounded target-parent evidence；public list/detail显式剥离该路径/identity，定向真实SQLite+FS已验证raw持久与public DTO不泄露。
- 新增的 `new-account:save-as` policy、copy contract、FilePlan authority brand 与 singleton Publisher wrapper 是跨文件 seam；本轮已按 E10-B checklist 及 archive/FilePlan/TaskLifecycle 定向回归 review，留待版本硬节点由 `/check-vars` 正式统计（本任务明确禁止运行 `check-vars` / `scan:vars`）。
- Round4只增加Publisher内部required-parent/recovery-root preflight，不改`freezeWorkerBatchContext`、TaskLifecycle、Archive schema/receipt或FilePlan shape；手工对照important-variables后无新增精确变量命中，Publisher/FilePlan/Archive关联链已由`500/500`交叉回归与全integration覆盖。
- Windows inode修复只触及`new-account:save-as` result validator的finance-safe delegate，不改全局`FULL_ACCOUNT_PATTERN`、protocol schema、source identity、Publisher/恢复/资金合同或production flag；关联链需复核inline adapter→protocol privacy→Supervisor terminal→Publisher恰好一次。
