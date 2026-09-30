# 固定基线与证据索引 — v3.2.11 低内存适配

<!-- document-identity
 document-id: v3.2.11-bizop-rows-low-memory/baseline-evidence
 target-version: v3.2.11
 branch: v3.2.11-bizop-rows-low-memory
 baseline: 18b82b4328cf5e00c1b2549d373a5b2f2677215c
 revision: R2
-->

> 基线：`18b82b4328cf5e00c1b2549d373a5b2f2677215c`；初版核验日期：2026-09-29。
> 目标版本：v3.2.11；功能分支：`v3.2.11-bizop-rows-low-memory`；文档修订：R2。
> 此文件只记录来源与现状，不维护业务要求或实施完成状态。方案决策见 [Spec](spec.md)／[TechDoc](techdoc.md)。

## 证据使用方式

源码链接均固定到提交，不随 main 漂移。初版生成时确认 SHA 与前两轮读取一致，并读取仓库模板、Renderer 边界、执行描述符、队列和旧扫描 dispatcher 等入口。R2 保持这一设计基线，只对本次修订相关的固定提交源码补查；未重新声明当前远端 main 的状态。来源中的注释可能有历史状态，事实应结合实际调用读取。

原 R2 方案编写阶段未复制／运行完整仓库，未访问用户本地工作树，也未获取用户的 Windows 日志或真实业务文件。后续本地开发与自动验证记录见 [实施记录 §12](implementation-notes.md#12-2026-09-30-完整本地实现)；本文件的固定基线事实不随实现更新。用户贴出的同提交 review 是方案依据之一；其观察不是本轮新产生的实机证据。涉及 export-source／export-validator 的具体 32 MiB 定位，同时由该 review 与公共 XLSX README 支持，不能据此宣称已逐行读取全部导出源码。

<a id="s01"></a>
## S01 — 远端 main 与正式发布标签

2026-09-29 初版通过 GitHub 读取 main，提交为 18b82b4328cf5e00c1b2549d373a5b2f2677215c，合并消息为 v3.2.10 发布 PR #240。refs/tags/v3.2.10 是附注标签，标签对象 d57edb9267727ab53a1388424f5fb8d4277f61b5 解引用到同一提交。后续读取源码均固定该 SHA；这不是会随 main 漂移的设计基线。

- [固定 main 提交](https://github.com/MatthewPZhong/bank-bill-excel-tool/commit/18b82b4328cf5e00c1b2549d373a5b2f2677215c)
- [v3.2.10 标签](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.2.10)


<a id="s02"></a>
## S02 — 仓库工作边界、版本分支与文档格式

AGENTS 要求只读方案不修改仓库、未经要求不提交／推送／升版；功能分支先合入本轮 release，再由 release 合 main。save-spec 要求已明确多分支的版本按完整分支名建目录。本任务上下文已经明确 v3.2.11 为多功能分支。本轮固定 main 的 changes/v3.2.11 返回 Not Found；因此没有复用其中不存在的本任务文档。changes/templates 有 Spec 模板，docs/templates 有 TechDoc 模板，分别采用。未以“远端 main 无版本目录”推断“本版本只有一个分支”。

- [`AGENTS.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/AGENTS.md)：工作边界／约定与分支。
- [`CODEX.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/CODEX.md)：决策与 spec／交付门禁与完成。
- [`.agents/skills/save-spec/SKILL.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/.agents/skills/save-spec/SKILL.md)：定位与存放／复用与补齐。
- [`changes/templates/spec.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/changes/templates/spec.md)：八节结构。
- [`docs/templates/TechDoc-template.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/docs/templates/TechDoc-template.md)：评审／文件清单／需求／任务／日志／未知项结构。

<a id="s03"></a>
## S03 — 平台内存预算与固定账本

resource-budget 默认 systemReserveBytes=2 GiB，hard ceiling=max(768 MiB,totalMemory/4)，memoryBytes=min(ceiling,max(0,freeMemory-reserve))。runtime 创建时计算预算并建立 Governor；Governor snapshot 的 available=budgets-activeUsage。上述参数允许受控 options 覆盖，所以算例明确指默认配置。

- [`src/main-process/background-execution/resource-budget.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/background-execution/resource-budget.js)：createPlatformResourceBudgets。
- [`src/main-process/background-execution/runtime.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/background-execution/runtime.js)：createBackgroundExecutionRuntimeInternal。
- [`src/main-process/background-execution/resource-governor.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/background-execution/resource-governor.js)：createResourceGovernor／snapshot。

<a id="s04"></a>
## S04 — 两个目标功能的固定阶段申请

rows policy 将 phase.memoryBytes 指定为 1024**3。BizOP candidate-policy 与 export-policy 各写入 1073741824，policies.js 按 action kind 构建最终 policy。模板 JSON 中 production.enabled=false 不可单独当作当前动作未启用的证明，需看最终 policies／release-gates；本方案没有根据模板字段改变生产启用状态。

- [`src/main-process/toolbox-row-split/policy.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-row-split/policy.js)：ROWS_POLICY。
- [`src/main-process/biz-op-v327/candidate-policy.json`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/candidate-policy.json)：resources.phase.memoryBytes。
- [`src/main-process/biz-op-v327/export-policy.json`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/export-policy.json)：resources.phase.memoryBytes。
- [`src/main-process/biz-op-v327/policies.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/policies.js)：buildBizOpPolicies。

<a id="s05"></a>
## S05 — 拆分前置入口与模式时序

toolbox:split:read 先选择文件并扫描字段；大通道调用 dispatchLargeSplit({op:scanFields})，普通路径调用 scanToolboxSplitFields。rows 模式在后续 toolbox:split:export 的 prepare 中判断。说明降低 rows 导出 worker 申请不能覆盖前置内存开销。

- [`src/main.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main.js)：toolbox:split:read／toolbox:split:export；review 定位约 20250 行。
- [`src/main-process/toolbox-large-split-router.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-large-split-router.js)：由 Main 引用的大小路由入口；本轮未据其内部阈值提出新容量结论。

<a id="s06"></a>
## S06 — 字段值扫描累加器

scanToolboxSplitFields 以 SPLIT 策略读取；boundedValues=true 才用有界累加器，否则使用 createValuesByFieldAccumulator。即便 worksheet 行是流式，字段去重集合也可能随唯一值数量增长。新 metadata 路径是本方案拟增加能力，基线未有同名实现。

- [`src/main-process/toolbox-format-operations.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-format-operations.js)：scanToolboxSplitFields／assertUniqueSplitHeaders。

<a id="s07"></a>
## S07 — 工具箱 XLSX SST、输入样式和关闭

openToolboxXlsxPass 先完整读取有安全限额的 styles/theme XML，未给 loadToolboxSharedStrings 传 onValue；该函数默认把每个字符串放入 values 数组。ToolboxXlsxPass.close 当前只关 ZIP。不能从 worksheet 逐行扫描推出整个读取流程是常量内存。

- [`src/backend/toolbox-format/xlsx-pass.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/backend/toolbox-format/xlsx-pass.js)：openToolboxXlsxPass／ToolboxXlsxPass.close。
- [`src/backend/xlsx/workbook-parts.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/backend/xlsx/workbook-parts.js)：loadToolboxSharedStrings／readToolboxMetadataEntryAsString。

<a id="s08"></a>
## S08 — 公共 XLSX 能力与资源所有权

公共 README 明确区分 legacy、rich 和 Toolbox 装配，列出 adaptive provider、显式预算、strictClose 与各调用方的不同配置。SST 独占目录／文件、关闭身份检查与任务级清理分别有 owner；公共 reader 回调有同步合同。本文复用其机制，不把不同业务的 reader／关闭策略无条件互换。

- [`src/backend/xlsx/README.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/backend/xlsx/README.md)：入口与能力／预算、关闭和临时资源／兼容入口与迁移。

<a id="s09"></a>
## S09 — rows 缓存、源格式与顺序输出

contracts 限制 rows 输出最多 1000 份，目标扩展名 .xlsx；`ROWS_BUDGETS.maxMaterializedSourceBytes=64 MiB` 由 rows 的 `assertSourceBudget` 使用，条件为非 XLSX 的源文件字节数不大于该值。Main 只有确认 rows 模式才调用对应 prepare，rows worker 读取源前也检查；本轮查看的公共 read／字段扫描入口未调用该 rows 限制。因此该数值不能被描述成所有拆分的公共源上限。cache 存 SQLite，回放 openCache 将 styles 逐个解码入内存。executor 顺序创建／提交／释放 writer，maxActiveWriters=1；执行资源观察以 heapUsed+external 与 768 MiB 相比。该观察不是全部原生内存的完整证明。

- [`src/main-process/toolbox-row-split/contracts.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-row-split/contracts.js)：ROWS_BUDGETS／assertSourceBudget／planRowCounts。
- [`src/main-process/toolbox-row-split/cache.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-row-split/cache.js)：createSealedCache／openCache／checkResources。
- [`src/main-process/toolbox-row-split/executor.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-row-split/executor.js)：executeRowsGeneration。
- [`src/main-process/toolbox-row-split/service.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-row-split/service.js)：validateRowsManifest／generateValidateAndPublishRows／rowsAdmissionError。

<a id="s10"></a>
## S10 — writer 提交、回读与释放

createToolboxOutputWriter 使用 ExcelJS streaming writer，useStyles=true、useSharedStrings=false。commitAndValidate 先 commit，再完整技术验证；release 要求 committed 状态。输出校验有读取 styles.xml 的分支。因此当前 API 不允许把 release 简单前移到验证前。

- [`src/main-process/toolbox-output-writer.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-output-writer.js)：validateGeneratedWorkbook／createToolboxOutputWriter／commitAndValidate／release。

<a id="s11"></a>
## S11 — OP 工作集、报告、发布与恢复独立申请

OP import 已有 SST 预算入口和错误采样，compute 使用 SQLite 工作表、顺序读取分片／按键分组。export-source 与 export-validator 的共享字符串配置仍需要收口。publication-owner 定义 EXPORT_IO_RESOURCES=1 GiB 并用于 shared-publication-observation；auto-error-report 的 savedFact 另外申请该资源验证已提交的目标。borrowed observation 的 release 不释放外层 I/O 租约。

- [`src/main-process/biz-op-v327/import-pipeline.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/import-pipeline.js)：runImportPipeline／resourceOrCancel。
- [`src/main-process/biz-op-v327/compute-pipeline.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/compute-pipeline.js)：runComputePipeline／openReadonly。
- [`src/main-process/biz-op-v327/export-pipeline.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/export-pipeline.js)：runExportPipeline。
- [`src/main-process/biz-op-v327/export-source.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/export-source.js)：原表 reader 的 SST 配置；基线 review 定位。
- [`src/main-process/biz-op-v327/export-validator.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/export-validator.js)：输出 reader 的 SST 配置；基线 review 定位。
- [`src/main-process/biz-op-v327/publication-owner.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/publication-owner.js)：EXPORT_IO_RESOURCES／acquireObservation／issueBorrowedObservation。
- [`src/main-process/biz-op-v327/auto-error-report.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/auto-error-report.js)：savedFact／saveFailure／save。

<a id="s12"></a>
## S12 — OP 等待边界与队首重评

acquireBizOpPhaseLease 在申请超过总预算时拒绝，排队 timeout 5 秒，明确不能在实际工作／载体退出前释放。admission-queue 的 DEFER_ADMISSION 会结束本轮队首 drain；新串行机制需要考虑带依赖的续接，不能制造队首阻塞型自等待。

- [`src/main-process/biz-op-v327/phase-admission.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/biz-op-v327/phase-admission.js)：acquireBizOpPhaseLease／BIZ_OP_RESOURCE_WAIT_MS。
- [`src/main-process/background-execution/admission-queue.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/background-execution/admission-queue.js)：runDrain／DEFER_ADMISSION。

<a id="s13"></a>
## S13 — 执行描述符、资源 profile 与载体限制

现行 README 指出只有 NewAccount generation 注册动态 estimator，其余 phase 预算来自 policy；存在独立批准 capability／production 基线。Toolbox descriptor 内 rows 的 V8 限制为 old=640、young=32 MiB。不能只在 JSON 中填一个低档值而不改 Main 绑定、真实 entry 与预算使用链。

- [`src/main-process/execution-descriptors/README.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/execution-descriptors/README.md)：领域归属与资源／新增或迁移 action。
- [`src/main-process/new-account/execution-descriptor.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/new-account/execution-descriptor.js)：resourceProfiles 的真实绑定示例。
- [`src/main-process/toolbox-background/execution-descriptor.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-background/execution-descriptor.js)：ROWS_ACTION entry.resourceLimits。
- [`src/main-process/background-execution/supervisor.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/background-execution/supervisor.js)：输入快照及真实协议边界；本轮读取文件前段，不据此声称已全量审计。

<a id="s14"></a>
## S14 — 当前 Renderer 所属与生命周期

Toolbox 实际在 renderer/dialogs/toolbox.js，父层持有读取 token／草稿／提交资格，view 有 requestGeneration 和销毁保护。README 规定 modal host 所有权，不允许业务直接拆除其他弹窗。新扫描迟到反馈、取消和模式转换应接在此处，而不是重新堆入全局 renderer.js。

- [`src/renderer/README.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/README.md)：弹窗入口与权限。
- [`src/renderer/dialogs/toolbox.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/dialogs/toolbox.js)：createToolboxDialog／releaseSession／requestGeneration。

<a id="s15"></a>
## S15 — 前置扫描的旧大文件 dispatcher

toolbox-large-split-dispatch 的 worker 入口是 backend/toolbox-xlsx-stream/large-split-worker，老生代上限 4096 MiB。finish 发 close、调用 terminate 后立即 resolve/reject；未等待 exit。此值是 V8 上限而非启动时预分配；现有 promise 也不能作为资源真实退出证明。新增 closed 能力是方案，不是当前实现。

- [`src/main-process/toolbox-large-split-dispatch.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/toolbox-large-split-dispatch.js)：WORKER_MAX_OLD_GEN_MB／dispatchLargeSplit／finish。

<a id="s16"></a>
## S16 — 现有容量脚本的证据范围

verify-toolbox-row-split-capacity 使用 freeMemoryBytes=8 GiB、totalMemoryBytes=16 GiB。采样 timer 位于 scanToolboxSplitFields 之后；同一采样区间内还用 ExcelJS.Workbook 完整读回验证文件。它适合原输出数量等用例，不是完整低内存用户链路证据。

- [`scripts/verify-toolbox-row-split-capacity.js`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/scripts/verify-toolbox-row-split-capacity.js)：main：runtime 参数、scan 与 timer 时序、读回验证。

<a id="s17"></a>
## S17 — 版本号与验证命令来源

本轮 package.json 显示版本 3.2.10。现有通用测试／交付命令以同提交 AGENTS、CODEX 与 package.json 为准；本轮仅阅读，不把历史文档中的通过状态当成本分支测试结果。新低内存脚本尚未实现。

- [`package.json`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/package.json)：version／scripts。
- [`AGENTS.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/AGENTS.md)：常用命令。
- [`CODEX.md`](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/CODEX.md)：验证与风险审查／交付门禁与完成。

<a id="s18"></a>
## S18 — 默认字段、值按钮与多文件分组（R2 补查）

固定 Renderer 中，单分组通过 headers 生成 select 的 option；`refreshValues` 和 `updateCompleteState` 根据现有数组长度禁用值入口，`fieldSelect` 的 change 调用 refresh。该实现原本消费已经扫描的值集合；新方案改成懒加载后，不能把“没有加载数组”当成“真实空字段”。多文件分组将 initialFieldIndex 回退为 0，值按钮也按当前数组长度禁用。因此“默认首字段／单列文件如何开始加载”属于新方案需要规定的交互合同，不是声称基线已经存在懒加载故障。

- [`src/renderer/dialogs/toolbox.js` 固定范围](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/dialogs/toolbox.js#L390-L930)：单组值按钮、refreshValues／updateCompleteState／change，以及多组 initialFieldIndex／refreshGroupValuesButton。
- [`src/main.js` 固定范围](https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main.js#L20250-L20357)：公共文件扫描与 rows prepare 的时序。

## R2 审查来源及交付布局证据边界

R2 依据用户本轮贴出的审查结论修订：两项确认问题为 rows 限制外扩和当前散件链接失配；另补默认字段懒加载约定，并细化 Bcompat 的固定拒绝／暂时等待。未读取用户电脑上的 `review-2026-09-29.md` 原文件，不将本节冒充完整审查报告。

用户报告的“44 次相对链接、38 个目标不存在、6 个目标属于其他文档”属于其 Downloads 四份带前缀文件布局的核查结果；本轮没有该目录副本，未独立复现这些计数。初版 ZIP 的检查只适用于当时保持目录／规范短文件名的布局，不能延伸为散件下载后的保证。R2 对本次实际生成并解压的独立目录重新检查目标存在、分支／目标版本／文档类型／修订号及文件摘要，实际结果仅记录在实施记录和交付验证报告。

## 默认预算算例复核

仅重算 S03 的纯数值表达式，假定总物理内存 8 GiB、默认预留 2 GiB、无其他资源占用；不是启动应用或执行源码测试。

| 采样可用内存 | 后台内存预算 | 是否容纳 1 GiB 申请 |
| --- | --- | --- |
| 512 MiB | 0 MiB | 否 |
| 768 MiB | 0 MiB | 否 |
| 1 GiB | 0 MiB | 否 |
| 2.5 GiB | 512 MiB | 否 |
| 3 GiB | 1024 MiB | 是 |

<a id="e01"></a>
## E01 — Node 内存指标及 worker 限制（外部机制参考）

Node 文档说明：worker thread 的 RSS 属于整个进程，其他 memoryUsage 字段属于当前线程；arrayBuffers 已包含于 external。resourceLimits 只约束 JS 引擎，不覆盖全部外部内存。本文用它们界定测量口径，不用在线最新 Node 版本替代项目实际打包 runtime。

- [Process memoryUsage](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage)
- [Worker resourceLimits](https://nodejs.org/api/worker_threads.html#new-workerfilename-options)

<a id="e02"></a>
## E02 — Node Stream 背压（外部机制参考）

highWaterMark 是停止继续请求／接受数据的阈值，不是严格内存上限。生产代码仍需真正遵守写入反馈及排空边界；本文没有由该文档推断 ExcelJS 内部存在某个可直接使用的接口。

- [Node Stream buffering](https://nodejs.org/download/release/latest-jod/docs/api/stream.html#buffering)

<a id="e03"></a>
## E03 — Windows 物理可用内存与可提交内存（外部机制参考）

MEMORYSTATUSEX 的 ullAvailPhys 表示当前可立即复用的物理内存，包含 standby/free/zero；ullAvailPageFile 表示当前进程还能提交的内存，不等于磁盘空闲空间，也不一定等于系统可提交余量。两种指标分别记录，不相加制造额外可用内存。

- [Microsoft MEMORYSTATUSEX](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex)

以上外部资料仅支持平台机制事实；各候选额度和支持矩阵的正式资格仍需实测，当前实现与验证结果以实施记录为准。


<a id="s19"></a>
## S19 — 2026-09-30 审查后兼容恢复与交互竞态证据

固定 main 基线 `18b82b4328cf5e00c1b2549d373a5b2f2677215c` 的共享 Publisher 没有独立 1 GiB 内存申请。本轮初始实现新增该申请后，8 GiB 总内存／2.5 GiB 可用内存对应 Bcompat=512 MiB，空恢复也被拒绝；错误位于主窗口创建之前。修复恢复原兼容内存记账并保留其他资源约束；原对照脚本在可用 512／2560／3072 MiB 下均得到基线和修复版空恢复成功。这里是确定性输入和真实恢复 Worker，不是 Windows 物理压力。

原 Renderer 的问题分别来自 replace 的新建／销毁顺序，以及成功回调依赖已删除的发起分组。修复后使用会话消费者订阅，真实 Electron 加入 6 个竞态回归。另验证 normal／low 实验档下，legacy wrapper 内的 BizOP 观察保留兼容额度而不等待自身；损坏 journal、未知 owner 和原兼容额度不足均继续拒绝。

具体复现、代码位置、测试与最终源码身份见 [修复报告](review-fixes/2026-09-30/fix-report.md)。此补充不重写 S01—S18 的固定基线事实。


<a id="s20"></a>
## S20 — 2026-09-30 第二轮 R4 并发依赖证据

第一轮内部静态 action 修复了空队列自等待；第二轮复审发现队首获批 phase 等待 legacy 活动结束、内部观察又等待队首的环。本轮按原矩阵复现：4 GiB 可用内存输入、2 GiB Bcompat、相同 normal 优先级下，normal／low 均约 5 秒双超时；25 ms 后取消队首，legacy 约 27–29 ms 完成。

修复通过 Main 活动身份和原始 inventory 快照证明依赖，只让解除队首依赖的 continuation 先执行。真实 owner／协调器／Worker 的新并发矩阵在两档均完成；另用真实 BizOP 异常导入生成诊断，自动报告先登记 publication 并排队，再执行 Main 合表 execute 的发布、恢复与归档，两个结果都成功。该场景没有预置孤儿记录。加载冻结的五个修复前调度文件时，同一业务回归重新返回 BIZOP_RESOURCE_WAIT_TIMEOUT。

证据为合成内存输入、真实模块与原生 Worker、隔离的 Main handler 集成；未启动完整 Electron GUI。文件、命令、时序、测试边界与最终源码身份见 [第二轮修复报告](review-fixes/2026-09-30-r2/fix-report.md)。S01—S18 仍是固定设计基线，S19 保留第一轮当时的验证范围。
