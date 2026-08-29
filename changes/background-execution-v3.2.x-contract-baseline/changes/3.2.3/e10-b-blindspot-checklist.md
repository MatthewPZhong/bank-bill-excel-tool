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
- [ ] BLOCK：现有FilePlan/Publisher尚未冻结普通target ancestor directory identity；rename+ordinary replacement可绕过。已提交只读合同delta，未获授权不改公开合同。
- [x] Publisher 调用前再次复核现有FilePlan target snapshot、symlink/alias、staging ownership/identity/hash与Main-owned业务 evidence。
- [x] Publisher failure 不 blind retry；committed保持archive-handoff journal，settlement失败/回包丢失只走既有recovery并保留RecoverySource/Hold evidence。
- [x] cancel/quit在copy前后safepoint生效；inline terminate/close等待实际execution，deadline显式transport leak；Publisher committed不伪报cancelled。
- [x] I/O lease acquire/release/reject 可证明；CPU slot/Worker slot 均为 0。

## 资金与业务不变量

- [x] E10-A合法sheet/header/rowCount/template/records/date/account/currency digests未改变；恶意Worker自洽业务与附加Sheet由Main authority拒绝。
- [x] Main authority冻结exact columns/used range/dimension；extra header/data/styled blank/merge/dimension全部拒绝，不再静默slice。
- [x] Main authority路径拒绝formula cached账户/金额、calcChain、externalLink、hyperlink；generic cached-formula oracle兼容保持。
- [x] 233536行authority分批让出event loop；dispatch前cancel/app quit不spawn Worker、不留staging，digest与同步oracle逐字节一致。
- [x] Main strict readback 不引入 raw rows DTO，不改变 E10-A generation/readback/golden。
- [x] source 有数据时不能在未验证业务 evidence 下发布；任一 digest mismatch Publisher=0。
- [x] production 保持 `false/legacy/0`；不新增 fallback、receipt、retry、Publisher 或 live flag。

## 最终门禁

- [x] Round2定向：E10-A `25/25`、E10-B `47/47`、strict `18/18`，交叉聚焦 `189/189` PASS。
- [x] Round2全量：unit `6390/6394 PASS, 3 SKIP`（仅 exact-parent 已知 NSIS baseline）；integration `51/51 scripts, 2455/2455 assertions`；smoke/lint/node-check/diff-check PASS。
- [x] E10-A、strict readback、Publisher、Governor/recovery 聚焦回归。
- [x] 全 integration、smoke、ESLint、node --check、git diff --check；全 unit 为 `6369/6373 PASS, 3 SKIP`，仅剩 exact-parent 可复现的 Windows NSIS 依赖模板基线失败，未豁免。
- [ ] ⚠️ 资金红线：真实资金样本需人工复核。
- [ ] Windows Setup/portable 与 durable restart recovery 需人工门禁。

## 关联功能 review

- `rules/important-variables.md` 未命中已登记的 Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor 符号。
- 新增的 `new-account:save-as` policy、copy contract、FilePlan authority brand 与 singleton Publisher wrapper 是跨文件 seam；本轮已按 E10-B checklist 及 archive/FilePlan/TaskLifecycle 定向回归 review，留待版本硬节点由 `/check-vars` 正式统计（本任务明确禁止运行 `check-vars` / `scan:vars`）。
