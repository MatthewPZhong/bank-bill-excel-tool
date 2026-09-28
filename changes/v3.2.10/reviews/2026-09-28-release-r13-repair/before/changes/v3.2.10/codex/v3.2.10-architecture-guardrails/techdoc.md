# TechDoc｜v3.2.10 架构依赖边界门禁（G8）

| 项目 | 内容 |
|---|---|
| 目标版本 / 计划分支 | 3.2.10 / `codex/v3.2.10-architecture-guardrails`；尚未创建 |
| 固定事实基线 | `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`（正式附注标签 `v3.2.9`） |
| 集成目标 | `release/v3.2.10`；交付前已与 v3.2.9 同步，本次未操作 Git；实施时按[总索引](../../README.md)再次核对 |
| 日期 / 状态 | 2026-09-20 / 设计稿，代码/规则/测试均未实施 |
| 需求与格式依据 | 同目录 [spec.md](spec.md)；[v3.2.9 工具箱 TechDoc](../../../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/techdoc.md) |

## 1. 现有检查和设计选择

[package.json:165](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/package.json:165)当前将 lint、smoke、unit、integration 串成 release-check。Windows 构建和正式发布工作流均调用此命令。新增检查插在 lint 后，沿用同一失败出口，不创造第二套发布 PASS 定义。

审查的 [scan-dependencies.cjs](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/architecture-coupling/2026-09-20/evidence/scan-dependencies.cjs)是一次性证据工具，没有稳定规则/例外/CI 合同；正式检查独立实现，复用其 AST/Tarjan 思路及共同口径对比。

采用 `acorn@8.17.0` 作为直接 devDependency，按 [package-lock.json:1354](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/package-lock.json:1354)当前已锁版本固定，不引用 ESLint 内部 parser，不额外引入依赖图框架或运行时依赖。扫描器通过 Acorn AST 自行遍历和静态取值，不 require/evaluate 生产文件，不联网。

## 2. 拟新增/修改文件与所有权

| 计划路径 | 职责 |
|---|---|
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/check-architecture.js` | 跨平台 CLI、参数、报告和退出码，唯一门禁入口 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/architecture/scan.js` | 枚举、Acorn 解析、词法绑定、路径解析、静态/动态边及脚本装配证据；纯返回数据 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/architecture/rules.js` | SCC、传递闭包、Renderer/DOM/治理入口规则、配置和例外校验 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/architecture/policy-history.js` | 只读 Git 配置历史、bootstrap、激活/退役底线与 policyChanges 链核对，不执行历史源码 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/architecture/boundaries.json` | 唯一边界定义：模块入口、允许依赖、全局工厂、待激活/已激活状态 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/architecture/legacy-allowlist.json` | 固定基线精确例外及删除条件；不保存所有合法依赖 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/architecture/policy-history-repairs.json`、`architecture/policy-history-repairs/<blob-id>.json` | 仅在历史 JSON 语法损坏时按 §5.4 新增：准确原 blob 到受审重建快照的登记与材料；无修复记录时不建占位文件 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/architecture/*.test.js` | scanner、规则、负向 fixture、activation 与 CLI 测试；fixtures 放同域 fixtures 子目录 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/package.json`、`package-lock.json` | 直接 devDependency、check:architecture 命令与 release-check 顺序 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/.github/workflows/build-windows.yml`、`release-windows.yml` | 为已有 release-check 传入明确 policy 对比提交，保留原有其他发布守卫 |

扫描器只读当前工作区、事件对比提交及本轮可达 Git 配置历史，不修改规则/源码。配置修改是显式代码评审内容，G1–G7 业务分支负责随自己的实际迁移更新对应 activation 和移除例外，不由自动扫描器发明架构决策。

## 3. 扫描输入、解析与边模型

### 3.1 枚举与解析

递归枚举 `src/` 下 `.js/.cjs/.mjs` 并按 POSIX 相对路径排序；拒绝指向仓库外的源码 symlink，不进入 node_modules、changes、测试、生成包目录。Windows 路径统一 `/`，保留大小写，对照实际目录段核对大小写，避免 macOS 可用但 Windows/Linux 解析不同。

`.cjs` 按 script，`.mjs` 按 module，`.js` 先 script 再 module；`ecmaVersion:'latest'`、`locations:true`、`allowHashBang:true`。任一两次解析均失败就报 ARCH-STATIC-COVERAGE，不能跳过继续输出 PASS。

为 Program/function/block/catch 构建词法绑定索引，区分被局部变量遮蔽的 `require/window/globalThis`；收集 destructuring import 和 const alias。该索引用于识别已支持语法，不宣称任意数据流证明。受保护入口内出现 require/全局对象无法解释的别名或反射，以诊断失败而不是忽略。

### 3.2 边种类和路径解析

统一边结构：

```js
{ from, to, kind: 'require'|'import'|'export'|'dynamic-import'|'worker'|'classic-global',
  source: { line, column }, specifier, evidenceId }
```

- 识别未遮蔽的 `require('literal')`、import/export source、`import('literal')`；无表达式模板字面量等同字符串。ES module re-export 同样形成边。
- 对相对路径固定尝试明确文件、`.js/.cjs/.mjs/.json`、目录 index；不执行 package.json 中代码。文件目标必须在 repo 内；越界失败。外部依赖只保存规范包名，`fs` 与 `node:fs` 归一为 `node:fs`；保留包内子路径供诊断。
- 本地 JS 图按 from→to 去重，Tarjan SCC 计算文件环；JSON 是叶子依赖，不参与 JS 环但保留于闭包规则。
- 支持同一作用域不可变 const 的字面量传播、`path.join/resolve(__dirname, literal...)`、`new URL(literal, import.meta.url)`；只处理确定的字符串/常量，不执行任意函数或 getter。
- 识别从 `node:worker_threads` 导入/解构/静态别名的 Worker 构造、明确注册的 utilityProcess.fork 和 child_process.fork；可解析目标加入 worker 边。worker 变量、多候选路径记录候选集，未知路径进入 unresolvedDynamic。
- 非字面量 require/import、新 createRequire/require.resolve 加载别名、未知 loader/fork 路径记录具体位置/规范 AST 指纹。现有三处动态加载按实际固定源码登记；新点必须解释并给出完整目标集合，否则失败。

第一次按与旧报告相同的字面量 require/import 口径，应复现 685 文件、2,254 唯一本地 JS 边与零环；新增 worker/global 边单独报告，不能混用总数声称原报告有误。对新增边形成的既有循环先列明准确历史路径及理由，再按本分支规则判断，不能自动加入豁免；纯字面量环固定禁止新增。

### 3.3 Classic scripts 与全局依赖

解析 `index.html` 的生产 `<script src>` 清单，只接受项目内明确路径，保持顺序。为 G3 新工厂在 boundaries 显式登记 `exportsGlobal` 和 `consumesGlobals`；根据 AST 的 window/globalThis 成员读取及已登记自由标识符建立 `classic-global` 边，验证消费者之前已加载提供者。宿主/服务不消费控制器工厂，控制器不能读取另一域私有命名空间。

不把整个 HTML 用正则推断业务组件：只需有限标签/属性解析器处理 script src、单双引号和属性顺序，并测试注释内假 script 不算；不能解析时失败。实现可使用专门小 tokenizer，无需新增 HTML 解析依赖。

G3 保护代码禁用 eval、Function constructor、非字面量全局成员访问；只允许配置列出的工厂导出和标准浏览器对象。旧 Renderer 复杂全局共享按准确例外保留并报告，不把旧四件套的 ESLint 忽略复制成新模块整体忽略。

## 4. 规则的确定行为

### 4.1 ARCH-CYCLE

字面量 JS 图所有环失败（基线为零）；新增可解释 worker/classic-global 图若暴露基线历史环，必须单独记录 `edgeKinds`，不能污染字面量图的零环口径。后续新增任意已覆盖边造成的新 SCC 都失败。诊断输出最短可复现环路径及每条边源码位置；无例外允许新的纯字面量环。

比较历史含环 SCC 时以规范化的实际循环边集合识别，不能仅比较“环数量没变”；旧环扩大或换节点是新违例。无历史扩展边环时不建立空泛例外。

### 4.2 ARCH-PLATFORM-CORE

立即保护以下既有入口的本地传递闭包：

- `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/resource-governor.js`
- `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/resource-lease.js`
- `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/background-execution/admission-queue.js`

允许本地目标仅为这三个现有模块和后续显式登记的纯辅助模块；当前外部仅允许 `node:crypto`。禁止依赖具体 BizOP/Position/Acquiring、Electron、fs、sqlite、worker、writer。检测闭包中的每条边，新增本地辅助模块不因“位于 background-execution 目录”自动合法。runtime/adapter/composition root 不属于纯核心，不禁掉它们合法的领域装配。

### 4.3 ARCH-PURE-LINEAGE（G6）

待激活入口为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/mapped-lineage-contract.js` 和 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/content-hash-contract.js`。允许本地依赖为彼此和现有同域 `definitions.js`，外部仅允许 `node:crypto`。

`row-mapper.js` 当前会经 normalizers 引入 xlsx，不能把它当允许纯辅助。G6 把必要 HASH_VERSION/PENDING_HASH_VERSION/contentHash/pendingContentHash 规则原样移入 content-hash-contract，旧 row-mapper 保留兼容导出；G8 检查新合同的整个本地闭包。writer → contract 与 review-export-plan → contract 合法，contract → writer/row-mapper 不合法。

除了静态检查，G6 真实 module load 测试记录 require.cache/Module load 观察到的模块，不启动 writer，证明调用校验没有加载 ExcelJS/XLSX/SQLite/文件执行器；该测试属于 G6，本分支测试用 fixture 验证相同规则。

### 4.4 ARCH-RENDERER-SCOPE / ARCH-MODAL-OWNER（G3）

新 controller/dialog factory 的参数合同由配置列明：`api/panel/ui/config` 以及只有 BankStatement/ReconID 可用的 `sharedReconSession`。禁止把 composition root 的 `state/elements/window.desktopApi` 整对象作为 factory 实参；冻结的、按方法构造的 scoped API 对象合法。检查受保护 factory 的注入点，以及受保护文件的直接 `window.desktopApi`/`desktopApi` 全局读。

控制器本地 `const state`、本地 `const elements` 是正常私有状态，不因变量同名误报。配置服务和 ui 对象有明示方法清单，禁止扩展为任意对象袋。工厂参数 alias/对象 spread 无法确定来源时，在新保护代码报 coverage 失败；不做静默放行。

release 的精确登记按 G3 实际装配补齐 modalHost、modalBridge、services、subscriptions、legacyController、differenceApi、reviewProjection 等具名参数；仍使用 `allowedApiFields` 的逐键历史强度比较。准确 Preload namespace 的方法集合、命名工厂返回、显式参数转发、静态对象 spread 和单领域面板别名由 AST 解析，整对象、未解释能力、对象被修改 helper 接管、global provider 重复赋值失败关闭。支持形式、保守拒绝形式及真实 VM 反例见 [Renderer 对齐说明](../../reviews/2026-09-21-release-repair/renderer-policy/mapping.md)。

第二轮 release 审查补齐 RR2-01～05：调用闭包选择静态数组/解构回调，Renderer 工厂保留多层 bind 的前置参数，以同文件对象 AST 身份核验别名变更并按顺序解释 spread；initialInfo / initialBillCategory 递归限制为纯数据或明确的 app:get-info IPC 数据。G1 内部恢复能力按当前函数绑定登记，合法链路逐调用指纹许可。具体支持与保守拒绝边界以 [architecture README](../../../../architecture/README.md#覆盖与验证边界) 为准，回归和验证见 [RR2 修复报告](../../reviews/2026-09-21-release-r2-repair/repair.md)。这是现有防倒退合同的检查器修正，不改变业务恢复、金额、匹配或导出合同。

第三轮 RR3-01～05 继续修正同一合同：未知长度数组 spread 不再伪造后续索引，嵌套对象身份不因无 chain 跳过检查，属性描述字典保留特殊自有键并单独处理 prototype setter；初始分类合同落在真实 config.initialBillCategory。G1 通过实际调用闭包保存经静态容器、helper 实参/返回值及跨文件转发的最终恢复能力身份，准确授权调用仍为停止点。当前能力与保守拒绝形式见上述 architecture README；证据见 [RR3 修复报告](../../reviews/2026-09-22-release-r3-repair/repair.md)。

第四轮 RR4-01～03：Renderer 能力求值与身份传播使用同一静态解析，分配位置叠加调用上下文区分新实例，外部共享对象保持原身份；bind、返回后成员选择及条件别名均保留可能来源。G1 将已进入闭包的隐式回调作为对应调用位置的受限能力入边检查。完整支持边界及保守限制仍见 architecture README；原反例、多实例与共享对象对照见 [RR4 修复记录](../../reviews/2026-09-22-release-r4-repair/repair.md)。未改变机器配置或业务合同。

第五轮 RR5-01～02：用不影响扫描结果/指纹的私有旁表保留成员读取时点；Renderer 在已知调用上下文内按执行顺序解析成员替换、解构与浅拷贝的对象身份，旧别名不迁移到新实例。函数值比较仅在未改写且未逃逸的静态数组 includes/indexOf/lastIndexOf 上排除回调执行，已解释 helper 和实际恢复回调继续按最终函数身份检查。详见 [RR5 修复记录](../../reviews/2026-09-22-release-r5-repair/repair.md)；业务合同、机器边界与授权例外未变。

第六轮 RR6-01～02：Renderer 参数绑定先保留对象身份，解构按调用时点复用成员快照，实际使用时再核验能力；静态数组比较的排除证明保留对象/解构/原型参数来源及有限 helper 返回投影。已知可能改写与未知来源不能共同被解释为“没有改写”；旧别名、独立实例和原生比较仍有正例。实现及验证见 [RR6 修复记录](../../reviews/2026-09-22-release-r6-repair/repair.md)。不改变生产业务合同或机器授权。

第七轮 RR7-01：AssignmentPattern 绑定按确定缺失/undefined 选择默认表达式；已提供值保留原身份，不确定值保留可能默认来源。默认表达式在被调用函数的词法环境和本次调用帧中解释，省略、成员缺失、显式 undefined、前序参数和新默认实例均有回归对照。见 [RR7 修复记录](../../reviews/2026-09-22-release-r7-repair/repair.md)。机器合同、G1/G5 解析和生产业务未改；既有数组元素替换观察仍保留，不作为本项关闭范围。

第八轮 RR8-01/02：IPC 数据来源不证明字段存在，默认参数保留默认对象候选，纯数据候选递归核验；不新增字段存在性白名单。数组在 Renderer 私有映射中获得分配及调用身份，固定槽位读取/解构/spread 采用成员快照，旧别名和独立实例保持。整体数据数组检查可见写入候选；未精确解释的数组变更保留不确定性与已知来源，不静默以初始元素代替。见 [RR8 修复记录](../../reviews/2026-09-22-release-r8-repair/repair.md)和 architecture README 的有限支持范围。前轮固定槽位观察在本轮补齐；共享扫描器、G1/G5、机器配置和业务合同不变。

宿主拥有 `modalRoot` 节点。扫描已知 `getElementById('modalRoot')`、`querySelector('#modalRoot')`、`elements.modalRoot` 及同作用域 const alias 的写入/append/remove/replaceChildren/innerHTML/textContent，宿主外违反。`overlay.remove()` 只在该 overlay 可追溯为宿主记录或 legacy modal 工厂返回时受规则约束，普通表格行/其他 DOM 移除不误报。难以追溯的已迁移域直接 DOM 外部移除由禁止全局 root 访问和 modal integration 测试补充，报告保留此边界。

初始 legacy 写入例外精确覆盖实际现存路径；G3 R1 激活要求这些例外全部移除、宿主被 script 加载、两份公共 open/close 转发以及 VCC/Position/账户映射场景测试齐备。静态 scanner 不尝试执行这些 GUI 测试。

第九轮 RR9-01/02：`&&` 的结果包含可能的假值左侧，不能无条件替换为右侧；只有静态确定真值（包括登记为对象的 Preload provider）才能取右值。完整 API 的可证明真值与可注入权限分别判断。mutator 的 spread 实参按展开时点保留元素对象来源，未知数组操作继续以不确定结果及可见来源检查，不承诺精确执行。旧别名、独立实例和真值安全对照纳入回归。见 [RR9 修复记录](../../reviews/2026-09-22-release-r9-repair/repair.md)；不修改共享扫描器、G1/G5、机器授权或生产业务。

第十轮 RR10-01/02：三个逻辑运算符按真值/空值选择返回分支，未知左支保留该分支成立时的非空或真值约束，防止默认参数重新引入不可能的对象；候选合并时来源取并集、分支证明取交集。工厂数组的内部写入使用 origin 调用环境，外部读取保留独立时点；静态 helper 参数继承正确调用帧。普通 spread 的未知长度仍保留可见来源而不伪造索引，能力对象别名写入继续检查。见 [RR10 修复记录](../../reviews/2026-09-23-release-r10-repair/repair.md)；机器授权、共享 scanner、业务输出合同保持。

第十一轮 RR11-01/02：对象自身的真值/非空证明不递归证明 IPC 子成员存在，成员投影时清除父证明，允许成员表达式重新建立自己的分支事实。数组发生 reverse、shift、splice 等重排时，静态检查保留重排前其他固定槽位的可见写入来源；读后写入和独立数组不计入。该保守集合用于识别后续别名能力写入，不声明精确模拟数组索引。见 [RR11 修复记录](../../reviews/2026-09-23-release-r11-repair/repair.md)。

release 第十二轮 RR12-01 将数组分配身份与内容求值分开：仅比较接收者身份时不展开元素，真正读取元素时保留原调用环境及递归深度/访问链。普通 helper 的唯一调用位置同时用于参数绑定与读写顺序核对，避免内部数组重排被错误排到外层写入之后。仍按既有合同保守收集重排来源，不精确模拟全部数组方法。见 [RR12 修复记录](../../reviews/2026-09-23-release-r12-repair/repair.md)。

### 4.5 ARCH-XLSX-INFRA（G4）

G4 计划目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/xlsx/` 包含 rich-workbook、shared-strings-provider、zip-reader、workbook-parts、excel-text、ooxml-namespaces、number-date、model、style-registry、xlsx-sheet-scanner 及 legacy/streaming-xlsx-reader、legacy/entry-size-preflight。该目录是 IO 基础设施，**不套用纯 lineage 的 fs 禁令**。

允许本地依赖在该目录内及明确现有 `src/backend/file-service/common.js` 错误类；允许 Node 内置模块和既有 yauzl/sax/jszip。不得反向依赖 Position、Pending、Toolbox 业务路径或 main-process，也不得经本地中间模块绕回这些路径。旧路径→新模块的单向 re-export 合法，Toolbox xlsx-pass 保留业务装配并消费新层合法。

配置登记该计划目录为 pending；目录出现即覆盖其中全部文件，防止只检查入口而漏掉新子目录。G4 完成时 active 要求全部中性入口与迁移后的生产消费方向存在；旧 shim 不属于永久必需入口。旧错误类名/code/constructor 兼容由 G4 行为测试验证，G8 不因为名称带 Position 就误判真实依赖方向。不会把解析层改写成不允许 IO 的纯函数层。

同时登记 `deprecatedEntrypoints`，每项固定字段：`path`（旧业务 API 所在文件）、`replacementPaths`（中性目标数组）、`exportNames`（受弃用的导出名数组；整文件 shim 为 null）、`existingConsumers`（基线准确 from/kind/importedNames 列表）、`state`（compat/retired）、`retirementEvidence`（兼容验证与全仓引用清点记录路径数组）。它与边界 entrypoints 分开，不使用目录 glob。Toolbox xlsx-pass 仍有业务装配，不整体登记为待删除 shim；其中转发 helper 的新消费方须改向中性 API，检查需依据具名 require/import 成员匹配，无法确定成员的新增整对象 require 报 coverage 失败。

迁移期仅已有 from/kind/importedNames 生产入边允许指向被弃用的 API；删除/切换合法，新增文件即使经 shim 最终到中性目录也失败。G4 active 时兼容 API 的生产入边必须归零。retired 要求生产入边为零且存在明确 retirementEvidence，不能仍在配置中要求 shim 文件必有；G4 的全仓 tests/scripts 调用清点与兼容测试由对应分支完成，scanner 只核对生产边与证据路径，不虚称已执行这些测试。退役登记不得重新变 compat 或恢复生产入边，遵循 policy comparison 防倒退规则。

### 4.6 ARCH-STATIC-COVERAGE

已存在两处 `src/build-info` 本地未解析引用注册为生成文件合同：准确 from/specifier、生成者 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/gen-build-info.js`、预计目标 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/build-info.js`。生成文件存在时正常解析，不存在时仅该准确合同可通过；新拼错模块不能借用通配豁免。

动态加载登记的 `allowedTargets` 被加入依赖图，不只忽略该点。历史三处动态点逐项标识所在函数和 AST 指纹；源码变化使指纹不匹配就重新核对，不复制旧行号当 proof。受保护纯模块不允许不透明动态加载，即使普通遗留清单存在该位置也不可穿过纯规则。

<a id="governance-rules"></a>

### 4.7 G1：ARCH-PUBLICATION-RECOVERY-ENTRY / ARCH-BIZOP-RECOVERY-PRIVATE

以 G1 的 owner-scoped gateway、dispatcher 授权事务及其 [TechDoc](../v3.2.10-application-recovery/techdoc.md)为接口正文，不在 G8 重新定义 grants。

- `ARCH-PUBLICATION-RECOVERY-ENTRY` 登记底层 `toolbox-output-publication.js` raw recover、publication worker 的 recover 操作、dispatcher 暴露的恢复方法和 prepare 内恢复调用。只有底层实现内部以及 `toolbox-output-publication-dispatch.js` 的授权事务可以形成这些入边/操作；Main 和业务只调用 coordinator 返回的 `forOwner(ownerId)` 能力。检查具名 import/require 成员和已知 worker operation 的字面量，整对象别名/动态 operation 无法追溯时在保护范围报 coverage 失败。
- 新授权事务内部的 raw 调用属于准确允许位置，不能允许整个 dispatcher 任意函数发起 raw recovery。其函数选择器、callee/operation 和源码指纹登记于配置。Main composition 可以创建/注入 coordinator，但 live handoff、ack、NewAccount、BizOP reconcile、dispatch transport-error 和 prepare 都不能成为独立 raw 入口。
- `ARCH-BIZOP-RECOVERY-PRIVATE` 保护 `src/main-process/biz-op-v327/recovery-driver.js`、`recovery-sources.js`、`recovery-budget.js`、`recovery-plan.js`、`recovery-alignment.js`、`export-publication.js` 及拟新增 recovery-participant/publication-owner 的私有恢复/发布 API（以实际迁移导出名登记，非整目录禁用）。BizOP 同域内部消费合法；Main 的明确 composition 以及 G1 的显式 participant/owner 装配可以引用。其他业务必须使用公共 owner gateway；本地 helper 转发也按闭包追踪，不能用中间模块隐藏跨域引用。
- 初始历史清单从固定基线逐项登记真实 from/to/importedNames 或 AST 操作位置，含隐式 prepare 和异常路径，不设 `main.js` 全文件豁免。G1 完成全部启动/实时/隐式入口迁移后，两项 active，旧 raw 入口例外归零；必要消费者和授权事务必须实际存在。

正例为业务→owner gateway→授权 dispatcher，以及合法 BizOP 内部/显式装配；反例为新业务直接 recover、dispatch 未经授权发 worker recover、prepare 再次隐式 raw recover、跨域 helper→BizOP 私有 API。静态规则只能证明调用位置/依赖方向；“discovery 零写、授权早于副作用、snapshot 指纹复核、队列和 lease、未知 owner 保留”由 G1 真实故障注入测试负责，不能因参数名叫 grants 就宣称已证明授权。

### 4.8 G2：ARCH-TASK-ADAPTER

保护既有 `src/main-process/archive-center/task-lifecycle.js`、`src/main-process/archive-center/ipc-task-contract.js`，拟新增 `src/main-process/task-adapters/registry.js`、`passthrough.js`、`prepared-resources.js`、`src/main-process/archive-center/terminal-route-registry.js`，以及 `src/main.js` 内的 `runArchiveAwareOperation` 通用编排作用域。确切职责以 [G2 TechDoc](../v3.2.10-business-task-adapters/techdoc.md)为准。Position 原 `interactive-task-preflight.js` 属领域模块，公共层迁出其通用清理辅助后不得反向依赖它，不能把整个领域 preflight 当作中立模块保护。

禁止这些公共模块的闭包加载 Position `interactive-task-preflight.js`、拟新增 `task-owner.js`、`task-adapter.js` 等业务状态机；禁止通用函数继续直接调用迁出的 Position pending、settlement、cleanup 私有函数。Main 同一文件中的显式组装/IPC handler 可引用领域 adapter，因此对 Main 采用具名函数作用域及其直接 callee 绑定规则，不能按整个 Main import 一票否决。可追溯 const/function alias 纳入；保护作用域里的未解释调用别名不能静默忽略。

组合实现中，具名编排沿真实调用目标扩展到 helper、被选中的工厂返回成员及可解释的 callback 实参，保留模块顶层初始化。注册对象的未调用方法不自动视为执行；公共机制的整文件反向依赖约束继续存在。未知动态执行目标失败关闭。精确数据调用 allowedSites 绑定包括回调在内的 AST，修改回调不能继承原许可。

允许 Main 注入 adapter invocation；允许领域 adapter→本域 task-owner/service、publication adapter→G1 owner gateway；通用层调用合同中的 execute/afterTerminal/onAbandon 合法。初始只对固定基线的 Position import/调用位置列例外，新的迁移模块无例外；G2 最后一个真实 task caller、live/replay terminal 路由迁移并删除兼容转发后 active。正反例验证公共 executor→helper→Position 失败、adapter 的同域调用和 Main composition 通过。二次 gate 的资源收口、executeStarted 交接和一次终态由 G2 行为测试负责。

### 4.9 G5：ARCH-BIZOP-QUERY

保护 `src/main-process/biz-op-v327/compute-inputs.js`、`export-inputs.js`、`import-main.js` 的事实读取，以及 `delete-preview.js` 中 `collect` 的业务/归档事实读取；迁移目标为 `catalog-queries.js` 和 `src/backend/database/archive-repository.js` 的 `hasOtherArtifactForBlob`。Q1 可先激活跨域 Archive 读取限制，Q2 激活 compute/export，Q3 激活 delete collect/import；各子边界 ID 独立登记，不等 Q4 才保护已迁移入口。

对受保护读取作用域禁止 `catalog.db`、别名 db 的 `prepare/exec` 和 raw 数据库句柄透传；允许 `catalog.queries` 的具体只读方法与 repository 查询方法。不得把原始句柄包装成 query facade 后继续在消费者构造 SQL。读取模块不能新建连接、事务或写 SQL；这些能力的加载边/已知 API 受静态规则约束，真实同步性、锁与预算由 G5 测试证明。

`delete-preview.js` 的 `get/create/bind` 继续持有自有 preview 表的读取、计数、过期删除、插入和绑定更新，作为合法 command 职责登记准确函数、API、SQL 字面量及 AST 指纹；**它们不是待清零的历史违例**，不能把所有 `SELECT` 或所有 `.prepare` 都禁掉。改变这些位置时重新核对职责，不自动沿用旧指纹。`collect` 的 archive_artifacts 存在性查询必须走 Archive 方法，不能借预览命令的允许项保留。

scanner 识别保护作用域内句柄来源和支持的静态 alias/SQL 字面量；新不透明 DB alias 或动态 SQL 在该范围失败，不能宣称静态分析理解任意 SQL 语义。合法 query 的业务过滤、顺序、LIMIT、iterator 和 readonly 要靠 G5 真库测试；G8 负例覆盖 raw 查询绕回、正例覆盖 facade、Archive API 以及全部预览自有命令/附属读取。

跨模块读取 helper 使用与 G2 一致的执行目标追踪：导入成员、返回函数、call/apply/bind 和对象实参中的实际被调能力不能隐藏 raw DB。真实消费者登记反映 `module → catalog → catalog-queries` 的装配注入以及 compute/export/import/preview 的实际调用链，不伪造不存在的直接 require 边。仅为公共 policy 汇总而可达的其他领域未调用仓储不视为查询执行。

### 4.10 G7：ARCH-DESCRIPTOR-COMPOSITION

保护 `src/main-process/background-execution/runtime.js`、`background-execution/execution-policy-registry.js`、`archive-center/task-policy-registry.js`、拟新增 `archive-center/task-policy-common.js` 和 `execution-descriptors/contract.js` 的公共机制。它们不能直接或通过本地 helper 加载具体领域实现，也不能反向加载以下装配入口。

明确允许 `src/main-process/execution-descriptors/composition.js`、`policy-catalog.js`、`mature-adapters.js`、`legacy-task-policies.js` 装配 [G7 TechDoc](../v3.2.10-execution-descriptors/techdoc.md)列明的各域 `execution-descriptor.js`、既有工厂/规则。Main 是调用这些装配入口并把冻结聚合结果交给 runtime 的 composition root。允许项是逐文件/具名导出，不允许整个领域目录的任意装配；policy-catalog 只汇总纯 policy 常量，不执行持有 Main authority 的工厂。

同一装配源文件可有多项准确目标/导出登记，每条边须完整匹配其中一项；不能把各项许可交叉拼接。namespace 引用仅在所有用途都为可解释具名成员时按实际导出检查，整对象透传、动态成员、突变或未授权成员继续拒绝。

迁移期 runtime 的原 `BACKGROUND_EXECUTION_POLICIES` 兼容导出若暂经 policy-catalog 转发，作为准确历史桥接登记并保持 pending/partial；真实调用方迁到 catalog 且 runtime 删除反向转发后，才可 active。旧常量名称和值保持不代表公共 runtime 必须永久兼任装配。正例为 composition→domain descriptor→同域实现、Main→冻结汇总→runtime；反例为 runtime/registry/contract→领域或→catalog/composition。G7 的 registry key、静态 profile fallback、重复键和 authority 保持由 G7 测试负责。

以上五条新增规则的 protectedScopes、允许装配/调用位置和旧例外均属于配置及 schema 的正式字段，不能只在文档出现。每个子边界有稳定 id、governance、planned/required entrypoints、消费者、activationEvidence；按切片更新。G8 的 scanner fixture 验收与各域真实行为测试分别记录，后者未执行不能标为生产边界已验证。

## 5. 配置、历史清单与激活合同

### 5.1 配置形状

```json
{
  "schemaVersion": 1,
  "factBaseline": "11086a3cbf632a30adbcfa796e4cd81810c5aef9",
  "boundaries": [{
    "id": "vcc-mapped-lineage",
    "governance": "G6",
    "state": "pending",
    "entrypoints": [
      "src/backend/vcc-financial-op/mapped-lineage-contract.js",
      "src/backend/vcc-financial-op/content-hash-contract.js"
    ],
    "allowedLocal": [
      "src/backend/vcc-financial-op/mapped-lineage-contract.js",
      "src/backend/vcc-financial-op/content-hash-contract.js",
      "src/backend/vcc-financial-op/definitions.js"
    ],
    "allowedExternal": ["node:crypto"],
    "requiredConsumers": [],
    "activationEvidence": []
  }]
}
```

示例只展示字段形状，实施时 `requiredConsumers` 按 G6 契约列 review-export-plan、dataset-writer、row-mapper，不能留空激活。G3 模块另外登记 globals、factory 与 allowedApiFields；枚举 ID 唯一，未知字段/无效路径/缺 owner/任意 glob 都失败。规则定义不支持任意 JS 回调，避免配置变成执行入口。

G1/G2/G5/G7 追加 `protectedScopes: [{path, functionPath}]`（null 表示全文件，嵌套函数用词法名称路径，禁止行号选择器）、`restrictedApis: [{path, exportNames, operations}]`、`allowedSites: [{rule, from, functionPath, callee, evidenceId, reason}]` 和 `compositionEntrypoints: [{path, importedNames, allowedTargets}]`；不使用的字段为空数组。别名解析来自 §3，无法追溯的位置报 coverage。合法预览命令、授权 dispatcher 和 Main 装配是 allowedSites；待删除的旧旁路是 legacy-allowlist，两者不能混用。配置 schema 与负向 fixture 必须覆盖这些字段。

`pending` 不等于跳过：不存在时报告 pending；任一 planned entrypoint 出现就检查它，部分入口到位报告 partial；active 要求所有入口/消费者/脚本装配和 evidence 路径存在。activationEvidence 是应维护的测试入口路径，不声称测试已经通过。active 不以计数代替行为验收。

### 5.2 例外形状与指纹

```json
{
  "schemaVersion": 1,
  "factBaseline": "11086a3cbf632a30adbcfa796e4cd81810c5aef9",
  "exceptions": [{
    "id": "legacy-modal-dialogs-root-clear",
    "rule": "ARCH-MODAL-OWNER",
    "from": "src/renderer-dialogs.js",
    "evidenceId": "sha256-of-normalized-ast-site",
    "reason": "G3 R1 前旧公共关闭入口直接清空根节点",
    "governance": "G3",
    "removeWhen": "modalHost 接入两份公共关闭及全部直接挂载者"
  }]
}
```

静态边豁免用 rule+from+to+kind 定位；动态/DOM/global 位置用 rule+from+规范 AST hash+所在函数定位。hash 从相关 AST 节点剔除位置/raw、按稳定字段排序后计算，同函数内相同节点加 occurrence，单纯空白/注释不改变；同一例外不得匹配多个未知位置。

检查输出 staleExceptions 警告并建议删除，同一治理变更在评审时收缩；默认命令不替人删清单。源文件改名不是自动重定位。初始化清单的辅助命令仅输出候选 JSON 到显式临时路径，人工核对固定基线后纳入；无 `--accept-all` 或默认覆盖功能。

<a id="policy-history"></a>

### 5.3 防止激活倒退：事件对比与历史底线同时执行

#### 三种证据不可混用

1. `factBaseline` 固定为本轮 v3.2.9 的完整 SHA，用于旧依赖事实和初始例外；该提交**没有** `architecture/boundaries.json`。
2. `policyComparedWith` 是本次真实事件的对比提交，本地默认 HEAD，PR 用事件 base.sha，main push 用事件 before，tag/manual 用实际被检查的 HEAD。`--against` 或 `ARCHITECTURE_BASE_REF` 只选择这一项，不能关闭历史底线。
3. `policyHistoryRoots` 固定包含实际 HEAD 和事件对比提交；从 factBaseline 之后这些提交的全部可达父链收集配置历史，包含 merge 的各父链，不只读 first-parent 或两端 diff。这样 S1 激活已纳入本轮历史后，S2 即使对比 S0、或 tag/manual 对比自己，也不能忘记 S1。

只读 Git：解析/验证提交，要求 factBaseline 是每个根的祖先；检查历史完整，shallow 或缺失对象报输入错误 2。枚举可达提交，提取 boundaries、legacy-allowlist、policy-history-repairs 三个登记 JSON，以及 repair 引用的 snapshot/reviewEvidence 路径有变化的 tree/blob；即使只改 repair 材料也不能漏掉该提交。按 blob hash 缓存，按需从对应历史提交读取 snapshot/evidence，读取 JSON 不 checkout、不 require、不执行历史脚本、不自动 fetch。当前源码仍只检查当前工作区，历史源码不重复扫描；历史材料缺失与历史提交本来没有该路径必须区分。实际 HEAD 与 CI 的 checkout SHA 必须一致，不能用旧 ref 作为实际 HEAD。

#### 首次无配置的处理

当前配置必须含 `bootstrap: { factBaseline: '<固定 SHA>', mode: 'first-introduction' }`，作为本轮首次建立规则的来源记录，后续保持。历史中首次出现配置时，验证固定基线确实没有配置，所有本稿规则/计划子边界完整登记，schema、现行立即生效规则与精确历史例外合法；不存在的计划模块 pending，已实现模块按实际入口/消费/证据确定状态。bootstrap 不是允许跳过检查的 CLI 开关。

当前树缺少配置一律失败；只有历史中的 S0 可合法无配置。一旦任一历史根的祖先已有配置，不能把后续缺文件、换 factBaseline、删 bootstrap、读不到提交或选择旧 tag 当成再次首次引入。配置被删后又完整恢复时，按当前配置和历史底线判断，不强制重写中间 Git 历史。

#### 构造不可降低的状态底线

历史底线是所有历史配置中出现过的 active 边界 ID、retired 入口，以及它们的必需入口、消费者、允许集合和精确例外约束；事件对比配置同样加入。id 永久稳定，禁止把 active id 改名伪装为新 pending。active 不得降为 partial/pending 或消失，retired 不得重新成为 compat 或恢复生产入边，这两类状态不能由 policyChanges 豁免。

底线比较必须覆盖全部影响规则效力的字段，不仅比较状态和文件名：规则与边界的绑定、protectedScopes、restrictedApis 及 exportNames/operations、globals/factory/allowedApiFields、requiredConsumers、activationEvidence、deprecatedEntrypoints、allowedLocal/External、allowedSites 和 compositionEntrypoints。删除/缩小保护作用域或受限 API、解绑规则、删除必要 evidence、扩大允许调用/装配范围均视为放宽。schema 拒绝未知字段，新增具有规则语义的字段必须同时定义收紧/放宽比较与 fixture，不能以未比较字段获得旁路。policyChanges 不能解除本稿对应规则的禁止能力。

逐个历史 active/retired 快照与当前配置比较：新增消费者/必需入口、收窄允许集合、删除已无匹配的历史例外是收紧；无依据地删除必需入口/消费者、扩大允许集合、新增例外、入口改名是待解释变更。所用证据固定到 `{sourceCommit, sourcePolicyBlob, boundaryId, field, from, to, reason, designDoc}` 的 `policyChanges` 项；sourceCommit/blob 必须确在已读取历史中且字段值与 from 相同，to 与下一条变更或当前值相符，不接受笼统“重构”或无来源记录。多次迁移按准确值链接且无环，merge 两父链的底线都必须满足或给出各自的合法迁移链，不能任意取最后时间戳的一份。

合法入口改名必须在当前树验证替代入口、消费者与原禁止能力，并同步当前规则说明；不能用记录为纯模块放行 writer/IO，不能豁免新增字面量循环。迁移链只让架构调整可核对，不宣称自动证明业务正确或已经人工批准。当前树若恢复到历史底线，可通过；中途失败状态保留为诊断，不要求为通过检查删除历史提交。历史中 malformed 配置使证据不可解析时默认报输入错误，明确指出 commit/blob；仅可按 §5.4 的准确重建证据继续，不能忽略该历史节点。

迁移链的节点按提交/配置版本及 boundary/field 识别，顺序须符合相应父链；“无环”禁止证据链回指旧版本，不禁止路径值重现。因此有准确记录、保持 active 和实际消费者合同的 A→B→A 是合法改名后恢复，须加 fixture，不能误判为值循环。

#### 事件参数与验收

| 场景 | policyComparedWith | 必查历史根与 bootstrap 行为 |
| --- | --- | --- |
| 本地未提交/已提交工作 | 默认 HEAD；可显式真实 base | 实际 HEAD + 对比提交，未提交配置另外检查；不能仅检查 HEAD→工作区 |
| PR | `github.event.pull_request.base.sha` | 现有 checkout 的 PR head + base；未引入 G8 的 base 合法，PR head 历史中 S1 仍受保护 |
| main push | `github.event.before` | checkout 的 after/HEAD + before；零 SHA/不可读 before 失败，不能自动空基线 |
| tag release | 已解析 annotated tag 的 HEAD（沿用现有 tag/main 守卫） | HEAD 的全部可达父链；不再固定与 v3.2.9 空配置作唯一比较 |
| workflow_dispatch | 实际 checkout HEAD | HEAD 的全部可达父链；和 tag 使用相同历史机制 |

必须用临时真实 Git repo 构造 S0 无配置 → S1 合法 active → S2 改 pending 且移除入口，分别用上表事件环境/CLI 调用，确认全部拒绝 S2。另测保持 active/entrypoints 不变，仅清空 G5 protectedScopes、删除 G1 restrictedApis 的 recover operation 或扩大允许装配，仍须失败。还须覆盖 S1/S2 在同一 PR/push 范围、merge 另一父链带入 S1、合法首次引入、shallow/missing object、配置删除、retired 复活、有证据改名和 S3 恢复底线。不能仅用手写对象或人为选择 S1 作 --against 的单用例证明 tag/manual 有效。

<a id="policy-history-repair"></a>

### 5.4 历史 JSON 语法损坏的受控恢复（第二轮非阻断建议）

问题范围是历史 `boundaries.json` / `legacy-allowlist.json` 的 JSON 语法无法解析，当前树虽然已恢复合法配置，§5.3 仍会因历史证据不可读取而阻断。恢复方式是为准确的历史 blob 提交可核对的重建快照，继续构造同一历史底线；不改 factBaseline，不 rebase/force-push，不增加忽略历史或跳过规则的开关。本节只是后续 G8 实现合同，本次不创建任何实际 repair 配置。

1. 检查器报告 `commit/path/blob` 及 parse error；先修复当前树，当前配置语法/schema 错误不能使用历史 repair。历史缺对象、shallow、可解析但违反边界的配置、未知 schema 版本也不能使用此出口：分别补齐只读历史、落实当前约束或增加受测 schema 兼容解析，不伪装成语法错误。
2. 维护者从指定 Git blob 导出原文，在 `architecture/policy-history-repairs/<blob-id>.json` 保存**最小语法修复后的完整配置**。不凭前一版本整体覆盖，不删除无法解释的字段/边界，不借修复调整业务或架构语义。重建差异及原意依据进入同一变更的审查记录；原意无法可靠恢复时继续阻断，不生成空配置或猜测快照。
3. `policy-history-repairs.json` 为独立、严格校验的只读登记：`{schemaVersion:1, repairs:[{path, originalBlob, sourceCommits, repairedPath, repairedSha256, reason, reviewEvidence}]}`。path 只允许上述两个配置路径；sourceCommits 必须实际可达且该路径的 blob 与 originalBlob 完全一致，原 blob 必须确因 JSON 语法错误无法解析；repairedPath 必须是仓库内固定 repair 子目录的普通文件，不允许 symlink/越界/通配；hash 与内容一致且重建快照通过原 schema。reviewEvidence 是存在的、说明原始差异和重建理由的审查文档路径，不是自动批准的证明。
4. 一条登记仅替代同 path + exact originalBlob 的解析输入，保留每个原 commit 的历史身份；不能连带覆盖相邻 commit、其他 blob 或其他路径。重建快照的 active/retired、保护字段和例外**完整进入 §5.3 底线**，再与当前树检查；即便 repair 被采纳，当前代码删除必需入口或扩大保护例外仍失败。机器校验身份、hash、schema、证据存在和已知约束，不声称能自动证明语法损坏前的业务原意，语义保持须由该变更的 review 核对。
5. 已进入可达历史的**完整有效** repair 绑定不可静默删改。逐历史提交按第 3 项完整核对原 commit/blob 身份（sourceCommits 当时已可达）、该提交中的 snapshot/hash/schema 和 reviewEvidence，全部机器条件满足后，才按 `(path, originalBlob)` 固定 repairedSha256；不能仅凭登记 JSON 可解析就永久锁定。当前缺记录/材料、改已固定 hash 或出现两个完整有效但不一致的绑定均失败，不能重新换弱配置抹掉已恢复的 active 底线。历史登记的语法错误、hash 笔误或当时缺材料等无效记录只记诊断，不授予替代权限、不固定错误 hash，也不抹掉更早的完整有效绑定；后续前向修正尚未有效的记录可继续检查。Git 对象实际不可读取仍按 §5.3 报输入错误，不能伪作“当时记录无效”跳过。当前登记必须合法并恢复所有既有完整有效绑定。已经有效的重建内容确有错误时需另行制定带完整证据的修订方案，不提供泛用 override。

只在需要 repair 时引入登记；正常仓库无文件等同空登记，已经有历史有效绑定后不允许按空登记处理。扫描器只读，不自动生成/采纳修复，也不通过执行历史代码取证。报告增加 `historyRepairsApplied: [{path, originalBlob, sourceCommits, repairedSha256, reviewEvidence}]`，输出有/无 repair 及对应证据，不能隐藏恢复来源。普通配置审查及各事件门禁使用同一机制。

G8-AC-22 使用真实 Git fixture：S0 无配置 → S1 合法 active → S2 JSON 语法损坏 → S3 当前恢复合法。无登记仍按原输入错误拒绝；准确登记和重建可恢复检查，并继续检出当前 active 降级/删入口。还须拒绝错 blob/hash/path、缺 evidence、把可解析退化配置当损坏、空重建、重建后改弱、merge 父链不一致绑定；未知损坏仍阻断。新增两条序列：从未有效的错 hash 登记经后续提交修正可以通过；已有完整有效绑定后出现坏 manifest，再恢复时仍必须保持旧绑定。只改 snapshot/evidence 的提交也须重新核对。单纯当前树恢复、选旧 --against 或添加忽略项都不能代替上述证据。该测试是实现要求，当前未执行。

## 6. CLI、报告与门禁

```sh
npm run check:architecture
node scripts/check-architecture.js --against <commit> --json <absolute-output-path>
```

`--root` 仅供测试 fixture 或离线快照，显式路径；普通 npm 命令锁定 repository root。JSON 输出只有用户指定才写；目录必须存在，失败报告非零，不把“报告写失败”当架构通过。

```js
{
  schemaVersion: 1, factBaseline, policyComparedWith,
  policyHistory: { roots, commitsExamined, distinctPolicyBlobs, bootstrapCommit,
    historicalActiveIds, historicalRetiredEntrypoints, appliedPolicyChanges,
    historyRepairsApplied },
  coverage: { scannedFiles, parsedFiles, literalEdges, workerEdges, globalEdges,
    unresolved, dynamicSites, pendingBoundaries, partialBoundaries },
  violations: [{ rule, from, to, line, column, message, dependencyPath }],
  matchedExceptions: [], staleExceptions: [], activeBoundaries: [],
  limitations: ['runtime IPC/callback/object mutation not fully proven']
}
```

列表、诊断、路径排序稳定，不在内容中掺时间戳保证相同输入可比；证据保存者可另记录运行时间。stdout 默认只打印摘要、失败/例外位置和待激活列表，不输出 2,000 多条全图。成功 0，违规 1，输入/解析器/配置/写报告失败 2；release-check 保留所有非零退出。

package scripts：`check:architecture = node scripts/check-architecture.js`；`release-check = npm run lint && npm run check:architecture && npm run smoke && npm run test:unit && npm run test:integration`。CLI 从 `ARCHITECTURE_BASE_REF` 读取 CI 显式对比提交，命令行 --against 优先；输入只传给 git 参数数组，禁止拼进 shell。

现有 build-windows/release-windows 在 release-check 步骤设置该变量，PR 为事件 base.sha，main push 为 before，tag/manual 为 checkout 后解析得到的 HEAD；历史底线无关闭选项且始终运行。当前两个 workflow 已使用 fetch-depth: 0，保留该要求并验证 factBaseline/事件提交可读取，不由 scanner 网络 fetch。不得更改已有 tag/main 守卫及 v3.2.1/BizOP 等专项门禁条件。测试 root 使用真实 fixture Git 历史；普通模式不能用 fixture 参数绕过历史要求。

## 7. 测试设计与负向用例

在 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/architecture/` 拟新增：

| 文件 / 用例 | 必须断言 | Spec AC |
|---|---|---|
| `scan.test.js`：CJS/ESM/re-export/dynamic literal/模板/alias/shadowing | 路径准确，遮蔽变量不当真实 require，解析错误失败，结果排序稳定 | G8-AC-01、G8-AC-08、G8-AC-13 |
| `scan.test.js`：worker path.join/URL/const，computed loader | 可解析目标形成边；未知加载非静默忽略；大小写/越界/symlink 失败 | G8-AC-08 |
| `rules.test.js`：两文件环、自环、历史环扩大 | 输出具体路径，环数量相同但换节点仍失败；删除通过 | G8-AC-02 |
| `rules.test.js`：platform→helper→writer/Electron/fs | 传递闭包失败；同域纯 resource helper 与 crypto 合法 | G8-AC-03 |
| `rules.test.js`：xlsx→fs/yauzl 与 xlsx→旧 Position/Pending/Toolbox | IO 基础依赖合法，反向业务依赖失败；旧路径单向转发通过；新增生产 consumer→旧shim失败；无入边+证据退役允许，恢复入边失败 | G8-AC-15 |
| `rules.test.js`：lineage→row-mapper→normalizers→xlsx | 失败路径包含中间节点；新 content-hash→crypto/definitions 合法 | G8-AC-04 |
| `governance-rules.test.js`：G1 raw/worker recovery、隐式 prepare、跨域 BizOP 私有 API | 错误入口及经 helper 绕回失败；准确授权事务/owner gateway/合法装配通过；历史例外清零才 active | G8-AC-16 |
| `governance-rules.test.js`：G2 公共 executor/prepared scope→Position | 间接依赖/私有状态调用失败；领域 adapter 和 Main 注入合法；不能整文件禁掉 Main | G8-AC-17 |
| `governance-rules.test.js`：G5 raw DB、query facade、预览表命令 | collect/query consumer 绕回失败；get/create/bind 合法操作通过；未解释 alias/动态 SQL 失败 | G8-AC-18 |
| `governance-rules.test.js`：G7 runtime→catalog/domain 与显式 composition | 公共反向依赖失败、合法装配通过；旧常量兼容桥未删不能 active | G8-AC-19 |
| `renderer-boundaries.test.js`：总 state/API 注入、私有局部 state、跨域 global、漏 script | 前两类有区分，错误顺序/未加载/反射失败，正确 factory 参数通过 | G8-AC-05、G8-AC-10 |
| `renderer-boundaries.test.js`：modalRoot innerHTML、alias append、普通 row.remove | 新 root 写入失败，普通 DOM 不误报，旧准确条目只豁免一个位置 | G8-AC-06 |
| `policy.test.js`：删除边/旧例外/新增宽匹配/路径改名 | stale 诊断，新增路径不得继承，拒绝无原因例外/通配 | G8-AC-07 |
| `policy.test.js`：pending/partial/active/退回 pending | absent 明示 pending；出现即检查；active 缺入口失败；against-base 倒退失败 | G8-AC-09、G8-AC-14 |
| `policy-history.test.js` + `cli.test.js`：真实 Git S0/S1/S2、PR/push/tag/manual/local 参数 | 首次完整配置通过；不同事件都拒绝 S2；S1 同范围/merge 父链不漏；缺配置/历史/错误来源不变 bootstrap | G8-AC-20 |
| `policy-history.test.js`：合法改名链、未授权放宽、S3 恢复、retired 复活 | 精确链和替代入口有效才允许迁移；active id 不准删除/改名；清空保护scope/受限operation或扩装配仍失败；当前恢复底线可通过，保留历史记录 | G8-AC-21 |
| `policy-history.test.js` + `cli.test.js`：历史语法损坏与准确重建 | 无 repair 保持失败关闭；精确 blob/hash/schema/evidence 才使用重建，已知底线继续生效；错配/空快照/有效配置旁路/后续削弱绑定/merge 冲突均失败，local/PR/push/tag/manual 同机制 | G8-AC-22 |
| `rules.test.js`：不变合同的函数名/空白调整与真实越界对照 | 合法重排不误报；真正跨域依赖失败，不要求测试镜像源码文本 | G8-AC-12 |
| `cli.test.js`：0/1/2 退出码、JSON、只读、无网络 | 检查前后 tracked 文件哈希一致；加载器不触发 fixture 内副作用；环境变量参数安全，报告含覆盖盲区与 pending 计数 | G8-AC-11、G8-AC-13、G8-AC-14 |

baseline parity 测试以冻结 fixture 或明确只读 Git 快照调用 scanner，不把实时 main 的文件数硬编码为永久 685。仅最初验明共同口径；后续文件数合法变化不失败。

G1–G7 的真实生命周期、资源、查询、描述符及 lineage 行为测试由对应分支实施；本分支不为了扫描器把所有源码字符串测试删除。对本分支新测试，改 fixture 局部函数名/空白/文件组织且合同不变应继续通过，模拟越界依赖必须失败（G8-AC-12）。

## 8. 实施阶段、兼容与回退

1. **A 基础扫描：** 固定 v3.2.9 快照校验共同口径；实现 parser/resolver/SCC/报告和 scanner 正反例，不接门禁前先消除已知误报。
2. **B 规则/历史：** 落地本稿全部十二条规则、合法装配、准确旧例外、动态/生成合同及 policy-history；G1–G7 未迁移部分保持 pending，出现即检查。逐条正反例和真实 Git 三提交测试通过。
3. **C 门禁：** 添加 acorn 直接依赖、npm 命令和真实 CI 参数；验证 bootstrap 与各事件历史底线不可旁路，再以完整 release-check 证明 baseline 合法代码不被门禁错误拒绝。
4. **D 随治理收缩：** G1 全恢复入口、G2-T5、G3 R1/各域、G4 XLSX、G5 Q1–Q3、G6 contract、G7 最终装配在自己的实现变更更新 activation/consumer/evidence 清单、删除准确历史例外；release 集成检查最终状态与实际分支一致。

正常扫描无源码写入、无数据迁移、无执行时开销。回退 C 时必须说明为什么检查不适用并保持其他已激活行为测试，不通过吞错让 release-check 看起来通过；回退配置与代码一并成套 review。本轮文档交付未运行上述测试或改动依赖。

## 9. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
