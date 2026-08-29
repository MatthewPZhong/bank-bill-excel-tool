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
- [x] source/target/staging 相互不 alias；symlink、hardlink、ancestor symlink、platform case/Unicode alias fail closed。
- [x] cleanup 只处理通过 task-owned validation 的 staging resource；outside manifest 不获得删除权。

## TOCTOU / 失败 / 生命周期

- [x] source copy 前后 canonical path、device/inode、snapshot、content hash 全部复核。
- [x] 同 size/mtime replacement、during-copy drift、after-copy drift 全部 Publisher=0。
- [x] staging partial/collision/tamper/replace、copy error 全部 Publisher=0 并安全清理。
- [x] Publisher 调用前再次复核 FilePlan target freshness、target ancestor、alias、staging ownership/identity/hash、业务 evidence。
- [x] Publisher failure 不 blind retry；uncertain 只走既有 journal recovery并保留必要 evidence。
- [x] cancel/quit 在 copy 前后 safepoint 生效；Publisher protected/committed 状态不伪报 cancelled。
- [x] I/O lease acquire/release/reject 可证明；CPU slot/Worker slot 均为 0。

## 资金与业务不变量

- [x] E10-A sheet/header/rowCount/template/records/date/account/currency digests 未改变。
- [x] Main strict readback 不引入 raw rows DTO，不改变 E10-A generation/readback/golden。
- [x] source 有数据时不能在未验证业务 evidence 下发布；任一 digest mismatch Publisher=0。
- [x] production 保持 `false/legacy/0`；不新增 fallback、receipt、retry、Publisher 或 live flag。

## 最终门禁

- [x] E10-B 定向 RED→GREEN 证据（缺模块 RED → `27/27 PASS`）。
- [x] E10-A、strict readback、Publisher、Governor/recovery 聚焦回归。
- [x] 全 integration、smoke、ESLint、node --check、git diff --check；全 unit 为 `6356/6360 PASS, 3 SKIP`，仅剩 exact-parent 可复现的 Windows NSIS 依赖模板基线失败，未豁免。
- [ ] ⚠️ 资金红线：真实资金样本需人工复核。
- [ ] Windows Setup/portable 与 durable restart recovery 需人工门禁。

## 关联功能 review

- `rules/important-variables.md` 未命中已登记的 Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor 符号。
- 新增的 `new-account:save-as` policy、copy contract 与 singleton Publisher wrapper 是跨文件 seam；本轮已按 E10-B checklist 全量 review，留待版本硬节点由 `/check-vars` 正式统计（本任务明确禁止运行 `check-vars` / `scan:vars`）。
