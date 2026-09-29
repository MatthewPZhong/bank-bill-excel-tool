# TechDoc — v3.2.11 存档中心批次删除确认文案精简

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.11 |
| 功能分支 | `codex/v3.2.11-archive-center-delete-confirm-copy` |
| 集成分支 | `release/v3.2.11` |
| 分支创建基线 | 当前本地 `main`，提交 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`（与 `v3.2.10` 一致） |
| 日期 | 2026-09-29 |
| 状态 | 已实施；lint、18 项聚焦回归及浅色/深色工厂截图验证通过；正式交付门禁与产品 Main/Windows 验收未执行；未提交、未推送 |
| 关联 Spec | [Spec](./spec.md)，6 项验收标准 |
| 依赖 | 现有存档中心预检/删除接口和确认弹窗；无新增依赖 |

## 一、Spec 评审意见（技术角度）

### 1.1 可直接落地的部分

移除指定说明只涉及一个确认弹窗调用点，不需要修改数据模型、IPC 或后台删除服务。当前生产实现已将固定说明和数量说明拼接到 `message` 中，可直接将其还原为既有确认问题。

实现依据：[`src/renderer/dialogs/app-settings.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/dialogs/app-settings.js#L1380-L1485)。Renderer 宿主和领域边界依据：[`src/renderer/README.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/README.md)。

### 1.2 技术意见 / 风险提醒

| 风险 | 处理 |
| --- | --- |
| 将“去掉文案”实现为不再确认、直接删除 | 保留 `createConfirmDialog`、两按钮、取消回调及原确认提交回调。 |
| 前端不再展示数量后误删预检或后端字段 | 仅移除本地展示变量；`prepareDeleteBatch`、`prepared`、`confirmationToken` 及后端摘要保留。 |
| 精简后残留换行，或批次号失去转义 | `message` 只保留原确认问题，保留 `<strong>` 与 `escapeHtml(batchNumber)`。 |
| 同版本其他分支同时修改设置文件 | 按删除确认代码块做局部合并；不得以整文件替换覆盖默认值、外观或存档设置的其他改动。 |

### 1.3 与 Spec 的差异

无。本方案不增加替代说明，不改变删除范围、流程或其他提示。

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
| --- | --- | --- |
| `src/renderer/dialogs/app-settings.js` | 修改 | 精简批次删除弹窗 `message`，删除展示专属局部变量。 |
| `scripts/renderer-lifecycle/fixtures/app-settings.js` | 修改 | 复用真实设置/公共确认工厂和已有交互回归，补充正文、数量摘要、预检失败及批次号安全显示断言。 |
| 本目录 `spec.md` / `techdoc.md` | 文档交付 | 记录本分支产品边界、实现差异和验收；存放目录见 Spec §5，文件间相对链接已按当前文件名调整。 |
| 本目录 `evidence/` | 新增验证产物 | 复用现有 fixture 的隔离截图脚本、浅色/深色截图及生产代码/测试/CSS 输入哈希。 |

已静态核对固定基线中的 [`app-settings` fixture](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/scripts/renderer-lifecycle/fixtures/app-settings.js)：已有取消后零删除、原令牌单次提交、完整删除/待清理反馈、失败与迟到结果、保留期限保存期间的生命周期用例。实施时复用这些用例并新增 11 项回归；最终聚焦运行 18/18 PASS，具体结果与证据边界见 §六。

不计划修改公共 `createConfirmDialog`、全局 CSS、`src/preload.js`、Main handler、后端存档服务、数据库、依赖或版本号。

## 三、需求实现

### 3.1 实现方案

保持原调用顺序：

```text
点击批次删除
  → 保留原设置保存/生命周期检查
  → prepareDeleteBatch(batchId)
  → 预检结果有效且存在 confirmationToken
  → 打开确认弹窗（本次仅精简正文）
      ├─ 取消：沿用原取消/返回流程，不提交删除
      └─ 永久删除：deleteBatch(batchId, prepared.confirmationToken)
            → 沿用原成功、失败或清理未完成反馈
            → 按原逻辑刷新列表、详情与统计
```

### 3.2 改动点

固定基线中，修改目标是批次删除流程内紧邻 `createConfirmDialog` 的 `fileCount`、`scopeSummary` 与 `message`。使用语义锚点定位，实施时以当前分支源码核对行号。

删除以下展示专属代码：

```javascript
const fileCount = Number(prepared.summary?.fileCount);
const scopeSummary = Number.isSafeInteger(fileCount) && fileCount >= 0
  ? `<br>本次涉及 ${fileCount} 个存档文件副本。`
  : '';
```

将原 `message`：

```javascript
message: `确定永久删除批次 <strong>${escapeHtml(batchNumber)}</strong> 吗？<br>该批次信息及存档中心保存的原始文件将一并删除，删除后无法恢复。${scopeSummary}`,
```

替换为：

```javascript
message: `确定永久删除批次 <strong>${escapeHtml(batchNumber)}</strong> 吗？`,
```

### 3.3 关键保留内容

以下为必须保持的合同，不是替换整个回调的示例：

```javascript
confirmText: '永久删除',
cancelText: '取消',
onCancel: restoreSettingsDialog,
```

实际删除仍调用：

```javascript
getArchiveCenterApi().deleteBatch(batchId, prepared.confirmationToken)
```

继续保留原 `onConfirm` 完整实现、`deleteBusy`、按钮禁用、`canClose`、请求代次与宿主资格检查，以及 `metadataDeleted` / `fullyDeleted` 结果判断。不能用简化回调替换这些逻辑。

### 3.4 注意事项

不做全仓旧文案删除：历史版本文档、变更前示例及测试中的反向断言可能合理保留旧字符串。验收对象是当前确认弹窗的可见正文，而不是整个仓库不再出现这些文字。

不要删除 `prepared`，不要删除后端 `summary.fileCount`，不要改动预检返回结构。显示逻辑不再依赖数量，与后台仍可能产生/使用数量摘要是两回事。

文案精简不应改变确认按钮可用条件，也不能掩盖“批次记录已删除、文件清理尚未完成”等真实结果提示。

## 四、任务分解与验证

| 序号 | 任务 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| T1 | 核对基线、工作区、分支和本任务文档是否已存在 | 已核对当前 `main`，从同一提交创建独立 worktree 与功能分支，复用修订后的两份附件 | 已完成（2026-09-29；后续代码实施前复查工作区） |
| T2 | 修改本弹窗文案和局部展示变量 | 差异仅为移除两项展示变量并精简 `message`，无公共组件或后端更改 | 已完成 |
| T3 | 补充正文与交互回归 | 原有 7 项加新增 11 项，18/18 PASS；lint 与语法检查通过 | 已完成（聚焦验证） |
| T4 | 验证浅色/深色主题下实际确认弹窗 | 使用合成批次、生产工厂和产品 CSS；2/2 PASS 并检查两张截图 | 已完成（隔离工厂预览，不代表完整产品 GUI 验收） |
| T5 | 按授权进入集成与交付 | 合入本轮 release；正式交付按仓库门禁执行 | 未执行，等待后续集成授权 |

### 4.1 必要回归设计

在 `scripts/renderer-lifecycle/fixtures/app-settings.js` 的真实设置/公共确认工厂入口，针对确认子弹窗的 `.alert-message` 断言确认问题及目标批次号仍存在，固定说明和动态数量说明不存在，且没有为删除说明保留的尾随 `<br>`。数量摘要覆盖 0、1、多份以及缺失；不要把数量边界改造成新的业务准入规则。

复用 fixture 中已有的取消和确认用例：取消允许已经发生的预检调用，但实际 `deleteBatch` 调用次数必须为 0；确认传入本批次 ID 和本次原预检令牌，重复点击只产生一次提交。继续使用合成批次和受控 API，不删除用户真实文件。

沿用已有删除失败、文件清理未完成、成功刷新及生命周期限制用例；按 AC-05 补充预检失败等尚缺的最小回归，断言没有进入实际删除流程。不得用仅搜索源码字符串的检查代替交互测试。

AC-06 的安全显示验证已使用实际生产函数：fixture 通过现有 `acorn` 解析器从 `src/renderer.js` 提取 `escapeHtml` 函数声明，取代原 `String` 替身；只加载该函数，不启动应用壳或用户数据。合成批次号包含 `<`、`>`、`&`、双引号及 `<em>` 文本，断言可见文本保持原值且未生成对应 HTML 元素。生产转义函数与公共确认组件均未修改。

### 4.2 验证入口与证据边界

在实施 worktree 根目录执行聚焦检查：

```bash
npm run lint
node scripts/test-renderer-lifecycle.js app-settings
```

测试启动器支持按 fixture 名称筛选；全量 Renderer 工厂回归仍使用 `node scripts/test-renderer-lifecycle.js`。现有 `scripts/integration/renderer-lifecycle.js` 已将这些用例接入集成测试入口，本需求无需新增测试框架或重复注册。

实施时先核对当前 `package.json.scripts` 与现有用例组织，再执行相应检查并记录结果。`package.json` 现有存档中心预览命令可以帮助进入页面，但不能假定其默认截图已经覆盖“批次删除确认”子弹窗；人工或自动测试必须实际打开该弹窗。

正式 GUI 交付、PR-ready 或发布时，按 [`CODEX.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/CODEX.md) 执行 `npm run release-check`；局部检查不代替正式门禁。本轮已执行聚焦检查及隔离工厂截图验证，结果见 §六；完整 `release-check`、产品 Main 与 Windows GUI 验收尚未执行。

## 五、实施计划（Commit 粒度）

以下为提交建议。功能分支中的代码、测试和文档已完成本轮实现与聚焦验证；未提交、推送或创建 PR。

| 序号 | 建议 Commit message | 范围 |
| --- | --- | --- |
| 1 | `fix(archive-center): 精简批次删除确认文案` | 文案最小差异、必要测试与本任务文档 |

分支路径：

```text
当前 main（18b82b4328cf5e00c1b2549d373a5b2f2677215c；与 v3.2.10 一致）
  → codex/v3.2.11-archive-center-delete-confirm-copy
  → release/v3.2.11
  → main（通过本轮发布 PR）
```

功能分支已创建，后续合入 release 与 main 的步骤仍为计划；本次未创建集成分支，也未执行合并或发布。分支/集成规则来源：[`AGENTS.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/AGENTS.md)。已有 release 集成成果直接核验复用，不重建或清空；发布前按仓库规则纳入必要的最新 main 更新。

## 六、实施日志

### 2026-09-29 — 只读核对与方案整理

已通过 GitHub 读取远端 main 固定提交，核对其与 `v3.2.10` 一致；阅读项目规则、文档存放规则、Renderer 边界及本任务相关生产代码。已确定最小修改点和回归范围。

本次仅在交付环境生成 Spec / TechDoc 文件及压缩包；未写入项目仓库，未修改生产代码，未创建或推送分支，未执行删除或功能测试。不将“方案可实施”表述为“功能已完成”。

文档格式参考 [`changes/templates/spec.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/changes/templates/spec.md) 与 [`docs/templates/TechDoc-template.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/docs/templates/TechDoc-template.md)。模板仅提供结构，不复用其中的旧版本、旧目录或完成状态。

### 2026-09-29 — 方案审查意见修订

- 修复 R1：两份独立附件的相互链接改为实际文件名，Spec 的技术章节链接同步修正；补充后续归档更名时同步链接的约定。
- 纳入 O1：明确 `scripts/renderer-lifecycle/fixtures/app-settings.js` 为测试修改位置，复用已有交互回归，补充聚焦运行命令和特殊字符批次号的转义验证要求。
- 本轮仅修改方案文档并核对链接、代码位置和两份文档的一致性；未修改生产代码或测试文件，未运行功能测试、GUI 验收或发布门禁。

### 2026-09-29 — 基于当前 main 建分支并存放文档

- 创建基线：本地 `main` 的 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`；与原方案采用的正式标签 `v3.2.10` 一致。
- 功能分支：`codex/v3.2.11-archive-center-delete-confirm-copy`。独立 worktree：`/Users/pzhong/.codex/worktrees/archive-delete-copy/bank-bill-excel-tool`；创建前未发现同名本地分支，新 worktree 初始干净。
- 文档位置：`changes/v3.2.11/codex/v3.2.11-archive-center-delete-confirm-copy/spec.md` 与同目录 `techdoc.md`。直接复用本任务修订后的附件，调整相对链接、基线与存放状态；6 项 AC 和生产代码方案保持一致。
- 本轮仅创建分支并存放文档，未提交、推送或实施功能；未运行功能测试、GUI 验收或发布门禁。主工作区的既有材料未纳入新 worktree。


### 2026-09-29 — save-spec、实现与聚焦验证

- `save-spec`：核对目标版本、分支与文档目录，直接复用现有 Spec / TechDoc，未另建重复正文。
- 生产改动：删除 `fileCount` / `scopeSummary` 两项局部展示变量，`message` 只保留转义后的批次号与确认问题。确认、取消、预检令牌、忙碌限制、永久删除范围、失败及待清理反馈均沿用原代码。
- 测试改动：在现有 app-settings fixture 新增 5 个数量摘要场景、1 个特殊字符批次号场景、3 个预检失败/缺少令牌场景及 2 个浅色/深色重新打开场景。复用原有 7 项交互与生命周期回归；生产转义函数通过 AST 提取后执行。
- 回归有效性：保持生产旧文案时，修正后的测试为 10/18 PASS，8 项失败均由旧说明或残留换行触发；应用生产修改后为 18/18 PASS。
- 运行环境：复用与本 worktree `package-lock.json` 一致的本地依赖，未修改依赖文件；Electron 为 36.9.5。测试隔离 `userData` / `Documents`，不启动产品 Main，不读取或删除真实业务数据。
- 执行环境问题已消解：受限环境首次启动 Electron 返回 SIGABRT，另一次无输出运行超时后已清理其专属进程；后续在允许桌面进程的前台终端完成全部聚焦验证及截图。

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `npm run lint` | PASS | 生产源码静态检查 |
| `node scripts/test-renderer-lifecycle.js app-settings` | 18/18 PASS，exit 0 | 真实 Electron DOM、生产工厂、受控 API |
| `node --check scripts/renderer-lifecycle/fixtures/app-settings.js` | PASS | 测试文件语法 |
| `node --check changes/v3.2.11/codex/v3.2.11-archive-center-delete-confirm-copy/evidence/capture-delete-confirm.cjs` | PASS | 截图脚本语法 |
| `node changes/v3.2.11/codex/v3.2.11-archive-center-delete-confirm-copy/evidence/capture-delete-confirm.cjs` | 2/2 PASS，exit 0；两张截图已检查 | 复用主题回归，真实确认工厂和产品 CSS；不包含产品 Main |
| `git diff --check` | PASS | 本轮差异格式 |

验收对应关系：AC-01/02 由确认正文与 5 个摘要场景覆盖；AC-03/04 由原取消、原 token 和防双击用例覆盖；AC-05 由 3 个预检场景与原失败/待清理反馈用例覆盖；AC-06 由刷新、生产转义函数及两种主题的可见性、取消重开和截图检查覆盖。这里的结果属于聚焦工厂验收，不表示完整产品或 Windows 验收通过。

证据：[浅色确认框](./evidence/delete-confirm-light.png)、[深色确认框](./evidence/delete-confirm-dark.png)、[截图摘要与输入哈希](./evidence/delete-confirm-preview.json)、[可复跑的截图脚本](./evidence/capture-delete-confirm.cjs)。截图确认无旧说明、无专属空行，批次号与两个按钮完整可见。

完整 `release-check`、产品 Main/Windows 验收、集成、提交、推送与发布均未执行。本轮没有改变后台删除合同，也未触碰真实批次。

## 七、兼容与回滚

无依赖升级、数据迁移或存量数据重写。既有删除 API、预检摘要和确认令牌合同保持兼容。

回滚时只还原本需求的文案和测试差异，不撤销同文件其他功能分支的改动。回滚文案不能恢复已经永久删除的数据。

## 八、待定技术问题

本轮实现与聚焦验证无未解决的技术阻塞。后续集成前重新核对工作区与最终内容，按正式交付要求执行完整门禁及适用平台验收；不得将本轮聚焦结果视为发布完成。
