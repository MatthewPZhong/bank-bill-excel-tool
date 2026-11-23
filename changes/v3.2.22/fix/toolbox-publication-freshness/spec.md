# Spec：工具箱合表 / 按字段拆分的确认前冻结与发布前核对（B57、B58）

> status: done
> created: 2026-11-23
> 目标版本：v3.2.22（暂定，发版时按 weekly-release 调整）
> 适用分支：`fix/toolbox-publication-freshness`
> 分支基线：正式标签 `v3.2.21`（`0e996340`）
> 依据：`knowledge/backlog.md` B57、B58 的关闭条件；2026-11-23 用户选定本轮修复范围
> 参照实现：按行拆分 `src/main-process/toolbox-row-split/service.js` `prepareRows`（确认前冻结、确认后核对）

## 1. 背景

| 编号 | 问题 |
| --- | --- |
| B57（P1） | 按字段多文件拆分在「覆盖全部」确认之后才形成 FilePlan：确认弹窗等待期间外部新建的目标、或被替换的已列出目标，会被当作合法目标覆盖 |
| B58-T3（P2） | FilePlan 冻结后源文件被替换，合表 / 单值 / 多文件拆分仍从原路径读新内容并正式发布，随后输入归档因 `ARCHIVE_SOURCE_CHANGED` 失败，正式输出缺少相符的输入归档 |
| B58-T4（P2） | 发布包装层只补目标文件快照，合表与单值 / 多文件拆分未把冻结的父目录身份交给发布器，目标目录被同路径替换后仍发布成功 |

## 2. 决策

| 编号 | 决策 |
| --- | --- |
| D1 | 多文件拆分在目录选定、非普通文件预检之后立即 `normalizeFilePlanV1` 冻结全部目标（含尚不存在的）与源文件；按冻结快照的 `targetSnapshot.exists` 列出冲突再弹「覆盖全部」；确认后 `assertFilePlanFresh`，确认期间的新建 / 替换报 `ARCHIVE_TARGET_CHANGED` 并取消，不覆盖任何文件。`prepared.filePlan` 就是确认前冻结的计划，契约层（`ipc-task-contract.js`）直接沿用，生命周期在执行前再核对一次 |
| D2 | 合表、单值拆分在保存框返回后同样立即冻结（系统保存框自带覆盖确认，冻结点与其相邻） |
| D3 | 发布包装层 `publishToolboxArtifacts` 带冻结 FilePlan 时：目标须与计划输出逐一对应（数量、路径一致）；父目录身份统一从计划输出取出交给发布器复核（目录被同路径替换即 `TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED`）；发布前再核对一次计划输入，源文件被替换或改写即拒绝（合表 `ARCHIVE_INPUT_CHANGED`，拆分沿用 `TOOLBOX_SPLIT_READ_CONTEXT_STALE`「拆分源文件在读取后已变化，请重新选择」） |
| D4 | 目标文件与父目录的复核仍由发布器在提交时完成，包装层只补发布器不掌握的输入快照；共享发布器（VCC 等也在用）不改 |
| D5 | 不改执行策略登记（G7 registry、mode、production 开关），也不切换后台 / 非后台路径 |

## 3. 行为与边界

- 用户可见变化：确认期间或确认后目标被外部改动、生成期间源文件被替换时，本次导出失败并提示原因，需重新操作；此前会覆盖或发布不一致的输出。
- 只读导出（持仓 / 预付等）同样经过包装层：其计划输入为空，父目录身份随之由发布器复核，只加严。
- 残余窗口：发布前核对输入到发布器提交之间仍有极短窗口，若源文件恰在此时被替换，正式输出已提交而输入归档失败（保留 receipt，按既有「存档接管待重试」处理），与按行拆分现状相同。
- 源文件「替换后再原样换回」（同 inode、同时间戳）不在快照可检测范围内。

## 4. 验收

- 单测 `tests/unit/main-process/toolbox-publication-freshness.test.js`（16 项，夹具 `tests/helpers/toolbox-main-handlers.js`，执行 Main 原始 prepare / execute 与真实发布器）：
  - 多文件拆分确认期间新建 / 替换目标时拒绝、原内容保留、冲突只列冻结时已存在的目标；确认后沿用同一计划，prepare 之后新建目标由生命周期核对拒绝；
  - 合表、单值拆分保存框返回即冻结；
  - 合表 / 单值 / 多文件：发布前父目录被同路径替换时发布器拒绝、不结算；未变时照常发布、回读正确；
  - 合表 / 单值 / 多文件：生成前、生成后源文件被替换时不发布。
  - 换回 v3.2.21 的 `main.js` 时 13 项失败（已验证）。
- 集成 `scripts/integration/toolbox-publication-freshness.js`（8 项）：CSV 源 → 正式 xlsx 回读的同类场景。
- 既有回归：`toolbox-multi-split-ipc.test.js` 源码顺序用例改为断言确认前冻结；按行拆分父目录身份用例与 rows 集成脚本仍通过（夹具补注入 `assertFilePlanFresh`、`normalizeFilePlanV1`）。
- `npm run release-check` 通过。

## 5. 未覆盖

- Windows 实机（目录替换、占用）未验证。
