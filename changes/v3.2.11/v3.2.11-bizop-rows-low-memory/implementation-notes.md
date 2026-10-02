# 实施记录 — v3.2.11 业务 OP 与按行拆分低内存适配

<!-- document-identity
 document-id: v3.2.11-bizop-rows-low-memory/implementation-notes
 target-version: v3.2.11
 branch: v3.2.11-bizop-rows-low-memory
 baseline: 18b82b4328cf5e00c1b2549d373a5b2f2677215c
 revision: R2
-->

> 分支：`v3.2.11-bizop-rows-low-memory`
> 基线：`18b82b4328cf5e00c1b2549d373a5b2f2677215c`
> 更新：2026-09-30
> 当前状态：完整本地实现与最终自动门禁已通过；Windows 真压力／安装包验收及生产低档启用待完成。用户已明确同意先完成本地实现并保留待验收项。
> 目标版本：v3.2.11；文档修订：R2。

正文需求见 [Spec](spec.md)，技术决策及实验参数见 [TechDoc](techdoc.md)。本文件记录执行事实，不复制业务规则。

## 1. 初版方案的历史交付记录

| 项目 | 结果 |
| --- | --- |
| 实时读取远端 main | 确认为固定 SHA；与前两轮 review 一致。 |
| 正式标签解引用 | v3.2.10 的附注标签目标与该 SHA 相同。 |
| 版本文档路径检查 | 固定 main 未找到 changes/v3.2.11；本任务按已明确多分支版本管理，不推断成单分支。 |
| 文档规则与格式 | 使用 save-spec 路径规则；Spec／TechDoc 分别参考仓库模板。 |
| 只读关键源码核查 | 复用同 SHA 已读内容，补读必要入口；范围与来源见基线证据，不宣称全仓审计完成。 |
| 默认预算算例 | 按源表达式重算结果一致；不是调用完整应用或 Windows 实测。 |
| 方案文件 | 生成 Spec、TechDoc、证据索引及本记录；打包保持唯一正文路径。 |
| 文档结构检查（初版记录） | 原记录为 UTF-8、代码块闭合、表格列数、内部链接／锚点、固定源码链接、24 项 AC／8 个切片及唯一正文目录检查通过。该结论仅限当时原包布局，不适用于重命名／分散后的 Downloads 文件；R2 另行验证实际交付包，见 §7。 |

## 2. R2 方案生成时未执行事项（历史记录）

未创建本地或远端 Git 功能分支；未编辑用户仓库；未提交、推送、开 PR、升版或合并。未执行仓库单测／集成／smoke／release-check，未运行 Electron，未生成安装包，未执行 Windows 低内存实机压测。

没有已测最低配置、速度提升比例或生产启用结论。低内存 profile 尚未实现和冻结，不填写虚构的 validatedEvidenceId。

## 3. 实施切片状态

| 切片 | 状态 | 说明 |
| --- | --- | --- |
| T0 | local_implemented | 28 个载体创建点（含 forkChild 别名）、默认 IPC 观察、Main 后台维护及旧 runtime 代次已纳入；入口表与遗漏负例见资源清点。Windows 运行覆盖仍待验收。 |
| T1 | local_implemented | 稳定账本、兼容上限、实时选档、可信配置、真实关闭与资格冻结机制已接入生产装配；低档资格仍 pending。 |
| T2 | local_implemented | v2 metadata／显式单字段 IPC、窗口 token、请求取消、Renderer 单组／多组懒加载已接通。65 MiB CSV 普通档真实 Worker 兼容用例通过。 |
| T3 | local_implemented | adaptive SST、metadata／单行预算、构造与关闭失败清理贯穿实际 reader。 |
| T4 | local_implemented | SQLite 样式 LRU、实际流消费背压、writer 关闭释放后回读、独立验证／发布阶段已接通。 |
| T5 | local_implemented | OP 导入、计算、六类导出、自动报告、发布、恢复、删除／升级配置贯穿；业务算法和恢复 journal 不变。 |
| T6 | local_implemented | grant 原子复核、反向排他、未知增长等待、定时重评、Base＋Phase 预检与兼容回归已实现。 |
| T7 | pending_windows | 本地合成完整链路与验收脚本已提供；用户暂无 Windows 环境，真实压力、最终构建、人工兼容验收和参数冻结保留待办。 |

切片内容和依赖仅在 TechDoc §十一维护，此处只更新状态／证据。

## 4. 待冻结事项

资源额度、系统余量、缓存组合与支持格式范围：未冻结，参考 TechDoc §三.5。

性能及 GUI 响应验收阈值：待基线建立后、验收前确定。不得用“资源用量降低”替代完整流程成功及可接受耗时。

重型入口、旧记录兼容及 writer 背压已按 §12 和 §13 接通并有本地回归；实机峰值和生产资格仍按 T7 冻结。

## 5. 后续证据记录格式

每次执行按下列结构记录，不预填结果：

```text
日期与执行人：
实现提交／构建 SHA：
切片／用例／对应 AC：
实际命令和环境：
源样本身份与特征（脱敏，不含业务正文）：
profileId／policyDigest／证据路径：
Windows／Electron／Node、总内存、磁盘及页面文件状态：
选文件前／grant 时／运行区间的可用内存：
各阶段峰值与总时长、事件循环／GUI 响应、取消响应：
结果一致性及完整性验证：
错误／清理／真实退出／恢复情况：
结论：pass / fail / not-run
偏离原方案的事实、原因与处理：
```

资源诊断不能包含账户金额、完整行、凭据或公共遥测中的绝对业务路径。需要调整业务范围时先更新 Spec；纯实现机制调整更新 TechDoc，不在日志中另设一套规则。

## 6. 2026-09-29 方案决策索引

本轮合并两轮 review 的补充项。特别将前置扫描、SST 默认数组、policy 外 OP I/O 配额和旧扫描 dispatcher 的真实退出问题纳入实施入口。

采用稳定账本与实时条件分离；资源未知增长不靠 RSS 估算放行；使用真实阶段边界，避免全链长锁造成发布／恢复自等待。所有正式参数以未来 T7 证据冻结为准。

本文件的“方案已交付”不等于功能“已实施／已验收／已合并”。


## 7. 2026-09-29 R2 审查修订与原下载交付（历史记录）

### 7.1 处理范围

只修改本次输出副本中的四份方案文档，并新增交付导航、清单和独立文档校验脚本；保留原附件及原 ZIP。不修改用户仓库或用户的审查报告，不创建／提交／推送 Git 分支。本轮固定提交补查范围为 rows contracts、Main 公共 read／rows prepare、rows prepare 的源预算，以及 Renderer 单组／多组值按钮；没有重新读取远端 main HEAD。

| 审查项 | 本轮文档处理 | 实现／验证状态 |
| --- | --- | --- |
| P2：64 MiB 限制外扩 | Spec P02／AC16 与 TechDoc §4.2 拆成公共安全、档位适用性和 rows 专属源预算；普通档字段路径不因 rows 阈值提前拒绝。 | 文档已修订；U16、I07 和代码待实施。 |
| P2：默认首字段补扫入口 | Spec AC08 与 TechDoc §4.1 明确首次激活值按钮才扫描，未请求可点击；单列／多组、空列／失败、去重及迟到响应分别约定。 | 文档已修订；U17、I08 和代码待实施。 |
| P2：散件相对链接失配 | 四份文档在一个独立分支目录使用规范短文件名；用精确文档身份、标题、修订号及 SHA-256 交叉验证，不只测文件存在。 | 本次交付包验证结果见 §7.2；不推断用户 Downloads 的当前状态。 |
| 实施观察：Bcompat 固定超限 | TechDoc §3.1—3.2 指定自身稳定上限、入队前过滤、不可满足即拒绝并继续 drain；T1／T6 增加 U14／U15。 | 文档合同已补齐；不是已运行的 Governor 测试。 |

保留审查的 P2 分类；不将文档修订表述成生产缺陷已修复。新文档仍为 propose，24 项 AC 编号和 8 个切片保持，增强相应判据而非重建另一套需求。T0 基线测量可按既定范围开展，本轮没有实际启动 T0 遥测或样本压测。

### 7.2 本次交付布局与校验

交付包名含 R2，四份规范正文只有一套，目标版本仍为 v3.2.11。正文分别带 document-id、target-version、branch、baseline、revision 元数据；包内 `document-manifest.json` 记录预期标题和 SHA-256，`verify-delivery.py` 检查解压后的实际目标。

本轮文档校验结果：四份正文身份与摘要、相对目标／锚点、UTF-8／代码块／表格结构、24 项 AC／8 个切片检查通过；ZIP 解压与移动目录后复验通过；缺失文件、同名错误文档、过期修订三种负例均被拒绝。具体计数见包根 delivery-validation.md。

上述结论只适用于本次 R2 ZIP 解压后的目录，外链仅核查固定源码链接的结构和 SHA，不宣称在线 URL 全部可访问。相对引用经过目标文件、锚点和文档身份核对；检查不包含用户未上传的 Downloads 文件。文档被合法后续修改后需更新清单并重新检查，不能继续引用旧摘要结果。

没有执行产品单测、集成、smoke、release-check、Electron／GUI、Mac 压力测试或 Windows 压测；256／384 MiB 等实验档和安全余量均未冻结。


## 8. R2 四文件独立下载交付说明（历史记录）

本次因 ZIP 无法下载，将原 R2 的四份正文分别交付。需求、技术方案、基线和文档修订号仍保持 R2；仅调整下载文件名与四份文档之间的相对链接，并追加本节交付说明。

四个文件应放在同一目录并保留下载名称：

| 规范仓库文件名 | 本次独立下载文件 |
| --- | --- |
| `spec.md` | [v3.2.11-bizop-rows-low-memory-r2-spec.md](spec.md) |
| `techdoc.md` | [v3.2.11-bizop-rows-low-memory-r2-techdoc.md](techdoc.md) |
| `baseline-evidence.md` | [v3.2.11-bizop-rows-low-memory-r2-baseline-evidence.md](baseline-evidence.md) |
| `implementation-notes.md` | [v3.2.11-bizop-rows-low-memory-r2-implementation-notes.md](implementation-notes.md) |

上文 §7 的短文件名目录、身份清单、校验脚本和摘要结果仅描述原 R2 ZIP，不表示本次四文件下载另附这些内容，也不将原摘要套用到更名改链后的副本。本次检查四份文件均为同一版本、分支、基线和 R2 修订，检查相对链接目标及显式锚点；除链接与本节外，正文与原 R2 保持一致。

仓库规范存放路径仍按原方案；未来将文件恢复为 `spec.md`、`techdoc.md` 等规范名称时，应同步恢复其相互引用。此次未修改仓库或执行产品测试。


## 9. 2026-09-29 仓库存放记录

按用户本轮要求，以当前本地 main 创建功能分支，存放已完成复审的 R2 文档。上文 §1、§2、§7、§8 保留原方案生成和下载交付时的历史记录；本节记录此次仓库存放事实。

| 项目 | 本次结果 |
| --- | --- |
| 功能分支 | `v3.2.11-bizop-rows-low-memory`，按用户指定名称创建。 |
| 分支起点 | 本地 `main@18b82b4328cf5e00c1b2549d373a5b2f2677215c`，与 R2 固定设计基线相同。 |
| 工作区 | 独立 managed worktree：`v3211-bizop-rows-low-memory/bank-bill-excel-tool`；开始存放前工作区干净。 |
| 规范目录 | `changes/v3.2.11/v3.2.11-bizop-rows-low-memory/`。 |
| 输入 | 本轮四份 `v3.2.11-bizop-rows-low-memory-r2-*.md` 下载文件，保存前核对其 SHA-256 与 R2 复审输入一致。 |
| 保存内容 | [spec.md](spec.md)、[techdoc.md](techdoc.md)、[baseline-evidence.md](baseline-evidence.md)、[implementation-notes.md](implementation-notes.md)。 |
| 适配 | 恢复规范文件名与相对链接；分支标识同步为用户指定名称；实施记录区分历史交付与当前存放。 |
| 业务与技术方案 | 沿用已复审 R2 正文；目标版本仍为 v3.2.11，文档设计修订号仍为 R2。 |
| 实施状态 | T0—T7 仍为 todo；本次没有启动低内存功能实现。 |
| Git 状态 | 文档已保存到功能分支工作区，未提交、未推送。原 main 工作区中的既有文件保留。 |

本次没有重新 fetch 远端，不将当前本地 main 表述为已实时核验的远端最新状态。仅进行文档身份、链接、锚点、结构、编号和差异核对；未运行产品单测、集成、release-check、Electron、Windows 压测或构建。

## 10. 开发记录

### 目标与边界

- Goal：按 Spec 的完整链路范围消除统一 1 GiB 申请造成的不可用，并保留可证明的资源和发布边界。
- Context：沿用本目录 R2 文档；本轮 save-spec 核对文件身份与摘要一致，直接复用，没有另建需求正文。
- Constraints：基于当前功能分支 worktree；保留业务算法、文件保真和恢复契约；不提交、推送或升版。
- Done when：按切片取得代码、回归及完整链路证据；Windows 容量未证实时不把实验档标为生产可用。

### Decisions

- 先建立可执行的资源采样、固定上限/实时判定与退出合同，再接入领域路径。新增能力默认不改变其他动作的运行策略；生产低档资格必须由最终证据支持。
- 旧 main 和下载附件保留。测试仅使用临时目录及合成文件，不使用真实业务数据库。

### 首批开发时的未知项（历史记录，当前状态见 §12）

| 项目 | 处理 | 当前证据／下一步 |
| --- | --- | --- |
| 所有重型入口及非受管工作增长 | PROBE | T0 枚举 Main、dispatcher、直接 lease 与 service；未闭合前不声明全局独占已经成立。 |
| 固定容量与当前资源不足的原子选档 | 已有组件证据 | 18 项 memory admission 测试与原 Governor/queue 回归通过；生产静态装配仍待接。 |
| 旧扫描 promise 早于 worker 退出 | 已有组件证据 | dispatcher 实际 exit 屏障；准备 owner 结果／退出分离、取消与失败；真实 Worker 集成已覆盖。 |
| writer 的消费完成信号和重叠峰值 | PROBE | 对锁定 ExcelJS 的写入链路及慢磁盘样本取证，不能以 highWaterMark 代替证明。 |
| Windows 容量与性能阈值 | PROBE | 当前开发环境为 macOS；本地逻辑与文件回归不能替代 T7 Windows 实机证据。 |

### Evidence

- 开发开始前：分支 `v3.2.11-bizop-rows-low-memory`，HEAD 为固定基线；仅四份未提交文档，无产品源码改动。
- 本地 Node 为 v25.8.0；Electron 自带 Node 与 Windows 测试环境另行记录，不能混用版本证据。

## 11. 首批开发与验证结果（历史记录）

### 11.1 工作区与实际影响

- worktree：`/Users/pzhong/.codex/worktrees/v3211-bizop-rows-low-memory/bank-bill-excel-tool`。
- 分支及 HEAD 仍为本文件头部标识；代码、文档和验证脚本均未提交、未推送。没有改主目录源码、下载附件或版本号。
- 已核对两目录 `package-lock.json` 一致。最初使用主目录 `NODE_PATH`；历史快照 gate 固定读取 worktree 的 node_modules，因此为本 worktree 创建指向现有依赖目录的本地 symlink。未安装或升级依赖，链接被 Git 忽略。
- 生产中立即生效的变化为旧拆分 dispatcher 等待真实退出，以及公共扫描关闭链可等待异步 reader。新 memory policy、metadata/单字段接口及 adaptive SST 在本批使用显式受控装配验证；尚未切换 Main 的生产拆分 UI。
- 生产 `ROWS_POLICY`、OP policies 和 OP 直接 I/O 的 1 GiB 额度仍未替换。因此原始低内存不可用问题尚未整体解决，不能作为用户发布版本。

### 11.2 已实现的组件

| 组件 | 实现及保护的不变量 |
| --- | --- |
| 资源包络与配置 | H 和 Bcompat 分开；完整 V1 配置严格校验并冻结；没有将缓存或 V8 上限当作阶段峰值。 |
| Governor | 固定不可满足在入队前拒绝；实际 grant 重新采样；普通／低档选择绑定到 lease；同账本排他、有限队列重采样、证据失效拒绝；保留 compound/replacement 净贡献。 |
| Main 采样 | 实际 `os.freemem()` 和时间戳；PID RSS 与线程 heap/external 分开；arrayBuffers 不重复求和。 |
| 准备 owner | 静态配额、5 秒测试等待、结果与 closed 分离、取消、清理与释放顺序；缺关闭事实保留租约。 |
| 旧 dispatcher | 增加独立 closed，promise 等真实 exit；构造／发送失败、异常退出不丢失关闭责任。 |
| 扫描组件 | metadata 无全字段集合，单字段有数量及字节预算，超限明确失败；共用 SPLIT 计数规则。 |
| Toolbox reader | 显式 adaptive SST，任务私有目录，strict close、ZIP 关闭等待、构造失败清理；旧缺省数组合同保留。 |
| 可执行证据 | [入口清点](resource-entry-inventory.md)、准备扫描探针、真实 Worker 接缝集成、核心架构能力负例。 |

T0 入口清点尚未闭合，因此本批提前实现的 T1/T2/T3/T6 接缝只在受控验证中装配。没有把实验成功转成生产 profile 资格。配置与接口的唯一技术说明见 TechDoc §十四。

### 11.3 本地验证

所有命令均在上述 worktree 执行；环境为 macOS arm64、Node v25.8.0。

| 检查 | 实际结果与范围 |
| --- | --- |
| ResourceGovernor、admission queue、memory admission、admission-only owner | `node --test` 四个对应测试文件，72/72 PASS；覆盖空兼容预算、后继调度、即时/排队采样、排他、取消/停机、真实关闭、compound/replacement、同步 provider 重入。 |
| Dispatcher | 新旧协议及真实 worker 扫描/导出测试通过，13 项；扩大回归再次覆盖当前源码。 |
| XLSX 原有格式／重复 ZIP／rich 关闭／消费方参数＋新 reader | 首轮 72/72 PASS；补充真实单列和 complete 空列后，新 reader 9/9 PASS。旧合同与新 opt-in 合同分别断言。 |
| 扩大回归 | 执行 background-execution 全部 25 个测试文件及相关 Toolbox IO/operations/path-matrix/rows/writer、OP phase/upgrade 调用方。仅历史快照 gate 因强制 NODE_PATH 失败；复用依赖链接后该文件 9/9 PASS。其他用例未出现产品失败。 |
| 依赖修正后的复跑 | 历史 manifest、最新 reader、核心架构负例合计 19/19 PASS。 |
| 新真实 Worker 接缝 | `node scripts/integration/toolbox-low-memory-foundation.js`：4/4 PASS；最终 Governor 改动后复跑通过。内存数值为明确注入的调度夹具。 |
| 现有 rows 准入／发布 | `node scripts/integration/toolbox-row-split-admission.js`：2/2 PASS；768 MiB 仍拒绝旧 1 GiB policy；足额时真实生成／发布，独立读回 2/2/1 行，输入与旧目标保护保持。 |
| 公共 XLSX 跨域 | `node scripts/integration/shared-xlsx-boundary.js`：52/52 PASS，覆盖 Toolbox、BizOP、Position、VCC 与真实关闭。 |
| 完整源码 lint | 通过现有 ESLint CLI 执行 `eslint src/`，退出码 0。 |
| 架构检查 | `node scripts/check-architecture.js` PASS：771/771 源文件、31 active、0 pending/partial；既有静态未解析统计为 2，不宣称无运行旁路。 |
| 差异／文档 | 最终交付前核查 `git diff --check`、文档身份与本地链接；证据输入摘要另存当前 manifest。 |

过程中的失败已纠正：

- 初次直接运行旧测试缺少 `jszip`，属于 worktree 依赖未就绪；锁文件一致后复用现有依赖。
- 新测试曾误用 `snapshot().queue` 和 yauzl 的不存在属性作为断言，分别改为 `queued` 和真实 close 事件后通过；未据测试辅助错误改业务语义。
- 初次架构检查拒绝核心依赖系统采样：改为 Main 注入，仅新增两个纯模块的准确能力登记及迁移依据。dispatcher 的匿名回调编号变化改用具名关闭回调解决，未扩大 worker 目标集或增加历史豁免。
- 复核增加 grant 前停机／取消和同步采样重入反例，均已通过。

本批没有执行完整 `release-check`、Electron GUI、Windows 压力／安装包、Excel/WPS 人工验收；不标注 PR-ready、已集成或已发布。

### 11.4 准备扫描实测

命令：`node scripts/verify-low-memory-workflows.js --rows 20000`。合成 XLSX 为 20,000 行、4 列，其中 3 列高唯一文本；每种模式使用独立子进程及真实 worker，50 ms 采样并覆盖创建前与 exit 后。

原始记录：[prepare-scan-probe.json](prepare-scan-probe.json)，包含实际加载源码摘要、依赖锁摘要、输入摘要和环境。`productionEvidence:false`，无空闲内存数字注入。

| 模式 | PID RSS 采样峰值 | 线程 heap 采样峰值 | 创建前至退出耗时 | 实际可用内存 min/median/max |
| --- | --- | --- | --- | --- |
| 旧全字段扫描 | 200.8 MiB | 70.7 MiB | 1.035 s | 820.1 / 820.9 / 916.8 MiB |
| 基础扫描＋adaptive SST | 152.7 MiB | 47.1 MiB | 1.495 s | 536.6 / 601.2 / 820.9 MiB |

两者返回相同表头和 20,000 行；新路径不返回字段值集合，任务 SST 已关闭清理。以上为本机一次小样本，测试期间可用内存变化且没有人为控制压力，不能据此冻结 512/768 MiB Windows 支持档或性能门槛，也不能把 V8 的 192/16 MiB 限制认定为完整阶段峰值。

### 11.5 当时的继续实施顺序（已由 §12 更新）

1. 补齐 T0 全入口活动观测及静态可信配置装配。
2. 接生产 metadata v2 Worker owner、按窗口 token/代次、Preload，以及值按钮触发的单列／多组懒加载；覆盖 64 MiB 检查作用域。
3. 收敛 rows 样式查询、真正 writer 背压、输出回读与发布峰值；完成 OP 各阶段和 policy 外直接租约的配置贯穿。
4. 完成全局屏障、嵌套借用与恢复兼容，再开展 Windows 完整压力／打包验收，按证据冻结并开启 profile。

以上保留首批交付时的未完成记录；本轮接续开发结果见下节，不再用此列表表示当前进度。


<a id="12-2026-09-30-完整本地实现"></a>
## 12. 2026-09-30 完整本地实现（审查前记录）

### 12.1 授权和交付边界

用户要求持续完成四份文档约定的开发，并明确答复“暂时没有，先完成本地实现并保留待验收项”。因此本轮交付是功能分支 worktree 内的实现、自动验证和可运行的验收工具。T7 的 Windows 真压力、安装包、真实业务与 Excel/WPS 人工验收继续待办；不据本地注入数字放开生产低档。

版本仍为 3.2.10，目标版本为 v3.2.11；未提交、推送、合并或发布。原 main 工作区及下载附件未改。

### 12.2 Decisions

- 目标阶段由静态 `memory-profiles.js` 映射到完整配置；Supervisor、直接 OP phase、prepare owner 和共享 Publisher 消费同一 Governor。保留 policy 中的 1 GiB 作为未取得资格时的兼容请求，已获资格的执行配置会在 grant 处替换它。禁止将兼容常量的存在误读为实验链路仍申请 1 GiB，也不能据实验链路通过声称生产低档已开放。
- 载体观察表由公共 `background-execution/memory-activity.js` 在 Main 统一维护，只用真实 `exit` 注销；领域 IPC 分类由 Main 适配层负责，公共 runtime 不回依赖领域。旧 runtime 活动 lease 继续参与；默认未知 IPC、启动清理、后台更新与定时维护也参加排他。子 Worker 归根阶段整体预算，不能在子 isolate 中创建一个空的“全局表”。具体入口见 [资源清点](resource-entry-inventory.md)。
- prepare 的 metadata 和字段扫描均在真实 Worker；单窗口、单源快照、token、requestId 绑定。字段结果最多 8 列，每列最多 50,000 个值／4 MiB 计费文本；超限明确失败。Main 与 Renderer 缓存均有界，迟到结果不覆盖新会话。
- rows 通过受控 PassThrough 等待实际 worksheet → ZIP → 文件流的消费回调；慢消费者、流错误、提前关闭均有测试。writer 和其样式对象在 validator 之前释放；回放样式通过 SQL LRU 重载。缓存字节是保守计费值，不能代替完整 V8／RSS 峰值证据。
- OP 配置作为可信 workerData 单独传递，不写进不可变业务计划、数据摘要或 journal。SQLite 按同时连接数分配总额度；发布观察借用已有租约，不嵌套等待自己的低档排他锁。
- 生产资格绑定源码树、依赖锁、版本、Windows 架构、Node/Electron、配置摘要和报告摘要。每档至少 3 个不同报告；low 覆盖 512／768 MiB。当前 phase 不细分格式，因此公共 prepare／rows-generation 必须同时取得 XLSX、CSV、XLS 的证据，不能只测 XLSX 就放开其他格式。其他 phase 要提供完整阶段证据。
- `package-lock.json` 随应用打包，供运行时资格核对；摘要只使用运行依赖和版本，兼容打包器删除 scripts/devDependencies/build。不升级依赖；证据缺失或损坏保持兼容准入，不阻断启动。

### 12.3 发现和纠正

- 65 MiB CSV 在首次普通档测试中触发 Worker 堆上限。根因是旧 parser 每字符拼接导致大量中间字符串。现改为连续文本片段拼接，保留整表 reader 和原引号规则；与固定 main 的 512 个确定性样本结果摘要完全相同。65 MiB 公共 metadata／字段扫描通过，rows 仍拒绝超限。
- 完整链路首次合成样本使用过多 fill，触发现有输出样式安全上限；修正为受支持的 128 个 fill，未放宽产品上限。两次失败的容量报告保留在 `local-capacity-attempt-*-failed.json`。
- 普通／低档导出说明页包含每次运行生成的 UUID、摘要、激活／发布时间。独立对比只规范这些技术身份，保留业务页、金额、日期、行顺序、说明结构；每次真实 Worker 的输出 validator 仍核对本次准确身份。
- Base 与 Phase 合并预检补上实际候选额度，固定不能容纳时立即拒绝。rows 新增验证阶段后，错误文案明确“私有目录已生成，尚未验证和发布”，避免误称完全未生成。
- 运行保护检查 heapUsed＋external；arrayBuffers 不重复计入。系统可用内存跌破安全余量时停止新输入；发布结果依原恢复协议处理。

### 12.4 Evidence 与验收状态

本节保留审查前记录；当前自动门禁、AC01—AC24 矩阵与剩余项见 [本地验证与待验收](local-verification.md)。[审查前完整链路探针](review-fixes/2026-09-30/before/local-capacity-probe.json) 记录合成样本、每阶段耗时、grant 配置、Main PID RSS 与采样线程内存；独立读回验证单列阶段。该报告固定 `productionEvidence:false`，不是 Windows 物理压力证据。

审查前最终 `npm run release-check` 退出码 0：9495 PASS／0 FAIL／4 SKIP（9499 单测），71/71 集成脚本通过；其中 Renderer 235/235、默认 30 万行 50/50、50 万／150 万行多 Sheet 31/31。单测跳过项均需 Windows。2 万行 normal／low 各一轮完整探针通过，业务摘要相同，源码身份与最终实现一致。两轮门禁的中间失败、修复和精确分母保留在 [审查前机器可读摘要](review-fixes/2026-09-30/before/local-gates-summary.json) 与原始日志。

§11 的准备扫描探针保留为历史结果，不能把其旧源码摘要套到当前实现。[审查前 development-manifest.json](review-fixes/2026-09-30/before/development-manifest.json) 记录当时 123 个工作区文件摘要；本地未提交，不编造实现 commit SHA。

### 12.5 Remaining unknowns

| 项目 | 状态 | 后续动作 |
| --- | --- | --- |
| Windows 512／768 MiB 真压力及正常对照 | pending_windows | 按 [验收操作说明](windows-acceptance.md) 在独立测试机各运行至少 3 次，测真实 Main／GUI 和最终安装包。 |
| 大样本、高样式、CSV/XLS 格式容量和性能阈值 | pending_windows | 按格式冻结代表样本、硬件与响应阈值；实测后决定候选参数是否保留或调整。 |
| Windows 特有 utilityProcess／文件锁／终止和恢复 | pending_windows | 本地有逻辑及真实 Node Worker 证据，Windows 平台路径单独验证。 |
| 生产档启用 | pending_qualification | 资格文件保持 pending；证据通过后才另行冻结 manifest，更新摘要并完成最终构建核验。 |


## 13. 2026-09-30 审查问题修复

### 13.1 Decisions 与依据

- R1：移除本轮误加到共享 Publisher 兼容路径的 1 GiB 请求，恢复基线无独立内存预留的合同。CPU／Worker／IO 资源与真实载体观察仍在；已取得资格的 phase 仍覆盖请求额度。空目录继续经过原 discovery／execute；损坏或未知记录按原规则报错。没有添加忽略恢复错误或按目录为空提前成功的分支。
- R2／R3：字段缓存按存活视图的字段集合管理消费者，并广播状态变化。模式交接保留新视图正在使用的请求；发起组删除或换字段不妨碍其他组收取共享结果。generation 校验继续防止旧回调打开错误面板。
- R4：在已有 legacy Main 活动内，BizOP 自有观察使用内部静态兼容 action，仍请求原 1 GiB、仍受 Bcompat 限制；外层增长未知状态保留到回调结束。wrapper 外的恢复和合法借用能力继续按原档位／scope 执行，避免嵌套租约等待自身。
- 额外观察项：为 Position Node fallback 的 `forkChild` 补同步准入与 exit 观察；AST 清点同时识别 fork／spawn／Worker 解构别名，清单从 27 补为 28 个点。

### 13.2 Evidence 与偏离记录

定向单测 68/68，真实 Electron Toolbox 20/20（新增 6 个竞态用例），发布恢复集成 12/12 均通过。原审查的空恢复精确基线对照及 legacy wrapper 复现已重跑成功。新增集成首次失败是合成 source/target 同目录违反既有发布限制，夹具改为独立 generation/output 目录后通过，产品限制未改。

最终门禁和重新绑定源码的 2 万行探针见 [修复报告](review-fixes/2026-09-30/fix-report.md) 与 [当前本地验证](local-verification.md)。修复前的 123 文件 manifest、门禁摘要、完整探针和载体清单保存在 [历史证据目录](review-fixes/2026-09-30/before/development-manifest.json)；§12 的通过数与摘要仅代表审查前版本。

Spec 的业务行为、金额／行／输出合同和 Windows 验收标准未改变。TechDoc 补明共享恢复的兼容额度与 legacy 嵌套观察规则。生产资格继续 pending；本次本地测试未提供 Windows 512／768 MiB 真压力、最终包体或 Excel/WPS 验收结论。


## 14. 2026-09-30 第二轮 R4 并发修复

### 14.1 Decisions 与依据

复审补充的正常优先级队列构成真实依赖环：迁移 phase 等待 legacy 活动结束，而 legacy 内部观察排在该 phase 后。修复前复现 normal／low 均约 5 秒双超时。原第 13 节的单请求验证不足以关闭并发问题。

采用受信任 continuation：Main 静态登记的 `publication:legacy-observation` 绑定当前仍存活的 legacy 活动；Governor 只在队首为确实受该父活动阻挡的获批 phase 时，允许 continuation 先执行。夹在二者之间的请求已经在等待队首，不得再阻止解除依赖；普通请求仍遵守优先级和 FIFO。无关队首、伪造或失效身份不获得此能力。

能力只改变依赖环中的排队顺序，不改变资源需求或授权。兼容 1 GiB、Bcompat、CPU／Worker／IO、低档排他、超时取消、恢复 scope 和真实退出屏障继续执行。父活动始终保留未知增长观察。不采用统一升优先级或放开普通请求插队，因为两者无法证明被越过的请求确实依赖父活动。

### 14.2 Evidence 与剩余项

修复前 132 个交付文件摘要全部匹配；证据已保存至 `review-fixes/2026-09-30-r2/before/`。新增 continuation 单测 16 项，与既有调度、活动和 carrier 检查合计 88/88；发布恢复专项 18/18；真实 BizOP 自动报告与 Main 合表并发 2/2。原矩阵在修复前复现双超时，新增真实业务回归加载五个修复前文件同样失败。首次业务集成的后续归档失败来自已有单领域测试宿主只提供 service、未装配 Archive controller 的归属查询；补入真实 controller 后两档通过，产品归属验证未放宽。最终完整门禁已通过：unit 9512 PASS／0 FAIL／4 Windows SKIP，73/73 集成脚本；绑定最终源码的 2 万行 normal/low 探针 2/2 PASS 且业务摘要一致。最终结果记录在 [本轮修复报告](review-fixes/2026-09-30-r2/fix-report.md)。生产资格仍为 pending，Windows 真实低内存及最终包体验收继续待办。


第 14 节补充：首轮全量门禁在 ARCH-PLATFORM-CORE 拦下 core memory-admission 直接依赖 Main 活动模块（连带 async_hooks／worker_threads）的方向错误。已改为 Main 静态装配传入同步 isContinuationBlocking provider；核心层只消费事实，架构 allowlist 未放宽。该次失败日志和之前绑定旧源码的成功探针均保留；最终门禁／容量报告重新绑定调整后的源码。


## 15. 2026-10-02 人工确认生产内存档

### 15.1 决策与授权

用户先明确“人工测试通过，从 pending 改出”，在说明现有摘要／压力报告资格规则后，又明确要求“调整”。据此将本版本启用依据改为静态人工验收确认；确认来源为本会话，日期 2026-10-02。目标分支 release/v3.2.11。原始 Windows 压力报告、安装包和逐项人工记录未提供，不填写实测次数、峰值或虚构摘要。

### 15.2 实现

- 随包 manifest 使用 schemaVersion 2、qualified、manual-acceptance PASS，明确列出 Windows x64 Electron 下的 18 个阶段配置。
- 生产 v2 启用不再计算整棵源码身份，也不要求安装包／压力报告或精确运行时版本；profileId／policyDigest 仍绑定实际执行配置。配置变化、重复项或未确认状态保留兼容路径。
- 实际活动覆盖、固定预算、实时采样与安全余量、低档互斥、Worker／缓存约束、取消和真实退出后的清理／释放继续执行。历史 v1 校验保留。
- 扫描和共享恢复兼容测试使用显式 pending 清单夹具，避免要求生产清单永久 pending；新增生产资格测试使用当前 qualified 清单。

### 15.3 本轮验证

新单测在旧实现为 2/4 PASS、2 FAIL；人工资格实现后，新旧资格单测 7/7 PASS。当前生产清单与真实策略／Governor／完整 rows 和 BizOP 工作流集成 9/9 PASS；真实 builder／ASAR／Electron 回归 7/7 PASS；pending 扫描兼容 12/12 PASS；发布恢复与并发 18/18 PASS。

本轮已按 package.json 的 release-check 五个阶段分别完成：lint、架构（786/786 文件、38 个历史提交）、smoke、全量单测（9572 PASS／0 FAIL／4 Windows SKIP）和集成（78/78 脚本、3052 项检查）。smoke／单测／集成执行时间为 15:35:20—15:53:59（Asia/Shanghai）；lint 和架构另行执行并通过。冻结 1769 个代码／测试／配置输入，期间只有 runner 自动生成的集成测试清单变化。

用户人工验收按本会话确认记录 PASS。本轮自动验证的 Windows 平台事实和内存读数为注入夹具；真实 Worker、Electron 和 ASAR 在本机运行，不冒充再次执行了 Windows 实机压力或安装包人工验收。本轮记录与日志见主检出目录 outputs/release-v3.2.11/2026-10-02-manual-memory-activation/activation-report.md。尚未提交、推送、升版或发布。


## 16. 2026-10-02 release 扫描临时资源补偿修复

### 16.1 依据与决策

复核基线 `release/v3.2.11@8cc9b2ddbc056c8a78d4a8f061083853815db019`。用户提供的 P2 指出：Worker 已退出，但临时目录删除抛错后，原 owner 的 finally 同时删除运行记录，后续 close 无法补偿。新增四项故障回归在旧实现均失败。

- 载体退出与清理完成分别管理。真实退出即释放执行 lease；保留待清理输入与错误，close 每轮单飞重试，返回独立 `unclosedCount`／`cleanupPendingCount`。
- Main 以 `{userData}/toolbox-scan-temp/` 固定根持有目录和 JSON 责任记录。删除前持久化关闭事实与对象身份清单；启动恢复、关闭重试和当前清理使用同一校验与删除路径。按登记对象逐项清理，文件／目录身份变化、未知内容和符号链接均保留。
- 无关闭事实、损坏记录、旧版无记录目录只保留并诊断。持久补偿待处理不占 Worker／内存额度；无法持久保存的新责任仍使退出失败，可重试。生产 qualified 清单及已有内存准入规则沿用当前实现。

### 16.2 验证与边界

聚焦 owner 与真实扫描单测 16/16 PASS，连同 Main 启动／退出合同共 27/27 PASS；新故障集成 16/16 PASS，覆盖真实 Worker、首次及持续 EPERM/EACCES、部分删除、目录／文件替换、符号链接、未知内容、新进程恢复、Main 启动与退出、日志失败以及取消后的补偿。完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 22:53:27—23:12:32 通过：lint、架构 787/787、smoke、单测 9577 PASS／0 FAIL／4 Windows SKIP、集成 79/79 脚本（3068 项计数检查）。冻结 1778 个输入，期间只有 runner 自动生成的集成清单变化。最终结果和完整发布门禁见 [本轮修复报告](../release/v3.2.11/review-fixes/2026-10-02-scan-cleanup/repair-report.md)。

文件系统错误为隔离注入，真实 Worker 和重启子进程在本机运行；这些证据不扩大既有 Windows 人工验收结论，也不代表重新完成安装包、Excel/WPS 或各功能完整人工验收。


## 17. 2026-10-03 release CSV 扫描档位适用性修复

### 17.1 依据与决策

基线 `release/v3.2.11@72c80bab465ca36fb098ac4271a8ea1de782c880`。独立复现的 13.73 MiB / 90 万行 CSV，在当前生产策略下获批低档后 Worker OOM，普通档正常。用户随后要求修复；本轮落实 Spec §4.3 的输入适用性要求，不更改业务合同或人工 qualified 清单。

- Main 按格式与 source snapshot 将整表 CSV 的低档范围约束到 256 KiB，较大 CSV 仅参与普通档准入；普通档不足按原 Governor 等待/拒绝。布尔 allowLowMemory 只收窄当前 phase 候选，不增加任何资格或资源。Renderer 仍无此参数入口。
- Worker 使用相同上限进行 fd 有界读取，stat 后增长仍最多读取上限加一个字节；解析前拒绝超限与格式变化。低档单行在创建格式化 cell 前按现有单对象预算检查，避免极宽行扩大对象工作集。
- 获批后和 Worker 开读前复核源身份。metadata 与字段补扫共用同一判定；小 CSV 低档、实际 XLSX 的流式低档、pending 零预算兼容和 65 MiB 普通档字段路径保留。
- 没有 OOM 后扩大堆重试；没有把 rows 的 64 MiB 上限用于公共入口；生产 qualified、profileId、policyDigest 和资源配置保持原值。

### 17.2 验证记录

聚焦单测 43/43 PASS；65 MiB 公共扫描/字段补扫与 rows 拒绝 4/4 PASS。生产 Main IPC/策略/Governor/真实 Worker 专项新增 17 项，最终结果、完整门禁及验证边界记录在 [本轮修复报告](../release/v3.2.11/review-fixes/2026-10-03-csv-admission/repair-report.md)。

最终完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 已通过，耗时 1331.4 秒：lint、架构 788/788、smoke、单测 9582 PASS / 0 FAIL / 4 Windows SKIP，以及 80/80 集成脚本（3085 项计数检查）。冻结 1780 个输入；仅 runner 自动生成的集成清单变化。源码在最终门禁后保持不变。

低档容量边界的验证在 macOS / Node 执行，Windows/Electron 身份及可用内存为受控夹具。该证据不扩大既有人工验收范围。原始故障、专项与门禁日志位于主检出目录 `outputs/release-v3.2.11/2026-10-03-csv-admission-repair/`。
