# v3.2.17 发布与集成记录

本文件记本轮范围、模块合入与最终证据；模块内的审查处置与验证细节见各自 spec / TechDoc，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.17（2026-11-12 升版，见「升版与发布文档」） |
| 操作范围 | 2026-11-12 用户要求把全部功能分支合入远端 release、Codex 审查到无 P2，并直接完成发版流程：升版、同步发布文档、推送、开 PR 并以 merge commit 合并、推送附注标签 `v3.2.17` 并核验发布结果。不删除远端分支 |
| 正式基线 | `v3.2.16` → `8e027cb893e3d1e4a60281ee36763c6efb931dfc` |
| release 分支 | `release/v3.2.17`，远端已从基线创建（2026-11-12 核对时末端即基线）；工作树 `.claude/worktrees/release-v3.2.17` 于 2026-11-12 建立 |
| 远端 main | `8e027cb8`，已包含在 release 历史 |
| PR | `release/v3.2.17` → `main`；CI、合并提交、正式标签与发布产物核验记录在 PR 正文「发布结果」 |
| 合并方式 | release → main 必须使用 merge commit（见 `AGENTS.md`「约定与分支」）；2026-11-12 核对仓库设置只允许 merge commit |

## 纳入范围（清单 A4）

各分支均基于 `v3.2.16`（`8e027cb8`），按下表顺序 `--no-ff` 合入。

| 内容 | 源分支 / 末端 | 合入提交 | 文档 |
| --- | --- | --- | --- |
| 新开账户「生成余额账单」与月度余额「装配」的 deferred FilePlan 修复（B79） | `fix/deferred-file-plan-resolver` / `616e4502` | `f2de5043` | backlog B79 |
| backlog 登记：`paired-parser-e07-c` 在 Windows CI 偶发 `CANCEL_TIMEOUT` | `chore/backlog-b79-paired-parser-flake` / `3d5b5717` | `dfa8d87e` | backlog B91 |
| 网银账单弹窗说明文案收进标题 | `feat/statement-dialog-title-tips` / `ff47d091` | `8dfd9d8c` | — |
| 「核对上一账单日余额」弹窗滚动、金额浮点尾差、首日断档说明 | `fix/balance-seed-mismatch-dialog` / `8dbb7c9a` | `d3987ed7` | [Spec](fix/balance-seed-mismatch-dialog/spec.md)、[TechDoc](fix/balance-seed-mismatch-dialog/techdoc.md) |
| 主库空闲自动整理 | `feat/db-idle-compaction` / `b9a47e77` | `cc5d8a38` | [Spec](feat/db-idle-compaction/spec.md)、[TechDoc](feat/db-idle-compaction/techdoc.md) |
| VCC 财务OP校验提速瘦身、级联解归档放宽、通道明细预检补录（B81–B85） | `feat/vcc-financial-op-speed-unarchive` / `679ea825` | `ef85391a` | [Spec](feat/vcc-financial-op-speed-unarchive/spec.md)、[TechDoc](feat/vcc-financial-op-speed-unarchive/techdoc.md) |
| 补录余额「导入余额文件」与「提取调拨订单对账ID」限定 FundType | `feat/balance-file-import-fundtype-gate` / `2ebcca3d` | `31e8830c` | [Spec](feat/balance-file-import-fundtype-gate/spec.md)、[TechDoc](feat/balance-file-import-fundtype-gate/techdoc.md) |
| 外观设置深色模式深浅度调节 | `feat/appearance-dark-lightness` / `40c1736a` | `8819b068` | [Spec](feat/appearance-dark-lightness/spec.md)、[TechDoc](feat/appearance-dark-lightness/techdoc.md) |

`feat/balance-file-import-fundtype-gate` 合入前只在本地工作区，2026-11-12 经用户同意整体提交为 `2ebcca3d`。

### 合入处理

- `knowledge/backlog.md`：`fix/deferred-file-plan-resolver` 与 `chore/backlog-b79-paired-parser-flake` 都用了 B79，后者改为 B91；其余条目按编号排列。`rules/integration-test-policy.md` 取 release 版本，完整集成后回写（`c0df3a07`、`7a73389a`）。
- 架构历史检查报 56 处 `ARCH-POLICY-HISTORY`：release 历史中其他分支的 28 个提交仍持有 `renderer-statement`、`renderer-dialog-configuration` 原 `allowedApiFields` 集合（不含 `files.importBalanceSeedFile`）。按 v3.2.16 先例补登放宽记录，来源取覆盖其余分支的合并提交 `ef85391a` 与 `40c1736a`（`8e8edbe0`），之后通过。
- 合并后 `fix/deferred-file-plan-resolver` 之外的两个分支各新增一个 exclude IPC，`archive-task-policy-registry.test.js` 的总数与 exclude 计数改为 302 / 154（`92290347`）。
- 导入余额文件把补录表单包进 `.manual-balance-view`，使「核对上一账单日余额」的子选择器失效、150% 缩放下说明区不再滚动；补齐包裹层选择器，两条对不上补录用例按账号核对字段更新（`c12de6bb`）。

## release 级审查

- 第一轮 Codex 只读审查（`8e027cb8..c0df3a07`）：2×P2，无 P0/P1。
  1. 余额补录被准入拒绝（`busy`，如空闲整理尚未退出）时，余额确认连续保存把该账号标为已保存，随后清状态并关闭弹窗，种子未写入、草稿丢失。
  2. VCC 提交前复核去掉二次解析后不再检查 `shouldCancel`，复核期间取消仍可能继续正式导入。
- 修复（`71b7ba5f`）：连续保存遇 `busy` / `cancelled` 不标已保存；补录、断档、不一致、替换确认在 `applyStatementResult` 前拦截 `busy`，保留弹窗与草稿并提示稍后重试；`revalidateImportPlan` 在哈希前、读取中（`hashSourceFile` 可选 `shouldCancel`）、哈希后与返回前检查取消。回归：渲染生命周期新增 3 例（修复前 3 例失败、修复后通过），`workbook-import-plan.test.js` 新增 2 例。
- 第二轮 Codex 只读审查（`8e027cb8..71b7ba5f`）：未发现 P2 及以上；以真实 worker、service 与内存 SQLite 验证取消后导入批次为 0、可重试成功。

## 遗留项处置（清单 B4）

- 关闭：B81–B85（VCC 四个痛点与通道明细补录，随 `ef85391a`、`cc5d8a38` 纳入），移至「已完成」。
- B79：修复随本版发布，Windows 打包版实测未做，改为待核验，目标 v3.2.18。
- 顺延 v3.2.18：B86（VCC Windows 真实数据回归）；B70、B75、B77（v3.2.16 发布后补测，仍未做）；B45、B47、B48、B52–B58、B60（本轮无修复纳入）。
- 新增 B92：本版新功能实机 GUI 检查与真实文件回归。
- B80、B87–B91 及其他目标未定的条目状态不变。

## 待人工复核

2026-11-12 用户确认以下资金红线人工复核通过，未提供复核人与明细。实机 GUI 与真实数据回归仍未做（B92、B86、B79）。

- ⚠️ VCC 通道明细人工补录可改金额、币种、方向，直接改变计算口径（[implementation-notes](feat/vcc-financial-op-speed-unarchive/implementation-notes.md)）。
- ⚠️ VCC 级联解归档删除所选月份之后各月的已确认结果与调整（预览列出并须勾选确认，写入审计）。
- ⚠️ 非 DBS 渠道「提取调拨订单对账ID」只认 `FundTransfer-in` / `FundTransfer-out`，其他类型行不再获得对账ID，R4 等后续匹配随之变化（spec D3、D4，用户实施前已确认影响）。
- ⚠️ 导入余额文件按原值写人工种子，有余额附加值的账号会重复叠加（spec D2，用户已接受）。
- ⚠️ release 审查修复：补录遇 `busy` 不再标为已保存；VCC 复核阶段取消不再继续导入。

## 验证证据

- 2026-11-12 release 工作树 `c12de6bb`（全部合入、补登策略与合并后修正之后）完整 `npm run release-check` 通过；集成 106/106、3719 例，§七回写单独提交（`c0df3a07`）。此前在 `8e8edbe0`、`92290347` 的两次运行分别失败于上面「合入处理」的计数与样式问题，修正后作废。
- 2026-11-12 release 工作树 `71b7ba5f`（release 审查修复后）完整 `npm run release-check` 通过：lint、架构检查、smoke 通过；单测 10220/10224、0 失败（4 个 Windows 专用跳过）；集成 106/106、3722 例，§七回写单独提交（`7a73389a`）。
- 升版与发布文档提交后的最终候选验证见下节。
- 真实应用 GUI 人工检查未做（本机开发版启动受 BizOP 资源预检阻断）；界面由渲染生命周期用例覆盖，登记 B92。

## 升版与发布文档（清单 C1–C2，2026-11-12）

| 项目 | 事实 |
| --- | --- |
| 升版 | `package.json`、`package-lock.json` 升到 3.2.17（`npm version 3.2.17 --no-git-tag-version`，项目无 version 生命周期脚本；npm 重排的 `build.files` 数组格式已还原） |
| 发布文档 | `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.17；`docs/USER_GUIDE.md` 版本号与顶部说明更新，补充导入余额文件、核对余额弹窗变化、FundType 条件（规则表与自带写死场景两处）、深色深浅度与 deferred FilePlan 修复说明；VCC 与空闲整理两节已由模块分支写入 |
| 升级弹窗 | `release-notes.json` 新增 3.2.17 的 5 条要点 |
| backlog | 见「遗留项处置」 |
