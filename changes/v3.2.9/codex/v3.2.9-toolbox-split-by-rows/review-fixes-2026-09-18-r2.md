# 第二轮审查修复｜v3.2.9 工具箱按行拆分

日期：2026-09-18。已核实 [第二轮审查](review-2026-09-18-r2.md) 的 **R05 / P2 成立，并完成修复**。修改仍位于 `codex/v3.2.9-toolbox-split-by-rows` 原隔离 worktree，基线为 `2ba9ef14fe972363b604955636cff0c9ac53700f`，未提交、推送或发布。原审查报告及证据保留不改。

## 核实与修复

FilePlan 和生命周期预检已有父目录身份保护，但 rows 调用 `publishToolboxArtifacts` 时只构造 `targetPath`，wrapper 只追加文件快照。因此，生命周期预检后、生成目录创建前，选定目录被重命名并在同一路径创建新目录时，两个原本不存在的目标仍可能发布到新目录。

本轮先加入执行真实 Main prepare/execute、公共 wrapper、生成器和 Worker Publisher 的回归。修复前再次得到 `success`，确认 R05 可复现。影响限于确认目录与实际输出目录的身份不一致；本轮未复现已有用户文件被覆盖。

产品代码仅调整 `src/main.js` 的 rows 发布目标映射：从冻结的 `taskContext.fileEvidence.filePlan.outputs` 逐项取 `filePath` 和 `targetParentIdentity`，分别传入 `targetPath` 与 `expectedTargetParentIdentity`。公共 wrapper、Publisher 和 journal 格式继续使用原实现；目录身份来自确认前的 FilePlan。

## 新增回归

文件：`tests/unit/main-process/toolbox-row-split-parent-identity.test.js`。

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 生命周期预检通过后、生成前重命名并重建父目录 | 错误返回成功，将两份文件发布到新目录 | 返回失败，Publisher 错误码 `TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED`；两个目录均无正式输出，旧目录文件和新目录文件均保持原内容；归档结算不执行 |
| 全部产物校验完成后、进入 Worker 发布前替换父目录 | 因 generation 路径消失返回 `TOOLBOX_PUBLICATION_INVALID_FILE`，缺少父目录身份验证 | 先识别父目录变化并返回 `TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED`，不进入正式发布或归档结算 |
| 父目录保持不变 | 正常发布，但 journal 缺少原确认父目录身份，新增断言失败 | 两份 XLSX 正常发布并回读表头/数据；journal 各项保存原确认父目录身份，归档结算调用一次 |

回归保持生产 `.toolbox-rows-*` 布局，生成目录随父目录一起被重命名，没有迁移临时产物来制造不可达状态。每个用例使用独立临时目录并清理自身数据。系统文件对话框、调度及归档结算为替身，未启动完整业务 Main 或桌面 TaskLifecycle 流程。

证据：[修复前 0/3](evidence/review-fixes-2026-09-18-r2/before.log)、[修复后 3/3](evidence/review-fixes-2026-09-18-r2/after.log)。三个修复前失败包含正常发布时的 journal 身份断言，不表示正常生成本身失败。

## 本轮验证

运行时：Node 24.13.0，本机 macOS。

| 检查 | 结果 | 证据 |
|---|---|---|
| rows、原文件覆盖竞态、新父目录竞态、Main IPC、IPC 合同、FilePlan、TaskLifecycle、Worker Publisher、归档及发布恢复 | **221/221 PASS，0 失败、0 跳过**，包含上述 3 项新增回归，不重复累计 | [focused.log](evidence/review-fixes-2026-09-18-r2/focused.log) |
| `scripts/smoke-test.js` | PASS | [smoke.log](evidence/review-fixes-2026-09-18-r2/smoke.log) |
| 本轮 Main 与新增测试 eslint、Main 语法、差异空白检查 | PASS | [checks.txt](evidence/review-fixes-2026-09-18-r2/checks.txt) |
| 代码范围 | 产品代码相对复审快照只有 rows 发布映射一处变化 | [Main 差异](evidence/review-fixes-2026-09-18-r2/main.diff)、[源码摘要](evidence/review-fixes-2026-09-18-r2/source-manifest.json) |

复验：

```sh
node --test tests/unit/main-process/toolbox-row-split-parent-identity.test.js
node scripts/smoke-test.js
```

TechDoc §5.2 已补充父目录身份从 FilePlan 到 Publisher 的字段映射；Spec 的既有目录保护要求不变。

## 关联功能 review 与验收边界

- 对照 `rules/important-variables.md`：本轮触及 Main 定义文件中的 `dialog`、`app` 关联范围，但没有修改原生对话框、取消分支或应用启动/退出钩子。取消覆盖、旧拆分 IPC、FilePlan、发布与归档恢复回归均已通过。
- 本轮没有前端改动，未重复执行 Electron UI 和 K=999/1000 实际生成容量验收。上轮 UI 通过记录保留，不记作本轮重新验证。
- 未重跑完整 `release-check`；实施记录中的整轮状态仍为 **FAIL**，之前 Biz OP 超时用例单独通过不替代整轮门禁。
- Windows、Excel/WPS、网络卷和真实 Main 系统对话框全流程仍未验收。本次专项修复通过不作为完整发布就绪结论。
