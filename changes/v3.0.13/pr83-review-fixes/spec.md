# PR #83 review 修复：导入目录记忆健壮性收敛

> 目标分支：`codex-3.0.13-import-dir-memory`（PR #83），修复后 84/85/86 依次 rebase
> 来源：PR #83 外部 review 8 条发现（全部验证属实），用户指示"全部修复"
> 状态：实施中

## 修复清单

| # | 发现 | 修复方式 |
|---|------|---------|
| 1 | 🔴 同步 stat 断连网络盘冻结主进程 | `resolveExistingDirectory` 改 async：单次 `fs.promises.stat` 与 300ms 超时竞速，超时/异常返回 undefined |
| 2 | 🔴 SQLite 读写无防护污染 handler | `getImportDialogDefaultPath` / `rememberImportDialogDirectory` 内部 try/catch 静默降级——记忆失败不影响导入主流程 |
| 3 | 🟡 9 处弹窗静默变窗口模态 | 保留 mainWindow parenting（视为改善），在 PR body 显式声明该行为变更 |
| 4 | 🟡 scope 字面量与 ALL_MODULE_IDS 零耦合 | `IMPORT_DIALOG_SCOPES` 常量表：模块对齐部分从 `ALL_MODULE_IDS` 派生（排除无导入入口的 new-account-generator），额外入口显式列出；新增扫描测试：main.js 中 `showImportOpenDialog('…')` 字面量必须 ∈ 常量表，且裸 `dialog.showOpenDialog` 只允许 background:select-file 白名单 1 处 |
| 5 | 🟡 同 scope 混装 JSON 配置与 xlsx 业务导入 | `scenarios:import-bundle` → `bank-statement-process-bundle`；`template:import-bundle` → `template-bundle` |
| 6 | 🟢 scoped 目录失效时全局兜底失灵 | settings-repository 新增 `getLastImportDirectoryCandidates`（scoped → global 去重序列），`getImportDialogDefaultPath` 逐个候选做存在性校验取第一个有效值；解锁旧测试 |
| 7 | 🟢 PR body 缺关联功能 review 段落 | 更新 PR #83 body：补 ⚠️ 段落（dialog Runtime-state 真命中 + settingsRepository Important-skeleton + getSetting/setSetting Minor） |
| 8 | 🟢 分支无版本 bump | 堆叠设计使然（bump+三件套在栈尾 #86 eb1c694），PR body 注明，代码无动作 |

## 附带修复（review 次要备注）

- `setLastImportDirectory` 空白 scope 双写全局 key：改用 `buildLastImportDirectoryKey` 结果与全局 key 比较
- 调用方显式传 `defaultPath` 时记忆值不再覆盖它（spread 顺序修正）

## 不改的

- 全局兜底"新入口首次 = 其他模块上次目录"是 body 明示特性，保留
- `setLastImportDirectory` 无条件写全局 key（兜底特性的实现基础），保留
- 保存类弹窗（showSaveDialog）不在本次范围

## 验证

- 更新 `tests/unit/main-process/import-dialog-state.test.js`（async 化 + 新增：repo 抛错降级、超时降级、scoped 失效回落 global、显式 defaultPath 优先）
- 更新 `tests/unit/backend/database/settings-repository.test.js`（candidates + 空白 scope）
- 新增 `tests/unit/main-process/import-dialog-scope-scan.test.js`（发现 4 的两条扫描）
- 修复后：`npm run test:unit` 全绿；栈顶 rebase 完成后 `npm run release-check`
