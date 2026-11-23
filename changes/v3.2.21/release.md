# v3.2.21 发布与集成记录

本文件记本轮范围、模块合入、release 整体审查与最终证据；模块内的决策、审查处置与验证细节见各 spec，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.21 |
| 操作范围 | 用户 2026-11-22 要求「将所有未合并进本地 release 的功能分支全合并进 release 里，然后执行发版流程」；2026-11-22 改为「暂停合并进 feat/cross-sheet-backfill 分支。让 codex 对 release/v3.2.21 进行 review，直到无 P2 Finding 后，开始执行发版流程」。完整发布（推送、PR、合并、正式标签、发布审批）沿用已获授权的流程 |
| 基线 | `v3.2.20` → `08d1fb413d71ce43f04e14a2f00047705dbe8feb`（PR #256 合并提交） |
| release 分支 | `release/v3.2.21`（工作树 `.claude/worktrees/release-v3.2.21`），2026-11-23 候选提交后首次推送远端 |
| 远端 main | `f217c8fd`（PR #257，v3.2.20 发布记录），已于 `bad116f3` 合入 release |
| 未纳入 | 主签出 `CLAUDE.md` 的未提交改动（与本轮无关，未动） |

## 纳入范围（清单 A4 / B5）

| 内容 | 源分支 / 末端 | 合入提交 | 文档 |
| --- | --- | --- | --- |
| 逻辑取值候补支持特征值、映射关系管理「启用」列与布局 | `feat/mapping-logic-feature-layout` / `c6509280` | `a857c84b` | [spec](feat/mapping-logic-feature-layout/spec.md) |
| v3.2.20 发布记录（main 同步） | `origin/main` / `f217c8fd` | `bad116f3` | [v3.2.20 记录](../v3.2.20/release.md) |
| 网银账单生成长数字按原文读取（关闭 B112） | `fix/statement-long-number-precision` / `532266be` | `ba67b2e2` | [spec](fix/statement-long-number-precision/spec.md) |
| 模板「日期格式」 | `feat/template-date-format` / `8d34c254` | `5fc739b0` | [spec](feat/template-date-format/spec.md) |
| 渠道子模板余额方式可不同 | `feat/channel-mixed-balance-mode` / `cb202376` | `592f8e02` | [spec](feat/channel-mixed-balance-mode/spec.md) |
| 拆分/合并账单「费用账单设置」与字段映射特殊处理 | `feat/bill-split-fee-field-mapping` / `a0d78580` | `0e49345e` | [spec](feat/bill-split-fee-field-mapping/spec.md) |

- 各模块分支合入前已分别完成 Codex 循环审查（见各 spec）；合入后 release 上的审查修复直接提交在 release 分支。
- **顺延**：`feat/cross-sheet-backfill`「跨 Sheet 回填」，用户 2026-11-22 决定暂不合入本轮（B129），分支与其 worktree 保留。

## release 整体审查

`codex review --base main` 共 15 轮（P1 / P2 条数）：

| 轮次 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | 3 | 3 | 1 | 1 | 1 | 1 | 1 | 0 | 2 | 1 | 1 | 1 | 1 | 1 | 2 |
| P2 | 3 | 2 | 2 | 3 | 3 | 4 | 5 | 5 | 4 | 2 | 2 | 3 | 2 | 2 | 2 |

- 合计 P1 20 条、P2 44 条。第 1–14 轮的全部 P1、P2 已修复并补回归测试；每轮修复都做了反向验证（撤掉修复后对应用例失败），并跑完整单测与两组集成测试。
- **收口标准**：第 9 轮后用户选择「放宽标准」——修所有 P1 与真实银行文件、正常操作可能触发的 P2，手工构造 XML、账号或币种含 `@@` 等极端输入才能触发的 P2 登记 backlog（B131、B132）。第 14 轮后（第 11–14 轮每轮 1 条 P1，均为手工改写 XLSX XML 与读取库解析口径的差异）用户选择「再审一轮就发版」：第 15 轮只修真实文件 / 正常操作可触发的问题与修复引入的问题。
- **第 15 轮处置**：两条 P2（旧模板包只在 MerchantId 映射行保存固定账号时的跳过日志脱敏；余额方式冲突诊断以本组未冲突账号命名的渠道脱敏）已修复并反向验证；两条 P1（`<Relationship` 后制表符分隔属性、工作表 XML 中注释掉的旧行）只在手工改写 XLSX 内部 XML 时出现，登记 B133 并列入合并前人工复核。第 15 轮修复后未再做 Codex 审查。

## 升版与发布文档（清单 C1–C2）

- `package.json` / `package-lock.json` 升为 3.2.21（只改版本行，保留原格式）。
- `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.21 条目；`docs/USER_GUIDE.md` 更新版本与 v3.2.21 说明，新增第 33–35 条（费用账单字段映射特殊处理、逻辑取值的特征值候补、长账号按原文输出），第 27、28 条补充本版调整（日期格式与渠道余额方式的问答由模块分支写入）；`src/main-process/release-notes/release-notes.json` 顶部新增 3.2.21 升级弹窗要点 4 条。

## 遗留项处置（清单 B4）

- 目标为 v3.2.21 的既有条目（含 B105 与 v3.2.20 顺延的 17 条）本轮无修复纳入，已于 2026-11-22 在原条目顺延到 v3.2.22（暂定）。
- 本轮新增：B111、B113–B128、B131–B133（B129 为跨 Sheet 回填顺延）；B112、B130 已关闭（见「已完成」）。

## 远端旧分支清理（2026-11-22，用户要求）

按用户要求删除未并入 `release/v3.2.21` 的远端分支共 44 个（均未被正式标签包含；第一批 4 个经核对内容已全部在 main，第二批 40 个由用户确认全部删除，含旧维护线 `v1.5.x` 与 8 个有补丁在 main 中找不到对应的旧分支）。与正式标签同名的 `v3.2.0`、`v3.2.1`、`v3.2.3` 按 `refs/heads` 精确删除分支，标签未受影响。需要恢复时按下列末端 SHA 重建：

```
codex/hotfix-balance-seed-status 032315597832b2db25d066282ef2fbcdf6897012
codex/v3.2.4-e11-a-reconfix-service ea41e095ca58bf051e712776b14b92afdd244350
codex/v3.2.4-e11-c-reconfix-export-restacked 0f8b2b848ff513a2e5bce056c8bff4c25eacfd71
fix/concat-field-marker 018291c055c389a2f30433f4e2eee997ecc6105a
codex/1.4.4 0f1fc4b349c71d869c16d0ff342a42dab8ab2cb1
codex/1.4.5 94d41cdcc3b07bc14b646a86fded34f13fc720eb
codex/v3.2.3-e09-a-statement-service-restacked 3ba216026ad2e133c5a6a220199c404ae039d249
codex/v3.2.3-e09-c-statement-generation-restacked c6d235e6f3e04ccd30c8cd647815734db4834f81
codex/v3.2.3-e09-d-manual-seed-settlement 600d07a949133f9ef8ac4a0eb1d948465558effa
codex/v3.2.3-e10-a-new-account-worker-restacked 4775b3f7cb5490e4492cb5cbda13a5e812d6986f
codex/v3.2.3-e10-b-new-account-copy-publisher-restacked e437cc2c8983537ddffdd1d55db4c5b7c6dbe90a
codex/v3.2.3-r3-release-evidence-restacked 8de425bd428fe94f3f1c10da43fd32b870a63158
codex/v3.2.4-e11-b-jpm-durable-inspector-restacked f409339b469307b650aa64090cb0a28ed2f78f72
codex/v3.2.4-e11-p0-jpm-id-aware-receipt-restacked 9ad1de674e3dc5245570246e66f518e6a1855bac
codex/v3.2.4-e12-a-vcc-single-writer-restacked 8bf31e4ebfd57ed99055dc8090d1fd58dfc4d5f9
codex/v3.2.4-e12-b-vcc-query-pushdown-restacked 0ac603cfd8101aeb2ed2395e59d761a8c2adb94c
codex/v3.2.4-e12-c-vcc-dual-writer-restacked 4450c13fc1564a23db3eb503a30c582f968f38c4
codex/v3.2.4-r3-release-evidence-restacked 9ce1b35ac08def032379801c38425443e3c02ef5
codex/v3.2.5-e13-a-readonly-exports-restacked 8fb0c4903b805254b21b6ff3f531f05d94666252
codex/v3.2.5-e13-b-readonly-exports-restacked ce8df1fd5905e510444e1af50562c9c5f11b6db5
codex/v3.2.5-e13-c-acquiring-classification-restacked a6194aaf494cb636d31b9b3e1037a8ac3753c09e
codex/v3.2.5-e13-d-pending-bizop-adapters-restacked 6d46fe3b47a2632c3eac4ffc0abe59bb6281b529
codex/v3.2.5-e13-e-acquiring-adapters-restacked 2475413b034f4885d47729dd4df155c3b5300ef1
codex/v3.2.5-e13-f-position-adapter-restacked 2d19d9cbc62328ff6410fc072b513146577a4c74
codex/v3.2.5-e13-g-manifest-coverage-restacked 71ef4fbe29d664bc9e0fd9f33cd55c9dbbafd754
codex/v3.2.7-pr1a 94d1e6fe7890ca5b745e02bd8ce92223b95e6745
codex/v3.2.7-pr1b ea41640f275f93979e7c1be0a1039d33b28dfa65
codex/v3.2.7-pr2 21afe1e378b6a4e0a5a75195254792e6b4a527a7
codex/v3.2.7-pr3 05d83dd0033172cfa40797ad92ebd4a1a98e04e1
codex/v3.2.7-pr4 822f583ee3e26ec3b8d79b4ac97dfdf4ac59e003
codex/v3.2.9-windows-diagnostics 8779c029ac94c859681d582bff378b426686dc09
v1.4.2 f9d4915821139017d47858645a0eea27eea747b1
v1.4.3 233fe3b39632ad573211dd908c3cd089dff6a306
v1.4.6 92bfa1d47243ce7d3f3641552b44d3774cb6fc61
v1.4.7 5e74a5f764b7a57ed8d6315138482cd3f2262d1b
v1.4.8 a49725663fae5a2872871a426c9613ba0f620853
v1.4.9 62500260e9934a8a33ba383f014cf6244826e695
v1.5.0 d02285e5f7aefdf12b6bd5f30b718fe140ef2ea8
v1.5.x 524e88f823a363a8c23b7f565a46d7126cab0462
v2.0.0-beta.4 42d47d605995d3b59a3a34e22b1b798ba643190e
v3.0.4 738747c54a563c621c857c3061e897ccfda0b1f6
v3.2.0 9afeb0ac4c5c7f2c6534453f7f690264c4cdaa45
v3.2.1 ac0d5be6c679558844d67e5e0d96db83d3596b65
v3.2.3 78ddffe05701ada1709cfc871ba5fff1d495f252
```

## 待人工复核（清单 C5）

- **⚠️ 渠道混合余额方式（资金红线）**：每个账户按所在子模板的余额方式出余额；同一账户命中不同方式时整批阻断；缺账单日期的行也参与冲突判断，出余额的交易缺账单日期或 MerchantId 时阻断。须用脱敏的实际银行模板复核导入时的账户归属与余额，以及已生成的同类余额与种子。提示改为「统一余额方式后整批重新导入」（分批导入会使同账户同日余额种子互相覆盖）。
- **⚠️ 人工补录余额**：补录种子键与补录弹窗的账户键改为无歧义编码（release 审查 P1：原先含 `@@` 的账户可能在未确认的情况下覆盖另一账户的人工余额，或把余额写给另一账户）。
- **⚠️ 长数字按原文读取（资金红线，B112 / B133）**：复核实际使用的银行模板导出的流水号、账号。release 审查修复了多工作表 XLSX 的串表、公式缓存值、数组公式区域等问题；仍有两种手工改写 XML 的写法可能取到另一张表或另一行的原文（B133），须确认实际使用的银行文件未经手工改写。
- **⚠️ 模板日期格式**：改格式后按错误日期生成的历史余额缺少恢复流程（B128），须业务人工复核。
- **⚠️ 费用账单行的账单日期（F4）**：费用行沿用交易行的账单日期，不可覆盖。
- **合计行识别（逻辑取值特征值候补）**：BillDate 候补含特征值时按查看过的候补识别合计行，须复核真实账单的合计行不进明细、真实交易不被误判。
- **实机**：Windows 打包版验收与映射关系管理加宽、「启用」列的实机核验未做（B105、B120）。
- **结果**：2026-11-23 合并前以上各项汇总请用户确认，用户选择「复核已通过，继续发版」；未提供复核人与逐项明细。Windows 打包版实机验收未做（B105、B120，目标 v3.2.22）。

## 验证（清单 C4）

- release 整体审查各轮：修复后 lint、架构检查、E13-G 执行清单（`--write`，234/234）通过；完整单测（第 14 轮 9057 个：9053 通过、4 跳过、0 失败）与两组集成测试（各 45 个脚本）全部通过。
- 第 15 轮修复：受影响单测 83 个通过；集成 `statement-template-date-format` 35/35、`statement-bill-split-fee-bill` 135/135、`statement-channel` 188/188、`statement-currency-big-account` 21/21；反向验证 4/4。
- `npm run release-check`（第 15 轮修复、升版与发布文档，即候选提交的内容）通过：lint、架构检查（668 个文件）、smoke、单测 9058 个（9054 通过、4 跳过、0 失败）、集成 90 个脚本全部通过；集成回写 `rules/integration-test-policy.md`「七」章节，随候选提交纳入。
- PR #258 Windows CI：候选 `a4da8540`（run 45208706075）全部通过（11 项）；Codex 云端审查（`a4da8540`）无发现。

## 合并、标签与发布（清单 E–F）

| 项目 | 结果 |
| --- | --- |
| 合并 | PR #258 以 merge commit 合并（2026-11-23 08:04 PST），`M` = `0e996340900916c3059a4422fbc197b2577f6c38`，父提交 `f217c8fd`、`a4da8540`，tree 与 `a4da8540` 相同；合并前再次核对远端 main 未推进 |
| main CI | `0e996340`（run 45212428019）通过，11 项 |
| 正式标签 | 附注标签 `v3.2.21`（对象 `d46cd297`）→ `0e996340`；推送前核对远端 main 仍为 `M`，只推该标签 |
| 发布流程 | run 45215522398，`production-release` 由用户授权经 `gh` 审批；21 个步骤全部成功。Windows 上 `release-check`：单测 577 个文件、0 失败；集成 90 个脚本全部通过，其中 `renderer-lifecycle` 506/506 用时 85.8 秒 |
| Release | [v3.2.21](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.2.21)，2026-11-23 08:58 PST 发布，非 draft、非 prerelease，为 Latest |
| 产物 | `bank-bill-excel-tool-setup-3.2.21.exe`（106720315 字节）、`bank-bill-excel-tool-setup-3.2.21.exe.blockmap`（111411）、`bank-bill-excel-tool-portable-3.2.21.exe`（106223452）、`latest.yml`（372） |
| `latest.yml` | `version: 3.2.21`，`path` 与 `files[0].url` 均为安装包，`size` 与安装包附件一致；本机下载安装包重算 SHA512（base64）与 `latest.yml` 一致 |
| 未做 | Windows 实机安装、升级与业务抽查未做（B105、B120） |

## 结论

v3.2.21 已发布并完成自动核验（含本机重算安装包 SHA512）；Windows 实机验收待补（B105、B120）。`release/v3.2.21` 与 5 个模块分支已被 `v3.2.21` 标签包含，按 `AGENTS.md`「约定与分支」可在授权后删除；`feat/cross-sheet-backfill` 未被任何正式标签包含，顺延（B129），保留。
