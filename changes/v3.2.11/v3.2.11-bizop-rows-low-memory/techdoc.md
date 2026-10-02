# TechDoc — v3.2.11 业务 OP 与按行拆分低内存适配

<!-- document-identity
 document-id: v3.2.11-bizop-rows-low-memory/techdoc
 target-version: v3.2.11
 branch: v3.2.11-bizop-rows-low-memory
 baseline: 18b82b4328cf5e00c1b2549d373a5b2f2677215c
 revision: R4
-->

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.11 |
| 功能分支 | `v3.2.11-bizop-rows-low-memory` |
| 基线 | `18b82b4328cf5e00c1b2549d373a5b2f2677215c`（初版已核验的远端 main／正式标签提交；R2 保持固定基线，不宣称重新核验当前 main） |
| 日期／状态 | 2026-10-02／生产资格沿用人工确认清单；扫描清理补偿实现与验证见实施记录 §16 |
| 关联需求 | [Spec](spec.md)，P01—P06、AC01—AC24 |
| 依赖 | 原资源 Governor／Supervisor、领域 owner、SQLite 保真缓存、公共 XLSX provider、Publisher／恢复体系 |
| 模板来源 | `docs/templates/TechDoc-template.md`；将 PRD 字段替换为本分支 Spec，按本任务扩充需求章节。 |
| 证据／执行记录 | [固定基线证据](baseline-evidence.md)／[实施记录](implementation-notes.md) |

本文的 `拟新增` 名称、DTO 和方法描述目标设计，不能据名称推断已经生产接入。业务行为只在 Spec 维护。R2 方案生成时未改代码，任务初始为 todo；当前具体接口见 §十四，完成状态及实测统一见实施记录。

## 一、Spec 评审意见（技术角度）

### 1.1 可直接复用

复用 OP 的候选／工作库、逐行计算、spool、严格源文件验证和既有错误报告；复用 rows 的密封保真缓存、顺序输出、FilePlan、产物校验和 Publisher。不新增一套对账存储或输出发布协议。[S09](baseline-evidence.md#s09) [S11](baseline-evidence.md#s11)

### 1.2 必须补齐的风险

| 风险 | 本文处理 |
| --- | --- |
| 前置扫描比正式 task 更早占用大量内存 | §四：扫描会话、基础扫描、准备阶段租约及真实退出。 |
| rows 限制误伤公共／字段扫描 | §四.2：公共安全、档位适用性和 rows 源预算分层；AC16。 |
| 默认首字段／单列没有 change 事件 | §四.1：首次点击值入口加载，未请求时入口可操作；AC08。 |
| 未迁移动作超过自身兼容上限却排队 | §三.1—3.2：先做稳定可满足性检查；无可用候选即终结，不 DEFER；AC05。 |
| 行流式但 SST／样式全量 | §五：完整读取预算与落盘 provider；输入样式纳入峰值。 |
| 获批小额度，worker 仍按旧大额度运行 | §三.3：可信配置贯穿参数与载体限制。 |
| publication／recovery 另拿 1 GiB | §七：阶段 inventory 和直接租约收口。 |
| 实时可用内存与配额重复扣除 | §三.1：稳定账本与实时检查分离。 |
| 串行资格与嵌套观察自等待 | §三.4：阶段持有／已授权借用，不持有锁等待自己的下一次申请。 |
| 旧 dispatcher 提前返回 | §四.3：单独 `closed` 屏障，清理与释放等待真正退出。 |
| 输出 writer 和 validator 对象叠加 | §六.3：实测后决定是否拆内部生命周期。 |
| 测试采样漏头、混入验证器 | §十：生产链路与验证器分离、真实 Windows 压力。 |

### 1.3 与 Spec 的差异

无业务目标差异。以下为本方案选定的技术口径：基础扫描先行、字段值懒加载；阶段级固定峰值档；低档独占重型执行阶段；未验证 action 保留兼容准入上限。实验额度不是需求方确认的产品最低配置。

## 二、涉及的文件清单

路径均相对仓库根；“修改”表示实施计划，不表示已修改。

| 文件／入口 | 类型 | 修改内容 |
| --- | --- | --- |
| `src/main-process/background-execution/resource-budget.js`、`runtime.js` | 修改 | 稳定硬上限、兼容额度与实时传感器分离；保留受控测试注入。 |
| 同目录 `resource-governor.js`、`admission-queue.js`、`resource-lease.js` | 修改 | 按请求自身稳定上限过滤候选、固定超限立即拒绝、暂不足才 DEFER；原子选档／批准、低档串行、定时重评、准确释放；保留依赖／replacement 语义。 |
| 同目录 `supervisor.js`、`adapters/worker-thread-adapter.js` 及实际使用的协议 schema | 修改 | 将获批配置交给真实载体；允许经验证的收紧限制，禁止调用方任意覆盖。 |
| 同目录 `memory-admission.js`、`memory-telemetry.js` | 拟新增 | 纯准入判定／可信传感器边界与低开销遥测；文件名可在实现时沿现有拆分习惯调整。 |
| `src/main-process/execution-descriptors/*`、领域 `execution-descriptor.js` | 修改 | 显式绑定资源候选 resolver／准备阶段 owner；保持公共机制不反向依赖业务。 |
| `src/main.js`、`src/preload.js` | 修改 | 基础扫描、补扫、取消及授权接线；不在 Main 中全量解析。 |
| `src/renderer/dialogs/toolbox.js`、实际 dialogs 窄 API 装配 | 修改 | 基础扫描结果；当前字段值入口首次激活触发加载、默认首字段／单列／多组状态；迟到响应隔离与提交锁。 |
| `src/main-process/toolbox-format-operations.js`、`toolbox-format-io.js` | 修改 | 新 metadata 扫描、档位适用性与公共检查；禁止上提 rows 专属 64 MiB 限制；传递 reader 预算并保留行／Sheet 策略。 |
| `src/main-process/toolbox-large-split-dispatch.js` | 修改 | 受信配置、准备扫描的 Worker 参数、独立退出屏障；原调用不被伪装为已受 Supervisor 管理。 |
| `src/backend/toolbox-xlsx-stream/large-split-worker.js` | 修改 | 明确新增 metadata 作业，复用已有格式 facade；取消及关闭协议回归。 |
| `src/main-process/toolbox-split-scan-service.js` | 拟新增 | Main 私有扫描会话、租约、token、源快照、临时资源归属。 |
| `src/backend/toolbox-format/xlsx-pass.js`、`src/backend/xlsx/shared-strings-provider.js`、`workbook-parts.js`、`xlsx-sheet-scanner.js` | 修改／必要时修改 | SST 查询适配、字节缓存、错误映射、等待关闭和构造失败清理。公共 provider 只补真实机制缺口。 |
| `src/backend/xlsx/style-registry.js` | 必要时修改 | 输入样式峰值保护；若已满足低档，保留解析机制，不扩大范围。 |
| `src/main-process/toolbox-row-split/{policy,contracts,cache,executor,service}.js` | 修改 | 获批预算、按需样式查询、输出积压、缓存验证及发布前资源边界。 |
| `src/main-process/toolbox-background/execution-descriptor.js` | 修改 | rows 当前固定 640／32 MiB V8 限制与获批配置对齐；预算不是仅改 policy。[S13](baseline-evidence.md#s13) |
| `src/main-process/toolbox-output-writer.js` | 修改 | 积压观测／可等待边界，必要的生命周期拆分及低内存输出回读。 |
| `src/main-process/biz-op-v327/{policies,phase-admission,execution-descriptor}.js`，两个 policy JSON | 修改 | 分阶段配置与低档资格，去掉目标链路的统一额度耦合。 |
| 同目录 `import-pipeline.js`、`compute-pipeline.js` 及其实际 router／sink | 修改 | SST、SQL 连接合计、缓冲和资源错误映射。 |
| 同目录 `export-source.js`、`export-pipeline.js`、`export-validator.js`、`export-writer.js` | 修改 | 原表及结果导出、writer／validator 的相同执行配置。 |
| 同目录 `publication-owner.js`、`export-publication.js`、`auto-error-report.js` 及恢复调用方 | 修改 | 直接 I/O 租约、借用观察、报告目标验证、重启资源重获。 |
| `src/main-process/toolbox-output-publication-dispatch.js`、`publication-recovery/*` 的实际调用边界 | 审核／必要时修改 | rows 发布／共享恢复的载体和流式文件 I/O 同样计入；不改发布所有权。 |
| `tests/unit`、`scripts/integration` 对应入口 | 修改／新增 | §十的逻辑、所有权、真实载体与输出一致性测试。 |
| `scripts/verify-toolbox-row-split-capacity.js` | 修改／保留原用例并补脚本 | 原容量证据保留；新增从选文件前采样的完整低内存验证。 |
| `scripts/verify-low-memory-workflows.js` | 拟新增 | 受控测试数据与 Windows 证据采集入口，不注入假内存冒充实机。 |

在落地前按符号搜索直接 `acquirePhaseLease`／`EXPORT_IO_RESOURCES`／`os.freemem`／`new Worker`／资源 override。该清单不是已经完成的全仓旁路证明；T0 必须闭合实际调用图。

## 三、需求 P01：稳定账本、实时准入与执行配置

### 3.1 账本定义

首版保留原硬上限计算方向，除非实测证据要求另行修改：

```text
H = max(768 MiB, floor(totalPhysicalMemory / 4))
U = Governor 当前已批准且尚未释放的资源贡献（仍按原 replacement／dependency 规则）
Q = 本阶段候选配置的完整新增峰值申请
F = 实际批准前采样的可用物理内存
R = 对应候选配置的系统安全余量
G = 其他工作尚未兑现的增长上界；只有受控缓存／阶段合同能提供依据，不能用粗略 RSS 猜出

配额检查：U + Q <= H（其他 CPU／Worker／I/O 槽位照常检查）
实时检查：F >= Q + R + G
```

U 只在固定账本扣一次；实时检查不再减整份 U。Q 不是缓存上限或 V8 堆上限，而是包含新载体启动、解析、原生缓冲、数据库连接、writer 和验证叠加的阶段工作集预算。已驻留状态不能被自动算成“零成本”。

当 G 无可靠界限时，不把它当作 0；等待增长不明的重型工作真实退出或到达已经证明释放资源的阶段边界。首版低档独占重型阶段，因而消除同级重型工作的未兑现承诺；有常驻 service／base lease 时仍需核实其增长上界，不能忽略。

这不是系统物理内存预留 API；批准后外部程序仍可能抢内存，因此还需要运行中保护。禁止通过 `max(最低配额, F-R)` 凭空创造可用内存。

**未验证 action 的兼容边界：** 固定 H 变大于旧启动预算时，不能顺手放宽所有动作。保留启动时原预算 `Bcompat=min(H,max(0,F0-2 GiB))` 作为未迁移动作的兼容准入上限，仍使用同一个 U 和同一个 Governor；不是第二个资源池。它们的既有 mode、并发拓扑、生产开关不变，但必须参与低档排他协调。目标已验证阶段才使用新的动态档位判定；恢复与准备阶段不得走另一套更宽松旁路。

**稳定上限与暂时不足的判定顺序（R2 明确）：** 上式为默认配置；有可信旧预算覆盖参数时，Bcompat 按原实际配置计算，不悄悄改成默认值。定义本次请求的适用稳定上限 C：已获准迁移的阶段使用 H；未迁移动作使用 Bcompat。归属由 Main 静态注册判断，Renderer 不能自报“已迁移”。

| 判定 | 行为 |
| --- | --- |
| 某候选的不可拆必需资源超过 C／自身稳定槽位上限 | 淘汰该候选；普通档不合适时仍检查已验证的其他候选。 |
| 所有合法候选都超过自身稳定上限 | 立即返回固定预算不足，不进入等待，不返回 DEFER_ADMISSION。可报告适用上限类别及缺口；不能靠重采样改写稳定上限。 |
| 存在可容纳的候选，但 U＋该候选净贡献暂时超过适用上限，或实时内存／串行条件暂不满足 | 有界等待，释放／退出／定时重采样后重新判断；不把其他任务占用误判为固定超限。 |
| 无有效传感器样本或配置／权限无效 | 走对应采样／配置／权限错误，不伪装成 0 内存或稳定超限。 |

未迁移动作仍须同时满足共享账本 `U + Q <= H` 和兼容判定 `U + Q <= Bcompat`；不能另建旧动作专属池。在原有 base／compound／replacement 请求中，沿既有向量和净贡献合同检查整体可满足性，不只看某个子 worker 的申请，既不重复扣父额度，也不遗漏不可拆总需求。

例如 `Bcompat=0` 且旧动作有正的内存申请时，即使申请小于 H、当前 F 很高，也必须即时拒绝；它不能占住队首直到 5 秒超时。零内存申请仍按其他维度正常检查，不因 Bcompat=0 一概拒绝。Bcompat 在该 runtime 代次内稳定；“外部释放后无需重启可重试”的改善针对已迁移链路，不借此宣称旧动作的兼容上限也变成实时值。

### 3.2 原子批准流程与重新评估

```text
验证 Main 来源／阶段／输入身份
→ 领域 resolver 返回有序候选配置（不分配大对象、不读业务明细）
→ 以请求自身稳定上限过滤候选；无可用候选则立即拒绝，不入队
→ 仍有可满足候选时，队列按原优先级和老化规则调度
→ drain／grant 前复核代次、候选资格与稳定上限；固定超限终结并继续调度下一项
→ 取得有效 F，检查适用上限/U、配置证据、其他增长及串行资格
→ 同一不可穿插的批准步骤记录租约和选中的配置
→ Supervisor／领域 owner 将相同配置送入载体
→ 本阶段运行
→ 等待真实退出／关闭 → 释放 → 触发重评
```

普通候选不满足时才尝试适用的低档；不能只换标识、执行时仍使用普通缓存。候选选择、租约记账和配置摘要绑定为一件事，禁止“先检查通过，await 后无复核地 grant”。异步传感器必须有时间戳／有效期，过期就重采样。

实际批准前无有效样本，返回“采样不可用”，不能当作内存无限或数值 0 伪装资源不足。系统安全余量及可提交内存不能用 RSS／页面文件大小替代。

**等待建议默认值：** OP 保留既有每次准入 5 秒；新增扫描及 rows 的准入默认也取 5 秒，作为本方案建议值，可经体验验收修改。仅对尚未获批阶段超时，不强制给运行阶段设同样期限。用户重试创建一次新的准入尝试，不自动再次执行已提交的业务写入。

**重评触发：** lease 释放、载体真实退出、阶段交接、用户重试，以及有待批请求时每 1 秒一次的系统重采样（建议初值，非硬实时承诺）。队列清空／runtime 关闭时移除定时器。复用原老化与优先级，避免无界计时器或恢复请求永久饥饿。

当前 `admission-queue` 在队首返回 `DEFER_ADMISSION` 时停止本轮 drain。[S12](baseline-evidence.md#s12) 固定超限必须在入队前拒绝；已排队请求若复核发现不可能满足，则以固定错误结算并继续本轮 drain，而非返回 DEFER。其他确属暂时不足的队首保持既有有界等待／取消机制。另不得让串行条件阻塞自身仍持有资源的续接：首版优先用 §三.4 的释放／借用消除依赖，不以临时提优先级或无限重采样掩盖问题。

### 3.3 执行配置的可信传递（拟新增合同）

资源档位在领域文件中定义，公共机制只消费同步 resolver／数据合同，不写 BizOP 或 Toolbox 的 action 分支。普通纯 policy／批准基线的资源 profile key 可以保留；确需新增契约或能力投影时，必须更新独立预期与验证，不从待测实现重采样来“自证正确”。[S13](baseline-evidence.md#s13)

建议 `ExecutionMemoryConfigV1` 内容：

| 字段 | 含义／约束 |
| --- | --- |
| `version`、`profileId`、`policyDigest`、`phaseKey` | 版本、领域档位和配置摘要；由 Main 注册配置取得。 |
| `phaseMemoryBytes`、`systemReserveBytes` | 与获批租约一致的完整阶段申请和额外安全余量。 |
| `sstMemoryBytes`、`sstCacheBytes`、`styleCacheBytes` | 分别限制内存主体、解码缓存和样式按需缓存；不是同一份预算反复使用。 |
| `sqliteAggregateCacheBytes`、`maxOpenConnections` | 全阶段同时打开连接的合计上限。 |
| `maxInFlightBytes`、`maxSingleRecordBytes` | 生产／消费积压及不可拆对象边界；不能用行数代替字节数。 |
| `workerLimits` | 只允许经验证的 V8 限制；不能从 Renderer 指定 `execArgv` 或堆大小。 |
| `validatedEvidenceId` | v2 指向本版本人工验收确认编号；v1 历史清单仍指向构建容量证据。实验 profile 不自动获得生产资格。 |

所有字段都是本次执行的技术配置，不改业务金额或行口径。Supervisor 经可信 grant 绑定配置，再送入 exact-key 校验后的 worker 参数；相应 DTO／schema／entry 必须一起变更。严禁只在请求中多放一个 `lowMemory:true` 绕过静态注册校验。

准备扫描和 OP 直接 phase lease 也调用同一准入／选档机制。它们不伪装成已注册的可发布 action。准备阶段新增显式的 admission-only owner 描述，由 Main 静态装配并验证；不据此授予执行 registry 中任意 action 的权限，也不创建假的归档任务身份。

当前 rows entry 固定 `maxOldGenerationSizeMb=640`、`maxYoungGenerationSizeMb=32`，旧大文件 dispatcher 的老生代为 4096 MiB。[S13](baseline-evidence.md#s13) [S15](baseline-evidence.md#s15) 低档需连同这些载体参数一起验证，不能申请小额度后继续沿用旧上限。较高上限本身不表示立即占用同量内存。

### 3.4 串行资格与租约交接

Main 保持本次执行链身份，实际重型独占资格按“正在执行的阶段”持有，而不是在用户打开窗口、等待确认或整个导出流程中长期锁住。

同阶段嵌套观察若已经由外层 I/O 覆盖，并且通过现有 capability 的 owner／scope／闭合证明，则借用，不再取得第二份独占资格／额度。现有 BizOP borrowed observation 的外层释放责任保持。[S11](baseline-evidence.md#s11)

下一阶段需要不同租约时，先在可交接边界确认旧载体退出、应关闭的 reader／DB／writer 已关闭，再释放／交接并重新申请。没有释放证明时不缩租；无法借用又不能关闭时，必须按重叠峰值取得完整承诺，不能占着独占资格再等待自己。

内部观察还需避免队列间接自等待：当队首先于 legacy continuation 排队且必须等待同一父活动结束时，受信任 continuation 可先执行以解除依赖。普通请求不得据此插队；Main 身份、当前活动和实时 inventory 必须同时证明该依赖。具体实现与兼容额度见 §14，第二轮证据见 [S20](baseline-evidence.md#s20)。

全局观察清单包含：managed worker、existing dispatcher、直接 phase lease、准备阶段重型扫描、发布／恢复 I/O 和活动 service。未观测的重型入口意味着低档串行不成立。普通新任务在低档运行期间也要服从屏障；仅 OP 与 rows 两个按钮互斥不合格。 未登记／未证明为有界轻量的工作默认不能被视作“无需协调”；领域白名单由 Main 静态装配，不能由 Renderer 或执行请求自报。旁路清点未闭合时只运行受控验证，不对生产启用低档。

等待外部内存期间不提前创建 reader／writer 或大缓存。取消、重复回调、异常 exit、runtime generation 替换均只能释放一次；未决载体继续保护相关租约和恢复义务。

### 3.5 实验参数与冻结规则（唯一数值来源）

下表保留首轮探索组合；当前批准配置见 §14.5。配置额度不构成硬件支持或任意文件容量承诺，不要求所有阶段使用同一组合。

| 项目 | 首轮候选 |
| --- | --- |
| 解析／计算／rows 完整 worker 阶段申请 | 256 MiB、384 MiB；必要时据实增加，不虚报可用。 |
| 流式 hash／发布观察等较轻阶段 | 64 MiB、128 MiB 起测；需包含实际载体与缓冲，不能直接认定足够。 |
| 额外系统安全余量 | 128 MiB、192 MiB、256 MiB。 |
| SST 主体／字节缓存 | 分别从 8 MiB 起测；低于单条合法记录时的处置必须显式。 |
| 样式查询缓存 | 8 MiB、16 MiB，保留输入及输出注册器本身的额外预算。 |
| SQLite 合计页缓存 | 16 MiB、32 MiB，按同时打开连接分配。 |
| 可等待生产链积压 | 1 MiB、4 MiB 起测，计入编码与压缩暂存；不是只设置 highWaterMark。 |
| 监测采样 | 运行时建议 500 ms／阶段边界；测试可加密，记录额外开销。 |

T0／T7 的测量方法用于诊断容量、性能和失败恢复，建议保留构建、运行环境与压力详情。2026-10-02 按用户确认调整生产启用条件：静态记录人工验收 PASS 和 profile 摘要；构建 SHA、精确运行时版本、报告次数与报告摘要不再是运行时资格前提。实际准入和执行中的资源检查照常执行。

## 四、需求 P02：前置扫描与字段懒加载

### 4.1 入口与结果合同（拟新增／扩展）

保留现有拆分导出及 `splitReadToken` 来源校验。新增字段不得无版本混进依赖 exact shape 的调用。

| 接口 | 建议合同与职责 |
| --- | --- |
| `toolbox:split:read` | 新生产调用显式传 `{version:2, scanKind:'metadata', requestId}`；文件路径仍由原文件对话框确定，Renderer 不传任意读取路径。 |
| 成功结果 v2 | 原必要字段＋`version:2`、`valuesState:'not-requested'`；不返回全字段值集合。Main 生成 token，绑定源快照／计数／发起窗口。可增加明确 schema 的只读 rows 不适用提示，但不能把它变成公共失败或授权依据。 |
| `toolbox:split:read-values`（拟新增） | `{version:2, splitReadToken, requestId, field}`；由 token 解出路径，仅在明确字段模式请求。返回该字段原口径的值与加载完成标志。 |
| `toolbox:split:cancel-read`（拟新增） | 仅接受本窗口 `requestId` 的活动准备扫描；幂等取消，不授权取消已发布／已提交业务。 |
| 旧无参数 read | 如需兼容，保留旧返回合同的明确分支；仍受格式和资源保护。新 rows 生产链禁止调用／自动回退该分支。 |

字段名需与冻结表头一致；结果的源快照、请求代次和窗口会话全部仍有效才接受。懒加载失败不是空字段。高基数字段不得无提示截断成“完整值列表”；本次不承诺字段拆分低档容量，必要时按原资源错误结束该扫描，但不得让它阻塞按行拆分。

**补扫触发约定（R2）：** 保持默认首字段、rows 默认不勾选、每份行数为空等既有口径。视图初次挂载、自动选中首字段、字段 `change` 均不自动扫描值；首次激活当前字段的“值”按钮才触发 `read-values`，鼠标点击与键盘 Enter／Space 激活遵守同一合同。字段 `change` 只切换字段、关闭原值面板、清空该分组不适用的选中项并呈现目标字段状态，不成为唯一加载入口。[S18](baseline-evidence.md#s18)

| 字段加载状态 | 值入口与反馈 | 点击／提交行为 |
| --- | --- | --- |
| not-requested | 按钮可操作，提示“点击加载可选值”；不是空列。 | 第一次激活后加载当前字段；未获得完整有效结果前，对应字段分组不能提交。 |
| loading | 显示“正在加载可选值”，阻止重复申请；完成按钮按该字段状态禁用。 | 同源同字段只保留一个 in-flight 请求，不因连点再次扫描；模式切换／取消能力不被全局 busy 误锁。 |
| complete 且有值 | 可打开面板，显示完整值列表及本组有效选中项。 | 不重复扫描；仍须满足原选值、文件名、分组和提交条件。 |
| complete 且为空 | 提示“该字段无可选值”，此时才能按既有空列规则禁用值入口。 | 不允许空选导出；可以切换字段或 rows。 |
| failed | 可操作，显示“加载失败，点击重试”，保留对应错误信息。 | 用户再次激活才重试；不自动反复补扫，不伪装为空列。 |

**多文件分组：** 每组值入口均使用上述规则，默认首字段和单列文件不需先制造 `change` 事件。加载数据按 `(splitReadToken, 源快照, field)` 标识；面板接纳再校验分组身份、分组字段代次、视图代次和请求身份。相同源／字段可以复用有界缓存或合并 in-flight 请求，但选中值仍属于各组，不能互相覆盖。切换字段、删除分组、关闭视图后，旧响应不能打开新面板或恢复旧选择；尚有其他组使用同一请求时不能误取消共享读取。

从字段模式切换到 rows 不等待字段值成功，关闭值面板、撤销不再被使用的补扫；补扫真正退出前仍保留其资源租约。基础 token 在源文件／会话仍有效时继续可用于 rows。切回字段模式只呈现有效缓存或 not-requested／failed 状态，仍由值入口明确触发。新读取状态须同步调整 `refreshValues`、`updateCompleteState` 和多组值按钮，禁止任何路径再以“数组长度为 0”代替是否已加载。

### 4.2 基础扫描与口径统一

新增 `scanToolboxSplitMetadata`（拟新增）或同一 facade 的显式 scanKind。沿用 `TOOLBOX_SHEET_STRATEGIES.SPLIT`，只计数、检查表头和读取身份；不创建 `createValuesByFieldAccumulator`，也不构造最终不会使用的大 `valuesByField` 消息。

基础扫描／构建 rows 缓存都消费相同的有效行事件；隐藏页和重复续页表头规则从原 facade 复用。不能因“不查字段”而意外放宽重复表头、改变源读行顺序或跳过有样式但符合原有效行判断的数据。

**格式与预算检查分层（R2，修正旧稿第 197 行）：**

| 层次 | 入口／检查时机 | 决策边界 |
| --- | --- | --- |
| 公共安全检查 | 公共 metadata、字段补扫及各模式 reader 分配前 | 保留各格式既有文件、结构和源身份检查。不得在公共 facade 无条件调用 rows 的 `assertSourceBudget`。 |
| 档位适用性 | metadata／字段／rows 各自申请资源前 | 依据该阶段的格式、规模和完整峰值证据筛选候选；低档不适用时普通档仍可参与准入，不等于文件非法。无可安全执行候选才给资源／能力错误。 |
| rows 专属源大小 | `mode==='rows'` 的 Main prepare 中，以及 rows worker 的源读取前 | 非 XLSX 源保持 `size <= 64 * 1024 ** 2`，超过时返回 `TOOLBOX_ROWS_SOURCE_BUDGET`；边界等于 64 MiB 不因此拒绝，但仍需资源准入。 |

固定基线中的 64 MiB 检查由 rows prepare／worker 消费，不是公共扫描或字段拆分的统一限制。[S05](baseline-evidence.md#s05) [S09](baseline-evidence.md#s09) 公共阶段可以用 stat 得到“rows 不适用”的只读提示；这只影响后续 rows 控件／提交，不阻断字段模式，也不能代替 Main 的最终复核。没有这种提示字段时，必须在 rows prepare 给出专属错误；不得为了提早反馈而拒绝整个文件。

**65 MiB CSV 的决策例：** 公共检查通过、普通档能够在资源合同内安全运行时，允许完成基础扫描并进入字段拆分；选择 rows 则只拒绝 rows，切回字段后仍可按原规则继续。若普通档实际资源也不足，按该阶段资源原因拒绝／等待，不能给“所有拆分不支持超过 64 MiB”的错误。CSV/XLS 未验证组合不启用低档，也不能仅凭压缩／磁盘字节数认定内存安全；不自动转换源文件。

上述普通档候选与兼容资格按 §三登记；“保留机会”不表示绕过 Bcompat 或其他资源门禁。低档失败后不得在没有再次批准的情况下悄悄改用更大工作集。

### 4.3 扫描会话、载体退出与临时资源

Main 创建 `ScanSession`（拟新增）：随机内部身份、发起窗口、请求代次、源文件快照、AbortController、准备阶段 lease、worker control 和临时目录所有权。它不是归档业务批次，不能伪造 Archive 的 exact operation context。

准备扫描重型解析复用 `large-split-worker` 内部的格式 facade，增加 metadata 作业；进入该新路径需接受可信执行配置，不沿用 `shouldUseLargeChannel` 的大小判断决定是否在 Main 中重解析。[S05](baseline-evidence.md#s05) [S15](baseline-evidence.md#s15)

旧 dispatcher `promise` 的完成不证明退出。实施时增加明确 `closed`／等价退出 Promise（拟新增，旧返回项保持兼容），在创建 Worker 后立即监听 exit；新准备 owner 在业务结果和真实退出均得到处理后释放执行配额，并独立完成临时资源清理。构造失败、postMessage 失败、done 后 exit 延迟、cancel 后不响应都要独立测试。不能只在 `finally` 中调用未等待的 terminate。

临时 SST 使用独占会话目录，文件身份／权限／关闭方式复用公共 provider。正常 scan 返回前关闭大资源；只保留小元信息和读取 token。窗口销毁或切换后取消本会话，迟到结果不更新 DOM；新元数据结果不会保留上一会话的字符串／样式引用。

崩溃残留的清理凭 Main 受控根、所属记录和文件身份进行；没有所有权证明就保留并报诊断，不递归扫删任意 temp 目录。该清理不读取归档的“永久保留”设置。

**release/v3.2.11 清理补偿实现（2026-10-02）：**

- `admission-only-owner` 将载体记录和待清理记录分开。确认真实退出即释放 CPU／Worker／IO／内存 lease；清理失败仍向调用方返回聚合错误，并保留清理输入、尝试次数和最后错误。`close()` 单飞执行，每轮对仍失败的清理重试一次；成功后才移除责任。
- `close()` 返回 `closed`、`unclosedCount`、`cleanupPendingCount`。`closed` 仅在两种计数均为零时成立；待清理记录不充当活动 Worker，也不占用已释放的执行配额。
- Main 固定扫描根为 `{userData}/toolbox-scan-temp/`。每次扫描使用独立随机目录及 `.toolbox-scan-owner-<UUID>.json` 责任记录；先登记 owner、根和目录身份，再启动 Worker。确认退出后，在删除前原子保存 `cleanup-pending` 和文件身份清单。文件数据先 `fsync`，记录通过同目录重命名替换；此处验证的是进程退出／重启恢复，不声明断电耐久性。
- 身份包含无损设备号、inode 和创建时间；普通文件还核对大小、修改时间和状态变化时间。重试重新核验根、目录、记录文件及已登记子对象；允许已成功删除的对象缺失，拒绝替换、新增对象、符号链接或非法相对路径。按清单逐项 unlink/rmdir，不递归删除未登记内容。
- Main 启动及 owner 关闭沿同一受控根读取责任记录，只补偿已记录关闭事实的 `cleanup-pending`。`running`、损坏记录、身份不符及旧版无记录的临时目录保留并诊断；不依据目录名前缀推断所有权，不将所属进程消失冒充原记录的关闭事实。
- 退出时，Worker 未退出仍阻断关闭；已退出且补偿责任已持久保存时记录警告并继续关闭 runtime，下次启动重试。若清理责任尚未成功保存，退出明确失败并允许重试，避免丢失仅在内存中的责任。清理不读取或修改 Archive 保留设置、来源文件和导出产物。


## 五、需求 P03：XLSX provider、样式与完整关闭

### 5.1 SST 从数组改为有界查询

工具箱当前调用 `loadToolboxSharedStrings` 未给 `onValue`，默认将字符串压入数组。[S07](baseline-evidence.md#s07) 在 Toolbox 装配层接入 `src/backend/xlsx/shared-strings-provider.js` 的能力；保留工具箱的 ZIP／Sheet／行策略，不整体替换成 OP 单 Sheet reader。

loader 将每个字符串交给支持同步写入／落盘的 provider；scanner 通过受限查询读取索引。对应 scanner、provider、构造和关闭必须同改，不能仅在上游落盘后让下游仍要求完整数组。

provider 主体、索引、解码缓存分别计量；超过 LRU 条目数或字节数时淘汰。索引 0、空串、重复字符串、富文本原投影、转义文本和非法索引必须回归。按真实解码长度估计缓存，不能把压缩后的 xlsx 文件大小当内存。

保留现有声明／实际解压字节检查、XML 完整性、关系校验与单对象安全上限；不使用 `skipDeclaredSizeLimit` 规避原安全边界。没有 SST 的工作簿使用空 provider，并正确处理 inline string。

### 5.2 输入样式与缓存回放

输入阶段现有 styles/theme XML 与注册器纳入预算。先测它们的叠加峰值；足够小的有界实现允许继续用，超出目标档则需要流式解析／受控存储，或在读取前明确拒绝该低档而选择有资源支持的其他档。不得在全量分配后才声称“预检保护”。

`rows.sqlite` 继续保存样式实体；`openCache` 改成通过主键 `(registry_id, style_ref)` 按需查询，使用字节限额的解码缓存，不能再遍历 styles 表还原完整对象数组。验证完整性时逐条检查引用，保留编号连续性与合法引用验证。[S09](baseline-evidence.md#s09)

查询缓存淘汰不删磁盘样式、不改变 sourceRegistryId，不影响 writer 已注册的样式。特别测量高唯一样式时 SQLite 读取成本和 writer 自身样式去重字典峰值；回放缓存变小不代表输出字典也变小。

### 5.3 同步回调与关闭合同

现有公共 reader 对 onRow／onCell 回调有同步约束。[S08](baseline-evidence.md#s08) 不能直接传 async 回调假装实现背压；需要在可暂停 parser／流或磁盘回放边界接续。

`ToolboxXlsxPass.close` 当前只关 ZIP。引入 provider 后扩展为可等待的、幂等的全部资源关闭；所有生产及测试调用方更新成 `await close()`／等价完成等待。构造中途失败也必须关闭已创建 provider 和 ZIP，不能等待一个从未返回给调用方的 workbook 来清理。

先关闭句柄，再按登记身份清理自有文件。关闭失败继续尝试其他已持有资源，聚合错误并保留无法证明安全清理的内容。Worker 被终止后的任务级清理归 owner，不由公共 XLSX 模块扫描其他任务目录。

## 六、需求 P04：rows 有界输出与回读

### 6.1 保留的流水线

```text
基础扫描（关闭并释放）
→ 冻结源身份与 FilePlan、确认输出位置／覆盖权限
→ 准入 rows worker（获批完整阶段峰值）
→ 生成／封存 SQLite 保真缓存
→ 验证缓存
→ 单 writer 顺序输出每一份
→ 每份技术／业务校验
→ 验证全部产物清单
→ 关闭 worker／释放本阶段
→ 为发布实际 I/O 边界获取资源
→ 原 Publisher 发布及归档交接／恢复
```

首版允许 rows worker 内缓存构建、回放、输出和回读使用同一经实测的峰值租约，避免过早优化细粒度缩租。Main 清单校验、hash、发布也必须被计入或单独获批；worker 已结束不等于后续操作不消耗资源。

### 6.2 输出积压和单对象预算

保留一个 active writer。按字节而非仅按 128 行控制回放速度，测量排队的编码行、XML、压缩缓冲及正在验证的对象。同步 emitRow 后的 `setImmediate` 只是让出执行机会，不是消费完成确认。

优先扩展本项目 writer facade 的 `flushPending`／可等待排空能力（拟新增名称），用实际下游接受／完成信号验证生产可以暂停。若所锁定 ExcelJS 内部链路不提供足够信号，应在项目 facade 内引入可控的有界暂存／批次或调整写入实现，并通过兼容测试；不直接依赖未经验证的内部缓冲字段。Node 的 highWaterMark 只是阈值，不是严格内存上限。[E02](baseline-evidence.md#e02)

单行／单字符串解码可超过一般批次目标；在分配前应用已定义的单对象上限。数据不截断，不自动更改用户每份行数 N。不能为低档偷偷增加输出文件数。

### 6.3 writer 与 validator 生命周期

先测当前 `commitAndValidate` 的叠加峰值；若可在获批完整阶段内通过，可保留接口。若不通过，内部拆为：

```text
WRITING → GENERATED_UNVALIDATED → VALIDATING → VALIDATED → PUBLICATION_ELIGIBLE
```

这些是技术状态，不新增归档业务枚举。生成完成需等待文件流关闭；释放已无用的 writer／worksheet／去重对象引用后再回读，保留必要的小校验摘要。不能直接提前调用现有 `release()`：该方法当前要求已校验提交。[S10](baseline-evidence.md#s10)

输出 validator 必须接受同一资源档。完整读取 styles.xml 的分支也要有实测上界或改为流式计数／验证；不只给输入 reader 降缓存。重新检查文件身份、hash、行数／表头／样式计数等既有判定，不能为了避开峰值删验证。

释放引用不保证立即归还物理内存；跨阶段缩租需满足资源闭合合同并重新采样，不能用 `global.gc()` 作为生产保证。最终整体成功继续由原发布协议确认。

## 七、需求 P05：OP 各阶段与独立资源入口

### 7.1 阶段配置清单

| 阶段 key（拟定义） | 基线入口 | 改造要点 |
| --- | --- | --- |
| `bizop.import` | `import-pipeline.js`、candidate policy | SST memory／cache／LRU、候选 router 连接／writer、样本上限、资源错误。 |
| `bizop.compute` | `compute-pipeline.js`、工作库／result sink | 同时打开的读、工作、输出库合计缓存；FILE 临时排序不等于原生内存为零。 |
| `bizop.export` | `export-source.js`／`export-pipeline.js`／writer／validator | 原表读取和输出回读仍有写死 32 MiB 的位置，全部显式传入。 |
| `bizop.publish-io` | `export-publication.js`、`publication-owner.js` | 用相应阶段配置替代 `EXPORT_IO_RESOURCES` 的统一 1 GiB。 |
| `bizop.report-verify` | `auto-error-report.js::savedFact` | 目标 hash／身份验证用单独适用档，不直接复用大导出档。 |
| `bizop.recovery-observe` | `publication-owner.js::acquireObservation` 及恢复 owner | 重启后重新获批；借用已有合法观察不重复申请。 |
| `bizop.maintenance` | policies 中的 delete-plan／upgrade-preflight／reclaim 对应执行路径 | 逐项登记资源边界；不改变删除、升级或回收规则，不让恢复必经维护被遗漏。 |

以上阶段不是全部新增运行时 action。优先复用现有 action key 和 owner，将资源阶段分类作为领域配置；是否需要扩展 schema 在 T1 精确登记，禁止伪造 entry／validator 或绕开既有 capability 基线。

### 7.2 参数贯穿与算法不变

导入、计算和导出 pipeline 的 options 必须来自本次可信配置；默认值只用于明确的旧测试／兼容调用，不在生产漏传时悄悄回到更大缓存。生产缺必需配置时应以配置错误拒绝。

共享字符串、SQLite 页缓存、router writer 数量、样式缓存、报告样本、spool 编解码和 writer 缓冲都纳入同一阶段盘点。SQLite 按连接合计，不仅改某个 reader 的 `cache_size`。临时数据库仍归 payload／工作目录，不能挪到主数据库。

金额计算继续调用原 decimal 机制，聚合键、容差、重复／冲突判定、区间和结果描述不改。按低档计算得到的计数、内容和原始血缘与正常档一致。

### 7.3 错误报告与资源失败分类

含非法业务数据的导入仍按现有规则整批拒绝／采样／保存自动错误报告，不因为低档而少扫描业务行。现有样本上限和 `errorCountExact`／`scanComplete`／truncated 口径保留。[S11](baseline-evidence.md#s11)

新增资源压力错误必须进入 `resourceOrCancel`／等价分类，不落到“该文件普通格式错误后继续处理其他文件”的分支。资源失败导致未完整扫描时，按原未完成语义处理；既有业务结果不被候选半成品替换。

报告生成、发布、最终 hash 和恢复都要有适用档。报告资源不足时分别保留“业务处理结果”与“报告未保存／结果待核验”，不将已有 COMMITTED 结果伪装成未发生，也不触发生成报告失败后反复自动再生成的循环。重试业务写入仍需原显式入口与幂等／恢复检查。

### 7.4 发布与恢复

原观察 capability 的 owner／scope／attempt／保护闭合验证不变。只改变资源来源，不使资源许可自动成为发布／恢复权限。

启动恢复即使发生在普通操作 runtime 完全就绪之前，也必须取得 Main 本代装配的同一 Governor／传感器边界，不能创建一个默认 1 GiB 的旁路实例。模块 recoveryReady 及 application recovery 阶段仍由原 owner 判断。

恢复读取旧 intent／FilePlan／journal 不要求它们预先包含新 profile；本次恢复以新的临时执行尝试绑定资源配置。不能修改已封存资料的 hash 来补资源字段。若实现确需改变持久 schema，必须另加明确兼容／迁移说明与旧记录恢复测试，不能默认通过。

## 八、需求 P06：运行中保护与诊断

### 8.1 可执行压力动作

| 对象／阶段 | 允许动作 | 不允许的替代 |
| --- | --- | --- |
| SST／样式查询缓存 | 淘汰已可重读条目，停止预取；维持磁盘实体。 | 清除尚无持久来源的字符串／样式，继续返回错误值。 |
| 输出回放 | 在有确认信号的边界暂停生产，等待消费者；持续超预算时安全结束。 | 仅 sleep／setImmediate 后继续无上限提交。 |
| SQL／事务 | 在原安全批次边界停止新输入、按原协议结束或回滚事务、关闭连接。 | 以关闭同步性、删部分结果或改金额聚合换内存。 |
| 不可拆大对象／同步解析 | 在分配前限制、或在 worker 层有受控终止；事先验证响应性。 | 假定 Main 发消息就能中断正在执行的同步 C++ 调用。 |
| 发布关键区 | 完成可完成的原协议步骤，或保留待恢复事实。 | 抢先清理 journal、释放仍活动的载体、把中断当回滚成功。 |

按可控制缓存水位进行预防，不等到 OOM 后才处理。为获批峰值保留分配粒度／检查间隔余量。未知的不可中断峰值不应获得低档资格。

### 8.2 监测口径

每次记录 request／grant／worker-start／phase-end／carrier-closed／release，以及阶段耗时、所选 profile 摘要、系统可用物理内存、可控制缓存／队列字节、SQLite 活动连接数、worker 堆／external、Main 所在进程 RSS、应用进程清单。

worker thread 的 RSS 属于整个进程，不能按 worker 求和；`arrayBuffers` 已包含在 `external` 内，不能重复相加。`heapUsed+external` 可作线程诊断，但不覆盖 SQLite 等全部原生分配；V8 resourceLimits 不等于总内存限制。[E01](baseline-evidence.md#e01)

应用层每个 PID 只采一次；跨 Electron 进程的 working-set 求和可能重复包含共享页，标为观测指标而非精确独占内存。预算批准不依赖这个粗略合计进行“抵扣”。系统可用物理内存与 commit headroom 分开记录；取不到 commit 指标就写 unavailable，不用页面文件剩余空间或物理内存替代。[E03](baseline-evidence.md#e03)

首版不为诊断强行引入原生依赖或频繁启动 PowerShell。现有 API 能力及实际打包 Node 版本在 T0 记录；不能因为在线文档是新版就假定安装包有同样 API。

### 8.3 错误合同

建议在既有错误族内区分：适用稳定上限不足（H 或 Bcompat）、当前配额被占用、实时物理内存不足、增长不明而等待、排队超时、采样失效、运行中压力、磁盘不足、配置缺失、恢复尚未就绪。固定不足不映射成等待超时；rows 专属 `TOOLBOX_ROWS_SOURCE_BUDGET` 不用于公共／字段路径。新错误码／字段需同步 error codec／schema；名称在实现时集中定义，不零散匹配字符串。

OP 旧 `BIZOP_RESOURCE_BUDGET_INSUFFICIENT`／`BIZOP_RESOURCE_WAIT_TIMEOUT` 的映射要区分“稳定上限”与“当前环境”，移除要求重启应用才能刷预算的常规提示。rows 的 `rowsAdmissionError` 同改。每个阶段实际是否开始、是否有待恢复副作用应准确显示。

日志遵循 finance-safe：不放源行、字段值和账户金额。需要源身份时使用内部 token／摘要，不能将用户完整文件路径写入公共遥测。

## 九、兼容、归档与回滚

### 9.1 边界治理

公共 governor／XLSX 机制不依赖领域模块；领域 resolver 与 Main binder 在明确 composition 中注册。准备扫描的 admission-only 描述不是新的可执行业务 action，也不能因为 action 数量固定而偷偷冒名 rows／export 来借权。若最终选择新 managed action，必须同步独立 manifest、binding authority、policy/schema、任务／归档分类和批准基线，并记录语义差量后再实施；这不是本方案首选。

保留旧函数参数／返回值的明确兼容面；新调用必须显式带配置，不靠公共默认值让其他 VCC／Position／Pending 的 reader 行为漂移。尤其公共 provider 的严格关闭与原宽松关闭场景不能混淆。[S08](baseline-evidence.md#s08)

### 9.2 同版本并行分支

本分支主要冲突热点是 Main 接线、共享资源机制、Toolbox dialogs、公共 XLSX 和执行描述符。v3.2.11 的默认保留期限／深色模式、前置资金弹框、VCC 财务结果导出需求不混入本分支。合入 `release/v3.2.11` 时做调用接口与回归协调，不复制其业务文档。

临时缓存不继承输入／输出文件“永久”保留；失败待恢复产物也不能因本分支新增清理自动删除。归档批次、输入／输出成组关系和实际归档 owner 不变。

### 9.3 回滚

首先停止对新的执行尝试选择低档；已获批尝试不能热切换成普通大缓存。等待载体真实退出和业务／发布协议闭合，保留不能闭合的恢复材料。

回滚资源档与对应执行配置作为同一组：不得旧执行＋新小预算混搭。需要恢复旧公共预算公式时在下一 runtime generation、没有活动租约时进行，并恢复匹配的策略／界面提示；这会重新带回低内存不可用，必须明确记录而非宣称修复仍有效。

代码版本回退前确认新私有资料能被旧版本识别或已安全闭合；不能删除恢复日志实现“兼容”。主业务库默认无迁移，任何实际新增持久字段必须另记兼容与迁移风险。

## 十、测试、验收与证据

### 10.1 逻辑与所有权测试

| 编号 | 用例与关键断言 | 对应 AC |
| --- | --- | --- |
| U01 | 总内存／H 固定，F 从低到高变化；账本总额不随 F 覆写，用户重试可重新获批。 | 01—03、21 |
| U02 | 两个请求同时到达；只有一个低档重型阶段获准，无同样本双重承诺。 | 04 |
| U03 | 老动作／service／直接 phase／准备扫描运行中；无界增长不被当零；漏登记负例必须失败。 | 04—05 |
| U04 | F 改变但无 lease 释放事件；队列靠受限重评被唤醒，空队列无定时器残留。 | 21 |
| U05 | 预算不足、取消、队列超时、停机、replacement、父依赖、重复释放、旧 runtime 代次。 | 01、05、09、20 |
| U06 | Renderer 篡改 profile／峰值／路径／token；跨窗口取消、过期源快照和请求代次。 | 08—09、22 |
| U07 | metadata 路径禁止创建字段累加器；字段补扫不伪装 empty／complete，延迟响应隔离。 | 06—08 |
| U08 | SST 0／空串／重复／富文本／转义／非法索引；触发 spill、构造失败及 strict close 失败。 | 10、12 |
| U09 | 样式按需查询的缓存命中／淘汰与引用完整性；输入样式／输出样式预算失败不降级。 | 11、13 |
| U10 | scan dispatcher done 后 exit 延迟；promise 已有结果时额度仍受保护。 | 09 |
| U11 | OP publication borrowed observation 不重复占 lane，跨阶段不持锁等自己，队首阻塞负例。 | 19—20 |
| U12 | OP 资源错误不当业务行错误；未完整扫描的计数／报告状态真实，报告失败不递归重试。 | 18、22 |
| U13 | 获批预算与 reader、writer、validator、worker 限制同摘要；漏传参数／更大默认值拒绝。 | 02、10—12、19 |
| U14 | Bcompat=0、旧动作 Q>0 且 Q<H：即使 F 很高仍立即固定拒绝、不入队；后续合法低档请求可调度。排队复核发现固定超限时终结并继续 drain。 | 01、05、21 |
| U15 | Q<=C 但 U+Q>C，或 F 暂不足：保持有界等待；释放／重采样后可获批。Q>C 的普通候选被淘汰但已验证低候选可容纳时继续选档；覆盖零内存请求及 compound／replacement 的原净贡献。 | 01—05、21 |
| U16 | CSV/XLS 阈值为 64 MiB−1 字节、64 MiB、64 MiB＋1 字节，外加 65 MiB 样本；公共／字段路径不套 rows 限制，rows prepare／worker 正确拒绝超限。普通档资源不足与低档不适用分别断言。 | 06、16 |
| U17 | 默认首字段、单列、failed 重试、complete 空列、连点去重；按下值入口才扫描，未请求不禁用；多组不同字段／同字段共享、删除或切换分组、rows 切换和迟到结果隔离。 | 08—09 |

### 10.2 真实载体与文件一致性

| 编号 | 场景 | 判定 |
| --- | --- | --- |
| I01 | XLSX 大量唯一文本、重复文本、inline string、高唯一样式、宽行、边界单元格。 | 各阶段与叠加峰值在所选完整预算内；受支持内容等价。 |
| I02 | 多 Sheet、隐藏页、空行、续页重复表头；N=1、尾份不足 N、份数上限及超限。 | 前置计数／缓存／输出总计一致，不擅改 N。 |
| I03 | 慢磁盘／受控背压、磁盘满、目标权限、覆盖目标中途变化、校验损坏输出。 | 无无界排队、无整体假成功；按既有发布协议处理。 |
| I04 | OP 正确输入完整链路；错误行／文件／截断样本；原表和所有结果导出。 | 金额、差异、行范围、诊断计数、报告和归档一致。 |
| I05 | 生成前／后、发布前／中／后强制终止；重启时低内存、随后释放内存再恢复。 | 原事实／权限核验不弱化，旧恢复记录可处理，不重复业务提交。 |
| I06 | 生产 read v2、旧 read、预览／旧调用兼容；同版本其他模块正常档回归。 | 不以兼容回退让新 rows 再走全量预扫描。 |
| I07 | 受控足额普通档运行 65 MiB CSV 以及有效 XLS 阈值样本；同源在字段／rows 间切换。 | 公共／字段不因 rows 限制提前拒绝；rows 专属超限仍拒绝；正常档输出与原规则一致。逻辑阈值桩不能替代真实 reader 测试。 |
| I08 | 实际工具箱单列文件、默认首字段及多组字段的点击／键盘加载、失败重试、切回 rows。 | 不需要“换到另一列再换回来”；未加载入口可达、提交条件准确、无跨组或迟到响应污染。 |

一致性验证比较业务数据、类型／格式语义、Sheet 顺序和拆分边界；不要求 ZIP 文件时间戳等无业务意义字节完全相同。验证器可在单独阶段／进程运行，其内存单列，不污染生产峰值证据。

### 10.3 Windows 真压力测试

本节保留压力诊断与复测方法；当前生产启用依据按 §14.5 的人工确认清单执行，程序不再据报告文件和重复次数决定是否注册档位。

必须记录启动前、选文件前、grant 时与整个执行区间的真实可用内存。设置约 512 MiB、768 MiB 两类压力场景，另设正常内存对照；报告实际最小／中位／最大值，而不是把一个设定值写成执行全程的事实。

注入 `freeMemoryBytes` 仅用于 U 类逻辑测试。真实压力使用隔离测试机／虚拟机和明确的内存压力工具，记录页面文件状态、磁盘类型、Windows、CPU、总内存及应用构建。不能在用户正常工作的公司电脑上未经授权制造 OOM。

样本矩阵覆盖真实用户文件特征的脱敏／合成数据。基础样本必须达到功能完成和一致性；极端样本可因明确资源边界拒绝，但需要证明拒绝发生在危险分配前且能清理／恢复，不能把所有样本拒绝当成低内存验收通过。

建议每个代表性场景至少 3 次，记录成功率、完整耗时和各阶段耗时、缓存命中、读写字节、主线程事件循环延迟／GUI 可交互性、取消响应、峰值、残留文件及恢复结果。最终可接受耗时／响应阈值在基线建立后、验收开始前固定，不能观察结果后任意放宽。没有对应测量时，不对外宣称具体性能阈值或硬件最低配置；这与人工确认清单的生产启用状态分别记录。

### 10.4 命令与完成门禁

既有基本检查沿 `AGENTS.md`／实际 `package.json`：`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run smoke`。按改动运行最小有效范围；正式 PR-ready／GUI 交付／发布前必须执行 `npm run release-check`，局部通过不能替代。

脚本的当前覆盖范围见 §十四，实际执行结果以实施记录为准。Windows 打包及真实 GUI／Excel 或 WPS 验收独立记录。R2 方案生成时未运行任何仓库测试／构建／Windows 压测；该历史事实不替代后续开发证据。

## 十一、任务分解与提交粒度

| 切片 | 内容／依赖 | 完成证据 | 建议提交标题 | 初始状态 |
| --- | --- | --- | --- | --- |
| T0 | 固定 SHA、全入口资源／载体清点，分阶段遥测与样本基线。 | 调用图、无遗漏 inventory、测量覆盖范围；不降低生产门槛。 | `test(v3.2.11): 增加低内存全流程基线与观测` | 见实施记录 §3 |
| T1 | 在现有 descriptor／Governor 边界定义配置、适用稳定上限／暂不足分类、准备 owner 与关闭合同；依赖 T0。 | 合同负例、权限与释放测试；U14／U15 覆盖 Bcompat=0 固定拒绝与后继调度；实验 profile 不启用生产。 | `refactor(v3.2.11): 定义可信内存档位与准入合同` | 见实施记录 §3 |
| T2 | 基础扫描的三类检查、值入口懒加载、扫描 token／取消／真实退出；依赖 T1。 | U06／07／10／16／17、I07／08；计数、64 MiB 作用域、默认首字段／单列／多组及 GUI 生命周期。 | `fix(v3.2.11): 拆分前置扫描按需读取并管理资源` | 见实施记录 §3 |
| T3 | SST 落盘、输入样式峰值、provider 关闭；依赖 T1。 | 高唯一文本、非法 XML、所有权及关闭失败。 | `fix(v3.2.11): 工具箱共享字符串使用有界落盘查询` | 见实施记录 §3 |
| T4 | rows 样式查询、writer 积压、输出回读与发布资源；依赖 T2／T3。 | I01—03、各阶段及叠加峰值。 | `fix(v3.2.11): 收敛按行拆分完整输出链路工作集` | 见实施记录 §3 |
| T5 | OP 导入／计算／导出／报告／发布恢复档位；依赖 T1、公共 provider 合同。 | I04／05、直接租约清零遗漏、借用／恢复一致性。 | `fix(v3.2.11): 贯通业务OP各阶段低内存配置` | 见实施记录 §3 |
| T6 | 实际 grant 动态判断、低档串行、队列重评、全旁路及兼容额度；依赖 T1，生产启用必须等 T4／T5。 | U01—05／11／13—15；固定不可满足请求不 DEFER，其他 action 回归。 | `fix(v3.2.11): 资源准入实时复核并支持低内存档` | 见实施记录 §3 |
| T7 | Windows 真压力、正常档回归、输出一致性、恢复、打包，冻结参数。 | 最终构建证据及 profile 摘要，AC01—24 全部闭合。 | `test(v3.2.11): 验证并冻结低内存完整流程支持矩阵` | 见实施记录 §3 |

提交标题仅是粒度建议，不代表获准提交或已提交。T4／T5 执行收敛与 T6 准入调整必须作为同一修复整体交付；只有降低门槛的中间提交不得成为面向用户的发布版本。

## 十二、实施日志与记录方式

实施过程中的状态、实际命令、失败、决策偏离和实测参数冻结记录集中写入 [implementation-notes.md](implementation-notes.md)。本节仅引用，不维护第二份任务完成表。基线材料见 [baseline-evidence.md](baseline-evidence.md)，不要改写历史版本的验收材料来适配新实现。

## 十三、Open Technical Questions

以下状态保留 2026-09-30 的测量记录。当前人工验收确认和生产启用见 §14.5 及实施记录 §15，不把用户确认改写成新的测量数据。

| 编号 | 实验事项 | 关闭条件 | 当前结论 |
| --- | --- | --- | --- |
| OQ01 | 各 profile 的完整峰值和余量。 | 同构建、完整链路、正常／压力场景证据通过并冻结。 | Windows 待验收；候选参数未冻结。 |
| OQ02 | 锁定 ExcelJS 的端到端背压信号与 writer／validator 拆分必要性。 | 慢磁盘测试证明积压有界；对象重叠符合档位；保持输出语义。 | 本地机制已实现，慢消费者／关闭负例通过；Windows 慢盘与完整峰值待验收。 |
| OQ03 | 输入样式解析是否需进一步受控存储。 | 高样式样本明确峰值；必要时实现机制后复测。 | 已约束 metadata 并实现回放样式 LRU；正式高样式容量待验收。 |
| OQ04 | Main 中 managed 之外重型入口与常驻服务增长。 | inventory 全量闭合、遗漏负例可失败；不能假定未列出的路径不占资源。 | 28 个源码载体点、Main 工作和旧 runtime 已接入并有遗漏负例；Windows 完整应用覆盖待验收。 |
| OQ05 | CSV/XLS 低档适用范围。 | 格式专属源读取峰值测试；未过组合不启用低档，普通档按资源准入保留机会；rows 的 64 MiB 限制不扩展到公共／字段路径。 | 65 MiB CSV 普通档／公共读取和 rows 拒绝已通过；低档格式容量待验收。 |
| OQ06 | 实际 Electron／Windows 下可取得的内存／commit 指标及成本。 | 记录 runtime 版本、API 能力／缺失值和采样开销；不新增未审批原生依赖。 | 本地记录真实 available/RSS/heap/external，commit 缺失明确为 null；Windows 待验收。 |
| OQ07 | 重构所需 exact schema／私有恢复资料兼容性。 | 原输入／旧恢复记录可验证，新配置不修改已封存业务摘要。 | 本地已关闭：资源配置在可信 workerData 单独传递，业务计划／journal 不增字段，旧记录和恢复回归通过。 |
| OQ08 | 性能和 GUI 响应验收阈值。 | 基线后、验收前固定；不得在只有耗时数据没有阈值时声称性能验收通过。 | Windows 待验收；本地并行运行耗时不作为正式性能基线。 |

## 十四、实际接口与装配

本节记录本轮实现机制；验证状态与历史失败见 [实施记录 §12](implementation-notes.md#12-2026-09-30-完整本地实现) 和 [验收矩阵](local-verification.md)。2026-10-02 起按 §14.5 的人工确认清单启用当前配置。

### 14.1 资源核心与 Main

生产 runtime 已使用 `createPlatformResourceEnvelope()` 的稳定 H，并将旧启动预算 Bcompat 注入静态策略。未迁移 action 仍受 Bcompat 限制。`assertSimpleJobFits()` 合并 Base 和实际候选 Phase 做稳定预检；实时采样只在 grant 前判断，不改账本、不重复扣 U。队列存在时每秒重新判断，目标阶段最多等待 5 秒。

`ExecutionMemoryConfigV1` 精确字段、缓存合计和 worker 参数校验后冻结。Main 的注册策略决定候选，Renderer 和不可变业务计划不能带配额。`worker-thread-adapter` 在创建 Worker 前设置获批 V8 上限，config 经单独 workerData 传入；发布 Worker 使用相同配置。

`memory-activity.js` 在 Main 观察全部原生载体直到 exit；上一 runtime 活动资源不会随 manager 替换消失。默认未分类 IPC 与已定位的纯 Main 后台维护是增长未知活动；运行时禁止低档与这些活动并行。控制／取消入口可用。载体清点与负例见 [资源入口表](resource-entry-inventory.md)。

### 14.2 prepare 与前端

`toolbox-split-read-owner` 使用 admission-only owner：grant → 同步创建 `{promise,closed,cancel}` → 真实 exit → 清理私有目录 → release。构造失败返回无载体事实；关闭未确认保留租约。v2 `toolbox:split:read` 返回 metadata/token/计数及实际读取模式，v2 `read-values` 只扫请求列，`cancel-read` 只取消当前窗口指定请求。源快照或窗口不匹配直接失效。

公共 metadata 与单字段补扫在生产资格 pending 时沿用旧扫描无独立内存预留的兼容合同：账本 `memoryBytes: 0`，同时申请 CPU／Worker／IO 槽位，真实 Worker 继续作为增长未知的重型活动观察。这里的 0 不表示工作集为零，也不授予实验低内存配置；有界 reader、字段值／缓存上限、低档互斥、真实退出与私有目录清理仍生效。不得把 rows／OP 已有的 1 GiB 申请移植成公共选文件的新门槛。资格获批后仍由 `split-prepare` 候选替换为已验证的阶段预算。固定资源配额无法容纳和资源争用超时分别保留 `RESOURCE_BUDGET_UNAVAILABLE`／`ADMISSION_TIMEOUT`，公共读取 IPC 显示中文原因；等待超时提示稍后重试。

兼容回归使用真实生产策略源码、显式 pending 清单夹具及注入的启动内存：总内存 8 GiB、启动空闲 512／2560／3584 MiB，对应 Bcompat 0／512／1536 MiB。测试脚本覆盖 CSV／XLSX 的 Main 读取 IPC、字段补扫、真实 Worker 按字段导出及回读，以及固定配额不足、IO 争用／超时、跨 Governor 低档互斥和实验获批配置替换。该合成验证不代表 Windows 真压力、完整应用界面、归档或安装包验收。

Renderer 初次打开和字段 change 不扫描；显式激活“值”入口才加载。状态分 not-requested/loading/complete/failed；支持真正空列、重试、同列请求共享、多组独立选择和迟到隔离。已切到 rows 可取消不再需要的字段补扫，不使基础 token 失效。兼容 v1 API 保留。

共享值面板另有独立的打开意图代次：每次激活值按钮（包括缓存命中）和关闭面板均推进代次。异步返回只有在分组、字段、视图和打开意图均仍有效时才弹出面板；迟到结果仍更新字段缓存及按钮状态。字段变更、增删组、取消和模式切换沿用关闭路径使旧打开意图失效。

字段缓存由会话持有，每个 picker 订阅自己使用的字段集合。新视图先订阅，旧视图销毁时只移除自身订阅；仅在所有视图都不再使用某字段时取消其 pending 请求。缓存的 loading／complete／failed 变化通知所有仍使用该字段的视图；发起分组的 generation 和存活检查只约束其面板打开，不决定其他分组能否接收状态。

### 14.3 reader、缓存、writer

Toolbox 新路径通过 `toolboxReaderOptions()` 启用 adaptive SST，传入独占临时目录、8 MiB SST 内存／4 MiB LRU、2 MiB 单条、收紧的 styles/theme 元数据预算。预算由实际 config 控制；旧调用未迁移时不扩大能力。close 等待 provider 和 ZIP，双重失败保留 AggregateError。

rows 保真缓存将样式逐条写入 SQLite；回放 SQL 查询加有界 LRU，使用估算字节淘汰并保留完整引用校验。`bounded-workbook-streams` 针对锁定 ExcelJS 4.4.0 的 `_openStream` 使用实际 PassThrough 写入回调，按字节计 pending，等待下游消费；不以 highWaterMark 自身声明完整硬上限。writer commit 和文件流真实关闭后清掉 writer/worksheet/registry，再运行原输出校验。生成结束另取 rows-io 租约验证 manifest，再取共享 publication-io 租约发布。

CSV 仍使用既有整表读取；parser 将逐字符拼接改为连续片段拼接，避免保留大量中间对象。64 MiB 预算仍只用于 rows；65 MiB 公共普通档兼容测试是真实 Worker 读取，不是绕过检查。

### 14.4 OP 与发布恢复

配置贯穿 import/candidate router、compute/result sink、六类 export 的 source/spool/writer/validator、自动报告的发布／最终验证、删除／升级与恢复。SQLite page cache 使用阶段 aggregate／实际并存连接数分配；源数据、金额、业务 SQL 和持久化 schema 不改。

OP publication owner 自有或借用可信 phase；共享 Publisher 只有在无领域观察 lease 时才额外申请，避免同一链路嵌套低档自等待。legacy IPC 已有未知重型观察时不降级复用新低档，保留原兼容执行边界。`acquireObservation` 在该作用域使用内部静态 action `publication:legacy-observation`，保留既有 BizOP 1 GiB 兼容额度及 Bcompat 检查；外层 Main 活动仍记为增长未知。当获批 phase 先排队并等待该 legacy 活动结束时，Main 静态 resolver 捕获当前活动的进程内 continuation 能力；队列仅在队首确实受该父活动阻挡时允许 continuation 先执行，夹在二者之间、已等待队首的请求也不阻断此次依赖解除。身份通过 WeakMap 绑定真实活动与 inventory 快照，作用域结束立即失效。该检查由 Main 静态装配以同步 provider 传入核心内存策略，核心层不导入活动表或原生载体模块。无关队列请求继续遵守优先级／FIFO；被选中的 continuation 仍经过完整资源、Bcompat、低档排他及超时／取消检查。wrapper 外仍按 `bizop-io` 的获批配置申请。借用能力的 root／owner／task／reason 校验和真实退出屏障保持。

无领域观察 lease 的共享 Publisher，在资格 pending 时沿用基线无独立内存预留的约定：兼容内存记账为 0，仍申请 CPU／Worker／IO 槽位，并持续观察真实载体的未知增长。这个 0 是账本预留值，不是工作集为零的声明。不得新增未经验证的 1 GiB 启动门槛。获批后 memory policy 将请求替换为 `publication-io` 的 normal 256 MiB／low 128 MiB；discovery 和 execute 均执行，损坏 journal 或未知 owner 的错误照常传播。旧恢复 journal 不增配额字段，重启时重新取当次资源。

### 14.5 候选配置与资格

| phase | normal MiB | low MiB | SQLite 最大同时连接 |
| --- | --- | --- | --- |
| split-prepare | 768 | 256 | 2 |
| rows-generation | 768 | 384 | 2 |
| rows-io | 256 | 128 | 1 |
| publication-io | 256 | 128 | 1 |
| bizop-import | 768 | 384 | 2 |
| bizop-compute | 768 | 384 | 3 |
| bizop-export | 768 | 384 | 2 |
| bizop-io | 256 | 128 | 2 |
| bizop-maintenance | 384 | 128 | 2 |

这些配置已按本次人工验收确认批准，数值不构成最低内存保证。normal/low 系统余量分别 192/128 MiB；SQLite aggregate 24/12 MiB；样式 8 MiB；in-flight 4 MiB；单条 2 MiB；Worker 老生代为阶段额度的 60%，年轻代 8 MiB。V8 限制不涵盖 native/external，运行安全点和真实容量验证仍必要。

2026-10-02，用户确认人工测试通过，并明确授权调整为人工确认启用。`memory-qualification.json` 使用 schemaVersion 2、status qualified，approval 记录 manual-acceptance／PASS、确认编号、日期和归属版本；profiles 显式登记上述 9 阶段的 normal／low 共 18 个 profileId／policyDigest。

v2 只在 Windows x64 Electron 运行环境中接受这些静态确认。启动时不再读取 sourceIdentity，也不要求源码／依赖锁／安装包摘要、精确 Node／Electron 版本、真实压力报告及重复次数。approval.releaseVersion 记录确认归属，不与尚未升版的 package.json 精确匹配；升版打包不会因此重新变成 pending。配置摘要变化、重复配置、缺少批准或 pending 状态仍保留对应兼容路径。新增／修改内存配置应重新验收并显式更新清单，不从当前代码自动补批生产配置。

`validatedEvidenceId` 继续随可信租约传递，值为人工确认编号。实时 inventory 完整性、未知增长观察、固定硬预算、实时系统内存及安全余量、低档互斥、取消和真实退出／清理／释放均由原准入及执行路径检查。没有 Renderer、环境变量或普通 runtime options 的放行开关。

schemaVersion 1 的历史构建证据校验保留原规则；人工确认不把旧报告补写为已实测，也不伪造包体／报告摘要。Windows 原始测量与安装包材料作为诊断资料单列记录。

`sourceIdentity()` 摘要包括 src（排除生成 build-info 和资格自身）、运行依赖、版本及 package-lock。打包通过独立的根目录 FileSet（`from: "."`、`to: "."`、`filter: ["package-lock.json"]`）将 lock 放入 ASAR 根目录，避开默认 matcher 追加的 lock 排除规则；该身份仍供容量诊断及 v1 历史资格使用，v2 人工确认不依赖它。打包输入洁净度门禁同时识别此 FileSet，对未跟踪、修改或删除的 lock 继续拒绝；不支持的目录映射明确失败。真实 builder 文件收集／拷贝和 Electron ASAR 身份回归验证包前包后身份一致，缺失／变更的 lock 不得沿用原身份。打包器删除开发脚本不改变该身份。

### 14.6 诊断与可运行验收

生产日志只写获批／释放的技术动作、模式、profile、policyDigest、字节、时间和 lease ID，不含业务行或路径。运行安全点使用 heapUsed＋external，arrayBuffers 不重复计入；系统可用内存低于安全余量时抛技术资源错误。

- `verify-low-memory-workflows.js`：保留的准备扫描基线探针。
- `verify-low-memory-capacity.js`：独立进程完整 metadata／单字段、rows 生成—验证—发布—恢复、OP 导入—计算—六类导出—恢复；支持真实系统采样或明确标注的注入模式，独立读回单独计时，输出排他创建。
- 脚本始终 `productionEvidence:false`，不编辑资格 manifest。Windows 真实 Main、GUI、安装包、Excel/WPS 和代表性业务验收见 [操作说明](windows-acceptance.md)。

本轮人工确认资格回归：`scripts/integration/production-memory-qualification.js` 使用当前随包清单及真实生产策略，覆盖 18 个配置、资源负例和完整 rows／BizOP 工作流；平台事实和内存读数为测试注入，结果不表述为重新执行了 Windows 实机验收。
