# TechDoc｜v3.2.9 工具箱：按行拆分（v2 · 实施版）

| 项目 | 内容 |
|---|---|
| 目标版本 | 3.2.9 |
| 实施分支 | `codex/v3.2.9-toolbox-split-by-rows` |
| 实际基线 | `main@2ba9ef14fe972363b604955636cff0c9ac53700f` |
| v1 设计评审快照 | `2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 需求依据 | 同目录 `spec.md`；用户已整体授权采用 D1–D8，未另作逐项口头确认 |
| 文档日期 | 2026-09-18 |
| 文档修订 | v2；依据用户本轮转述的同事 review |
| 实现状态 | 已实现；实际文件、预算、测试与平台边界见 `implementation-notes.md` |
| Review 对照 | 同目录 `review-response.md`，区分采纳、新增工程约束和未验证项 |

> 2026-09-18 实施补记：用户已授权按本文整体实施，D1–D8 采用文档默认值。以下保留设计依据；当前实现、工程预算及实测范围以 [实施记录](implementation-notes.md) 为准。

## 1. v1 已核对的代码现状与本轮证据边界

| 位置 | 现状与影响 |
|---|---|
| `src/renderer-dialogs.js` / `createSplitFieldPickerDialog` | 字段为原生 select；值为按钮加独立浮动勾选面板，不是原生 select。现有 `updateCompleteState()` 仅看选值数。 |
| 同文件 / `refreshValues()` | 切换字段会清空 `selectedValues`；新模式切换不得复用这个清空逻辑。 |
| 同文件 / `createToolboxDialog` 的 `onComplete` | 回调当前接收 field、values、mode、groups，只区分按值单文件与 `multiple`；非 multiple 路径强制校验字段和值。 |
| 同文件 / `createMultipleSplitFieldPickerDialog` | 原多文件分组独立弹窗，每组含文件名、字段和值，UI 限制最多八组。 |
| `src/main.js` / `toolbox:split:export` 的 prepare | 当前非 multiple 请求要求 field；必须在新增 rows 分支前完成模式判别，不能继续落入旧校验。 |
| `src/main.js` / `toolbox:split:read` | 普通路径调用 `scanToolboxSplitFields`，大文件路径调用 `dispatchLargeSplit({ op: 'scanFields', ... })`，随后建立 splitReadContext。 |
| `src/main-process/toolbox-format-operations.js` | 当前提供 `exportToolboxFilter`、`exportToolboxMultiFilters`、`scanToolboxSplitFields` 等；没有已实现的 `exportToolboxByRows`。 |
| 同文件 / scan | 已经遍历数据，但结果仅返回 headers 和 valuesByField；可复用遍历结果增补可信 dataRowCount，不必仅为计数再扫描一次。 |
| 同文件 / export | 用 `rowInfo.matchValues` 判断条件，输出使用原始富类型 row；输出 writer 负责 commitAndValidate。 |
| `src/main-process/toolbox-format-io.js` | `SPLIT` 统一管理首个逻辑表头、跨 Sheet 顺序、重复首行表头、隐藏 Sheet 与有效行规则。 |
| 同文件 / `streamToolboxPassTables` | 当前调用 `onDataRow(...)` 时没有 await。新增代码不能假定 async 回调会被读取层等待。 |

这些现状来自 v1 记录的远端快照，不代表本轮已重新验证或本地尚未推送的 v3.2.9 迭代已经包含在其中。

review 提及旧单字节路由掩码及可复用的保真编码能力。本轮未读取这些底层实现；因此将“rows 不依赖旧掩码”和“复用前先验证编码往返与引用完整性”写成设计约束，不虚构现成缓存 API 或容量保证。

## 2. 变更边界

保留现有公开 `desktopApi.toolbox.splitExport` / `toolbox:split:export`，新增 `mode: 'rows'`。在创建任务之前，将 rows 分派到独立内部 action **`toolbox:split-rows`**；原单文件字段与 `multiple` 分组路径仍走原合同。新增内部 action 不等于新增公共 IPC，也不等于新增任务管理页面。

首版架构固定为：**独立 rows 后台任务 → 保真任务私有缓存 → 单个活动 writer 顺序输出 → 全部校验后发布**。普通与大文件共用同一后台核心，不再保留拉取式源读取改造作为另一条生产路径。

不修改对账算法、输入原件、存档业务状态及旧字段分组的八份限制。不预设需要业务数据库迁移；若任务平台对 action 的持久化约束确实需要兼容处理，必须在实施前定位并单独记录，不能以“新增 action”绕过任务校验。整体尺寸、模板管理、夜间模式不属于本分支。

下列是模块职责建议，不表示这些新增文件已存在：

| 文件/区域 | 计划修改 |
|---|---|
| `src/renderer-dialogs.js` | 控件与模式草稿、数量上限校验与 rows 参数/结果分支。 |
| 现有 `.toolbox-split-picker-*` 样式所在文件 | 新行和输入局部样式；保留已有布局和其他分支变化。 |
| `src/preload.js` | 核对参数/结果透传或白名单；无新增公共入口。 |
| `src/main.js` 的 splitRead / splitExport 适配 | 可信 R、token、新模式分派、任务前校验、计划与发布编排；重处理不在 main 执行。 |
| `src/main-process/toolbox-format-operations.js` | scan 增量返回 `dataRowCount`；不改旧过滤生成器的模式语义。 |
| 建议新增 `src/main-process/toolbox-row-split/` | `contracts`、`plan`、`cache`、`executor`、`result-validation` 职责；可按当前工程规范合并小文件。 |
| 后台任务 action/策略/执行器注册处 | 登记 `toolbox:split-rows` 的输入、资源、结果和失败结算合同；实际路径需沿工作区真实注册点定位。 |
| 现有 FilePlan / Publisher / 归档适配 | 接受已校验的 K 个 rows 输出；沿用任务所有权、目标保护与恢复协议。 |

不得仅向旧 worker 消息加 `op: 'exportRows'` 就认定独立后台任务接入完成；也不能先按旧策略创建任务，再在执行器内部悄悄改 action。

## 3. 前端状态设计

建议在拆分弹窗内新增：

```js
let splitByRows = false;
let rowsPerFileText = '';
let rowsInputTouched = false;
// 导入返回的计数与 token 只用于页面反馈；主进程仍独立验证。
const previewReadInfo = { splitReadToken, dataRowCount, maxRowSplitFiles };
```

上例变量由父级导入结果传入，并非允许 renderer 设置后台上限。计数缺失或非安全非负整数时禁止按行提交并要求重新导入。

现有 fieldSelect、currentValuesList、selectedValues 保持为字段模式草稿。不要为了切换 rows 而重建整个弹窗或调用 `refreshValues()`。

### 3.1 DOM 结构

在值控件所在行之后、hint 元素之前插入：

```html
<div class="toolbox-split-by-rows-row">
  <label class="toolbox-split-by-rows-toggle">
    <input type="checkbox" data-field="split-by-rows">
    <span>按行拆分</span>
  </label>
  <span class="toolbox-split-row-count-wrap" hidden>
    <input type="text" inputmode="numeric"
      data-field="rows-per-file"
      aria-label="每份文件数据行数"
      placeholder="请输入行数" disabled>
    <span>行</span>
  </span>
</div>
```

使用 text + inputmode 是为了能够严格校验十进制正整数，避免将浏览器 number 控件接受的指数写法误当成需求允许输入。前端只是辅助，主进程仍为安全校验边界。

样式限定在本弹窗类内，hidden 状态不可被 flex 样式意外覆盖；控件高度、颜色、边框复用项目已有定义。不为这一行引入新 UI 依赖。

### 3.2 单一状态刷新

新增统一刷新函数，例如 `syncSplitModeUi()`，集中维护以下派生状态：

```text
field.disabled    = splitByRows || busy || 沿用字段不可用条件
values.disabled   = splitByRows || busy || 当前字段无可选值
multiple.disabled = splitByRows || busy
rowWrap.hidden    = !splitByRows
rowInput.disabled = !splitByRows || busy
complete.disabled = busy || (splitByRows
  ? !(合法行数 && 本次计数可用 && R>0 && 预计K未超限)
  : !原字段模式有效)
```

勾选时先 `closeValuesPanel()`，再同步 disabled/hidden，并聚焦已启用的行数输入框；鼠标与键盘勾选行为一致。取消勾选时恢复原值列表提示，不聚焦已隐藏输入框。浮层的打开与选择处理也检查当前模式，避免遗留事件让禁用控件继续改变状态。

字段模式只在真正改变字段时清空选值。切换模式保存草稿、切换校验，不刷新数据、不重新扫描文件。

合法 N 与当前 token 的有效 R 均存在时，在内部计算 K 并校验数量上限；按用户最新要求，不渲染预计数量提示行。主进程不接受 renderer 的 R/K/上限作为权威。预计超限提示与 Spec §6.5 一致；实际执行仍经任务前校验。

### 3.3 点击完成

rows 分支必须先于旧字段校验执行：

```js
// 设计示意，validateRowsInput 为本次新增纯函数。
if (splitByRows) {
  const checked = validateRowsInput(rowsPerFileText);
  if (!checked.valid) {
    showRowCountError(checked.message);
    return;
  }
  if (!isRowsPreviewReady()) return; // 本稿新增的页面前置检查，不替代主进程校验。
  closeValuesPanel();
  onComplete?.({ mode: 'rows', rowsPerFile: checked.value });
  return;
}
// 原字段模式的 getSelectedValues、非空校验与回调保持兼容。
```

父级 `createToolboxDialog` 的回调解构也加入 rowsPerFile，按明确的 mode 分支构造请求。不要使用“只判断 multiple，否则都当单文件”的二元分支。

## 4. 参数合同与兼容

### 4.1 rows 请求

```js
{
  sourceFilePath: '由既有导入结果提供',
  splitReadToken: '由既有导入结果提供',
  mode: 'rows',
  rowsPerFile: 1000
}
```

rows 请求不携带 field、values、groups。数字必须经过前端规范化，但主进程仍检查其类型为 number、安全整数且大于零；直接传入字符串、NaN、Infinity 或小数应拒绝。

主进程按 mode 进行白名单处理：旧省略 mode 的请求仍按原单文件字段模式处理；保留 multiple；新增 rows。若接受显式 single，应与旧省略模式语义相同。未知模式明确报错，不静默回落到字段模式。

前端不提交可决定输出范围的 totalRows、fileCount 或目标路径数组。输出数量和最终目标必须由主进程的可信导入上下文与用户目录选择决定。

### 4.2 导入计数

`scanToolboxSplitFields()` 内记录 `streamToolboxTables()` 返回的 dataRowCount，并在结果中增加同名字段。保持 headers、valuesByField 的原值、字段名及逻辑不变。

普通路径、大文件 scanFields 路径都返回同语义的计数。主进程把计数及其来源快照与 splitReadToken 对应的上下文关联；只信任已验证的上下文，不信任 renderer 传来的计数。

新版导入返回 `dataRowCount`，并返回供展示的 `maxRowSplitFiles`（由主进程配置提供）。主进程仍使用内部策略的上限，不使用页面回传的上限。

旧或缺少计数的导入上下文不启动 rows 生成，提示重新导入；不得按 undefined 当 0、信任前端估算或在任务创建后补扫并扩张计划。本轮不顺便把旧导入阶段的主线程/Worker 路由全部改为后台；“普通和大文件均后台”指本次 rows 缓存与输出生成。

继续沿用当前重复表头和格式校验；本次不额外引入“重复表头也能导入”的旁路。

### 4.3 成功结果

建议在现有结果合同上新增 rows 分支，公共 success/failed/cancelled 状态不变：

```js
{
  status: 'success',
  mode: 'rows',
  rowsPerFile: 1000,
  inputDataRowCount: 2501,
  outputDataRowCount: 2501,
  fileCount: 3,
  files: [
    {
      partIndex: 0,
      outputId: 'row-split-0001',
      fileName: '流水明细_按行拆分_0001.xlsx',
      filePath: '正式发布后的路径',
      dataRowCount: 1000
    }
    // 其余文件按 partIndex 依次排列；格式警告沿用现有语义。
  ]
}
```

不要让前端在 rows 模式继续读取旧单文件的 `filePath` 作为唯一结果。可复用多文件结果展示组件，但不应伪造 `mode: 'multiple'` 或把每个块伪装成字段分组。

计数以 writer 已校验结果为准。若兼容层仍要求 matchedCount，应清楚地把它映射为该份数据行数，不执行实际字段筛选。

公共结果的 `files` 必须覆盖全部 K 份，不能为了 IPC 通过而少返回文件。主进程在任务创建前验证结果包的可计算大小上界，发布前再校验真实结果大小。警告使用保留语义的有界汇总与完整诊断引用，不能静默截断业务警告；具体载体沿现有警告协议适配。内部完整产物清单可保存在任务私有 manifest，Worker 仅传有界描述符，详见 §6.3、§6.5。

rows 成功弹窗使用独立样式类 `toolbox-split-rows-result`：内容区允许纵向滚动，确认区不收缩；完整列表与末尾警告可查看，确认按钮始终可见并可返回工具箱。沿用正式 Clear 主题，不改公共 alert 或旧字段模式弹窗样式。

## 5. 主进程流程与 FilePlan

### 5.1 创建生成任务之前

```text
splitRead：沿用扫描 + dataRowCount + source snapshot/token
  → 用户输入 N，页面内部计算 K 并校验，不展示预计数量行
  → main 校验 mode、N、token、源快照与可信 R
  → R=0 拒绝；计算 K 并检查 K≤1000
  → 通过后选择输出目录、构造 K 个目标
  → 验证计划、消息与结果上界；检查各卷磁盘及资源策略
  → 冻结 FilePlan 的源快照、全部目标存在状态/身份及父目录身份；校验别名/原件保护
  → 从冻结快照列出同名冲突并等待覆盖确认；返回后复核同一 FilePlan
  → 沿 IPC 入口复用同一已冻结 FilePlan，再创建 toolbox:split-rows 生成任务
```

次序是合同的一部分：**K 超限时，不得先构造 K 个路径、巨大数组、FilePlan 或生成任务再拒绝。** 取消目录或拒绝覆盖同样不创建生成任务。导入已有记录与拒绝审计日志不属于生成任务。

推荐由纯函数规划计数；R、N 先严格验证为安全整数，N>0、R≥0。内部使用整数运算，避免 `(R + N - 1)` 在边界处溢出；以下是新设计示意，不是已接入源码：

```js
const r = BigInt(R);
const n = BigInt(N);
const limit = BigInt(MAX_ROW_SPLIT_FILES); // 首版推荐 1000
const k = r === 0n ? 0n : (r - 1n) / n + 1n;
if (k > limit) {
  const minimumRows = (r - 1n) / limit + 1n;
  // 返回可操作的数量超限错误；不得在此之前分配 K 个输出。
}
// 通过限制后才转换为 number 并构造计划；BigInt 不进入公共 IPC。
```

K=1 也选择一次输出目录并使用 rows 文件命名。目标路径、别名、硬链接/符号链接的既有保护、同名覆盖许可等沿用项目 helper，不信任 renderer 提供目标数组。K、N、R 与路径列表一并冻结，不允许生成过程中改变 N 或添加计划外输出。

覆盖确认期间新出现、被替换或被移除的目标都必须拒绝，不在确认后重新采集快照作为覆盖许可。`prepareIpcTaskInvocation` 仅复用通过 Main 当前进程 WeakSet 身份校验的 normalized FilePlan；普通或复制来的对象仍按原入口规范化。TaskLifecycle 启动前继续执行 freshness 校验，Publisher 继续使用同一目标快照，覆盖确认到正式写入之间的变化均不能被自动接受。

### 5.2 任务准入与实际执行

调用 `requireToolboxSplitReadContext`、`assertToolboxSplitSourceFresh` 等现有保护；计划冻结与 beforeStart 均按既有协议检查源身份。重处理需要读取的输入应是平台已授权且符合一致性规则的源快照，不靠“行数相同”证明内容没变。

公开 `toolbox:split:export` 的请求先做模式分派，再选择内部任务 action/资源策略。若当前 `trackedIpcHandle` 无法按请求选择 action，新增薄适配层在创建任务前完成分派；不得复用旧字段 action 的八分组策略后，仅在 Worker 中换一个操作名。

后台任务完成缓存、按序生成及每份校验后，主进程校验返回证据与冻结计划的一致性，再交既有 Publisher。主进程负责准入、轻量合同检查和发布编排，不同步编码缓存或生成工作簿。

rows 发布目标必须从冻结的 `fileEvidence.filePlan.outputs` 构造：`filePath` 传为 `targetPath`，`targetParentIdentity` 传为 `expectedTargetParentIdentity`，同时沿用 `targetSnapshots` 的文件级保护。公共 wrapper 保留该父目录身份，既有 Publisher 负责发布前复核和 journal 持久化；不在生成后重新采集目录身份作为确认依据。

### 5.3 双重计数核验

导入 R 用于提前规划；缓存封存计数用于确认实际生成输入。缓存读取到的有效行数必须等于可信 R，且行序号完整。两者不同应在发布前失败、提示重新导入，不应依据缓存的新计数重建目标并沿用旧任务。

仅数量一致仍不足以证明源文件未变；源快照保护和内容/引用完整性校验不能被这一计数比较取代。源快照能力的真实保证以工作区现有实现为准，本稿不新增未验证的强保证。

## 6. 按行生成与格式保真

### 6.1 分块规则与统一核心

源读取仍使用 `TOOLBOX_SHEET_STRATEGIES.SPLIT`。有效行按跨 Sheet 原顺序编号 `rowSeq=0…R−1`；每条 row 恰好写入缓存一次，不重新筛选、排序或去重。

```text
partIndex       = floor(rowSeq / N)      // 从 0 开始的整数
rowIndexInPart  = rowSeq % N
startRowSeq     = partIndex * N
endRowSeq       = min(R, startRowSeq + N) // 右开区间
```

实际实现须使用已验证不溢出的整数计算。`partIndex` 是整型索引，不是 bit flag；不得使用旧分组单字节掩码、`1 << partIndex`、按位或/与路由，不能把每一块伪装为旧字段分组。旧八份限制保留在旧 `multiple` 合同中，rows 输出上限另行校验。

表头、`sourceRegistryResolver`、`layoutBaseline`、行模型和 writer 预算沿用既有保真语义；输出富类型 row，绝不以 `matchValues` 作为输出内容。各份及各滚动 Sheet 的重复表头不计入 R。

### 6.2 首版固定为保真落盘缓存

#### 6.2.1 同步源回调的处理边界

v1 记录 `streamToolboxPassTables` 调用 `onDataRow` 时不等待 Promise。因此首版**不改造成异步拉取源读取器**，也不在源回调里异步提交输出 writer。

在 rows 后台执行环境中，回调只将当前富类型行追加到任务私有缓存。缓存追加采用可验证的同步写入，或固定大小批次缓冲后同步刷盘；回调返回时，该行已经写入缓存或纳入严格有界的缓冲区。出现 I/O 错误必须同步抛出并终止扫描，短写必须处理，不能忽略。

这项选择也禁止下面这种“异步落盘替换”：`onDataRow: async row => await cache.append(row)`。它仍未解决上游不等待的问题。`fs.writeSync` 或等效同步追加只允许在后台执行器内使用，不在 renderer/main 执行；缓存封存前须刷清缓冲区。缓存编码本身如依赖未完成异步解析，应先完成依赖准备或证明可同步编码，不能留下未等待的 Promise。

#### 6.2.2 缓存格式与生命周期

缓存是本次新增合同，可在验证后复用已有保真编码器；不假定已有具体类名。至少包含：

| 部分 | 必须保存/验证的信息 |
|---|---|
| 头部 | 缓存格式版本、taskId/attemptId、输入快照身份、SPLIT 策略版本或标识、预期 R。 |
| 逻辑表头 | 原始表头单元格、规范化表头、表头行属性、现有布局基准。 |
| 引用资源 | 每个 `sourceRegistryId` 对应的持久资源；样式/共享内容等所有输出所需依赖可在源 reader 关闭后独立解析。 |
| 数据记录 | 连续 `rowSeq`、原始值与类型、单元格位置、样式及来源引用、既有保真范围内的行属性。 |
| 封存证据 | 实际行数、记录/区段完整性信息、引用完整性结果、缓存总字节数、格式警告、完成标识。 |

简单保存样式编号不等于保存样式。源资源必须在读取器释放前被捕获或复制为独立可用的依赖，不能在 `pass.close()` 后继续引用失效句柄。注册表快照及其引用分配需保持一致，跨源命名空间不冲突。包含原始数字/文本/日期/布尔/空值等的编码必须通过类型往返测试；未经类型标签和引用合同的 JSON 转换不能直接当作保真方案。

缓存写入中的状态为 `WRITING`；仅在记录刷盘/文件关闭、格式与完整性检查、实际行数=R、引用可解析后，才发布任务私有的 `SEALED` 清单。状态名为本稿设计说明，不是要求新增存档业务状态。未封存缓存不能用于生成；崩溃留下的半成品不能通过重命名就认定可恢复。

为减少额外扫描，行序号、计数和摘要可在编码时累计，读缓存时再次验证；不要求把整个缓存一次性读回内存。确切格式、校验方法与磁盘持久性操作须适配已有平台规范并记录测试证据，不宣称仅一次 rename 即有完整崩溃恢复保证。

#### 6.2.3 单个活动输出 writer

缓存完全封存后，从头顺序回放。对第 p 份，只创建这一份的输出 writer；消费 `[pN, min(R,(p+1)N))` 的缓存行，执行提交、校验并释放该 writer，然后才开始下一份。

```text
for partIndex = 0…K−1：
    验证该份范围与冻结计划一致
    创建该份 writer；任务内活动 writer 数必须从 0 变成 1
    按序回放本份缓存行，保留值、类型和样式引用
    等待 commitAndValidate 完成（目标仍为任务私有 generation 路径）
    释放/关闭 writer 相关资源；活动数从 1 变成 0
    记录该份只读产物描述与校验证据
全部份数结束后执行汇总校验
```

缓存读取器可以提供独立的可等待迭代接口；这不等于改造旧源读取栈。回放驱动须支持暂停，不能再用不等待回调的 API 异步切 writer。不得 `Promise.all` 并行生成 K 份、提前创建全部 writers，或将已提交 writer 保留在活动集合中。

具体 writer 何时释放资源、是否需要适配关闭方法，实施时应核对真实 API；本稿不虚构已有 `writer.close()`。生命周期测试以资源真正释放为界，不能仅把变量置为 null 就减少活动数。

#### 6.2.4 全量输出一致性

发布前至少验证：缓存计数=R；K 与计划一致；各分块序号唯一、顺序/范围连续；非末份数据数=N，末份正确且非空；数据数之和=R；全部产物均在指定 generation 路径、每份校验成功、所有输出引用有效、结果 envelope 在预算内。

类型与样式验证按现有保真合同定义。输出工作簿可能重新编号样式；应比较解析后的样式语义而非直接比较 `styleId` 或 ZIP 二进制。原已明确不支持/会降级的对象继续产生原警告，不宣称本次新增了所有 Excel 对象无损能力。公式、日期和缓存值的语义沿既有实现，不能偷偷改为重新计算。

### 6.3 独立 rows 后台任务合同

#### 6.3.1 注册项

下表均为待实现的新合同；实际平台字段名可映射，但语义不能省略。

| 项目 | rows 合同 |
|---|---|
| 内部 action | `toolbox:split-rows`；公开 IPC 仍是 `toolbox:split:export`。 |
| 合同版本 | 首版设为独立版本 1，版本不匹配拒绝，不回退旧字段执行器。 |
| 输入 | 授权的源快照/token 绑定证据、R、N、K、冻结 FilePlan、任务身份、资源预算。 |
| 输入限制 | R/N 为安全整数且满足范围，K=ceil(R/N)、1≤K≤1000，输出索引/范围与计划一致；不接受字段过滤条件。 |
| 资源策略 | 执行位置必为后台；每个任务单一生成执行器、活动输出 writer≤1；缓存/内存/句柄/磁盘/IPC 均受预算约束。 |
| 执行器 | 普通/大文件调用同一缓存与回放核心；不得复用旧分组掩码或失败后 fallback。 |
| 成功结果 | 任务/attempt/计划身份一致的 manifest、R/N/K、各输出范围与实际行数、校验凭据、格式警告。 |
| 主进程结果验证 | action/版本/任务身份、计数、连续范围、输出身份/路径、校验证据与预算均一致后才可发布。 |
| 失败/取消 | 按既有平台结算；不返回部分 success、不自动重跑、不删除其他任务或正式文件。 |
| 恢复 | 发布阶段按现有协议恢复；首版不承诺从半封存缓存续跑或从第 j 份无缝续生。 |

资源策略的并发约束是任务内的；整机多个任务是否同时准入继续受平台全局资源管理，不另外开无限线程池，也不把“每任务一个 writer”误当作全进程只有一个 writer。

2026-09-19 准入修订：rows 实际 `thread-single` 策略维持 1 CPU / 1 Worker / 1 IO / 1 GiB Phase 预约、零 Base。Supervisor 的 simple job 总预算预检同时覆盖静态策略与动态估算策略；在取得 Base 前检查 Base + Phase 是否可容纳，超额返回 `RESOURCE_BUDGET_UNAVAILABLE`，不启动生成 Worker。临时占用保持既有优先级排队规则、有界 5000 ms 排队、取消与租约释放，等待耗尽仍返回 `ADMISSION_TIMEOUT`。

诊断仅采集五维资源数值、申请阶段、失败原因与队列数量，不携带任务身份、租约归属或文件路径。内部诊断保留结构化数值，跨协议仍采用原 `SafeErrorV1` 的 `code/message/stage/detailLines` 四字段；数值使用分组和 MiB，避免被账号隐私过滤误判。rows service 将两类错误转为中文，Main 返回可选 `code`、原 `detailLines` 并写活动日志；普通无错误码的失败返回形状保持不变。

平台内存总配额按 runtime 创建时的内存快照计算并冻结；此修订不动态刷新配额，不调整 2 GiB 系统预留或 rows 1 GiB 预约。因此释放外部程序内存后，若旧 runtime 的总配额仍不足，须重启应用重新计算。截图事件没有当时的资源快照，不能据当前内存状态断言历史事件唯一原因。本轮验证覆盖静态总预算不足、暂时争用、真实生成与发布，以及源件/旧目标保护；不替代实际 Windows、Excel/WPS 或大规模性能验收。


#### 6.3.2 内部传递与验证

大体量的保真行、样式注册表与缓存记录不跨 IPC。完整 FilePlan/产物清单可使用任务私有清单文件，消息只传 task/attempt、版本、清单引用、字节数与完整性描述等有界元数据。清单引用须由主进程分配并校验任务归属，不能接受任意路径或 renderer 自报的缓存文件。

这是拟新增的内部载体约定；实施时优先复用现有计划/manifest 机制。使用文件引用不免除大小检查：读取清单前验证字节预算和归属，解析后验证元素数、字段长度、索引与冻结计划。Worker 返回成功只是生成阶段证据，不直接成为公共 success。

Worker 与主进程分别校验输入/输出；未知字段采用显式白名单策略，特别是公共 rows 参数中的 `fileCount`、`totalRows`、`groups` 或目标路径不能改变后台计划。旧省略 mode 的兼容路径维持不变，不能借 rows 严格校验破坏旧调用者。

若平台当前资源注册、结果 schema、FilePlan 或 journal 对输出数量存在旧上限，应对 rows 做隔离适配和边界测试，而不是修改旧字段分组上限或去掉全部限制。本轮并未确认这些底层限制的实际值。

#### 6.3.3 取消可见性

缓存同步追加不意味着消息式取消能立即被后台忙循环观察到。必须复用并测试平台实际可见的取消机制及检查点；若只依赖尚未处理的消息，不得宣称已经取消。取消可见时停止后续读取/写入，在既有允许边界清理；强制退出保留必要任务证据，由平台处理。

本次不新增取消按钮，不改变现有关闭策略，也不承诺材料中未给出的毫秒级取消时限。

### 6.4 数量上限与失败关闭

首版推荐 `MAX_ROW_SPLIT_FILES = 1000`，来源为本轮 review；**待实测，不是已验证容量**。该值与旧多分组的八份限制、每份 Sheet 容量分别校验。

| 条件 | 行为 |
|---|---|
| R=0 | 提示无数据，不创建生成任务。 |
| 1≤K≤1000 且其余前置条件通过 | 允许 rows 准入，不应用旧八份/位掩码限制。 |
| K>1000 | 在路径数组、FilePlan、生成任务之前拒绝，返回预计份数、上限和 `ceil(R/1000)` 建议行数。 |
| 容量/资源配置缺失或非法 | 不把限制当作无限；拒绝启用 rows 并记录配置错误，不能标记为容量已支持。 |

R=250000、N=100 的错误提示与 Spec 一致。K=9、K=1000 的正向成功验收必须独立执行；仅测试规划器能返回 1000 不构成“1000 份可发布”的证据。

### 6.5 资源、磁盘及消息预算

#### 6.5.1 数值来源与启用门槛

输入材料只提出了文件数量建议上限，没有提供经过验证的缓存、内存或 IPC 字节数。本稿不编造这些数值。实施必须从当前平台已有有效策略继承，或实测后配置以下预算，并记录具体值、单位、来源和测试环境；必需预算缺失时 rows 不能进入可发布状态。

| 预算项（设计名） | 约束与检查位置 |
|---|---|
| `maxOutputFiles` | 推荐 1000；K 检查先于所有按 K 的分配。 |
| `maxCacheRecordBytes` / `maxCacheBufferBytes` | 单记录与批缓冲有界；长文本/宽行不能产生无限队列。 |
| `maxCacheBytes` / `maxRegistryBytes` | 缓存和保真依赖总体有界，写入过程持续计量。 |
| `maxGeneratedBytes` / `maxTaskTemporaryBytes` | 包括所有已校验生成文件，不仅当前 writer；不能只预算一个块。 |
| `minFreeBytesByVolume` / 安全余量 | 按缓存卷、目标卷及备份/跨卷复制路径分别检查与复核。 |
| `maxPlanBytes` / `maxManifestBytes` | 任务前计划包/清单上限与读取后的真实性校验。 |
| `maxWorkerMessageBytes` / `maxPublicResultBytes` | 内部消息和公共结果独立限额；按可计算上界预检，按真实包二次校验。 |
| `maxActiveWriters` / 内存与文件句柄预算 | 每任务输出 writer 峰值=1；注册表、缓存、writer、校验器的其他资源仍独立预算。 |

不能将“上限以内必须成功”解读为必须处理磁盘已满或非法路径；同样不能人为设置低于九份的消息预算，再声称九份用例“按策略失败也算通过”。正常路径下的九份与千份端到端测试必须同时满足数量与各项资源限制。

#### 6.5.2 磁盘峰值

预算至少覆盖下列构成，并按实际分布的磁盘卷统计，不能仅用源文件大小乘一个未经验证的固定倍数：

```text
任务期间峰值占用 ≈ 新增输入快照
                 + 保真缓存（含注册表/元信息）
                 + 全部 generation 文件
                 + 校验临时峰值
                 + 发布新增副本/旧目标备份
                 + 安全余量
```

缓存和 K 份已生成文件可能同时存在；单 writer 并不减少保留这些文件的空间。压缩源的字节数不能直接当作解码缓存大小。任务前做可说明的估算与准入检查，运行中做硬预算和剩余空间检查；超限在发布前失败，未知估算不能被表述成已保证不耗尽磁盘。

目标目录、缓存目录不在同卷时分别检查，发布阶段沿用既有跨卷/备份策略。任务缓存不作为业务存档原件；清理受任务所有权和恢复保留规则控制，不按目录通配删除。

#### 6.5.3 IPC 与结果大小

统一定义 JSON-compatible 合同的应用层字节度量，例如同一规范化编码器生成 UTF-8 字节后计数。它是本产品的应用预算，不代表 Electron/传输层的真实硬极限；实际往返还必须做集成测试。

检查顺序：先检查 K；构建有限的计划；校验计划字节数；按确定的 K、文件名/路径、整数宽度及有界警告合同计算公共结果上界；校验后台消息与私有清单预算；全部通过后才创建生成任务。生成完成后再用真实 manifest 和公共结果检查一次，之后才开始发布。

诊断明细可保存在任务归属的日志/报告中，并保留现有语义的警告统计与引用；禁止通过静默少返回输出、丢弃类型信息或吞掉警告适配预算。若既有警告载体不能给出上界，需先补齐该合同，而不是等发布成功后才发现结果无法返回。

## 7. 发布、失败与兼容

### 7.1 发布门槛与所有权

必须同时满足缓存封存、R 一致、每份提交/校验/释放成功、汇总范围与计数一致、manifest/公共结果合法且未超预算，才允许首次调用既有 FIFO Publisher。生成 writer 始终只写计划指定的 generation 路径。

全部校验后发布不等于“一千个文件天然原子”。正式发布、备份、journal、回滚与恢复继续由现有发布体系决定。发布开始后，生成器不擅自清理正式目标或 Publisher 需要的 staging；所有权移交及保留路径必须登记。

输入与 K 份输出仍绑定一个逻辑任务，按既有归档和结算协议登记；内部 action 不能导致输入、输出挂到两个不相关任务。`splitReadContext` 的消费和清理时机沿既有协议，不提前删除合法导出所需证据。

### 7.2 分阶段失败断言

| 失败点 | 允许的状态与必须满足的约束 |
|---|---|
| 校验/超限/选目录取消 | rows 生成任务=0，缓存写入=0，正式发布=0；可保留拒绝审计。 |
| 缓存写入或封存失败 | 不创建输出 writer；正式发布=0；半成品不进入 SEALED。 |
| 第 j 份生成/提交/校验失败 | 停止后续生成；正式发布=0；前 j−1 份仅为任务私有临时结果。 |
| 汇总、manifest 或结果 envelope 失败 | 即使每份独立可读也不发布；任务不记 success。 |
| 发布已开始后失败 | 按 journal/恢复协议处理，禁止重新生成并再次盲目发布；不宣称全部失败所以可以直接删目录。 |
| 清理失败 | 保留必要证据与真实错误状态，不删除其他任务/原件，不掩盖原始失败。 |

首版不实现缓存续跑或第 j 份续生。用户重新提交应重新经过 token/freshness/准入校验，使用新任务与私有缓存；发布中的未恢复任务先遵守现有冲突/恢复门禁，不能并行重试覆盖相同目标。

### 7.3 旧功能回归

旧字段单文件与多分组的过滤投影、枚举、八份限制、命名、警告、发布、合并功能不改变。未知 mode 失败关闭，旧省略 mode 的请求仍可用。rows 不得复用旧掩码，旧字段模式也不得被本轮改为无上限自动分块。

## 8. 测试设计

所有测试均为计划，本轮未执行项目自动化、容量或人工验收。文档检查与算法示例核对不能替代以下任何运行证据。

### 8.1 前端与规划器

覆盖 Spec A01–A08、A19–A21：默认值、控件联动、草稿恢复、浮层关闭、键盘与窄窗口、有效/非法 N、计数缺失/过期、预估行移除且数量上限仍生效、连续导入不串 token、父级 mode 分派与防重复提交。

规划器覆盖 R=0/1/N/N+1/2N/2N+1、安全整数边界、非 number 输入、未知 mode；枚举 K=1…1000 的序号与分块范围；测试 K=1001 提前失败且路径构建/任务创建 spy 调用=0。校验超限建议的整数计算，不能只判断错误文本含“超限”。

### 8.2 后台合同与输出数量

普通文件和大文件均断言 action 为 `toolbox:split-rows`，执行位置不是主进程，核心实现相同；失败时无主进程 fallback。

K=1/8/9/999/1000 至少各有完整生成、全量校验、发布与结果返回的成功用例；补测 255/256/257 索引边界以检查非整型/字节截断风险。九份必须成功；一千份端到端未测不能写容量已验证。旧 multiple 八组仍成功、九组仍依原约束拒绝。

同时测试计划/清单/公共结果 schema；输出数量未超限但字段长度或消息预算异常时按独立失败用例处理，不与正常成功用例混算。

### 8.3 保真缓存与内容一致性

对缓存编码/解码先做往返测试：类型、值、行序号、样式依赖、跨 Sheet 来源引用均可在源 reader 关闭后正确解析。注入截断、重复/跳号、错误版本、缺少注册表、部分写入，必须拒绝生成。

支持输入格式采用明确行标识样本，按源 SPLIT 逻辑形成基线；输出按分块顺序拼接，移除各输出新增的表头后逐条比较。除标识和数量外，还验证原始值、文本长数字/前导零、数字 0、布尔值、空值、日期/数字格式、基础样式和支持的行属性。样式比较使用解析语义而非局部编号。

既有降级对象按基线警告和既有支持范围验收，不用“已降级”掩盖本次新引入的数据或样式丢失。原 Sheet 的布局不是逐 Sheet 无条件照搬，仍以现有布局基准合同为准。

### 8.4 串行性、故障与恢复

对每份 `commitAndValidate` 注入可控延迟，以创建、提交开始/完成、验证完成、资源释放事件生成时序证据。K>1 时 `maxActiveOutputWriters === 1`，且第 p+1 份创建发生在第 p 份完成释放之后；不能仅用一个 JS 变量证明没有并发。

在缓存、回放、第 1/中间/最后一份提交、汇总验证各阶段注入故障，Publisher 调用必须为 0。发布阶段注入中断、重复恢复、进程退出，按真实恢复协议验证正式文件、备份、journal 与一次性结算；不把该阶段与生成失败混成一个断言。

测试磁盘不足、预算变化、缓存短写、长行/巨型样式资源、Worker 退出、关闭与取消可见性、源文件变化、路径别名冲突。重复提交必须由真实门禁阻止，不仅依赖按钮 disabled。

### 8.5 性能、上限与仓库回归

记录输入格式/压缩前后相关大小、R/N/K、缓存大小、各卷临时峰值、最大活动 writer、峰值内存、句柄、计划/manifest/IPC 字节数、扫描/缓存/回放/校验/发布各阶段耗时。保留全部已生成文件时测量磁盘峰值，不能测完每份就删掉以制造低占用数据。

至少覆盖普通样本、大文件、宽行/长文本与高样式基数、小 N 导致多文件、K=1000，以及资源不足的失败样本。有限用例通过只证明测试环境覆盖的容量，不能推广为任意文件均可成功。

以下命令源自 v1 记录的工程说明；实施时以当前工作区为准，本轮未运行：

```bash
npm run test:unit
npm run test:integration
npm run smoke
npm run release-check
```

按当前工程规范执行关联变量检查与发布门禁；至少回归工具箱合并、原字段单文件、原字段多文件与任务/归档发布链路。

### 8.6 自动化与人工证据分离

| 证据 | 必填内容 | 本轮状态 |
|---|---|---|
| 自动化 | commit、命令/用例、样本版本、断言、日志路径、PASS/FAIL/BLOCKED | 未执行 |
| 资源与上限实测 | 硬件、系统、磁盘卷、运行时、各预算实际值、K=1000 全流程与峰值 | 未执行 |
| Windows 桌面人工 | Windows 版本、安装包/commit、导入/交互/路径/覆盖/取消与恢复结果 | 未执行 |
| Excel 人工 | Windows 下 Excel 版本、样本、打开告警、表头/值/日期/样式核对、结论 | 未执行 |
| WPS 人工 | Windows 下 WPS 版本、相同样本与检查项目、结论 | 未执行 |

文档未给出的应用版本不猜测、不写“最新版通过”。自动化能回读 XLSX 不等于 Excel/WPS 打开与视觉验收通过；截图也不能代替逐行一致性断言。

## 9. 开发顺序、回滚与交付

先确认目标工作区、本地未推送变更与工程规范；v1 快照不是本轮重新读取的最新代码。产品需记录 D1–D8 是否采用，资源策略需填入可追溯的真实预算，不把本稿当作已完成实施。

实施顺序：固定产品口径和计数/数量规划测试 → 独立 action 与资源/结果合同 → 保真缓存往返与引用封存 → 单 writer 顺序核心及故障测试 → main 准入/FilePlan/Publisher 接入 → 页面控件和联动 → 九份/千份端到端 → 回归与 Windows/Excel/WPS 人工验收。

分支保持：

```text
codex/v3.2.9-toolbox-split-by-rows
```

文档拟归档路径保持，并增加 review 对照：

```text
changes/3.2.9/codex/v3.2.9-toolbox-split-by-rows/
  spec.md
  techdoc.md
  review-response.md
```

交付时分别报告文档修订、真实源码修改、执行过的测试、容量证据、仍未确认的产品口径、关联功能 review 和恢复未完成项。本次仅创建新的文档建议版及 ZIP，保留 v1 原件，不创建 Git 分支、不提交、不 push、不发 PR、不 bump 版本。

回滚不能卸掉仍有未恢复任务依赖的 action/schema/恢复识别。先停止新 rows 准入，按既有协议完成或妥善处置在途任务和发布恢复；保留必要的旧合同识别与 journal，再回退相关实现。用户已导出文件、原件、其他任务数据及恢复证据不因回滚被删除。

### 9.1 尚需核对或验证的门槛

| 项目 | 本稿已决定的约束 | 仍需取得的证据 |
|---|---|---|
| 技术路线 | 首版只做保真落盘缓存 + 串行单 writer | 与真实读取/编码/writer API 的接入与生命周期测试。 |
| 后台 action | 独立 `toolbox:split-rows`，所有 rows 生成后台化 | action、准入策略、执行器、结果和恢复注册的实际位置与集成测试。 |
| 资源 | 数量推荐 1000；全部关键预算显式、缺失失败关闭 | 字节预算真实值、各卷峰值与千份成功证据。 |
| 产品 | D1–D8 为推荐默认值，不伪装逐项确认 | 产品确认记录及有变更时的同步修订。 |
| 兼容 | 不依赖旧掩码，旧八分组行为不变 | 原模式回归、源关闭后的保真回放、Windows/Excel/WPS 人工结果。 |

这些门槛是未完成项，不再保留技术路线二选一。报告“文档已采纳 review”不等于“功能已经可用”或“容量已经验证”。
