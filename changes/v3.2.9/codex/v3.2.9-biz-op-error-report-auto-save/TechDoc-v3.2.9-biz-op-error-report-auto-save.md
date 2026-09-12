# TechDoc — v3.2.9 业务 OP 错误报告自动保存与操作入口精简

| 项目 | 内容 |
| --- | --- |
| 项目 / 模块 | `bank-bill-excel-tool` / 业务 OP 数据核对 |
| 目标版本 | v3.2.9 |
| 文档版本 / 日期 | 1.2 / 2026-09-11 |
| 状态 | **实现完成，review 修复定向验证通过；完整门禁候选边界见 verification.md，平台人工验收缺口见第十二节** |
| 功能分支 | `codex/v3.2.9-biz-op-error-report-auto-save` |
| 基线 | `v3.2.8^{commit}` = `2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 关联 Spec | [Spec-v3.2.9-biz-op-error-report-auto-save.md](Spec-v3.2.9-biz-op-error-report-auto-save.md)，18 条 AC |
| 依赖 | 现有 Biz OP v327 的诊断、TaskLifecycle、admission、ERRORS 导出、发布和恢复能力 |

> 本文使用“当前/已有”描述已读代码事实，使用“新增/拟/应”描述设计。1.0 中的撤回 push 属于原交付记录，1.1 为只修订文档阶段。当前 1.2 根据用户授权建立功能分支并实施，验证结果见第十二节与 implementation-notes.md；未提交、推送或执行远端撤回操作。

## 一、Spec 技术评审

### 1.1 可直接落地的部分

| Spec 要点 | 技术方案 |
| --- | --- |
| FR-01 删除错误报告按钮 | 在 `renderer-biz-op-v327.js` 删除按钮节点、事件及可见性状态，不删除 ERRORS 导出底层能力 |
| FR-02 删除任务取消入口 | 删除页面侧共享任务取消按钮及其动态移动逻辑；保留系统选择器取消、弹窗提交前取消和后端终止能力 |
| FR-03～05 自动保存 XLSX | Main 决定受管输出位置，复用 `runExport({ outputKind: 'ERRORS', ... })`，不调用 `export:pick` |
| FR-06～08 状态、去重与失败保护 | 自动报告编排包含在原 IPC 请求 promise 内；先验证身份与请求摘要并复用有效缓存，仅新请求再过业务就绪门禁；业务结果与报告结果分层 |

### 1.2 风险与处理

| 编号 | 基线事实或风险 | 本次处理 |
| --- | --- | --- |
| R-01 | `runImport()` 使用独占准入，`runExport()` 使用读任务准入；独占未释放或恢复未就绪时禁止开始读任务。[T3][T4][T5] | 导入调用退出 → 恢复 → 明确确认可读 → 自动导出，禁止在导入 `execute` 内直接嵌套导出 |
| R-02 | `reportRef` 可先于诊断登记存在；当前 import catch 可能抛错，而 IPC `failure()` 不保留任务诊断上下文。[T2][T3] | 使用 Main 内部、本请求作用域的真实任务身份；恢复后查询并核实本任务诊断，不以非空 ref 或“最近一份”报告为依据 |
| R-03 | 成功导入也可能产生内部空诊断，随后按原机制退役。[T3] | 以业务结论和可信诊断摘要判断是否应输出，不把所有诊断记录导成空 XLSX |
| R-04 | 发布与归档不是一个结果；导出可能已发布后再出现收尾错误。[T4] | 依既有 publication/recovery 事实区分已保存、确认未保存和发布待核验；不只看异常有没有抛出 |
| R-05 | 取消按钮会移动到弹窗，其他普通取消按钮则不调用任务取消接口。[T1] | 按事件语义删除，不全局删除包含“取消”的字符串或所有 dialog cancel 事件 |
| R-06 | Windows 发布校验和诊断读取保护是现有数据安全边界。[T4][T6][T7] | 保留既有导出管线，不直接从 renderer 写文件，不直接 rename/copy 内部诊断绕过任务 |
| R-07 | 当前 `register()` 先调用 `assertBusinessEnabled()`，之后才到 `operation()` 查缓存；恢复期间或完成后恢复仍未就绪时，相同请求会被 `BIZOP_RECOVERY_REQUIRED` 提前拦截。[T2][T8] | 对受缓存管理的 operation 入口调整顺序：可信身份/输入校验 → 请求摘要与缓存 → 仅新请求执行业务就绪门禁；保留其他入口门禁，详见第七节 |

### 1.3 与 Spec 的差异

无业务范围差异。技术上“自动保存”不等于任何故障下都必须输出文件：恢复门禁、文件系统错误或诊断未封存时，必须按 Spec 返回真实状态，不能绕过保护。

## 二、涉及文件清单

下表记录本轮实际改动与审查范围。已有 `v327` 文件名代表当前架构，不因版本目标为 v3.2.9 而整体重命名。

| 文件 | 实施类型 | 说明 |
| --- | --- | --- |
| `src/renderer-biz-op-v327.js` | 修改 | 删除两个类别的按钮及专用状态；保留忙碌/焦点/关闭保护；展示报告结果 |
| `src/main-process/biz-op-v327/auto-error-report.js` | 新增 | 自动报告服务：可信诊断资格检查、目标路径、受管导出调用、保存结果映射 |
| `src/main-process/biz-op-v327/ipc.js` | 修改 | 调整 operation 入口缓存与门禁顺序，在原请求生命周期内编排恢复与自动报告，增加受限 `errorReport` 响应 |
| `src/main.js` | 小范围修改 | 在 `registerBizOpV327Handlers` 装配处注入已有 `getStorageRoot`，不复制目录规则 |
| `src/main-process/biz-op-v327/import-main.js` | 小范围修改 | 增加可选 Main 内部身份回调，避免异常路径丢失本任务身份；不改变导入校验和提交规则 |
| `src/main-process/biz-op-v327/module.js` | 已审查，未修改 | 现有参数传递可复用，诊断描述符由自动报告服务同步有界读取 |
| `src/main-process/biz-op-v327/export-main.js` | 小范围修改 | `beforeStart` 绑定真实 Task 后立即调用可选 `onTaskIdentified`；来源冻结失败也能保留导出身份 |
| `src/main-process/biz-op-v327/export-inputs.js`、`read-protection.js`、`admission.js` | 回归审查 | 诊断来源、pin、门禁及关闭义务不变 |
| `src/preload.js` | 已审查，未修改 | 不新增接收绝对路径的 renderer API；已有内部/兼容导出与取消能力不做全局删除 |
| `src/renderer.js`、`index.html` | 已审查，未修改 | ACTIVE 使用专用 controller，DISABLED/API 缺失回到 legacy；legacy 无同类任务按钮 |
| `src/styles-biz-op-v327.css` | 修改 | 清除取消插槽与空列；报告文本保留换行并可选择复制 |
| `scripts/verify-biz-op-v329-renderer-dom.js` | 新增 | 隔离 Electron 原生 DOM、真实 CSS、焦点与截图验证 |
| `tests/unit/main-process/biz-op-v329-auto-report.test.js` | 新增 | 纯 Main 服务及真实任务身份回调单测 |
| `tests/unit/main-process/biz-op-v329-ipc.test.js`、`biz-op-v327-ipc.test.js`、`biz-op-v327.test.js` | 新增 / 扩充 | 真实 handler 请求重放、身份门禁、完整业务登记与六类导出回归 |
| `tests/unit/main-process/biz-op-v329-renderer.test.js` | 新增 | 页面按钮与状态交互测试 |
| `rules/integration-test-policy.md` | runner 自动同步 | 完整门禁后更新脚本清单、实际数量和耗时，不修改规则正文 |
| `scripts/integration/biz-op-auto-error-report.js` | 新增，自动被 runner 收录 | 真实诊断 → XLSX → 发布/归档集成测试 |
| `changes/v3.2.9/codex/v3.2.9-biz-op-error-report-auto-save/implementation-notes.md` | 新增实施记录 | 记录真实改动、独立审查修复与验证范围 |

不计划数据库迁移、依赖升级、平台协议扩展或报告 schema 变化。如实际实现迫使这些范围发生变化，应先更新 Spec/TechDoc 说明原因，不静默扩大改动。

## 三、需求 1：页面入口与执行状态

### 3.1 删除内容

在当前 controller 中删除：

- `reportButton` 的创建、绑定、追加及启用/显示条件；仅供按钮使用的页面 `reportRef` 状态。
- `cancelButton`、`cancelRequested` 及向 `actionPair`、弹窗 footer 移动任务取消按钮的逻辑。
- 按钮事件工厂中仅对 `cancelButton` 放行的特殊分支。
- `perform()` 向 `work` 传递的页面主动取消回调，以及仅服务于此回调的状态。

`requestId` 仍必须每次任务生成并用于请求去重，不得因为删除 `activeRequest` 状态就删除真实请求身份。可以将 request ID 限定在 `perform` 的局部作用域。

### 3.2 保留内容

`busy`、原 disabled 状态保存/恢复、当前任务弹窗、状态提示、焦点恢复、忙碌时阻止关闭任务弹窗的逻辑保留。可以使用 `aria-busy` 表达状态，将焦点放到当前弹窗 feedback 或页面状态区；不能继续调用已删除按钮的 `focus()`。

`status === 'cancelled'` 分支不能整体删除：原生文件选择/保存对话框，以及后端安全退出仍可能返回取消结果。日期选择、删除确认和“取消选取”必须逐一验证其语义。

普通导出继续使用 `pickExport()`。只有错误报告的自动保存不再调用它。主工具栏只剩被允许的入口；空的辅助 footer 不占位，【重试恢复】仍按原门禁显示。

### 3.3 反馈显示

新增一个纯展示函数解释 `result.errorReport`，由统一结果/错误展示路径使用。展示原业务消息后附加报告结果，不把 `errorReport.status === 'saved'` 映射为整个任务成功。

开始新任务时清除上一任务的报告展示上下文；刷新模块状态不能把正在显示的本次失败摘要无条件重置为欢迎语。长相对文件名应可查看和复制，不通过 `innerHTML` 注入文件名或错误文字。

## 四、需求 2：Main 自动报告编排

### 4.1 放置位置

新增服务工厂为 `createBizOpAutoErrorReportService({ getStorageRoot, module, now?, uuid? })`。实例提供 `save({ identity, businessResult, taskLifecycle, runtime, signal, onControl, onTaskIdentified, recoveryReady })`，返回 `{ errorReport?, cleanupPending? }`；`now`、`uuid` 仅供确定性测试注入。

服务只在 Main 使用，依赖通过装配注入：现有存储根目录提供者、Biz OP module、TaskLifecycle、runtime。IPC 将首次恢复的 `recoveryReady` 传入 `save`；报告 Task 的 `onTaskIdentified({taskRunId})` 在真实 `beforeStart` 绑定时传出，最后兜底也保留该身份。服务不在内部再次 `require('electron')` 决定目录，不新增保存目录配置。

编排入口放在 `ipc.js` 的原 `operation()` 请求 promise 中，而不是在 renderer 中增加一次自动点击，也不是在导入独占事务里调用导出。

```text
原 import IPC 请求（同一 requestId，期间保持 busy）
  → 验证 sender/frame、输入结构、requestId 与请求摘要
  → 有效缓存命中：同摘要复用原 entry.promise；摘要不同则拒绝，不启动新工作
  → 仅缓存未命中的新请求：业务启用/恢复门禁 → 登记请求并执行以下流程
  → 执行 runImport，捕获原业务结果及可信任务身份
  → 导入独占调用退出
  → 执行现有 recovery.run，确认是否恢复就绪
  → 就绪：读取本任务的可用诊断描述符
      → 需要报告：Main 生成路径和 FilePlan
      → runExport(ERRORS)：既有受管 XLSX 生成、验证、发布与归档
      → 再执行必要恢复/收尾并核实发布事实
  → 不就绪或不可用：构造明确的未保存/不可用反馈
  → 原业务结果 + errorReport + cleanupPending
  → 缓存原请求最终结果，再解除页面 busy
```

### 4.2 可信任务身份，不从错误字符串猜测

建议给 `runImport` 增加可选 Main 内部回调：

```javascript
// Main 内部元数据回调；不是 renderer/worker API。
onTaskIdentified({ taskRunId, reportRef })
```

在 TaskLifecycle 已给出真实 `taskRunId`、Main 已确定本次 intent 的 `reportRef` 后调用。IPC 在**该请求自己的局部上下文**内保存身份；不要使用“最后一次失败任务”全局变量。

此回调只提供关联信息，不等于声明报告有效。导入返回错误或抛错后，仍须在恢复/诊断登记完成后验证：

1. 诊断记录的 `report_ref` 与本次 Main intent 一致。
2. `task_run_id` 与本次真实导入任务一致，状态为可读取的 `READY`。
3. sealed manifest 与既有登记摘要一致，producer/载体关闭等验证由原恢复和导出来源校验执行。[T3][T6][T7]

不得直接把 worker 或 renderer 传入的路径/错误对象当成可信报告来源；不得为本次报告新造一个替代业务 Task ID。`compact()` 之前与之后都要明确哪些身份仅留在 Main，哪些是允许返回的有界元数据。

### 4.3 导出资格判断

资格判断结合原业务结果与可信诊断摘要。正常成功且无错误不输出；存在文件级/行级错误或失败任务的有效诊断说明时输出。不要仅写 `if (result.reportRef)`，也不要仅写 `sample_count > 0`。

`restoreDiagnostic()` 已有对扫描完整性、精确计数标志、样本数与字节数的验证。基线允许最多 1000 条已收集样本、8 MiB 样本文件；这些是既有约束，不是本次新增限额。[T3]

本次保留原 XLSX 的样本与说明表示，尤其保留扫描未完成、错误计数非精确、样本截断的含义。不得把“收集 1000 条样本”改写为“只有 1000 条错误”。

预检无诊断、文件选择取消、尚未形成任务的错误不调用自动导出。业务结果是失败但无法取得可信诊断时，返回 `unavailable`，保持原始失败信息。

### 4.4 恢复顺序与门禁

`runImport()` 的独占调用退出只是必要条件，不是充分条件。`recovery.run()` 正常 resolve 也不等于 `ready === true`。必须按返回结果和当前 admission 状态确认允许读取。[T5]

未恢复就绪时，不尝试靠重复调用 `runExport` 碰运气，不设置 `markRecovered()` 强行放行，不提前解除 pin。该次自动保存返回 `failed`，使用恢复受阻的有界原因，原业务结果和 `cleanupPending` 继续保留。

同步 `admission.read()` 只能读取有界元数据，不能包裹异步导出。实际导出仍由 `runExport` 自己取得 `readTask()` 并重新冻结/验证来源，避免在元数据读取与异步写出之间信任过期快照。

空诊断是否有说明内容独立于业务 status 判断：封存摘要的样本数、扫描完整性、精确计数和 `errorSamplesTruncated` 必须与可信记录一致；Main 后处理异常不会使无错空诊断变成有效报告。业务失败且仅有完整、精确、未截断的空诊断时返回 unavailable；零样本但实际截断/不完整/错误摘要仍沿用原 ERRORS 说明。

完成一次导出后执行现有必要恢复/收尾。导入恢复、报告导出、报告收尾分别记录结果；后一步失败不能把已知业务结果改写为成功，也不能否定已经确认的文件发布事实。

## 五、文件路径、FilePlan 与发布事实

### 5.1 单一目录来源

在 Main 装配点注入既有 `getStorageRoot()`。自动报告服务只补充：

```text
error-reports/<本地生成日期>/<唯一文件名>.xlsx
```

生成时间在本次保存操作开始时冻结，用同一个时间对象产生目录和文件名，避免跨午夜时目录日期与文件名日期不一致。UUID 在本次逻辑保存中只生成一次；同一请求复用同一保存结果。

使用 `path.join` 构造实际文件系统路径，用规范化相对路径用于 UI 展示。检查根目录有效且为绝对路径。创建父目录后仍需服从既有发布器的目标身份/路径安全验证，不能仅靠目录字符串检查放行文件发布。

### 5.2 使用已有 ERRORS 任务

由 Main 构造 `normalizeFilePlanV1` 支持的标准 FilePlan：

```javascript
// 拟定接线示意，不是可单独运行的替代导出实现。
{
  version: 1,
  allocation: 'eager',
  inputs: [],
  outputs: [{
    filePath: mainGeneratedTargetPath,
    role: 'output',
    sourceOperation: 'bizOpReconV327:export:errors'
  }]
}
```

调用既有 `runExport`，关键参数为 `outputKind: 'ERRORS'` 和本次已核实的 `objectId: reportRef`。不得调用 `dialog.showSaveDialog()`、`export:pick` 或要求 renderer 提交 selectionRef 才能自动保存。

继续沿用真实导出 Task、来源冻结、worker 生成、工作簿验证、publication、归档及清理义务。不要为了减少改动直接将内部 JSONL 命名为 XLSX，不要让 Main 临时重写一套不同列规则的报告 writer。[T4][T6]

UUID 降低重名风险，但不作为覆盖已有用户文件的许可。检测到意外目标冲突时，在开始发布前重新选择唯一目标，或按已有安全策略失败；不得覆盖旧错误报告。

### 5.3 保存成功的判断

正常路径以既有 `runExport` 成功返回的发布证据和目标文件为准。目标类型、文件身份、完整性校验继续由现有导出/发布流程承担；额外 `lstat` 非空检查只能辅助，不能替代工作簿内容与哈希验证。[T4]

`runExport` 抛出异常时，不能直接断言文件未保存。通过真实导出 task 身份（现有 control 的 `carrierIdentity.taskRunId`、返回的 taskRunId，或必要的 Main 元数据钩子）结合原 publication/recovery 查询进行判定：

| 已知事实 | 对外报告状态 |
| --- | --- |
| 发布确认完成且文件有效 | `saved`；归档未结束另带提示 |
| 明确尚未发布或已按原机制完成回滚 | `failed` |
| 已进入发布但结果/清理仍待核验 | `pending`，保留真实任务及现有恢复证据 |
| 没有本任务可读取的结构化诊断 | `unavailable` |

不得自动重新导入或立即换一个文件名重做结果未明的发布。对已经开始的导出，沿用现有恢复；对尚未开始的保存失败，本期没有跨启动自动补导队列。

### 5.4 诊断生命周期

保留成功批次空诊断的既有退役流程。错误诊断不能因为报告按钮被删除，或因为一次自动保存失败，就被主动退役/删除。

不要提前释放报告读取 pin，也不要删除尚未确认归档/恢复完成的 staging。可用错误诊断的最终保留/回收仍遵循原生命周期；本次不引入无限期保留策略或通用存档配置变化。[T7]

## 六、IPC 响应与页面契约

### 6.1 业务结果与报告结果分层

原 `status`、`code`、`message`、`summary` 继续表示业务操作结果。新增可选 `errorReport` 仅表示本次错误报告的保存情况。failed 原因按错误码白名单映射为固定中文权限、磁盘空间、目标占用/变化、资源预算/等待提示，未知异常提供通用排障建议；不回传原始异常 message/path/stack。只有已确认未保存时采用错误原因；发布后异常不能将 saved/pending 降级。以下是已实现 DTO 示例：

```javascript
{
  status: 'error',
  code: 'BIZOP_IMPORT_REJECTED',
  message: '本次导入未通过校验',
  summary: { /* 保留既有、经过校验的有界摘要 */ },
  cleanupPending: false,
  errorReport: {
    status: 'saved',
    fileName: '业务OP导入错误报告-20260911-173000-<UUID>.xlsx',
    relativePath: 'error-reports/2026-09-11/业务OP导入错误报告-20260911-173000-<UUID>.xlsx',
    taskRunId: '<真实的报告导出任务ID>',
    pendingArchiveHandoff: false
  }
}
```

这是字段示意，不是本次真实任务结果。成功且不需要报告时省略 `errorReport`。

### 6.2 errorReport 判别联合

| status | 允许字段与语义 |
| --- | --- |
| `saved` | `fileName`、`relativePath`、真实导出 `taskRunId`（已知时）、`pendingArchiveHandoff` |
| `failed` | 有界 `code`、用户可读 `message`、真实任务 ID（已创建且可用时）；不返回暗示已保存的路径 |
| `pending` | 有界 `code`、`message`、已开始发布的真实 `taskRunId`；说明待恢复核验，不声明文件存在或不存在 |
| `unavailable` | 有界 `code`、`message`；仅表示没有可用结构化报告，不覆盖业务错误 |

拟定附加错误代码可以使用 `BIZOP_AUTO_REPORT_SAVE_FAILED`、`BIZOP_AUTO_REPORT_RECOVERY_REQUIRED`、`BIZOP_AUTO_REPORT_PUBLICATION_PENDING`、`BIZOP_AUTO_REPORT_UNAVAILABLE`。实现时遵守现有错误码约束，不把操作系统异常堆栈原样放入公开响应。

`compact()` 或最终显式响应构造器应仅允许这些字段。当前 IPC 的输入/响应预算仍保持不变，不扩大到传业务行或完整 manifest。`failure()` 的异常分支也要与正常错误返回分支一样保留本请求的可信诊断关联，再由 Main 服务构造 `errorReport`。[T2]

### 6.3 相互独立的三种状态

- 业务失败 + 报告已保存：业务仍然失败，页面显示失败摘要及保存位置。
- 报告已保存 + 归档未决：文件保存成功，不能用归档异常改写为“未保存”。
- 报告发布未知：必须标为 pending，不能用“未抛异常”或“有一个路径”推断成功。

第二次恢复有了更明确的发布事实时，以核实后的事实更新本次响应。若仍未知，保留 pending；不宣传尚未实现的自动补导能力。

## 七、去重、取消与跨启动边界

现有 `operation()` 用 sender ID 与 request ID 关联请求，并按请求内容摘要防止同 ID 改参；完成后缓存保留约 10 分钟，进程重启不保留该 Map。但当前 `register()` 在进入 `operation()` 前执行 `assertBusinessEnabled()`，后者同时检查模块启用状态和 `recoveryReady`。因此仅保留原缓存代码并把自动报告加入 promise，不能满足 FR-07 在恢复期间的重放承诺。[T2][T8]

本次必须调整受请求缓存管理的 operation 入口顺序：

1. 在统一的异常响应构造范围内，先校验可信 sender、主 frame、输入字段白名单/预算和 `requestId`。非法调用不得通过猜测 request ID 读取缓存。
2. 按现有有效期规则清理已过期的完成请求，以 `senderId:requestId` 查找请求，并比较包含操作类型和参数的原摘要。同 ID 改参仍返回 `BIZOP_REQUEST_CONFLICT`。容量淘汰仅在确认是新请求后执行，不得先淘汰当前可能命中的有效缓存。
3. 同一 sender 的有效请求命中且摘要相同时，直接共享原 `entry.promise`。此路径不重新消费 `selectionRef`，不运行导入、恢复、诊断读取或报告保存，也不因当前 `recoveryReady=false` 拒绝已有结果。
4. 仅缓存未命中的新请求执行既有 `assertBusinessEnabled()`、忙碌及容量检查；通过后登记 entry，再进入执行 promise。查缓存、准入和登记之间不得新增异步间隔，避免两个并发新调用都绕过查重。门禁拒绝时不消费文件选择，也不创建业务 Task。

该顺序适用于共用 `operation()` 的导入、核对、删除和导出入口，回归须覆盖这些调用方；不全局移除 `register()` 的保护。文件选择、导出位置选择、预检和元数据等未走请求缓存的入口继续执行原门禁，后端取消与恢复入口保留原有规则。新请求的模块启用与恢复校验不得因缓存调整被省略。

导入恢复或报告收尾期间，重放共享在途 promise 并等待原请求结束；若原请求最终为 `cleanupPending=true`，在缓存有效期内仍返回原业务结果、`errorReport` 和 `cleanupPending`。这是该请求的结果快照，不因后续恢复状态改变而重新求值；获取当前恢复状态使用既有状态/恢复入口。缓存失效后的请求按新请求执行门禁和选择器有效性检查，不宣称可以永久重放。

自动导出必须放在同一个 `entry.promise` 内，直到报告结果与收尾结果确定后才设置 done。不得在 promise 返回后以未等待的 `then` 或事件另起报告写入，这会造成忙碌状态提前释放与重复保存。

保留请求中 `AbortController`、控制对象和后端 signal 的语义。删除的是 renderer 主动取消按钮，不是 worker/主进程在退出和故障处理时的取消机制。自动报告若尚未开始且 signal 已中止，不强制开始；若已进入发布保护阶段，继续服从既有发布保护，不能在此新增强制取消路径。

导入入口从新请求登记到自动保存收尾持有独立 BusinessOperationRegistry token，并在原 promise 的 finally 中释放。退出等待该 token，覆盖两个 FilePlan Task 间的恢复和目标准备阶段；缓存命中不重复登记。shutdown transition 拒绝尚未开始的新 Task 时如实返回报告未保存，不额外重试。

本期去重承诺：**同一进程、同一有效请求缓存中的一次逻辑保存**。不新增跨启动唯一索引、报告导出状态表或自动补导任务队列。已启动的导出崩溃恢复由已有持久任务/发布记录处理；未启动的导出不假装已有恢复凭证。

## 八、测试矩阵与验收证据

### 8.1 纯服务、IPC 与页面单测

| 编号 | 场景 / 断言 | 对应 AC | 当前状态 |
| --- | --- | --- | --- |
| UT-01 | 注入固定时间与根目录，自动创建正确的本地日期子目录；仅返回规范化相对位置 | 06、16 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-02 | 同秒两个独立报告生成不同目标；不覆盖既有文件 | 07 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-03 | 非法根目录、同名文件占用父目录、写入权限失败等不会误报 saved | 13 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-04 | 磁盘/导出异常映射为附加报告错误，原业务 status/code/message/summary 不变 | 13 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-05 | 有 ref 但无 READY 记录、归属不符、manifest 不匹配均不调用正式导出 | 10、12 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-06 | 成功批次空诊断不输出；失败批次有真实文件级说明但样本为零不被无条件丢弃 | 09、11 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-07 | 恢复返回 ready=false 或抛错时不启动异步读导出，不绕过 admission | 14 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-08 | 导入抛错后仍通过可信任务身份取得本任务诊断；不能取得其他任务诊断 | 10 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-09 | 顺序为导入退出→恢复→导出→必要收尾；不得在独占 execute 内调用 runExport | 14 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-10 | 同一请求并发/缓存内重放只执行一次导入和保存；同 ID 改参仍拒绝，重放不再次消费 selectionRef | 07 | PASS：真实 handler + 状态门禁；含真实六类导出 |
| UT-11 | 缓存过期与新 requestId 不被宣称永久去重；不自动复用旧 selection | 07 | PASS：真实 handler + 状态门禁；含真实六类导出 |
| UT-12 | 自动错误报告的 showSaveDialog/pickExport 调用数为零；FilePlan 为真实 ERRORS task | 05 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-13 | 发布前失败、已发布但归档未决、发布结果待核验分别得到 failed/saved/pending | 15 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-14 | 初始、失败、再次选中模块以及各类任务执行期间均无被删除的任务按钮 | 01、02 | PASS：VM / Electron DOM（原生对话框结果由 API 模拟） |
| UT-15 | 导入按钮保持布局，busy 时禁止重复提交，完成/异常后禁用与焦点恢复 | 04 | PASS：VM / Electron DOM（原生对话框结果由 API 模拟） |
| UT-16 | 文件选择、日期选择、删除确认、取消选取和普通另存为取消仍按原语义执行 | 03 | PASS：VM / Electron DOM（原生对话框结果由 API 模拟） |
| UT-17 | 后端 cancelled 响应与忙碌时 dialog cancel 关闭保护仍有效，不残留 api.cancel 点击调用 | 02、18 | PASS：VM / Electron DOM（原生对话框结果由 API 模拟） |
| UT-18 | 新任务不会显示上一份报告路径，原业务失败与报告保存结果同时可见 | 10、13、15 | PASS：VM / Electron DOM（原生对话框结果由 API 模拟） |
| UT-19 | 响应字段白名单与预算不变，内部绝对路径、原始错误堆栈/业务行不进入页面 | 16 | PASS：服务 / 身份回调 / IPC / 集成覆盖，见 verification.md |
| UT-20 | 分别在导入恢复、报告收尾期间保持 recoveryReady=false，重放相同 sender/requestId/参数；共享在途结果，导入/报告/恢复均不因重放重复执行 | 07、14 | PASS：真实 handler + 状态门禁；含真实六类导出 |
| UT-21 | 首次请求结束且 cleanupPending=true、恢复仍未就绪时重放，返回原 status/code/summary/errorReport/cleanupPending；后续恢复就绪也不改写有效缓存结果 | 07、13、15 | PASS：真实 handler + 状态门禁；含真实六类导出 |
| UT-22 | 恢复门禁关闭时新请求仍被拒绝；跨 sender/非法 frame 不得读原缓存，同 sender 同 ID 改参仍报冲突；共用 operation 的核对/删除/普通导出及未缓存入口保留准入保护 | 07、14、16～18 | PASS：真实 handler + 状态门禁；含真实六类导出 |

纯服务测试可以替换文件发布依赖，用来验证目录和编排。但测试替身写出的内容不能被用于证明真实 XLSX 生成、列格式或归档已经正确。

UT-20～22 必须经过真实 `registerBizOpV327Handlers` 的入口校验与 `operation()` 缓存层，并使用真实 `assertBusinessEnabled()` 或确实随 recoveryReady/mode 变化拒绝请求的等价门禁。不得将该门禁替换为空函数后宣称恢复期间重放已通过；恢复等待可通过受控 barrier 稳定触发。

### 8.2 真实集成与相关回归

| 编号 | 场景 / 断言 | 对应 AC | 当前状态 |
| --- | --- | --- | --- |
| IT-01 | 构造真实异常 OP/流水 XLSX，走真实 TaskLifecycle、诊断登记、ERRORS writer/validator/publication，自动获得可读 XLSX | 05、06 | PASS：真实集成 / 六类导出 IPC 回归 |
| IT-02 | 同一诊断的自动报告与基线手动 ERRORS 导出在 sheet、表头、样本、说明及关键单元格类型/值上等价 | 08 | PASS：真实集成 / 六类导出 IPC 回归 |
| IT-03 | 超样本数量/字节预算、文件级错误、扫描不完整、计数非精确场景保留正确说明 | 09 | PASS：收紧既有样本预算，真实文件触发边界 |
| IT-04 | 故障注入覆盖目录创建、写出、发布前、发布后归档/清理；核实业务状态和恢复证据 | 13～15 | PASS：目录/写出故障单测；真实发布后故障集成 |
| IT-05 | 已启动导出的中断恢复不破坏发布保护和 pin；不重放原业务写入、不重复覆盖报告 | 14、18 | PASS：进程内中断、真实持久恢复与退出；未新增跨进程强杀 |
| IT-06 | 普通 OP_RAW、OP_CHECK、FLOW_RAW、FLOW_CHECK、RESULT_FULL、RESULT_DIFF 导出仍走原流程 | 17 | PASS：真实集成 / 六类导出 IPC 回归 |
| IT-07 | 导入成功/拒绝、区间核对、数据管理与删除关联结果的现有回归通过 | 17 | PASS：IPC / 既有定向回归 / 全仓门禁 |
| IT-08 | mode/legacy 可达入口实查及其他模块取消行为回归，不跨模块删除按钮 | 17、18 | PASS：路由实查 / DOM / 其他模块全仓门禁 |

IT-02 比较语义内容，不要求两次生成的 XLSX 压缩包二进制完全相同；时间戳等非业务元数据差异不能代替对业务字段的逐项核实。

### 8.3 Electron / Windows 人工验收

确认页面、任务弹窗和文件对话框取消语义正确；错误报告生成后在 Windows Excel 或 WPS 打开，检查工作表、错误样本、说明、中文文件名及长路径显示。检查保存位置是应用既有“文档”根目录，而不是安装目录、仓库目录或 userData 的内部诊断目录。

不得只提交截图或只验证文件名存在；至少保留本次候选 SHA、输入样例说明、实际输出相对位置、自动化日志、人工检查结果。真实业务数据应按项目数据处理规则使用和保管，不将生产明细提交到仓库。

### 8.4 验证命令与证据边界

以下为本轮可重复的验证入口；已执行项、最终结果与平台缺口记录在第十二节及 verification.md。已提交候选检查仅在存在该类差异时使用，当前实现尚未提交。

```bash
# 新增定向单测
node --test tests/unit/main-process/biz-op-v329-*.test.js
node scripts/integration/biz-op-auto-error-report.js
node scripts/verify-biz-op-v329-renderer-dom.js /private/tmp/biz-op-v329-renderer-evidence

# 既有测试入口；相关集成脚本需按仓库 runner 约定接入
npm run test:unit
npm run test:integration
npm run smoke

# 开发中检查尚未提交的 src 改动（不能代替已提交分支检查）
npm run check:vars

# 模块分支已提交候选相对已核实开发基线的关联检查
npm run check:vars -- --since 'v3.2.8^{commit}'

# 模块达到 PR-ready、正式 GUI 交付前的完整自动门禁
# release 集成改变候选内容后，最终发布候选也须完成此门禁
npm run release-check
```

无参数 `check:vars` 扫描 `git diff HEAD -- src/`；`--since` 检查基线至 HEAD 的已提交差异，不包含已跟踪文件的未提交修改。两种模式均额外纳入未跟踪的 src 下 JS 文件。有工作区与已提交两类改动时分别检查；最终候选应能用记录的 SHA 与工作区状态明确对应。脚本输出“无改动，跳过”不等于完成模块分支审查。扫描只是关联 review 的线索，命中后的定义、调用方与回归覆盖仍需人工核对；退出码 2 表示命中需 review 的层级，不能当成测试失败，也不能省略处置。

`node --check` 可补充语法验证，但不能替代单测或真实集成。按照实施工作区当前 `AGENTS.md` / `CODEX.md`，`release-check` 是 PR-ready、正式 GUI 交付以及最终发布候选的完整自动 PASS/FAIL 依据，不能推迟到 release 集成阶段才首次执行，也不能用局部单测替代。证据覆盖最终候选；必要检查通过后，没有内容变化、失败或新疑点时不机械重复执行。人工验收仍需独立记录。[T9]

## 九、关联功能 review

已运行 `npm run check:vars`：扫描 7 个 src 文件，命中 `dialog`、`state`，exit 2 表示关联审查提示。`dialog` 的原生选择取消由既有 IPC 与页面回归覆盖；页面 dialog 为本模块局部工厂。`state` 命中局部状态/出版状态，未修改 `src/renderer.js` 的共享单例。详细证据见 verification.md。[T9]

重点审查：页面 `busy` 与状态恢复、请求 Map 与 signal 生命周期、存储根目录提供者、真实 taskRunId/reportRef 绑定、FilePlan task policy、publication 与归档收尾、诊断 pin/退役时机。

本次不计划改动金额/汇率运算和数据匹配，但自动导出会经过共享任务和文件安全层，仍须执行相关回归。主进程/共享层改动必须在后续实施汇报中说明关联影响，不能仅汇报“删除两个按钮”。

## 十、任务分解

| 序号 | 任务 | 产出 / 验证 | 状态 |
| --- | --- | --- | --- |
| TSK-01 | 核实基线、工作区规则和实际可达入口；记录报告相关既有测试 | 基线 SHA、调用点和测试清单，不混入其他模块改动 | DONE |
| TSK-02 | 补齐可信导入任务身份，设计受限诊断描述符读取 | 异常路径、缺失/错误 owner、空诊断测试 | DONE |
| TSK-03 | 实现 Main 自动报告服务及根目录注入 | FilePlan、保存成功/失败、唯一命名与真实 XLSX 测试 | DONE |
| TSK-04 | 调整缓存与门禁顺序，接入原 IPC promise，分层返回业务与报告状态 | 真实恢复门禁下在途/完成重放、同 ID 冲突、新请求拒绝及发布未决测试 | DONE |
| TSK-05 | 删除页面任务按钮及专用状态，接入报告反馈 | DOM/真实页面、焦点、普通取消与布局回归 | DONE |
| TSK-06 | 完成真实集成、故障注入与关联功能 review；模块 PR-ready/正式 GUI 交付前完成 release-check | 实际运行日志、基线至候选的关联审查、候选 SHA、异常恢复及完整门禁证据 | DONE：完整门禁 exit 0 |
| TSK-07 | 完成人工验收和文档状态更新 | Excel/WPS 与 Windows 页面验收记录 | Windows Excel/WPS 待验收；文档已更新 |

编码可以逐步完成，但对外验收必须把“删除手动按钮”和“可用的自动保存链路”作为一个完整交付，不能先交付没有报告出口的半成品。

## 十一、实施计划（Commit 粒度）

下表仅用于后续实施安排，不代表本次已经创建或授权这些提交。

| 序号 | 建议 Commit message | 范围 |
| --- | --- | --- |
| C1 | `docs(biz-op): 定义 v3.2.9 错误报告自动保存迭代` | 本对 Spec / TechDoc，保留待实施状态 |
| C2 | `feat(biz-op): 自动保存已验证的错误报告` | Main 身份、路径、服务和 IPC 编排，服务/IPC 单测 |
| C3 | `refactor(biz-op): 移除手动错误报告与任务取消入口` | 页面移除、反馈与交互测试 |
| C4 | `test(biz-op): 覆盖错误报告发布与恢复回归` | 真实 XLSX、故障注入、回归与实际验证记录 |

在 feature 分支完成后，按本轮 release 工作流集成；不要将该模块直接推到 main。版本提升、三份发布文档统一收口、正式 tag 和安装包发布属于 release 阶段，本轮不执行。

以下为原设计中的分支示例，不作为当前工作区操作记录。当前已从同一基线使用 `git worktree add -b` 创建分支，详见 implementation-notes.md：

```bash
git status --short
# 有未提交改动时先保留并处理，不运行 reset --hard。
git fetch origin --tags
git rev-parse 'v3.2.8^{commit}'
# 必须等于 2ba9ef14fe972363b604955636cff0c9ac53700f；不一致时停止，不改写标签。
git switch -c codex/v3.2.9-biz-op-error-report-auto-save 2ba9ef14fe972363b604955636cff0c9ac53700f
```

## 十二、实施日志与当前验证状态

### 2026-09-11 — 原 1.0 撤回与设计交付记录（历史材料，本轮未独立核实远端）

| 事项 | 已核实事实 / 当前状态 |
| --- | --- |
| 撤回前远端 `v3.2.9` | `5cf95dfb6c794efde50908192756cc2c1eea467f`，与上一轮推送一致 |
| 撤回操作 | 将该远端分支引用回退到 `2ba9ef14fe972363b604955636cff0c9ac53700f`，执行成功后读回核实 |
| 标签基线 | 已核实 `v3.2.8` 的 annotated tag 对象解引用到同一基线提交 |
| 原远端分支 | 名称保留在基线上；未声称清除历史 Git 对象 |
| 新功能分支 | 仅确定名称；查询时不存在同名远端引用，本次未创建 |
| 代码实施 | **未开始；已撤回的旧实现不计入本轮完成状态** |
| 单元 / 集成 / smoke / release-check | **本次均未执行** |
| Windows / Excel / WPS 人工验收 | **本次未执行** |
| 本次产出 | Spec、TechDoc 及交付说明，提供下载文件，不提交到 GitHub |

旧提交或旧改动包只能作为历史材料，不能直接作为已验收实现。尤其不能把上一轮“15 项测试通过”的文字搬到本文件作为本次测试证据。

### 2026-09-11 — 1.1 文档评审修订

- 明确受缓存管理的 operation 入口先验证身份和请求摘要、复用有效请求，仅新请求再执行业务就绪门禁；补齐恢复期间与 cleanupPending 结果重放的验收。
- 区分工作区变量检查与基线至已提交候选的变量检查，补充 `--since 'v3.2.8^{commit}'` 和扫描结果的证据边界。
- 将完整门禁明确到模块 PR-ready、正式 GUI 交付前及最终发布候选，并同步任务与完成定义。
- 本次只修订文档，功能实现及本设计的单元、集成、完整门禁和 Windows/Excel/WPS 验收仍待执行；未执行远端操作，未将原交付的撤回记录当作本次核验结果。

### 2026-09-11 — 1.2 分支创建与实施

- 已在独立 worktree 创建 `codex/v3.2.9-biz-op-error-report-auto-save`，基线为 `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 复用用户提供的 1.1 文档并按当前 save-spec 存放；源文件 SHA-256 与实际工作区见 implementation-notes.md。
- Main、页面与真实 XLSX 自动保存链路已落地。独立审查补齐 Main 异常后的空诊断排除与可行动的保存失败原因提示；最终验证见 [verification.md](verification.md)。
- 页面 VM 与隔离 Electron 原生 DOM 各 8/8 PASS，真实 CSS 下导入按钮位置、空工具栏、长路径换行/文本选择已验证。
- 最终 `UNIT_TEST_CONCURRENCY=2 npm run release-check` exit 0：lint、smoke 通过，470 个单测文件合计 7,349 PASS / 0 FAIL / 3 个既有 Windows 专用 skip；54 个集成脚本全部通过，汇总 2,500/2,500，含本次真实集成 12/12。自动生成的集成清单已同步。
- 代码/测试/验证脚本共 14 份的 SHA-256 在固定 worktree 迁移后与最终门禁后保持一致。合成 OP/FLOW 原件、真实报告与页面图保存于忽略日志目录，详见 verification.md；Windows Excel/WPS 未验收。
- 原始业务规则、迁移、模式路由和版本号未修改；原件及数据库均为临时自建。未提交、推送、合并或发版。

## 十三、Open Technical Questions / 实施前核对项

分支、目录含义、按钮语义与本轮范围已固定；以下技术事项已核对，Windows Excel/WPS 人工验收仍待具备该平台时执行。

核对结论：

1. Main 的实际装配点已注入 `getStorageRoot`，整个 import promise 持有 BusinessOperationRegistry 登记，两个 FilePlan Task 仍各自独立登记，signal 与原保护流程传递。退出前等待整段工作，不提前关闭 runtime；shutdown transition 可拒绝尚未开始的报告 Task，按未保存结束。
2. 专用 controller 仅在 ACTIVE 使用；DISABLED/API 缺失走 legacy，旧页面未发现同类待删按钮。共享路由、普通取消和其他模块无修改。
3. 复用 `createHost` / `createExportHost` 和真实 XLSX fixture。自动报告与同诊断原 `runExport(ERRORS)` 按全部工作表、单元格值、类型、格式与公式进行比较；截断/不完整/非精确计数说明有真实文件验证。
4. 文档已按当前 `save-spec` 规则存入本版本/分支目录；后续直接维护这份正文及同目录记录，不再复制到旧 docs/iterations 路径。
5. 如果必须改变 schema、报告字段、平台协议或跨启动调度，先说明与本 Spec 的差异并更新设计，不静默扩展本小迭代。

## 十四、代码来源与事实锚点

下表外部链接固定到基线 SHA，用来解释原能力；本轮新增服务、回调与测试以功能 worktree 实际文件及 verification.md 中的内容摘要为准。

| 编号 | 文件与相关内容 |
| --- | --- |
| T1 | [src/renderer-biz-op-v327.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/renderer-biz-op-v327.js)：`setBusy`、`perform`、`reportButton`、`cancelButton`、modal 与模式切换 |
| T2 | [src/main-process/biz-op-v327/ipc.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/ipc.js)：`operation`、请求缓存、`compact`、`failure`、选择器、恢复与取消 IPC |
| T3 | [src/main-process/biz-op-v327/import-main.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/import-main.js)：`restoreDiagnostic`、`runImport`、诊断验证/空诊断退役 |
| T4 | [src/main-process/biz-op-v327/export-main.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/export-main.js)：`runExport`、TaskLifecycle、来源/文件身份校验及 publication/settle |
| T5 | [src/main-process/biz-op-v327/admission.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/admission.js)：`exclusive`、同步 `read`、异步 `readTask`、recoveryReady |
| T6 | [src/main-process/biz-op-v327/export-inputs.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/export-inputs.js)：`freezeExportSource` 中 ERRORS / DIAGNOSTIC 来源 |
| T7 | [src/main-process/biz-op-v327/read-protection.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/read-protection.js)：`closed`、`registerDiagnostic`、`retireDiagnostic`、pin 释放条件 |
| T8 | [src/main-process/biz-op-v327/module.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main-process/biz-op-v327/module.js)：组件装配及恢复诊断钩子；[src/main.js](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/src/main.js)：`getStorageRoot` |
| T9 | [CLAUDE.md](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/CLAUDE.md)、[package.json](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/package.json)、[rules/important-variables.md](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/rules/important-variables.md)、[TechDoc-template.md](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/2ba9ef14fe972363b604955636cff0c9ac53700f/docs/templates/TechDoc-template.md)：仓库流程、验证与文档组织 |
