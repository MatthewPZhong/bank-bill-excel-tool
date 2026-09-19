# v3.2.9 候选包人工验收清单

日期：2026-09-19。发布状态见 [release.md](release.md)，本轮审查及自动证据见 [release-review-2026-09-19.md](release-review-2026-09-19.md)。

本文件是待执行清单，**没有任何人工或 Windows 性能项目被预先判为通过**。草稿 [PR #239](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/239) 保留本轮全部功能。旧候选 `af58af73` 的 Windows 检查/构建已通过，但新增 RSS 指标修订与按行拆分准入修复后，须使用新候选的检查、包身份及人工记录；旧失败和通过记录均保留历史，不充当新候选证据。自动检查、性能采样、安装包操作及 Excel/WPS 人工核对分别记录；源码脚本通过或安装包成功生成均不代替人工验收。本文件不另行改变各模块需求、资源门槛或发布合同，RSS 合同修订以已同步的 Spec/TechDoc 为准。

## 1. 候选身份、环境与证据

| 字段 | 本次记录 |
|---|---|
| 最终候选 commit / 工作树状态 | 待补；使用完整 SHA，不以浮动分支名替代 |
| release → main PR | [PR #239](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/239)，草稿，待必要验收完成 |
| Windows Setup 候选包 / SHA-256 | 待补链接及摘要 |
| Windows portable 候选包 / SHA-256 | 待补链接及摘要 |
| 最终候选 release-check 日志 | 本轮 RSS/准入修复内容 PASS / exit 0；8100 单测 PASS、4 Windows SKIP、0 FAIL；60 个集成脚本全 PASS，报告计数2579/2579；[本地摘要](../../logs/verification/release-v3.2.9/rows-admission-fix/verification-summary.json)。实际 Windows 包与候选 SHA 另绑定 |
| 测试者 / 复核者 / 日期和时区 | 待填 |
| Windows 版本、build、架构 | 待填，不写“最新版” |
| CPU / 物理内存 / SSD 型号与文件系统 | 待填 |
| 输入、数据库、临时和输出所在卷 / 测前测后可用空间 | 待填 |
| Node / Electron / ExcelJS / lockfile 身份 | 待填实际版本及候选身份 |
| Excel 版本、build、位数 / WPS 版本、build、位数 | 分别填写；未安装或未测试者明确 `NOT_RUN` |
| 显示器分辨率 / Windows 缩放 / 应用 viewport / DPR | 待填，截图另记实际像素 |
| 人工记录、截图/录屏、输入输出样本与哈希清单 | 待补证据目录或链接 |

- [ ] 在专用 Windows 测试用户或可恢复的测试 VM 中安装候选，使用合成或经许可脱敏样本、独立应用数据和独立文档目录；不对生产库或真实工作文件试删。先保存测试环境快照。
- [ ] 分别记录 Setup 安装运行和 portable 运行的实际身份；没有执行的包型保持 `NOT_RUN`。打开应用确认显示 v3.2.9，并将包哈希与构建 commit 对上。
- [ ] 在隔离环境完成 v3.2.8 安装版 → 本候选安装版升级，核对版本、已有设置和数据保留；执行包含 SQLite 主库、WAL 与 SHM 的一致备份及恢复演练，记录备份方式与恢复后实际结果，不将拷贝单个主库当作完整备份。
- [ ] 在重启后的真实应用内执行下列人工项；不能只打开 HTML 原型、使用 mock API 页面或把脚本直接调用 Service 当成完整 Main 界面验收。
- [ ] 每项保存“输入说明/哈希、操作步骤、预期、实际、结果、证据路径、测试者”。失败保留原始证据；修复后注明新候选身份和受影响复验范围，不覆盖原失败记录。

可在 PowerShell 中记录测试包和输出摘要：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "C:\验收\候选安装包.exe"
Get-FileHash -Algorithm SHA256 -LiteralPath "C:\验收\本次输出.xlsx"
```

上例路径由测试者替换为本次测试文件。完整业务数据、真实账号及内部路径不提交到公开仓库；仓库内放脱敏记录与获准的样本。

## 2. 合同索引

| 功能 | 依据及本清单重点 |
|---|---|
| BizOP 自动错误报告 | [Spec](codex/v3.2.9-biz-op-error-report-auto-save/Spec-v3.2.9-biz-op-error-report-auto-save.md) FR-01～08、AC-01～18；[TechDoc](codex/v3.2.9-biz-op-error-report-auto-save/TechDoc-v3.2.9-biz-op-error-report-auto-save.md) §8.3 Windows 页面、原生对话框和 Excel/WPS |
| 按模块存档期限 | [Spec](codex/v3.2.9-archive-retention-by-module/spec.md) §1～3；[TechDoc](codex/v3.2.9-archive-retention-by-module/techdoc.md)：14 项设置、保存竞争、历史期限及窗口/缩放 |
| 存档永久删除 | [Spec](codex/v3.2.9-archive-center-permanent-delete/spec.md) §5、§8 AT-01～24；[TechDoc](codex/v3.2.9-archive-center-permanent-delete/techdoc.md) §10.3～10.4：真实占用、权限、退出重试和 `managed-only` 边界 |
| 定时深色模式 | [Spec](codex/v3.2.9-night-mode/spec.md)“验收”；[TechDoc](codex/v3.2.9-night-mode/techdoc.md)：原生时间输入、启动/唤醒、背景和真实显示器 |
| 工具箱按行拆分 | [Spec](codex/v3.2.9-toolbox-split-by-rows/spec.md) A01～A35，特别 A22/A23/A33/A35；[TechDoc](codex/v3.2.9-toolbox-split-by-rows/techdoc.md) §8.6：Windows、Excel、WPS、容量证据分离 |
| VCC 多 Sheet / 待确认表 | [Spec](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_Spec.md) AC01～AC30、RV01～RV13；[TechDoc](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_TechDoc.md) §8.3.2、§12.4、RV12：Windows 安装版、Excel/WPS、PF01～PF05 |

历史文档中冻结的旧运行结果或未执行表格不自动成为本次结果；使用最终候选的证据。历史版本的人工签字不能代签 v3.2.9。

## 3. 自动证据与 VCC 性能采集（由验证负责人执行）

### 3.1 已有入口与不可替代的边界

`scripts/vcc-financial-op/verify-review-performance.js` 已提供 PF01～PF05 的场景入口。它调用生产 Review IPC handler、Service、原 Review Worker、E/A 清单、Writer 和 X 回读验证；原生另存为是替身，未启动完整业务 Main 冷启动，也未通过安装包加载 ASAR。

样本工作簿使用生产读取/导入/计算逻辑；Archive batch/artifact、上月归档余额及已保存调整由合成夹具直接建立。PF03 的 10,000 条调整会经生产结果读取校验，**不代表逐条人工调整命令或 UI 保存性能已验收**。样本生成耗时与待确认导出耗时分开记录。

以下缺口必须继续标记 `NOT_RUN`，不能因 runner 的 `automated: PASS` 或某一子项退出码为 0 而勾选完成：

| 项目 | 当前采集能力与缺口 |
|---|---|
| 导出宿主进程峰值 RSS | 2026-09-19按用户委托修订为TechDoc §12.4.1 `host-process-rss-v1`。Main与worker_threads共用PID，独立采样线程只计一次进程RSS；准备另进程退出后新启测量宿主。两规模绝对峰值差及基线校正增长差均≤256 MiB，基线漂移≤32 MiB；缺原始采样、身份或覆盖不得PASS，heap/external不替代RSS。旧独立Worker RSS项由本明确修订取代。 |
| SST 字典压力 | 当前合成输入使用 inline strings，没有非空 shared-string 字典；高基数文本不等于 SST 压力。缺失指标为 null，不能当 0 或通过。 |
| PF04 上游停止/恢复读取 | runner 已检查实际 SheetStream drain 阻塞时 SQLite pageRows 游标不前进、输出恢复/drain 后游标再推进；原 XLSX 提取在此之前已完成。采集能力不等于最终 Windows PF04 已通过。 |
| PF05 真正 drain 等待 | `cancel-drain` 已检查真实 SheetStream drain 等待中取消、无输出恢复依赖、源游标及句柄关闭；本机合成 10,000 行补充实测通过，正式 Windows PF05 仍 NOT_RUN。其他取消点仅在真实阶段入口，未覆盖各阶段内部所有边界。 |
| 人工、原生和安装版 | Excel/WPS 打开、真实另存为/占用/覆盖、真实界面忙态解除、安装版及完整 Main 冷启动均不能由此脚本代替。 |

### 3.2 固定机器与执行命令

正式 PF 基准使用 **Windows x64、16 GiB 内存、SSD、本地同卷**，Electron **36.9.5**、ExcelJS **4.4.0** 和最终候选锁定依赖。记录实际 CPU、Windows/Excel/WPS 版本、可用空间、完整构建 SHA 和全部采集/比较脚本的摘要。两种 PF01 规模必须在同一机器、同一构建、相同启动条件下执行。runner 的 15～17 GiB 检测范围仅容纳操作系统报告差异，不能把 32 GiB 或其他配置写成规定基准。

在与候选包同一提交的干净验收源码副本准备依赖；`src/`、`assets/`、package 文件不能有已跟踪或未跟踪改动。不要在已完成的证据目录继续覆盖运行。下列命令均由测试者执行，本清单创建时未运行。

```powershell
Set-Location "C:\验收源码\bank-bill-excel-tool"
npm ci
git rev-parse HEAD
git status --short
node -p "JSON.stringify({node:process.version,electron:require('electron/package.json').version,exceljs:require('exceljs/package.json').version})"

$v329PfRoot = Join-Path $env:TEMP ("v329-pf-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $v329PfRoot | Out-Null

# 小样本先检验采集器能运行；不代表大规模或人工验收。
node scripts/vcc-financial-op/verify-review-performance.js --mode smoke --output (Join-Path $v329PfRoot "smoke")
$v329SmokeExit = $LASTEXITCODE
Get-Content -LiteralPath (Join-Path $v329PfRoot "smoke\summary.json")

# 固定 Windows 基准上采集完整 PF 场景；可能耗时较长，避免并行负载干扰。
node scripts/vcc-financial-op/verify-review-performance.js --mode windows --output (Join-Path $v329PfRoot "windows")
$v329WindowsExit = $LASTEXITCODE
Get-Content -LiteralPath (Join-Path $v329PfRoot "windows\summary.json")
```

单项复验可使用新的输出目录，例如：

```powershell
node scripts/vcc-financial-op/verify-review-performance.js --mode windows --case pf02 --output (Join-Path $v329PfRoot "pf02-rerun")
node scripts/vcc-financial-op/verify-review-performance.js --mode smoke --case cancel-drain --output (Join-Path $v329PfRoot "cancel-drain-smoke")
```

允许的正式 case 为 `pf01-100k`、`pf01-1m`、`pf02`、`pf03`、`pf04`、`cancel-prepare`、`cancel-extract`、`cancel-write`、`cancel-readback`、`cancel-drain`、`cancel-publish`。PF01 比较应在一次完整采集中保留两种规模；单独一项不产生两规模判据。

| 退出码 | 正确处理 |
|---|---|
| 0 | 小 smoke 自动检查通过，或所选正式单项已满足脚本声明的子项；继续查看 summary/evidence 的 `NOT_RUN`。单独 PF02 的 0 不等于整版验收通过。 |
| 1 | 自动断言失败、进程异常/信号退出或附加进程 RSS 预算失败；保存日志，先定位，不能勾选通过。 |
| 2 | 已生成记录但仍有 `NOT_RUN`。环境不符时不生成大样本；整套执行后也可能因宿主RSS配对身份/采样不足或其他缺口返回 2。不得改记为验收 PASS。独立 collector 工作流可将“证据已收集”记为成功，但必须保留 NOT_RUN，不代表发布门禁通过。 |

证据必须保留 `summary.json`、各 case 的 `config.json`、`fixture-preparation.json`、`fixture-run.log`、`evidence.json`、`process-rss.jsonl`、`run.log`、合成输入/输出及 SHA-256；缺少原始准备记录或原始采样不能复算为PASS。文档中的“采集完成”与“验收通过”分开填写。自动全仓门禁引用最终候选 `release-check` 日志即可；没有新变更、失败或疑点时不为填写本清单重复运行。

### 3.3 PF01～PF05 完成条件

- [ ] **PF01 / RV12**：100,000 与 1,000,000 行，保持文件数、主体数、差异坐标、结构和 Sheet 数相同；长 ID、高基数文本、Pending 双币种均被保留，E/A/X 一致。取得符合host-process-rss-v1的两例原始JSONL及独立复算结果，绝对峰值差与基线校正增长差均≤256 MiB，基线漂移≤32 MiB，固定元数据/构建/环境相同。准备隔离、500ms采样目标与750ms最大间隔、起止覆盖均通过才可勾选；旧样本不可追认为本合同PASS。
- [ ] **PF02**：一组恰好 1,048,576 条数据，真实输出 1,048,575 + 1 两页，各页恰有表头；顺序、身份、其他正常组及系统 OP 固定预期均完整。保留分页边界行和完整清单。
- [ ] **PF03 / AC30**：200 主体、至少 500 个有数据附页、10,000 条已保存调整；完整生成及回读，Excel 和 WPS 分别核对主体、调整、长表名、批注、引用与打印。元数据占用单列，不以 PF01 的固定元数据假设解释它。当前人工部分 `NOT_RUN`。
- [ ] **PF04**：百万行、1 MiB/s 限速及一次暂停；观测各 XML/ZIP/输出队列、行批次、SST、暂存和句柄。验证输入批次 ≤512 行或4 MiB、单行 ≤16 MiB、活动 XML/ZIP 队列8 MiB且至多一条单行瞬时超额、SST64 MiB及固定句柄边界；证明停写时上游停止读取，恢复后无丢行或无界 Promise。当前 SST 字典压力与上游停读证明 `NOT_RUN`，不能仅以峰值 ≤24 MiB 代替全部条件。
- [ ] **PF05**：准备、提取、写入、回读阶段分别取消；补充真实 drain 等待且输出停写的取消证据。记录请求、Worker 收到、停止读取、游标/连接/句柄关闭、暂存清理、UI解除忙态时间；取消不依赖慢盘恢复。最终保存保护阶段完成提交或回滚后收口，不强杀。当前阶段入口/输出暂停探针不覆盖全部内部边界，缺口保持 `NOT_RUN`。

每500 ms采样；没有采到或不能独立归因的值填 `NOT_RUN`/null。另记录基线、峰值、各阶段耗时、输入/输出/暂存字节和每个物理文件扫描次数。不能缩小规定样本、调大预算或用其他机器结果替代固定基准。

## 4. 候选包人工操作

### 4.1 业务 OP 自动错误报告

- [ ] **B01 / AC01～04、18**：进入、失败后重进模块，确认没有“导出错误报告”和已提交任务取消按钮；导入/运行/导出/删除执行期间防重复提交，结束后恢复控件及焦点。真实文件选择、日期选择、删除确认、取消选取、普通另存为仍可取消，取消前置对话框不提交任务。
- [ ] **B02 / AC05～10**：分别导入真实结构的合成 OP 和 FLOW 异常 XLSX，不手工选择保存位置；得到本次报告，页面同时显示原业务失败和报告保存状态。实际路径在应用的文档根目录 `error-reports/本地日期/`，中文文件名、长路径可读；两次独立导入不覆盖，后一次不显示前一任务路径。
- [ ] **B03 / AC08～09**：在 Windows Excel 或 WPS 打开报告，记录实际软件版本。核对“导入错误报告”“核对说明”、原始定位、样本及文件级错误；对样本截断、扫描不完整和非精确计数的专用样本，说明必须真实。没有修复文件提示，不把文件存在或截图当成内容正确。与同诊断基线 ERRORS 的自动逐格证据一并保存。
- [ ] **B04 / AC11～15**：成功导入和取消选文件不产生空错误报告。使用专用测试目录复核权限/占用等保存失败，原业务错误仍保留；“保存失败”“发布待核验”“已保存但存档未决”按真实情况分别显示。恢复只收口原任务，不重复生成；尚未开始的自动保存不承诺强制退出后补导。

### 4.2 按模块存档期限

- [ ] **R01 / Spec §1、§3.1～3.3**：默认配置及13个业务模块+工具箱共14项均可选30/60/90/180/365天或永久；模块可“跟随默认”。测试独立永久、独立30天和继承，重启后回读；改变一个模块不改其他模块，已有自定义默认值不被重置为60天。
- [ ] **R02 / Spec §2、§3.4～3.5**：分别记录修改前的历史批次、已预约批次和新建批次到期日；新值只影响后续新批次。到期当天仍保留，永久/锁定/业务引用/恢复保护不因期限变化解除。到期清理不删除外部原件及另存副本；检查测试文件实际哈希。
- [ ] **R03 / Spec §3.6**：快速连续修改、保存中返回/关闭、切换模块、保存失败与再次打开；最后成功值正确，保存期间关闭/模块切换保护有效，迟到回包不修改已关闭页。真实 Windows 下覆盖1080×760、1240×860与100%/125%/150%缩放，保存截图和viewport/DPR。

### 4.3 存档永久删除

本版范围固定为 `managed-only`。以下仅对专用合成批次执行；不会删除外部导入原件、正常外部输出或用户另存副本，也不级联清空业务数据。

- [ ] **D01 / AT01～05、16、24**：各取普通业务模块和工具箱批次，包含多个输入及输出。预检前和取消确认后文件/批次不变；确认框不含被要求删除的旧整句。确认永久删除后，真实受管独占文件和正常批次入口均消失，详情与统计刷新；外部原件、外部输出、另存及无关同名文件 SHA 不变。
- [ ] **D02 / AT06～07、20、22～23**：锁定、活动任务、业务引用或恢复未收口时拒删；两个批次共享内容时删一个不破坏另一个。未知或归属证据不足文件不能猜删；先恢复原任务/迁移，不通过手工解锁内部保护或清空数据库绕过。
- [ ] **D03 / AT08～10**：真实 Windows 文件独占和测试目录权限不足时，不报完整成功。若批次已删除而文件未清理，出现可定位的“待完成删除”；关闭占用/恢复测试权限后可重试。离线存储根不能被当作全部文件已缺失。
- [ ] **D04 / AT13～15、18～19**：在专用可恢复环境中验证清理中退出、重启与重复请求；计划和证据不丢，批次不复活，号码不复用，已提交业务动作不重跑。迁移journal或原 owner 后处理未完成时仍阻止新删除；困难故障点由验证负责人配合自动夹具和真实环境复核，未做者保持 `NOT_RUN`。

Windows 独占文件可用第二个 PowerShell 窗口辅助复现。先确认路径是本次合成批次的受管测试文件：

```powershell
$v329LockedTestFile = Read-Host "本次合成批次的受管测试文件完整路径"
$v329LockHandle = [System.IO.File]::Open($v329LockedTestFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
try { Read-Host "保持窗口，完成应用内删除失败检查；回到此处按 Enter 释放占用" }
finally { $v329LockHandle.Dispose() }
```

记录删除前后实际路径、文件身份/哈希、批次ID和待清理状态；不能用 macOS 上“打开文件仍能unlink”的结果代替 Windows。

### 4.4 定时深色模式

- [ ] **N01 / Spec 功能、验收**：真实候选“设置→外观设置”位于导航末项，默认关闭、18:30–06:00。使用鼠标、Tab和原生分段时间键盘连续输入；有效值保存并重启回读，非法或起止相同不保存。慢保存时继续编辑、开关排队后输入新时间、关闭设置再重进均不丢新值；失败保留已保存配置和主题，并显示原因。
- [ ] **N02 / Spec 验收**：在测试VM记录18:29/18:30/23:59/00:00/05:59/06:00，以及同日时段；含开始、不含结束。运行跨边界、睡眠唤醒、聚焦、系统时间/时区变更后正确校正；系统外观偏好不接管主题。关闭立即浅色并保留已保存时段；测试后恢复测试机时钟。
- [ ] **N03 / Spec 验收、TechDoc**：深色时冷启动和重载无浅色闪屏；默认/纯色背景进入深色底色，返回浅色恢复颜色；自定义图片、背景草稿、保存与删除不受主题切换破坏。检查本版六功能页面及代表弹窗的焦点、禁用和差异标记，不把深色主题写入Excel导出。
- [ ] **N04 / Spec 2560×1440补充**：真实显示器覆盖1080×760、1240×860、2560×1440及100%/125%/150%缩放，记录实际viewport/DPR/截图像素。窄布局无横向遮挡，时间完整可见；离屏截图通过不代替真实显示器通过。

### 4.5 工具箱按行拆分

- [ ] **T01 / A01～A08、A19～A20**：字段值浮层打开时勾选“按行拆分”，浮层关闭且字段/值/旧多文件入口禁用；N默认空，合法正整数才可完成，`00010`规范化为10；0、负数、小数、指数和混合文本拒绝。切换模式保留本弹窗草稿，新文件重置；双击不重复提交。
- [ ] **T02 / A09～A18**：使用多Sheet、隐藏Sheet、重复首行表头与空行的合成表，R=2501/N=1000生成1000/1000/501条，跨Sheet连续、不重复计表头。拼接输出与有效行同序一一对应；R=0拒绝，R=N/R<N无尾空文件。旧字段单文件/最多8组方式保持原行为。
- [ ] **T03 / A22～A25、A35**：最终候选实际完成K=1/8/9/999/1000的生成与发布，不能只看规划器。R=1001/N=1拒绝并建议N≥2；长路径和警告列表（含K=30及1000）可滚到底，警告和确认按钮可见。资源不足按失败记录，不将九份/千份正向失败记通过。
- [ ] **T04 / A16、A30～A34**：取消原生目录选择、拒绝覆盖不创建输出；中文路径与同名文件正常确认。确认期间或生成后由第二窗口新建/替换目标，原未经确认的新对象不被覆盖。真实Windows占用/权限失败及受控发布中断保持旧目标或给出恢复路径；恢复不重新生成或重复结算，不移动内部备份/journal来掩盖失败。
- [ ] **T05 / A13、A33**：Excel和WPS分别打开保真样本，核对表头、长编号/前导零、日期、布尔、错误值、文本、行列布局和支持范围内的样式；检查首/中/末输出及续Sheet样本。完整逐行/逐文件一致性采用自动回读证据，人工打开结果另记，不能相互替代。已知降级提示仍可见；CSV/XLS超过64 MiB的拒绝与先转XLSX提示正确。

### 4.6 VCC 多Sheet、待确认导出、存储v3

- [ ] **V01 / AC01～09、RV01～04**：真实应用导入单页、同类型多页、混合类型、隐藏页与说明页；逐页展示定位，说明页须明确排除，坏表头/旧Pending/独立多表块不能借排除绕过。同文件不同通道页填不同主体并重启核对来源；九币种须同Sheet完整，不能跨页拼凑。部分组失败/取消/恢复明确保留已提交组，不宣称整批回滚。
- [ ] **V02 / AC10～16、24**：单主体和多主体结果确认页左下角“导出待确认表”，没有主体选择步骤；真实原生另存为默认`YYYY-MM_VCC财务OP校验待确认表.xlsx`。取消、成功、失败均留在确认页；未归档结果为“待确认”，归档后“已归档”，解归档后又“待确认”；导出不等于归档，正式结果出口仍只导出已归档结果。
- [ ] **V03 / AC12～20、RV08～09、RV13**：Excel、WPS各自核对Sheet1与确认页全部主体、十四列、明细/调整/汇总顺序、提示、M/N调整证据；检查A1版本批注。零差异恰好一张Sheet；有差异附页保留正确来源，Pending双币种分流、同组不重行，合法零金额不丢。核对长ID、前导零、高精度金额、普通`=...`文本、日期、历史结构、表名截断后批注和续页，不把公式重新计算当正确值。
- [ ] **V04 / AC21～23、RV05～07、RV11**：真实原生覆盖确认、目标被Excel/WPS占用、中文/长文件名、权限不足及受控失败；无假成功，旧目标不变或可恢复路径明确。尝试受保护目标时拒绝且文件不变；结果/输入变化后拒绝旧快照发布。业务DB只读证据与页面状态一起保存，不能只看输出文件。
- [ ] **V05 / AC25～29、RV10**：在含合成历史数据的v2副本升级候选，记录v3合同和迁移前后业务/来源/结果/调整守恒；保留旧来源兼容，混合文件只冻结一次。旧程序不得写v3；非空v1不在普通启动清空。提交前失败与提交后连接初始化失败分别核验，不手改marker降级；回退仅用符合合同的程序或升级前完整测试备份。
- [ ] **V06 / AC27～30**：从真实Windows候选包运行正式结果导出和待确认导出，验证实际ASAR内置模板、原生保存、覆盖/占用及Excel/WPS打开。源码Electron/ASAR专项日志作为补充，不能替代已安装候选运行。
- [ ] **V07 / AC30、RV12**：将第3节完整PF原始数据和Windows安装版/Excel/WPS人工记录一起交付。host-process-rss-v1配对验收、SST、真实drain或任一必须项仍未完成时，本项保持未勾选；不把小样本、其他机器或仅RSS单项通过写成全部通过。

## 5. 结果填写与验收结论

每项结果使用 `PASS / FAIL / NOT_RUN`；只能在预期成立且有证据时勾选。某软件、包型、窗口/缩放或故障分支未运行就单列，不用一张“整体通过”截图覆盖缺口。

| 项目ID / 包型 / 环境 | PASS / FAIL / NOT_RUN | 实际结果与证据链接 | 测试者 / 日期 |
|---|---|---|---|
| 本地完整门禁 | PASS | 修复提交 `30317ee5`：单测 7,864/0/3 SKIP、59 集成脚本 2,575/2,575；真实 drain 取消 43 ms 的本机补充验证通过，内容覆盖见 [修复摘要](self-review-2026-09-19/runtime-repairs-summary.json) | 2026-09-19 自动检查 |
| 最终 PR Windows CI / 候选包 | NOT_RUN | 待补最终 head 的日志及候选包 | 待填 |
| B01～B04 | NOT_RUN | 待填逐项记录 | 待填 |
| R01～R03 | NOT_RUN | 待填逐项记录 | 待填 |
| D01～D04 | NOT_RUN | 待填逐项记录 | 待填 |
| N01～N04 | NOT_RUN | 待填逐项记录 | 待填 |
| T01～T05 | NOT_RUN | 待填逐项记录 | 待填 |
| V01～V07 / AC30 | NOT_RUN | 待填逐项记录 | 待填 |
| PF01～PF05 / RV12 | NOT_RUN | 自动采集与缺口分别填写 | 待填 |
| Excel / WPS | NOT_RUN / NOT_RUN | 各软件版本与核对记录分别填写 | 待填 |

- [ ] 候选包、commit、日志和人工样本属于同一版本；修复后受影响项已在最终候选复验。
- [ ] 六功能适用人工项与AC30/RV12没有以模拟/历史结果替代的缺口；仍有失败或`NOT_RUN`时已列明，未宣称完整验收通过。
- [ ] 验收负责人填写结论、姓名、日期及证据链接；发布负责人据真实证据处理后续发布步骤。此清单本身不产生发布、合并或标签操作。

最终结论：**待执行、待补证据与人工签字。**
