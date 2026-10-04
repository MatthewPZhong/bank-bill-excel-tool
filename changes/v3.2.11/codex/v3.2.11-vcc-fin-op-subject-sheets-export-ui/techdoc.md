# TechDoc — v3.2.11 VCC财务OP：仅结果表按主体分 Sheet 与导出页面调整

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.11 |
| 日期 | 2026-09-29 |
| 状态 | Rev4 / implementation；代码已实现；最终完整本地门禁 PASS，平台人工验收见 §12 |
| 关联 Spec | [spec.md](spec.md)，原样复用 Rev3，同一功能分支目录；D1—D7 与 19 项 AC 不变 |
| 适用功能分支 | `codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui` |
| 分支组织 | v3.2.11 包含多个功能分支（用户已明确）；本任务文档归属该功能分支 |
| 源码依据 | 设计与开发起点均为 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`，本次核实为当前本地 `main`；实际接线、实施差异与验证见 §12 |
| 仓库 | `MatthewPZhong/bank-bill-excel-tool` |
| 格式来源 | `docs/templates/TechDoc-template.md`；按本任务增加输出合同与测试章节 |
| 存放路径 | `changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/techdoc.md`；已存入功能分支 worktree，未提交或推送 |

## 一、Spec 评审意见（技术角度）

### 1.1 可直接落地的部分

用户最新口径为“仅结果表按主体分 Sheet，输出一个结果表文件”。页面两项调整继续保留。正式结果单文件多主体 Sheet 改变用户可见输出合同，必须同步改正式结果的 Writer、Validator、文件计划和测试，不能按纯 UI 任务处理。

基线正式结果按主体输出多个文件，现有主体级数据和样式能力可复用，但“一个最终文件包含多个主体”需要单独的编排合同。待确认表继续使用原 `projectReview`、manifest、Writer、Validator 和差异附页管线，本稿不再提出任何主体拆 Sheet 改造，仅做不变性回归。

### 1.2 技术意见 / 风险提醒

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| R1 | 只改正式结果写出、不改回读校验，会被固定 Sheet 名/数量检查拒绝；放宽检查又可能漏掉串主体 | 新正式结果校验目标改为冻结的有序 Sheet 计划；待确认表原校验不变 |
| R2 | 上一稿包含待确认表改造，残留计划可能导致误实施或破坏其固定引用 | 撤销待确认主体 Sheet 计划、投影/manifest/Writer/Validator 改造；原 `待确认表!M行号`、打印、批注及计数保持原合同 |
| R3 | 原结果“主体索引→输出文件”合同与新单文件不等价 | 为新布局使用明确的内部输出合同；旧主体文件路径继续为历史/归档/恢复调用保留 |
| R4 | 直接把多个主体加载到一个内存工作簿可能增加峰值内存 | 单个最终 Writer 顺序写 Sheet，按主体读取和释放；采用受限写出，验证也遵守资源预算 |
| R5 | 两个 UI 页面共用月份选择器 | 导出调用显式传入展示模式；样式和常态提示只对该模式生效 |
| R6 | 旧控件最小宽度、错误百分比基准或 transform 导致不符合 40% | 保留原 Grid 轨道，以原占满轨道的控件宽度为基准缩为 40%；真实 DOM 双版本测量 |
| R7 | 多主体正式结果工作簿内名称、定义名称和打印范围不再相互隔离 | 建立全工作簿唯一名称计划；按业务身份、Sheet 和局部单元格核验，不按名字猜主体 |

### 1.3 与 Spec 的差异

本方案遵循 Spec 已确认的 D1 及 D2—D7 设计约定。D1“仅正式结果按主体分 Sheet、仅输出一个文件”已由用户明确，不再列为待确认解释。Rev2 撤销上一稿待确认表的生产代码改造、任务和提交计划；其检查统一改为原有行为回归。暂不改业务数据库结构或金额算法。若当前输出平台需要新的持久化版本字段，应仅用于新正式结果输出合同并补齐兼容，不影响待确认布局或业务事实。

### 1.4 本轮审查意见的处理

用户提供的审查结论为：现稿范围正确，未发现必须阻断实施的文档缺陷；此前“待确认表未按主体分 Sheet”的问题已撤销。本轮保留该结论，不把以下三项重新登记为已确认缺陷，也不把文档可作为设计输入解释为实现或验收通过。

| 审查建议 | 本稿补充位置 | 设计验收目标（当前证据见 §12、§13） |
| --- | --- | --- |
| 补齐真正的页面导出接入点 | §二 S15/S16、§5.2、T1 | 从原页面/IPC 入口导出，多主体时只交付一个完整结果文件；不是只单测新内部 action |
| 逐 Sheet 校验实际原始 XML 部件 | §5.4、§5.5.1、§7.2 | 按工作簿关系解析各 Sheet；仅篡改第二主体的调整引用或原因也能检出 |
| 区分提交前失败与提交后接管待重试 | §5.5.2、§6.1、§7.3、T5 | 已提交文件和必要恢复凭据保留；接管失败不被重新解释成导出失败；恢复不重复发布 |

Spec 原样复用 Rev3，不增减产品需求或验收编号。下文保留 Rev4 的设计依据；当前实现、检查结果和未验收项以 §12、§13 为准。

## 二、涉及的文件清单与代码依据

以下“现有”路径记录 Rev4 设计时的固定提交事实，当前改动另见 §12、§13。Rev4 文档阶段定向重读 `vcc-financial-op-service.js`、`vcc-financial-op-writer.js`、`vcc-financial-op-output-publication.js` 和 `vcc-financial-op-output-recovery.js`；其余沿用原稿记录或本轮用户提供的审查报告。`src/main.js` 的页面直接入口定位来自该审查报告，本轮未独立通读其 IPC handler；必须在 T1 核对真实 handler、依赖注入和调用者，不能将用户本地代码与固定提交静默视为相同。

“新增建议”不是已存在接口，也不是已完成代码。以下直接调用链、策略定义与运行时有效 gate 分开记录；未启动应用，不断言某 managed 策略当前已启用。

| 索引 | 文件 / 入口 | 核实到的事实或计划改动 |
| --- | --- | --- |
| S01 | `src/shared/vcc-review-projection.js` / `projectReview` | **保持不变，仅回归**：原多主体投影、标题/表头、分隔行、明细/调整、四类汇总及行号 |
| S02 | `src/backend/vcc-financial-op/review-export-plan.js` / `prepareReviewManifest`、`sheetName` | **保持不变，仅回归**：manifest、新鲜度、来源、分组、附页名称与预算；不新增主体主 Sheet 计划 |
| S03 | `src/main-process/vcc-financial-op-review-writer.js` / `writeReviewWorkbook`、`expectedDefinedNames` | **保持不变，仅回归**：一个 `待确认表` 主 Sheet、原调整引用与 `pages.length + 1` 计数；不迁入新结果布局 |
| S04 | `src/main-process/vcc-financial-op-review-validator.js` / `validateMetadata`、`normalizeRange`、`expandLineage` | **保持不变，仅回归**：原主表索引、单主表打印区、固定 Sheet 引用及原表附页核验 |
| S05 | `src/main-process/vcc-financial-op-writer.js` / `buildResultSheet`、`buildPendingSheet`、`validateStagedWorkbook`、`validateResultWorksheetRawPayload`、`assertAdjustmentLineage` | 现有主体级模板布局与严格验证；本轮核实 raw payload 包装器固定读取 `xl/worksheets/sheet1.xml`，血缘检查也含固定结果 Sheet 名；须按真实部件/全工作簿计划参数化，不只循环旧函数 |
| S06 | 同上 / `planRunWorkbookOutputPaths`、`writeRunWorkbooks` | 现有多主体多路径、主体分片及下推读取参数；新单文件不能复用“每主体一个 outputPath”的假设 |
| S07 | `src/main-process/vcc-financial-op-output/` | 已有 `dispatch.js`、`authority.js`、`artifact-evidence.js`、`staging-identity.js`、`writer-coordinator.js`、`writer-core.js` 等。审查指出 `dispatch.js` 不是该页面当前的直接调用方；不能仅改此目录而遗漏 S15 → S16。是否复用其中执行能力，须从页面真实链路显式接入 |
| S08 | 同目录 `policies.js` | 已有 `export-subjects` 与 `export-single` 不同策略、文件计划和校验键；其中 production 为策略基线信息，不能单凭此文件断言运行时启用了某路径 |
| S09 | `src/main-process/vcc-financial-op-output-publication.js` / `writeXlsxAtomically`；`src/main-process/vcc-financial-op-output-recovery.js` / `publishVccFinancialOpOutputs` | 前者封装单次 staged 写入/校验/交接；后者负责正式目标发布及存档接管。不能把生成文件的 atomic handoff 等同于正式目标最终提交。本轮核实后者在提交后接管异常时返回 `pendingArchiveHandoff: true` 和 `warnings`，保留 receipt，不把已保存文件改判失败 |
| S10 | `src/renderer-vcc-financial-op.js` / `createArchivedMonthPickerDialog`、`handleExport`、`openUnarchiveDialog` | 共用弹窗、年份/月字段、就绪提示、busy/代次/关闭保护；导出模式局部调整 |
| S11 | `src/styles-vcc-financial-op.css` | 原 Grid 三列、`gap:10px`、select 的 `width:100%`、`min-width:0`；增加导出专用选择器 |
| S12 | `index.html`、`src/styles-gemini.css` | 现有样式装配；全局 `box-sizing:border-box` 及 `[hidden]{display:none!important}` |
| S13 | `src/backend/vcc-financial-op/README.md` | 纯 hash/映射血缘入口与 IO 分离；不得为分 Sheet 引入另一份金额、hash 或血缘算法 |
| S14 | `AGENTS.md`、`CODEX.md`、`.agents/skills/save-spec/SKILL.md` | 分支基线、文档存放、输出合同变化的集成测试及正式交付门禁 |
| S15 | `src/main.js` / 既有 VCC 结果导出 IPC handler | 按审查报告定位的页面直接入口；T1 核对保存位置选择、单文件路径计划、target snapshot、batchContext 与对 `exportRun` 的调用。需要修改/复用这里的实际接线，不能只登记内部 action |
| S16 | `src/main-process/vcc-financial-op-service.js` / `exportRun` | 本轮重读核实：`runDirectTask('export-result')` 内重查已归档月份、runId/subjects，随后调用注入的 `writeRunWorkbooksFn`，再调用 `publishOutputFilesFn`。这是新整月 Writer 的明确服务接入点；既有发布返回信息不得在新路径中被误吞或改判 |
| N01 | 建议新增 `src/backend/vcc-financial-op/result-sheet-plan.js` | 仅正式结果的纯 Sheet 计划/名称分配能力；禁止包含 fs、DB、worker 或金额重算；待确认表不接入 |
| N02 | 建议新增 `src/main-process/vcc-financial-op-result-workbook-writer.js` | 新整月单工作簿受限 Writer 与单工作簿校验编排，避免破坏旧主体文件入口 |

**本轮定向源码证据：** 固定提交中，S16 的 `exportRun` 位于本轮读取的第 900—1090 行片段；S05 第 857—889 行包含固定 `sheet1.xml` 的读取，第 880—985 行包含固定 Sheet 名的血缘范围检查；S09 的 `publishVccFinancialOpOutputs` 第 1—174 行包含正式发布和提交后接管返回合同。行范围仅用于本轮静态定位，实施后以函数与新提交为准。`src/main.js` 的入口定位另以用户粘贴的审查报告为依据，不冒充本轮独立源码核验。

主要测试入口：已核实引用 `tests/unit/main-process/vcc-financial-op-review-export.test.js`、`scripts/integration/vcc-financial-op-adjustment-archive-chain.js`；Renderer 实际生命周期测试入口为 `scripts/test-renderer-lifecycle.js`。新用例与文件名按当前测试目录及集成测试策略补充，不凭空标记现有测试已覆盖新行为。

## 三、需求 1：正式结果的主体 Sheet 计划

### 3.1 基本原则

本章仅用于正式结果。待确认表不共用、不迁入新布局计划。分组键只能是权威结果中的原始 `subject`，不能用 `sanitizeFilePart(subject)`、Sheet 名、截断字符串或显示文案作为身份键。有效主体集合及顺序沿用现有正式结果导出语义；不把导入原表的 Sheet 名当作导出主体，不额外请求用户选择主体。

一次正式结果导出冻结同一 run/revision/input fingerprint 及有序主体集合。读取和写出期间不混合来自不同结果版本的主体；发布前继续执行已有新鲜度/资格检查。无论包含多少个有效主体，最终用户输出都为一个结果文件。

### 3.2 建议内部计划结构

下面是拟新增的内部设计，不是当前 IPC 或已持久化 JSON 合同。业务库中的 hash 版本、金额结构及 run 状态不变。

```text
ResultWorkbookSheetPlan
  layout: subject-sheets-v1
  kind: result
  runId / resultRevision / inputFingerprint
  artifactCount: 1
  subjectOrder: [原始主体身份...]
  sheets:
    - ordinal: 工作簿内连续序号
      kind: result-main | result-pending
      subject: 原始主体身份
      name: 最终合法 Sheet 名
      contentReference: 对应主体结果计划或 Pending 附表计划
      rowCount: 此 Sheet 自身实际行数（包括适用的表头）
      expectedContent: 对应的内容/行身份/样式校验证据
```

计划中保留 Sheet 类型，不得通过“第一个 Sheet 就是主表”或后缀字符串判断表类型。`subjectCount`、`sheetCount`、`artifactCount` 分别核算。本方案保留每主体一张结果主表和一张 Pending 附表，因此有 N 个主体时，最终文件数为 1、Sheet 数为 2N；临时资源不能计入最终文件数。计划中不包含 `review-main`、`review-source` 或待确认投影。

### 3.3 名称分配

正式结果主表名使用 `<主体>-结果表`；结果附表用 `<主体>-移除归档Pending发生额计算表`，对应 Spec D2、D4。待确认表的固定主 Sheet 名和差异附页名完全不变。

在写任何正式结果 Sheet 之前先分配并冻结全工作簿名字：先登记所有主体主表，再分配附表。名称规则沿用原稿归纳的合法化原则：处理不合法/控制字符和首尾引号、31 字符边界、大小写不敏感去重、保留名、稳定摘要后缀。判重同时维护公共 XLSX reader 的 `toUpperCase()` 占用键及 ExcelJS 回读的 `toLowerCase()` 占用键；任一冲突即使用既有摘要后缀，不将名称键用作主体业务身份。截断需避免拆开 Unicode 代理对，消歧后缀也计入长度。两个主体被清洗成相同显示名时必须分配不同名字，完整主体仍保留在表内和导出清单中。

纯计划与名称分配由 N01 负责，不为消除表面相似而把待确认 manifest、投影或名称规则一起重构。若复用已有纯工具，保留原入口默认行为，并证明待确认表输出不变。

### 3.4 全量一致性条件

正式结果主 Sheet 的主体集合与权威主体集合完全一致，每主体恰有一个结果主 Sheet 和一个 Pending 附表。零差异或没有明细但已有有效汇总的主体也不得遗漏；不以待确认差异附页的生成条件筛选正式结果主体。

每主体业务行、金额、汇总和调整记录与同一快照下旧单主体结果一致；仅文件组织、Sheet 名及相应引用位置变化。全工作簿的行数、Sheet 数和内存等资源限制须在新结果管线内检查，超过限制明确失败，不遗漏主体、不退回多个最终文件，也不调整待确认表原有预算。

## 四、待确认表保持现状与回归边界

### 4.1 撤销上一稿的改造任务

不实施上一稿的逐主体 `projectReview` 调用、主体主表 manifest、多个待确认主 Sheet、局部行号重排、引用/打印重建或新布局版本。S01—S04 作为现有行为依据与回归对象，不属于本次计划修改的生产文件。

待确认表仍单独导出，固定 `待确认表` 主 Sheet 包含全部主体，后续仅追加现有差异原表附页。不能将待确认表合入正式结果，也不能输出 `<主体>-待确认表`。

### 4.2 保持的合同

保留原多主体投影中的标题、表头、主体分隔空行、明细/调整与四类汇总，保留原工作簿内行号和 `待确认表!M...` 调整引用。主表打印范围、批注、合并区域、冻结和样式继续由原 Writer/Validator 处理。

manifest 的来源、事实、分组、附页、实际提取等表结构及冻结/核验流程不改；附页选择、排序、分页、原始单元格与血缘校验不改。原“一个主 Sheet 加若干附页”的计数和预算仍有效，不改成主体数加附页数。

### 4.3 回归验证

以同一有效结果快照比较改造前后待确认工作簿的 Sheet 名和顺序、全部主体内容、调整引用、打印/批注和附页身份。保留既有“多个主体仍在 Sheet1”的断言，不因正式结果引入新布局而修改其预期。

覆盖存在差异、全体差异归零、人工调整、多个主体及来源完整性异常等原场景；例如没有差异附页时仍只有一张固定 `待确认表` 主 Sheet。比较业务/布局/引用合同，不要求导出时间等自然变化元数据或 ZIP 字节完全相同。

如正式结果复用的样式、引用或发布基础设施有变更，应回归证明待确认行为未变；不得以共享代码为理由扩大本次待确认输出范围。

## 五、需求 1：正式结果单工作簿实现

### 5.1 与旧主体文件导出分开

S05/S06 当前公开函数服务按主体文件的输出，且带 `subjectIndexes`、`subjectQueryPushdown`、`subjectNames` 等执行参数。新出口不能通过“把所有 outputPaths 设成同一个文件名”复用它们，这会导致多 Writer 覆盖同一目标，且破坏文件身份核验。

推荐新增整月单工作簿编排 N02，旧 `writeSubjectWorkbook` / `writeRunWorkbooks` 默认合同保留。正式结果的 UI 导出路径选择 `subject-sheets-v1`；待确认导出不接入；旧历史恢复、仍依赖单主体文件的内部归档流程继续沿旧合同运行。不要在尚未清点调用方时全局改变旧函数返回值和文件数量。

### 5.2 页面真实接入链路与新内部任务合同

#### 5.2.1 明确页面 → IPC → service → Writer → 发布

按照用户提供的源码审查定位，并结合本轮对 service 的独立复核，正式结果导出应沿下面的原入口接入新布局。图中 `src/main.js` 的 handler 定位来自审查报告；S16 后的调用已在固定提交复核。新增整月 Writer 是本稿设计，并非当前实现。

```text
renderer-vcc-financial-op.js / handleExport
  → api.exportResult({ targetMonth })（既有前端 API / IPC 桥接）
  → src/main.js / 既有 VCC 结果导出 IPC handler
      选择并授权一个最终保存目标
      准备一个 outputPath、目标快照与原 batchContext
  → vcc-financial-op-service.js / exportRun
      保留 runDirectTask('export-result') 的任务与租约边界
      拿到租约后重查归档资格、expectedRunId、expectedSubjects
      显式选择 subject-sheets-v1 → 新整月单工作簿 Writer（N02）
  → 生成并验证一个受管 generation 文件
  → 原 publishOutputFilesFn / 正式发布与存档接管边界
      核对实际注入是否为 publishVccFinancialOpOutputs 的现有包装
      发布一个最终文件；按提交结果处理接管完成或待重试
  → 原 IPC 返回 / 页面完成反馈
```

固定提交的 `exportRun` 当前调用注入的 `writeRunWorkbooksFn`，不是直接调用 `output/dispatch.js`。**实施必须在 S15/S16 明确接到新单文件编排。** 新增 `export-workbook` action 或只修改 `dispatch.js` 不能替代页面接线；新内部路径即使单测通过，也不等于用户点击导出已使用新布局。

T1 先列出 S15 的真实 handler、service 创建/注入处和保存位置/路径计划，再落实修改。原多主体分支若按主体数生成多个 `outputPaths`，或只提供目录选择，必须按一个最终结果文件重新规划；保留原生位置选择、授权、覆盖保护和目标快照机制，不复用旧多文件规划后再将路径强行改成同名。月份、run 和完整主体集合继续由 Main/service 权威结果决定，不能让 Renderer 提供任意主体列表或文件系统路径权限。

新入口覆盖所选月份的全部有效主体；单主体、多主体均进入相同单文件布局。旧 `writeRunWorkbooks` 默认合同与仍依赖它的内部归档/历史恢复消费者不全局切换；待确认导出不接入 N02。新服务依赖或调用参数采用显式布局/入口区分，具体签名实施时核对现有工厂和测试，不能把本图当作已存在的 API。

#### 5.2.2 内部 action 是条件性接入手段，不是前端入口

若实际使用的平台策略按 action 绑定固定主体文件/单主体校验合同，再为新布局登记独立内部 action，例如 `vcc-financial-op:export-workbook`。该名称为新增建议；采用时必须补齐当前注册、执行器、准入、结果校验、发布、恢复与测试，并由上述真实链路明确调用。不得根据 `policies.js` 的 fixture 就认定生产路径或切换 feature gate。

保留既有导出 IPC 入口和请求参数，不新增绕过归档的前端入口。新文件计划只有一个最终 artifact，但仍包含完整主体集合和实际 Sheet 映射；`outputPaths`、`generationFilePaths`、`targetSnapshots` 等适用的文件级集合均与该单一目标对应，不能保留 N 个重复路径条目。`subjectCount` 不得随文件数变为 1。

当前 service 的结果包含 `filePaths`；是否保留或扩展其他返回字段须核对 Main 和 Renderer 消费者。若外围使用 `outputs` 数组，本次同样只包含一个真实文件条目。已知旧 `export-single` 名称虽包含 single，也不能未经合同核实就当作任意多主体单文件。授权、结果新鲜度、文件所有权与安全发布边界沿用原机制，不能以单文件为由跳过。

### 5.3 数据流和资源

```text
选择月份
  → 读取并核实已归档资格
  → 冻结 run / revision / input fingerprint / 全部主体
  → 规划一个最终文件和全部 Sheet 名
  → 后台单个最终 Writer，按主体读取并顺序写出
  → 关闭工作簿并完整回读校验
  → 发布前复核结果资格与文件身份
  → 由现有发布边界提交一个正式文件
  → 存档接管：完成则正常收口；待重试则保留正式文件与必要 receipt
  → 返回准确的文件结果及适用的接管告警
```

在同一只读一致性快照内按主体加载有效结果和 Pending 数据，复用 S05 已有的主体结果计划与模板语义；不从 UI 文本反算金额。为满足“主表在前、附表在后”，可以在同一快照中分两轮按主体读取，或将必要的附表数据写入受管临时缓存，不能因排序要求无限保留全量数据。

最终工作簿只有一个所有者、一个 Writer。现有主体级并行能力若继续用于准备数据，其输出只能是受管准备结果，不可并发写同一个 XLSX。首版采用顺序受限写出不代表性能与旧多文件导出相同，需记录基线与改造后耗时、峰值内存；没有性能实测不得承诺提速。

大数据量时不建议将全部主体表装入现有普通 `ExcelJS.Workbook` 后一次性回读。应迁移/提取必要的行式构建能力到受限写入入口，逐行/逐 Sheet 提交；回读校验也须受限。对模板保真、合并、定义名称和打印设置做真实文件回归，不能以换成流式接口为由削减格式合同。

### 5.4 主体结果与 Pending 附表

`buildResultSheet`、`buildPendingSheet` 的新共享实现接受显式 Sheet 名，但旧公开调用仍可默认使用旧固定名。将对应 Validator 改为接受明确 Sheet 对象/名字及本主体计划；原始 XML 层还必须接收经关系解析得到的实际 worksheet part。保留旧双 Sheet 校验包装器；新全工作簿包装器按冻结计划调用参数化校验，并统一核验工作簿级定义名称。不得仅在外层循环仍固定读取 `sheet1.xml`、固定结果 Sheet 名或扫描全部名称的旧包装器。

每个结果 Sheet 独立克隆模板列、行样式、合并范围、打印/筛选设置、调整值/原因格式和该主体差异着色。Pending 附表保留现有十一列布局、行内容与汇总语义；每个附表严格限制在一个主体。没有 Pending 明细时仍沿用当前附表空数据表现，不删除原本必有的附表。

正式结果的调整 defined name 需在最终 Sheet 名和最终行号确定后生成。引用必须正确转义 Sheet 名中的单引号；合法 Sheet 名可能含逗号，范围解析不得直接按逗号盲目切分。全工作簿的名称冲突不能通过改变 `rowKey` 或主体业务身份解决；应先确认现有 key 的唯一性，并使用匹配既有血缘语义的范围集合或明确的新输出引用合同，测试覆盖相同分类/币种出现在多个主体的情形。

### 5.5 最终文件验证与发布

#### 5.5.1 按实际部件逐 Sheet 验证

最终校验覆盖主体集合、主表/附表一一对应、有序 Sheet 名、每主体金额/汇总、调整行和原因、样式/合并/打印/筛选，以及无额外/遗漏主体或跨主体引用。保留原始 OOXML 检查，不能只用 ExcelJS 读取几个表头。

本轮复核 S05：`validateResultWorksheetRawPayload` 固定读取 `xl/worksheets/sheet1.xml`；`assertAdjustmentLineage` 也把范围限定到原固定结果 Sheet。这两个旧假设仅适用于原合同，新多主体包装器不能原样循环使用。

拟定的新校验流程如下；这是待实现设计，优先复用现有 OOXML 命名空间、ZIP 与受限读取基础设施，不新增无关依赖：

1. **冻结期望，再独立解析实际映射。** 从关闭后的 XLSX 读取 `xl/workbook.xml` 和 `xl/_rels/workbook.xml.rels`，按 Sheet 的 `r:id` 解析实际 worksheet 文件部件，得到 `sheetName / workbookOrdinal / sheetId / relationshipId / entryPath`。核对冻结的名称、顺序、类型和主体映射；不得用 `sheetId`、数组下标或名称拼成 `sheetN.xml`，也不得用输出文件内自报的主体名替代权威期望。
2. **验证映射合法性与完整性。** 关系必须指向包内存在的 worksheet 部件；按既有路径安全规则规范化，拒绝外部关系、越出包范围、重复/歧义关系及多个预期 Sheet 指向同一数据部件。缺失、额外或不匹配 Sheet 均失败，不因前几个主体通过就忽略剩余部分。
3. **逐个校验实际 worksheet。** 对每个 `result-main`，使用本主体行计划、局部行号和对应 `entryPath` 校验原始 XML，再做原值/样式/合并/冻结/筛选等合同验证。可把 `validateResultWorksheetRawXml` 的纯规则复用为参数化入口；不得重复读取第一张 Sheet。对 `result-pending` 使用其十一列附表合同及对应真实部件校验，不能把主表规则错误套给 Pending，也不能跳过后续主体附表。
4. **工作簿级引用一次汇总核验。** 调整 `definedName` 的声明在 `xl/workbook.xml`，不是全部位于 worksheet XML。结合最终 Sheet 名、适用作用域/`localSheetId` 和本主体 M 列局部行号，检查名称、目标单元格、rowKey、币种与主体的对应关系；普通调整原因在该主体 worksheet 的 N 列逐项检查。打印范围与适用的内建定义名称按实际 Sheet 作用域核对。保留单引号/逗号等名称转义规则，不能对范围字符串盲目按逗号切分。
5. **受限读完再准许发布。** ZIP/工作簿级元数据尽量只打开或解析一次，逐部件受限读取；不能每个主体都完整加载整个 ZIP。全部主表、附表、原始 payload 和工作簿级引用核验通过后才准许正式发布；生成文件的 SHA/大小、主体集合与 Sheet 映射进入相应证据。

新增显式负向要求：第一主体完全不变，仅将第二主体调整原因替换为含公式 payload 的单元格（包括显示/缓存值看起来相同的情况），仍必须失败；另单独只改第二主体的调整 defined name，使其指向第一主体或错误局部行，也必须失败。两项分别修改 worksheet 与 workbook 元数据，不把“调整引用”和“原因单元格”误当作同一种 XML 位置。详见 §7.2。

新文件的默认名见 Spec D7。保留原保存位置授权及覆盖保护机制，按一个最终文件规划目标；前端文件数和路径列表指向该文件，主体数仍为实际数量。内部准备片段不对用户发布。

#### 5.5.2 以正式提交边界区分失败与接管待重试

`writeXlsxAtomically` 在生成阶段的成功不必然代表用户最终目标已提交；正式提交以既有 publisher 的耐久结果与凭据为准。不能仅根据文件存在、异常发生先后或 Writer 返回成功判断正式发布结局。以下是实施阶段分类，不新增业务状态枚举，也不改变已归档 run 的业务状态。

| 阶段 / 证据 | 正式文件与结果语义 | 清理与恢复要求 |
| --- | --- | --- |
| 正式提交前的生成、校验、资格检查失败，且确认尚未提交或已安全回滚 | 本次导出失败，不交付新的部分结果；原有目标和原始输入按原保护合同处理 | 只由 owner 清理本次拥有且允许清理的临时资源；尊重 `preserveTemporaryFiles` 等保护，不能通用 catch 删除 publisher 所需凭据或备份 |
| 提交中断，尚不能确定提交结果 | 不凭猜测宣称已导出、未导出或已回滚 | 保留既有 journal/receipt、必要备份和所有权证据，交给原恢复 owner 判定；不自动重导、不覆盖现有目标 |
| 正式文件已提交，但存档接管/耐久交接未完成 | **正式文件已保存，存档接管待重试**，不是生成/导出失败，也不是所有后续工作都已完成 | 保留正式文件和恢复所需 receipt；沿既有接管/启动恢复流程重试；不删除、重新发布或制造第二个结果文件 |
| 正式文件已提交，接管及适用终态已耐久完成 | 正常返回一个已保存文件 | 仅由既有 owner 按原合同清理已可释放资源；不得提前删除 receipt |

固定提交中的 `publishVccFinancialOpOutputs` 在正式发布完成后执行 `settleManifestArtifacts`（或既有 `recoverIntoArchive`）以及适用的 `onDurableHandoff`。其中接管异常会返回 `pendingArchiveHandoff: true` 和 `warnings`，而非把已提交输出抛成失败；代码明确保留 receipt 供耐久收口或启动接管。此合同必须在新单文件路径保持。

本轮同时确认：基线 `exportRun` 只是 `await publishOutputFilesFn(...)`，未把其返回对象合入 `publishedResult`。因此不能假定页面目前已自然收到 `pendingArchiveHandoff`。实施时核对 Main 包装、TaskLifecycle 与 Renderer 的消费者，显式保留或映射相应技术结果和告警：维持单一 `filePaths` 的已保存事实，通过既有可见反馈区分接管待重试，不因内部告警抛出通用“导出失败”。具体对外字段以现有 IPC 兼容合同确认，不能擅改业务 `status` 枚举，也不能静默吞掉待接管事实。

外围 `TaskLifecycle.runFileTask` 的终态结算必须覆盖接管 Promise rejection：首次业务回调仍获得原异常，Publisher 据正式提交事实返回已保存、待接管；外围只在业务分类为 `succeeded` 且没有业务异常时，将再次等待缓存 Promise 的 rejection 视作非耐久结算。保留首次 `artifactKey`、SHA256、大小和原 owner，进入现有成功终态意图持久化分支，不清空缓存、不立即重试、不提前 finish/ACK。`beforeTerminalSettlement` 的提交未知保护先执行；普通失败、取消、意图自身抛错或未持久化仍沿用原拒绝行为。本轮只修复实际 eager 入口，不扩大至 deferred 通路。

提交后的技术告警不属于待隐藏的常态“已归档，可导出”框；可以复用现有主状态框或错误/警告反馈，不新增无关页面。恢复只续做原接管/结算动作，按 receipt 和文件身份核对并保证幂等；不能再调用 Writer 重生成来假装完成恢复。接管成功前不得释放恢复仍需的凭据。遇到结果不确定或身份不一致，保留证据并按原恢复合同报告，禁止根据路径存在自动认领。

任一阶段都不得扩大资源所有权，不删除原始输入、历史归档或无关文件；但也不能把“异常就清理临时资源”用于擦除已提交但待接管的正式文件或必要恢复凭据。§7.3 分别验证这些阶段，保持 Spec AC10/AC11 的原含义。

## 六、需求 2：导出页面局部调整

### 6.1 导出展示模式

在 `handleExport` 调用月份弹窗时传入明确展示模式，如 `presentation: 'result-export'`，其他调用默认维持原样。为导出弹窗追加独立 class，例如 `vcc-fin-op-archive-picker-dialog--export`；不要修改共享 `.vcc-fin-op-delete-state` 或所有 `.vcc-fin-op-input`。

正常就绪时清空并隐藏 `[data-role="archive-picker-state"]` 的框体，使其不占空间、不进入可访问的提示内容。模式判断与内部“就绪”语义结合，不用匹配 `XXXX-XX` 字符串，也不能把 `tone === 'success'` 的所有消息都隐藏。

加载、资格变化、执行中、失败和取消失败等状态仍使用原来的可见反馈。正式文件已提交但存档接管待重试时，保留“已保存”的准确结果和可见技术告警；该告警不得被常态就绪框的隐藏规则吞掉，也不得改写成文件导出失败。可以保留一个条件显示的反馈元素，避免空节点和 `waitForPreviewState` 空引用；测试需要核验实际可见性与文案，而不仅是 class 存在。

保持 `previewVersion`、`renderGeneration`、`currentSelectionCanExecute`、`pendingPreview`、busy 锁、`canClose`、监听释放和取消资格。隐藏常态文案不影响后台复核；旧异步响应不能重新显示已隐藏提示或启用错误月份的按钮。

### 6.2 宽度实现：保留原 Grid 基准

当前基础样式：

```css
.vcc-fin-op-archive-picker-fields {
  display: grid;
  grid-template-columns: auto minmax(110px, 1fr) minmax(110px, 1fr);
  gap: 10px;
}
.vcc-fin-op-input { width: 100%; min-width: 0; }
```

现有全局为 `box-sizing: border-box`。保留同样的 Grid 轨道、表单外宽及 label/gap，原 select 外框宽度等于它自己的轨道宽度。导出模式下可限定为：

```css
/* 新增建议，仅作用于正式结果导出的年份、月份两个控件。 */
.vcc-fin-op-archive-picker-dialog--export
.vcc-fin-op-archive-picker-fields > select.vcc-fin-op-input {
  width: 40%;
  min-width: 0;
  justify-self: start;
}
```

此处 `40%` 的参考盒是该控件原来占满的 Grid 轨道，因而等于原控件宽度的 40%，不是整个弹窗的 40%。原 `110px` 为轨道下限，不是新控件下限；不能给 select 重新加 `min-width:110px`。控件仍位于原列起点，因此仅改变宽度，不主动重排布局，符合 Spec D6。

不要把整个 fields 容器再缩成 40%，也不要把两个轨道简单改成两个 `0.4fr`：若它们仍共同分配全部剩余宽度，实际宽度不会缩小。不得在每次重绘时读取已经缩小的宽度后再乘 0.4，导致重复缩小。

真实界面确认不存在后置主题规则覆盖，并检查原生 select 的文字、箭头及鼠标/键盘操作。必要时只调整导出模式的水平内边距，不缩放字体/高度，不悄悄提高目标宽度。如果支持窗口条件下发生无法兼顾的内容裁切，应报告具体测量而非宣称通过。

### 6.3 UI 验证方法

在同平台、同窗口尺寸、相同年份/月值、主题与页面缩放下，分别运行基线和改造版，记录：

```text
yearBefore / monthBefore = 基线 getBoundingClientRect().width
yearAfter  / monthAfter  = 改造版 getBoundingClientRect().width
逐个断言 abs(after - before × 0.4) ≤ 1 CSS px
```

保存测试条件与截图/测量记录。检查初次打开、切换年/月、失败恢复、重开弹窗和明暗主题；另对解归档弹窗做同条件比较，确认其控件宽度与提示原样保留。只用 jsdom 的零宽度或检查 CSS 文本不算尺寸验收。

## 七、测试与验收设计

### 7.1 最小测试数据

至少包含两个名称不同、金额和差异结果不同的主体；每主体含普通行、人工调整、四类汇总以及 Pending 数据。再覆盖单主体、零差异、有汇总无明细、主体名非法字符/超长/大小写碰撞/单引号/逗号，以及两个主体相同分类和币种。Unicode 碰撞至少覆盖 `Straße/STRASSE`、`σ/ς`、`ﬀ/FF`、`ß/ẞ`；真实 Writer/Validator 和 ExcelJS 回读都必须通过，并核验各主体金额、调整引用与重复导出的名称稳定性。

所有金额比较使用当前规范化金额合同，不通过格式化显示字符串或浮点近似重新推导期望。样本只用合成数据或明确授权的脱敏数据，不读取真实生产资金数据做自动测试。

### 7.2 单元与文件级测试

| 分组 | 必测项 | 对应 AC |
| --- | --- | --- |
| 正式结果 Sheet 计划 | 原始身份分组、确定性排序、主表与附表名称全局唯一、特殊名称引用、单主体和空/重复身份拒绝 | AC02—04、08 |
| 待确认不变性回归 | 仍只有固定多主体主 Sheet；原主体分隔行、引用、打印/批注/合并、统计及预算不变；不改原断言为新布局 | AC01、07 |
| 待确认差异附页回归 | 生成条件不变；原表行身份/顺序/原始值/分页不变，内容篡改仍失败；全体归零时仍只有原固定主 Sheet | AC01、07 |
| 正式结果 | 一个 artifact、多主体主表和 Pending 附表；逐主体数据样式及汇总与旧输出一致 | AC02、05、06、09、18 |
| 正式结果负向校验 | 人为删除主体、交换内容、错调整坐标、漏附表、错误打印区、额外公式/链接；必须包含只篡改第二主体的独立用例 | AC06—10 |
| 实际 Sheet 部件映射 | 非连续 sheetId、部件名称与 ordinal 不相同仍正确定位；缺失/错误/重复关系被拒绝；不硬编码 `sheet1.xml` | AC08—10 |
| 提交结果传递 | 已提交、`pendingArchiveHandoff` 与 warnings 经服务/IPC/反馈正确处理；不抛成通用失败、不隐去告警 | AC11、13、18 |
| 前端 | 导出模式不显示就绪框；错误可见；不能绕过月份资格；共享解归档和旧异步响应保护 | AC12、13、15、16 |

**第二主体与 XML 定位专项用例（新增实施测试，不增加 Spec AC 编号）：**

| 用例 | 独立改动 / 测试条件 | 预期 |
| --- | --- | --- |
| XML-N1 | 第一主体内容和元数据不变；只改第二主体调整原因 N 列，加入公式/shared formula 等不允许的原始 payload，即使缓存或显示值一致 | 原始 worksheet 校验失败；不得发布 |
| XML-N2 | 第一主体不变；只在 workbook 的 defined names 中将第二主体调整引用改为第一主体 M 单元格，或错误的第二主体局部行 | 引用/血缘校验失败；不得以金额相同放行 |
| XML-N3 | 仅在第二主体结果 Sheet 的合并 follower 注入值、公式或 inline payload | 原始 XML 校验失败；不能因高层库忽略 follower 而漏检 |
| XML-N4 | 只改第二主体 Pending 附表金额、主体关联或删除该附表 | 全量主体/附表内容校验失败；不能只检查主表或第一主体 |
| XML-M1 | 在保持合法完整关系的前提下，使用非连续 sheetId 或不同 worksheet 部件名；另分别构造缺失/指向错误部件的关系 | 合法等价映射按实际关系通过；错误映射失败。关系修改应保持合法样本的内容类型/部件引用一致，不能把损坏测试包当成映射能力测试 |

独立变异测试必须先证明未改动的合法工作簿通过，再单独变更一个目标点并断言对应拒绝原因；不能仅因 ZIP 损坏而报错就算检出。确保两个主体确有不同 rowKey/金额/调整原因，且第一主体仍完整。不要只用与 Writer 相同的 helper 生成全部期望：保留独立的主体/行/金额固定预期或基线样本，防止两处一起写错而“自证通过”。

### 7.3 集成与恢复

执行真实临时 DB → 有效结果/调整 → 原待确认导出 → 归档 → 新正式结果导出流程，用真实 XLSX 回读断言，不伪造 Writer 结果。待确认环节断言原布局；正式结果环节断言一个文件内全部主体主表与 Pending 附表，不能把两类输出共用一套新 Sheet 数量预期。参考并扩展现有 `scripts/integration/vcc-financial-op-adjustment-archive-chain.js`，运行方式按现有集成策略与 runner 确认。

**必须有一个从真实页面导出入口贯通的用例：** 经原 Renderer API/IPC、Main handler、`exportRun`、新整月 Writer 和正式发布边界，证明多主体时只规划一个目标、交付一个文件且覆盖全部主体。测试可用受控原生保存对话框和合成临时数据；不得把 `exportRun`、新 Writer、publisher 全部 mock 掉后声称链路通过。记录实际运行路径，证明不是停留在新 action 的孤立单测。此处不要求使用生产数据或真实用户存档。

| 用例 | 注入时点 / 场景 | 必须验证的结果 | 对应 AC |
| --- | --- | --- | --- |
| REC-01 | 第二主体写出或最终 XML 校验失败；或发布前资格/目标快照漂移 | 无新增部分正式文件；已有目标受保护；允许清理的临时资源由原 owner 收口 | AC10、11 |
| REC-02 | 正式文件提交成功后，`settleManifestArtifacts` 或适用接管回调失败；包含经真实 Main wrapper/TaskLifecycle 的 Promise rejection | 保留唯一正式文件；核对 SHA/大小不变、`pendingArchiveHandoff` 与告警、必要 receipt；不报告为生成失败，不重导 | AC11、13、18 |
| REC-03 | 正式文件提交且前序接管步骤成功，但 `onDurableHandoff` 或适用耐久收口失败 | 文件不删除；保留恢复所需凭据，准确表述接管/收口尚未完成 | AC11、18 |
| REC-04 | 用 REC-02/03 的真实耐久记录执行既有恢复入口，再重复恢复 | 只补接管/结算，状态/产物关联幂等；不重复输出、不覆盖文件；receipt 仅在原合同允许时释放 | AC11、17、18 |
| REC-05 | 提交前后崩溃导致结果暂不确定，或恢复时目标身份不匹配 | 由既有 publisher/恢复 owner 依据凭据判定；不因文件存在就认领，不通用 catch 删除凭据，不自动重生成 | AC10、11、17 |
| REC-06 | 用户取消保存位置、适用可取消阶段取消、退出保护及旧格式恢复 | 原取消/关闭保护不退化；旧布局夹具仍按旧合同恢复，新布局不会误走旧主体分片发布 | AC11、17 |

正式文件提交前失败与提交后接管待重试必须是分开的测试，不能都断言“最终文件不存在”。接管/耐久收口失败的注入只能放在已确认正式提交之后；恢复测试须使用真实耐久记录和临时归档环境，不只 mock 一个布尔值后断言函数被调用。旧任务恢复夹具继续保留，待确认表恢复合同不改。

UI 尺寸使用真实 Electron/浏览器布局执行；`scripts/test-renderer-lifecycle.js` 可用于现有生命周期回归，不等于它已自动覆盖本次比例测量。页面还需验证 REC-02/03 的告警不被常态就绪提示隐藏规则吞掉；此检查不改变 40% 的原验收口径。

### 7.4 验证命令与证据状态

先阅读当前测试 runner 与集成测试策略，再运行覆盖本次变更的最小有效测试。已核实仓库要求包括 `npm run lint`；正式 GUI 交付、PR-ready 或发布前必须以 `npm run release-check` 通过为自动检查门禁。使用项目要求的运行时和已安装依赖，不为方便验证擅自升级依赖。

原稿记录过源码/固定版本核对；Rev2 调整功能范围，Rev3 修正多功能分支文档归属。Rev4 以用户粘贴的审查意见为修改依据，并定向静态复核 §二列明的 service、Writer 与发布/恢复代码；不重新定义当前 `main` 或本地运行路径。Spec 原样复用 Rev3，D1—D7 与 19 项 AC 不变。

Rev4 文档交付时已完成文档差异、Spec 字节一致性、同目录链接和 ZIP 唯一文档位置检查；当时未运行应用验证命令，未修改或执行业务代码，未生成真实结果工作簿，未启动应用或测量控件像素宽度。XML-N1—N4/XML-M1、REC-01—06、T1—T7 及所有 AC 均是待执行设计，不能作为测试通过记录。该段保留文档交付时的证据边界；本次开发验证及剩余人工项见 §12、§13。

## 八、任务分解

| 序号 | 任务 | 完成证据 | 状态 |
| --- | --- | --- | --- |
| T1 | 核对工作区/基线与 `src/main.js` 原 IPC → `exportRun` → Writer → 发布的真实链路；落实新整月 Writer 接线，清点旧归档/恢复消费者及实际依赖注入 | handler/工厂/路径计划清单；原页面多主体单文件链路证据；实际运行路径与日志版本，不能只有 action 注册 | 已实现；链路集成通过 |
| T2 | 建立仅用于正式结果的主体 Sheet 计划、合法名称和引用合同 | 单元用例覆盖身份/顺序/重名/特殊字符 | 已实现；单测通过 |
| T3 | 待确认表原有行为回归，不改其生产导出管线 | 真 XLSX 固定多主体主 Sheet、原引用/打印/计数/预算、调整及差异附页不变 | 生产保持原样；完整门禁回归通过 |
| T4 | 新整月单工作簿受限写出；按实际关系定位各 Sheet 的原始 XML 与工作簿级引用校验 | 单文件完整主表/附表、数据/样式比较；XML-N1—N4、XML-M1，第二主体单点篡改必须拒绝 | 已实现；真实 XLSX 回归通过 |
| T5 | 接入单文件计划、最终发布、审计/统计及恢复；区分提交前失败、提交结果不确定与已提交接管待重试，保留适用结果/告警 | REC-01—06；正式文件及 receipt 的保留/释放边界、幂等恢复、旧日志回归和页面准确反馈 | 已实现；故障与恢复验证通过 |
| T6 | 导出 UI 模式、就绪框隐藏和局部 40% 宽度 | 真实页面测量、错误反馈及解归档回归 | 已实现；UI 18/18，键盘菜单/Windows 待人工 |
| T7 | 集成、性能和正式交付前门禁 | 最终代码对应的测试输出与人工验收记录 | 性能已测；完整门禁 PASS；平台人工项未完成 |

## 九、实施计划（Commit 粒度建议）

本节只建议提交边界，不表示已创建提交，也不授权自动 push。

| 顺序 | 建议提交说明 | 范围 |
| --- | --- | --- |
| 1 | `feat(vcc-fin-op): 增加正式结果主体工作表计划与命名合同` | 仅正式结果的纯计划能力及测试，不改待确认生产管线 |
| 2 | `feat(vcc-fin-op): 校验结果导出为多主体单工作簿` | 新结果编排、任务/文件合同、兼容与发布测试 |
| 3 | `style(vcc-fin-op): 简化结果导出月份选择页面` | 导出专用状态和宽度、真实 UI 回归 |
| 4 | `test(vcc-fin-op): 补齐结果单文件导出与待确认不变性回归` | 正式结果集成/恢复/资源证据；待确认固定主 Sheet 等原合同回归 |


模块分支基于已确认的 `v3.2.10` 标签，不基于继续漂移的旧 release 分支；后续按本轮发布安排合入 `release/v3.2.11`，再由发布任务处理 main、版本号与正式标签。本次不创建这些 Git 引用。

本任务是 v3.2.11 多功能分支版本中的一个功能分支，文档按 `save-spec` 规则唯一存入 `changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/`。保留完整分支名并将其中的 `/` 展开为目录层级；不在版本根目录另存本任务的 Spec/TechDoc。关联 Spec 使用同目录相对链接 `spec.md`，Spec 反向引用 `techdoc.md`；正文反引号中的源码、规范和模板路径仍以仓库根目录为基准。若工作区已有上一稿，核对同名文件及未提交差异后迁移本任务文档并同步调用方引用，不覆盖其他功能分支文档。

## 十、实施日志

### 2026-09-29 — Rev1 原稿记录

原稿通过连接的 GitHub 读取固定 `main` 提交、正式标签、仓库规范、模板、相关导出源码和 UI/CSS；记录正式结果当前为按主体多文件、待确认当前为一个多主体主 Sheet、月份选择器复用于解归档。

原稿记录的固定基线为 `v3.2.10` → `18b82b4328cf5e00c1b2549d373a5b2f2677215c`，源码索引见 §二。原稿未修改业务代码、归档文件或远端分支。

### 2026-09-29 — Rev2 范围调整

用户明确：“调整一下：仅结果表按主体分sheet，输出一个结果表文件”。本次依据该调整及已交付的 Spec/TechDoc 修订，不重新搜索或推断当前远端实现状态。

决策：正式结果按主体分 Sheet，每次只交付一个结果文件；待确认表保持原有导出结构及完整管线；导出页面去除就绪状态框、年份/月宽度缩至 40% 两项不变。D1 转为已确认要求，具体名称、顺序及附表保留按 Spec D2—D7。

同步修改：Spec 范围/功能点/影响范围/验收矩阵；TechDoc 风险、文件计划、内部数据结构、待确认章节、测试、任务与提交计划；文档包 README。原待确认主体拆 Sheet 的实施方案全部撤销，T3 改为不变性回归，不作生产改造。旧稿不再作为实施输入。

当时交付：Rev2 `spec.md`、`techdoc.md` 和配套文档包；该稿现由 Rev3 替代。T1—T7、真实 UI 测量、真实输出验证、性能测试、集成与发布门禁当时均未完成。未修改应用代码，未创建分支、提交、push 或 PR。

### 2026-09-29 — Rev3 功能分支文档归属修正

用户明确：“该任务为功能分支，该开发版本有多个功能分支”。据此撤销上一稿“仅明确一个开发分支，先存版本根目录，后续多分支再迁移”的约定，不再把固定基线中不存在目标版本目录作为单分支依据。

决策：本任务仍使用功能分支 `codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui`；Spec 与 TechDoc 唯一存入 `changes/v3.2.11/codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui/`，按完整分支名展开目录层级。正文中的同目录引用、文档元数据、README 和 ZIP 内目录结构已同步调整；本次包内不再保留版本根目录下的本任务文档副本。

本次只修正文档归属与路径。Rev2 已明确的功能范围不变：仅正式结果按主体分 Sheet，每次输出一个结果表文件；待确认表不改；导出页面去除常态就绪提示，年份、月份下拉宽度为原来的 40%。D1—D7、19 项 AC 及 T1—T7 均保持不变。

当时产物：Rev3 `spec.md`、`techdoc.md` 与文档包。Rev3 完成的是文档和打包一致性自检；当时未重新读取远端仓库、未迁移实际仓库文件、未修改应用代码，未创建分支、提交、push 或 PR；应用测试与正式验收仍待实施后执行。

### 2026-09-29 — Rev4 吸收审查实施细节

输入是用户在对话中粘贴的审查结论及三项建议。本轮没有读取或改写用户本地 `/Users/pzhong/.../2026-09-29-v3.2.11-vcc-doc-review.md`，也不宣称已更新该报告；审查中已撤销的待确认表问题继续保持撤销。

原样复用 Spec Rev3，未改需求、D1—D7、19 项 AC 或分支归属。仅在 TechDoc 补齐页面真实接线、逐 Sheet 原始 XML/全局引用校验及提交后接管待重试语义，并在风险说明、文件清单、测试设计、T1/T4/T5 和门禁中同步对应细节。没有新增第二份 Spec 或另一套业务状态枚举。

本轮在原固定提交独立复核 service、Writer 与发布/恢复相关片段：确认 `exportRun` 直接使用注入 Writer/发布回调；确认旧 raw payload 包装器固定读取 `sheet1.xml`；确认正式提交后接管失败返回 `pendingArchiveHandoff`/`warnings`，并发现 service 不能被假定已透传这些返回信息。主 IPC 定位按用户审查报告记录，真实工作区 handler/注入和运行验证仍属 T1。

交付包 Rev4 包含未改动的 Spec Rev3、新 TechDoc Rev4 和更新的 README。已执行文档差异、链接、Spec 字节一致性及 ZIP 完整性检查；未修改实际仓库文件或业务代码，未创建 Git 分支、commit、push、PR，未运行应用测试。新测试用例全部为待实施/待执行，不能把本次静态核对视为实现、性能或验收通过。

## 十一、Open Technical Questions / 实施门禁

Rev4 的技术 probe 已按本地固定基线核实；没有改变需求的 BLOCK 项。当前结论和证据归入 §12、§13，尚未完成的平台验收继续单列，不能由文档设计或自动化检查代替。

## 十二、实施记录（2026-09-29，功能分支）

本节保留首轮实施状态；两项 P2 的修复及最新验证见 §13。§7.4 与 §十保留 Rev4 文档交付时的历史记录。Spec Rev3 保持字节一致，范围、D1—D7 和 19 项 AC 不变；自动化通过不表示全部 AC 已完成人工验收。

- 工作目录：`/Users/pzhong/.codex/worktrees/v3211-vcc-subject-sheets/bank-bill-excel-tool`。
- 功能分支：`codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui`；起点为用户指定的当前本地 `main`，`18b82b4328cf5e00c1b2549d373a5b2f2677215c`。
- `save-spec` 已核对并复用本目录的 Spec/TechDoc。Spec SHA256 为 `c4e20640566e9b309b65010668888c0d19aa75e2bdc4979a5e0adcdf63ee3db3`，19 项 AC 未增减。
- 修改均在独立 worktree；测试使用合成数据和临时数据库/文件。未提交、推送、开 PR、升版或发布；主 checkout 的已有文档保持。

### 12.1 Decisions / 已核实的不变量

1. 页面原 `vccFinancialOp:export:result` 仍由 `src/main.js` 的 `trackedIpcHandle` 登记，准备与执行逻辑提取到 `vcc-financial-op-result-export-ipc.js`。单主体和多主体均用原生单文件保存对话框，默认名 `YYYY-MM_VCC财务OP校验结果表.xlsx`，仅一个 FilePlan output。实际 handler 工厂进入集成验证。
2. `exportRun` 保留原 `runDirectTask('export-result')` 互斥，写出前及发布前重查 run、主体集合、revision、fingerprint 和归档时间。新专用 Worker 使用只读 DB 与一致性事务，Writer 使用嵌套 SAVEPOINT 并且不提交外层事务。Main 等待真实 exit 后发布；结果消息不作为退出屏障。关闭时只允许同一活动 direct task 完成必要的资格读取。
3. 原结果导出执行阶段为 direct task，取消/应用关闭继续等待完成，不新增执行中途取消合同。待确认表的独立导出及其取消路径保持原实现。
4. Main 注入现有 ResourceGovernor 的 phase lease；新结果 Worker 申请一个 CPU、Worker、重 IO 槽位及 512 MiB 内存预算，V8 old-space 上限 384 MiB。总预算不足直接拒绝，暂时占用最多等待 5 秒；不降级为多文件。预算值是准入约束，不是实测峰值上限。租约在 Worker 真正退出后释放。
5. `result-sheet-plan.js` 为正式结果建立 `subject-sheets-v1`：全部主体主表置前，全部 Pending 附表置后。完整业务主体身份与名称清洗分离，工作簿内统一处理非法字符、31 字符上限、代理对和重名；单主体使用同一规则。
6. 新 Writer 在同一快照内分两轮逐主体加载、构造、写出并释放。默认限制 4096 张 Sheet、单主体 50000 源行/64 MiB 字段字节、整本 1000000 输出行、单 worksheet XML 与共享字符串 XML 各 256 MiB；在 `.all()` 前先用 SQL 核验物化预算。金额与有效调整沿用原 DTO/模板，旧 Writer 仅增加可选名称参数与 parser 导出。
7. 流式 ExcelJS 的共享字符串通过本域磁盘 SST 输出，缓冲 1 MiB，去重缓存最多 8192 条/8 MiB，保留 `_xHHHH_` 字面量和真实换行。同时补齐流式 `printOptions` 以及带单引号的打印范围；未修改公共 XLSX 基础设施。新 Validator 经 workbook relationships 定位各 Sheet，逐张校验值、原始 payload、样式、合并、冻结、筛选、打印及定义名称。
8. Worker 创建专有 generation 子目录；Validator 的 `sstTempRoot` 显式位于其中。正常关闭由公共 provider 按身份逐文件收口；SST 身份冲突、严格关闭失败或遗留 spill 向上传递 `preserveTemporaryFiles` 和恢复路径，父层不递归删除证据。生产 adaptive spill 通过降低测试预算触发真实分支验证。
9. 继续复用既有 publisher、receipt 和 ArchiveCenter owner。验证所得 SHA256/大小经 `expectedArtifacts` 传入 publisher，避免校验后换件。已提交但接管待重试时 service 显式返回 `pendingArchiveHandoff`/warnings；正式文件及 receipt 保留，页面按“已保存、存档接管待重试”反馈。后续临时清理失败只增加告警。
10. 提交结果未知的保护只由本次 publish 已派发后的事实触发。dispatcher 增加内存标记，VCC adapter 经 Main 透传既有 `beforeTerminalSettlement` hook，阻止未知任务提前落 failed/ACK；旧 receipt 在 preflight 阻塞本次新导出仍按普通失败收口。preflight 区段显式标记 `publicationNotStarted`，service 只清理本次随机 generation，旧 receipt 的 preserve 标记和恢复路径仍保留；该分支不留下无 owner 的新暂存目录。未修改通用恢复状态机、receipt 格式或旧输出策略。恢复沿原批次和凭据处理文件，工作簿内容作为已校验产物，不由旧恢复器猜 Sheet 布局。
11. Renderer 仅 `result-export` 模式隐藏就绪框且不占空间，两个 select 各为原 Grid 轨道的 40%，保留高度/字体/起点。已保存待接管和提交未知分别提示；未知提交同时兼容带 code 的错误与 Electron 丢失 code 后的固定安全文案，月份刷新漂移也不误显示“导出失败”；状态框移除 Electron 的技术前缀，只显示完整中文恢复说明。解归档仍使用默认模式。

### 12.2 最终实现入口

| 责任 | 文件（均相对仓库根） |
| --- | --- |
| 页面入口与资源注入 | `src/main.js`、`src/main-process/vcc-financial-op-result-export-ipc.js` |
| 权威快照与发布前复核 | `src/main-process/vcc-financial-op-service.js`、`vcc-financial-op-result-export-contract.js` |
| 专用 Worker / exit / phase lease | `src/main-process/vcc-financial-op-result-workbook-runner.js`、`vcc-financial-op-result-workbook-worker.js` |
| 正式结果名称计划 / 写出 / 校验 | `src/backend/vcc-financial-op/result-sheet-plan.js`、`src/main-process/vcc-financial-op-result-workbook-writer.js`、`vcc-financial-op-result-workbook-validator.js`；复用旧 `vcc-financial-op-writer.js` |
| 未知提交与原恢复收口 | `src/main-process/toolbox-output-publication-dispatch.js`、`src/main-process/vcc-financial-op-output/task-adapter.js`；Main 只透传现成 hook |
| 页面与局部样式 | `src/renderer-vcc-financial-op.js`、`src/styles-vcc-financial-op.css` |
| 真文件/真实发布链集成 | `scripts/integration/vcc-financial-op-result-workbook.js`、原历史月份及跨月调整集成脚本 |
| UI 与性能证据 | `scripts/test-vcc-financial-op-export-ui.js`、`scripts/benchmark-vcc-financial-op-result-workbook.js` |

旧 `output/dispatch.js` 的 `export-subjects`、旧多文件 Writer 默认合同及待确认 Writer/Validator 均继续保留；新页面不依赖其未启用的内部 action。数据表、业务状态枚举、金额算法和模板文件未改。

### 12.3 Unknowns Register / 已消解与待人工项

| 问题 | 当前结论 / 证据 |
| --- | --- |
| 多 Sheet 模板、金额、Pending、调整原因/引用能否等价 | 已由真实 SQLite/XLSX 与旧主体输出逐值/样式/打印对照；第二主体单点原因/引用/合并从格/Pending/差异色篡改均拒绝，非连续 sheetId/重命名 XML 部件仍正确定位 |
| Worker result 早到、异常退出、资源拒绝和资格漂移 | runner/service 回归通过：真实 exit 前不发布或释放，拒绝时不启动 Worker，发布前漂移不交付部分正式结果；同一 direct task 关闭等待可完成 |
| 提交、存档接管及未知结果的恢复界线 | 真实 publisher、SQLite、receipt 故障测试通过；原任务未知保持 running、旧 receipt 阻塞的新任务 failed、原 receipt 随后接管成功，恢复不重复新增 artifact |
| 共享字符串 spill 是否留在任务所有权内 | 明确 `sstTempRoot`；真实 spill 正常严格关闭无残留；换 inode 的文件保留，错误标志跨 Worker 透传 |
| 40% 实际宽度、正常提示、错误/待接管/提交未知反馈 | 隔离 Electron 18/18；8 组同条件基线/当前 DOM 测量，详细尺寸见 §12.5 |
| 性能与内存是否已测 | 已记录 6 主体、每主体额外 1000 Pending 行的独立进程样本；严格校验明显增加耗时，未宣称提速或生产规模性能已验收 |
| 原生方向键/Enter 与平台打开打印 | 未完成。macOS trusted 按键到达原生 select，但自动化未能稳定提交原生 popup；Tab 焦点已验。Windows、Excel/WPS 打开/打印、真实业务样本仍须人工验收 |

### 12.4 Evidence / 自动化验证

命令均在本功能 worktree 执行。完整门禁使用 Node `v25.8.0`；UI 使用安装的 Electron `36.9.5`、Chromium `136`、Node `22.19.0`，平台为 macOS arm64。集成与单测使用合成数据及临时目录；UI 使用隔离用户目录与合成内存 API，不加载产品 Main 或真实用户数据。

| 检查 | 结果 |
| --- | --- |
| 新计划、新 Writer 与旧 Writer 聚焦单测 | 38/38 PASS（3 + 19 + 16） |
| Renderer 聚焦单测 | 34/34 PASS |
| runtime 接线、真实 publisher、service 与未知提交生命周期聚焦测试 | 最终 27/27 PASS；包含 preflight 仅清本次目录、旧 receipt/未知目录保留并恢复 |
| 新实际 Main handler → service → Worker → publisher → 恢复集成 | 7/7 PASS |
| 原历史月份模板导出 / 调整跨月归档集成 | 29/29、226/226 PASS |
| `node scripts/test-vcc-financial-op-export-ui.js` | 18/18 PASS；原生菜单键盘提交明确未计为通过 |
| Renderer lifecycle | 最终完整门禁中的 `renderer-lifecycle` 233/233 PASS；此前 VCC/Position 聚焦 21/21 PASS |
| `UNIT_TEST_CONCURRENCY=2 npm run release-check` | **PASS，exit 0**：lint、架构、smoke；单测 9473 通过/0 失败/4 跳过（总 9477）；69/69 个集成脚本、2908/2908 项检查 |
| Spec 原样复用、同目录链接及 19 项 AC | SHA256 一致，19 项；相对链接和 `git diff --check` 通过 |

完整门禁日志：仓库根 `outputs/vcc-financial-op-release-check.log`；冻结输入清单 `outputs/vcc-financial-op-gate-inputs.json`（1776 个生产/测试/配置/模板输入）。最终复核 1776 项全部一致，无新增/遗漏输入；清单记录成功退出码及日志 SHA256。集成 runner 按原规则更新 `rules/integration-test-policy.md` §七，加入本次新脚本并刷新实测统计。第一轮全门禁发现旧 Main runtime 调用计数断言未排除新增 VCC phase lease，在已确认失败并修正后以 SIGINT 结束（退出码 130）；日志另存 `outputs/vcc-financial-op-release-check-attempt-1.log`，不算 PASS。最终输入重新冻结后从 lint 起完整重跑，不用聚焦结果替代全门禁。

4 个单测跳过项全部属于 Windows 条件用例：真实 PowerShell snapshot/token cleanup、CIM/文件祖先采集器、packaged canary 的进程早退与 Setup 失败诊断。当前 macOS 环境未执行这些检查，不记为通过。

### 12.5 UI / 性能测量与验收边界

真实 UI 测量覆盖 1080×760、1240×860 两种窗口，明/暗主题，100%/125% 缩放，共 8 组。100% 下两控件各从 196 CSS px 变为 78.3984375 CSS px；125% 下从约 196.2 变为 78.475 CSS px，均满足 `abs(W_new - 0.4 × W_old) ≤ 1 CSS px`。Grid 轨道、列内起点、高度和字体保持；解归档基线宽度与提示保持。截图中年份、月份及箭头可读。布局测量和交互证据位于 `outputs/vcc-financial-op-export-ui/evidence.json`，并保留就绪、待接管和提交未知截图。

性能命令：`node scripts/benchmark-vcc-financial-op-result-workbook.js 6 1000`。合成 6 主体，每主体额外 1000 Pending 行；旧版和新版分别使用独立 Node 子进程，计时包含写出与各自文件回读验证，RSS 是整个子进程峰值，不是 V8 heap 或 512 MiB 准入预算的实测上限。

| 样本 | 最终文件 | 主体 / Sheet | 写出及验证耗时 | 峰值 RSS |
| --- | --- | --- | --- | --- |
| 旧单主体多文件 | 6 | 6 / 共 12 | 597 ms | 325376 KiB（约 317.75 MiB） |
| 新整月工作簿 | 1 | 6 / 12 | 6634 ms | 326704 KiB（约 319.05 MiB） |

新样本共 6072 输出行，流式写缓冲峰值 169481 字节。新版完整核验逐 Sheet 与 Pending 单元格，旧版 Pending 验证较少，两者检查工作量不同；本次样本约 6.6 秒，相比基线增加约 6 秒，不能解释为性能改善或全规模性能承诺。原始结果保存在 `outputs/vcc-financial-op-result-performance-6-1000.json`。大于默认预算时明确拒绝，不删除主体、跳过校验或自动拆成多文件。

AC01—AC08、AC10、AC12—AC14、AC16—AC18 已有相应自动化覆盖；AC09 的模板与打印元数据自动化通过，Excel/WPS 实际显示/打印未验；AC11 的受保护退出与真实故障恢复自动化通过，实际应用关闭/重启和目标平台恢复仍待人工；AC15 的联动、Tab 与禁用逻辑通过，原生方向键/Enter 未完成人工验收；AC19 已完成合成性能样本和预算故障测试，真实代表性业务规模仍待验。未将 19 项 AC 统一标为全部完成。


## 十三、审查修复记录（2026-09-29）

本轮依据用户提供的两项 P2 审查修复，功能分支、基线、需求范围和 19 项 AC 保持不变。Spec SHA256 仍为 `c4e20640566e9b309b65010668888c0d19aa75e2bdc4979a5e0adcdf63ee3db3`。原审查及其复现证据保留在主 checkout；本轮结果见 [修复复审文档](reviews/2026-09-29/fix-review.md)。

### 13.1 Decisions / 修复与边界

- **P2 接管异常（REC-02）**：修复点是 `src/main-process/archive-center/task-lifecycle.js` 的实际 eager `runFileTask` 外围 await。只在业务成功时收敛缓存 rejection，复用既有未耐久成功意图。首次接管依然抛错；首次 output 证据、receipt 和正式文件保留；恢复沿原 owner 归档，耐久完成后 ACK，再清理遗留 outbox。真实入口集成由原来的内部 handler 调用升级为 Main wrapper → TaskLifecycle → handler → service → Worker → Publisher。生产归档服务多数存储异常会返回 `{ok:false}`，本项证据只针对额外 rejection，不推广为所有存档异常都会失败。
- **P2 Unicode 命名（AC08）**：名称计划同时检查 upper/lower 两套占用集合。前者覆盖 `Straße/STRASSE` 等公共 reader 冲突，后者保留 ExcelJS 对 `ß/ẞ` 的回读兼容。命中任一规则仍使用原摘要后缀；不修改原始主体、金额、调整 rowKey 或 defined name 身份。
- 相对首轮冻结输入，本轮只改 2 个生产文件、4 个测试/集成文件。没有改 Renderer/CSS、数据表、状态枚举、Publisher/receipt 格式或 deferred 生命周期；不修改 Spec。

### 13.2 Evidence / 本轮验证

| 检查 | 结果及证据（相对仓库根） |
| --- | --- |
| R1 修复前真实外围链路 | FAIL，`INJECTED_REC02`；`outputs/vcc-financial-op-r1-integration-red.log` |
| R1 生命周期与提交未知回归 | 65/65 PASS；`outputs/vcc-financial-op-r1-unit-green.log`，包含 5 项新边界用例 |
| R1 实际 Main wrapper、归档意图及幂等恢复集成 | 9/9 PASS；`outputs/vcc-financial-op-r1-integration-green.log`，核验原 owner、SHA/大小、未提前 ACK、恢复后 receipt/outbox 均清空 |
| R2 修复前 Unicode 回归 | 4/4 FAIL；`outputs/vcc-financial-op-r2-before-20260929T134115429518Z.log` |
| R2 仅用 upper 的反向兼容回归 | `ß/ẞ` 在 ExcelJS 回读失败；`outputs/vcc-financial-op-r2-lower-before-20260929T134401516182Z.log` |
| R2 最终名称计划、新 Writer、旧 Writer | 43/43 PASS（4 + 23 + 16）；`outputs/vcc-financial-op-r2-final-20260929T134500181602Z.log` |
| 本轮完整 `release-check` | **PASS，exit 0**：lint、架构 772/772、smoke；单测 9483 通过、0 失败、4 跳过（总 9487）；69/69 个集成脚本、2910/2910 项检查。日志 `outputs/vcc-financial-op-review-fix-release-check.log`，冻结输入 `outputs/vcc-financial-op-review-fix-gate-inputs.json` |

§12 的完整门禁是首轮历史证据，不能覆盖本轮 6 个输入的变化；本轮重新从 lint 执行完整门禁并通过。完成后复核 1776 个输入全部与冻结清单一致，无新增或遗漏；HEAD 和日志哈希匹配。新日志 SHA256 为 `a69d82236f85581bf97b2f19cd174409dc0e48dc7d2b5da78c50e78000b81061`。runner 按原规则刷新 `rules/integration-test-policy.md` §七实测统计；4 个跳过项均为 Windows 条件用例，不计为通过。UI 文件未变，本轮未重跑 GUI；Windows、Excel/WPS 打开与打印、原生下拉框方向键/Enter、实际应用退出重启、真实业务规模性能仍未完成验收。本轮未提交、推送或发布。
