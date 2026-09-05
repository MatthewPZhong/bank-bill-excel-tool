# 版本功能变更清单

说明：

- 本文档按版本号整理 `新增 / 变更 / 移除` 功能点。
- 内容以 [CHANGELOG.md](../CHANGELOG.md) 为事实来源整理。
- 以后每次版本迭代，需同时更新：
- `CHANGELOG.md`
- `docs/VERSION_FEATURE_HISTORY.md`
- `docs/USER_GUIDE.md`

## v3.2.5（2026-09-05，正式发布候选）

v3.2.5 完成 Pending、BizOP、PreFund、Position、VCC Financial OP 与 Acquiring 剩余只读导出和成熟执行器 adapter，并以 54 个 action 的 Manifest、Capability Inventory、Effective Production Strategy 与逐 action release evidence 收口后台执行平台外围能力；production enablement 保持关闭。

### 新增

- Pending/BizOP 五条只读导出、PreFund/Position/VCC Financial OP 四条只读导出和 Acquiring copy/regenerate 两条静态分类 capability；所有输出继续使用模块原有 SQL、排序、金额/币种、Workbook 与 Publisher 语义。
- Pending/BizOP big-table、Acquiring import/run/resume 与 Position utility-process adapter；adapter 不在旧 dispatcher 外额外 spawn，也不改变事务、chunk、Critical Intent、receipt、取消或恢复拓扑。
- 54-action Action Manifest、Capability Inventory、Effective Production Strategy Snapshot 和 324/324 surface coverage；16 个 legacy-only action 与 2 个 platform canary 不伪装成 runtime capability。
- R3.2.5 逐 action evidence，分别记录 baseline fixture、语义/DB/Workbook/故障/资源、Windows、人工复核和 production decision。

### 变更

- package 元数据更新为 `3.2.5`；顶层 Spec/TechDoc 继续记录冻结来源，并以受测试约束的 current-tree 修订纠正 Position export、Acquiring topology、Position identity 和 deferred PreFund action 的真实 authority。
- capability 与 effective strategy 完全分开：36 个 implemented capability 可审计，但全部 54 个 action 的 effective mode 仍为 legacy、worker count 为 0，生产启用数为 0。

### 兼容与人工边界

- 业务 SQL、稳定排序、金额、币种、Workbook、事务、幂等、取消、恢复、进程拓扑和 legacy 用户入口不变；legacy seam 不自动删除。
- 冻结 R3.2.5 evidence 中 Windows packaged 的 `NOT_RUN`、真实样本与资金/恢复的 `PENDING_HUMAN_REVIEW`，以及 Excel/WPS、RSS 和稳定观察窗口的未执行状态保持不可篡改；自动测试和发布授权都不能据此启用 production。
- 发布负责人 `MatthewPZhong` 于 2026-09-05 另行确认本次资金、恢复、真实业务样本及稳定窗口人工验收通过，该签字只覆盖本次正式技术发布，不改写冻结 R3 快照。发布已获授权通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 完成；Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装与 `production/latest` canary 按 Issue #220 在发布后逐项补做。workflow 内置 `release-check` 获授权，本地 `release-check` / `check-vars` / `scan:vars` 未运行且不得声明为 PASS；production 继续 disabled/legacy。

## v3.2.4（2026-09-04，正式发布候选）

v3.2.4 完成 ReconFix 长驻 Service、JPM durable mutation/Inspector、多 artifact 原子发布，以及 VCC Financial OP 单 Writer、主体查询下推和最多双 Writer 的后台执行 capability；production enablement 保持关闭，既有金额、币种、方向、匹配、Workbook、样式、行序和用户流程不变。

### 新增

- ReconFix 长驻 Service，统一持有导入状态、revision、source evidence 与运行结果；普通/BOC 只读 action 和 JPM mutation action 使用独立策略与证据门禁。
- JPM ID-aware ADM reader、精确 no-op、pre/post image、Critical Intent、同事务 marker/receipt、receipt-first Inspector 与 Recovery Hold。
- ReconFix 多 artifact task-private staging、Main 深度回读和唯一 Publisher，全有或全不发布。
- VCC Financial OP 单 Writer、subject filter pushdown、deterministic 1/2 Writer 分片、全组 Join、单一 Publisher 与有界 SafeError/cleanup。

### 变更

- committed-result-lost 固定保持 `interrupted + RESULT_LOST + active Recovery Hold`；not-committed 才按确定性失败收口并解除对应 Hold，unknown 不自动猜测或重跑。
- VCC 双 Writer 只在相同冻结 authority 下并行读取不同主体；任何缺失、重复、错 owner、篡改、取消或 child crash 都在 Publisher 前 fail closed。
- package 元数据更新为 `3.2.4`，顶层 Spec/TechDoc 同步自冻结基线；R3 evidence 保留为独立 exact Git head 复验。

### 兼容与人工边界

- ReconFix/VCC 的金额、币种、方向、业务键、匹配、Workbook、样式、Pending 投影、行序、命名与 legacy 用户流程不变。
- capability 与 effective production strategy 分离，6 个 action 的 production 均关闭、effective worker count 为 0；冻结 R3.2.4 evidence 中的 `PENDING_HUMAN_REVIEW` / `NOT_RUN` 保持为不可改写的历史快照。
- 发布负责人 `MatthewPZhong` 于 2026-09-04 另行确认本次资金、恢复、真实业务样本及稳定窗口人工验收通过。Issue #220 授权本版通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 发布技术 stable Release；Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装与 `production/latest` canary 在发布后逐项补做。workflow 内置 `release-check` 获授权，本地 `release-check` / `scan:vars` / `check:vars` 未运行且不得声明为 PASS。

## v3.2.3（2026-09-04，正式发布候选）

v3.2.3 完成 Statement 交互式大状态 Service、原子 balance seed 与 NewAccount Worker/Publisher 的后台执行 capability；production enablement 保持关闭，既有金额、币种、借贷方向、余额、Workbook、命名和用户流程不变。

### 新增

- Statement 长驻 Service，统一持有导入 session、映射行、revision、交互上下文和生成状态；主进程只接收有界 DTO。
- 大账号与手工余额 continuation 使用 opaque、单次消费、受 TTL 和资源 reservation 约束的 token，并用 candidate-first replacement 保留失败后的旧 token 可用性。
- Statement current/all 生成使用只读 Worker、staging manifest 与唯一 Publisher；manual balance seed 使用 durable intent/receipt、inspector 和 Recovery Hold。
- NewAccount 生成使用 one-shot Worker，另存为使用 source/target/direct-parent identity 校验、异步 staging copy 与 durable Publisher journal。

### 变更

- 大文件解析、长驻状态和生成过程不再把完整可变状态复制回主进程；资源 grant/adopt/revoke/release、operation receipt 和取消/关闭顺序由冻结合同管理。
- 来源漂移、输出篡改、崩溃、部分提交和结果丢失按精确 identity、manifest、receipt 与 inspector 收口，不自动重跑或把未知状态伪装为普通失败。
- package 元数据更新为 `3.2.3`，顶层 Spec/TechDoc 同步自冻结基线。

### 兼容与人工边界

- Statement 的四金额模式、借贷方向、币种、余额、current/all 行序和 Workbook，以及 NewAccount 的日期、账户、币种、命名和模板语义不变。
- capability 与 effective production strategy 分离，production 仍关闭；发布负责人 `MatthewPZhong` 于 2026-09-04 明确确认资金、恢复、真实业务样本及稳定窗口人工验收通过，该签字只覆盖本次发布。
- Issue #220 授权本版通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 发布技术 stable Release；Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装与 `production/latest` canary 在发布后逐项补做。workflow 内置 `release-check` 获授权，本地 `release-check` / `scan:vars` / `check:vars` 未运行且不得声明为 PASS。

## v3.2.2（2026-09-04，正式发布）

v3.2.2 完成 FundRecon、Duplicate 与 BankBU 的后台执行 capability 和恢复审计基础；production enablement 保持关闭，既有金额、币种、匹配顺序、Workbook 与用户操作合同不变。

### 新增

- FundRecon 长驻单 Service，统一持有银行、网关、退款会话与运行结果，并继续按 R1→R5/M2M 顺序执行。
- Duplicate 长驻 Service、启动前 inspector/Recovery Hold、worker-durable receipt，以及只负责准备 spool 的可选 paired parser。
- BankBU one-shot Worker、side/main 同一 operation identity、恢复 inspector，以及只负责读取两个输入的可选 dual parser。

### 变更

- 主进程不再作为这些模块完整可变状态的第二所有者；只保留有界 DTO、资源 grant/reservation、TaskLifecycle 和 artifact authority。
- 崩溃、超时、部分提交和结果丢失按持久 receipt/inspector 收口；未知状态不会自动重跑或伪装为普通失败。
- 修复普通 no-file 配置任务的空 evidence 合同，模板重命名不再在执行前被 TaskLifecycle 拒绝，最终 Hold gate 保持不变。
- 人工余额补录从 freshness、导入上下文或当前 statement session 恢复真实源文件 FilePlan；余额 `0` 可正常保存，无来源或 IPC 失败时给出可见反馈并保留草稿。
- package 元数据更新为 `3.2.2`，顶层 Spec/TechDoc 同步自冻结基线。

### 兼容与人工边界

- 业务 SQL、匹配顺序、候选消费、金额/币种、Workbook、事务和幂等语义不变；capability 与 effective production strategy 分离，生产仍关闭。
- 发布负责人 `MatthewPZhong` 于 2026-09-04 明确确认资金、恢复、真实业务样本及稳定窗口人工验收通过；最终 Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装与 `production/latest` canary 依据 Issue #220 在发布后逐项补做。
- Issue #220 授权本版通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 发布技术 stable Release；production strategy、feature flag 和 effective worker 继续 disabled/legacy。workflow 内置 `release-check` 获授权，本地 `scan:vars` / `check:vars` 未运行且不得声明为 PASS。
- PR #225 已普通合并，最终 `main=c2d23f5981b1b2218b0988cf13e7e048e02ced46`；annotated `v3.2.2`（tag object `9be1783cec1e3629d2ba3d8faa2d49d0cf999c04`）精确指向该提交，Release run `33835873671` 与 Setup、portable、blockmap、`latest.yml` 四项资产均完成独立回读。


## v3.2.1（2026-09-03，正式发布）

v3.2.1 完成 Toolbox 单 Writer后台生成与 PreFund MPT parser spool、durable receipt、单 Writer和受限 parser pool capability；production enablement 保持关闭，既有文件顺序、金额、币种、Workbook、事务、幂等和用户操作合同不变。

### 新增

- Toolbox one-shot generation Worker 与密封 route DB；输出准备可隔离执行，正式文件仍由单一 FIFO Publisher 收口。
- PreFund MPT 任务私有 spool、file-level durable receipt、inspector/Recovery Hold 与单一有序 DB Writer。
- 普通 import 的受限 parser pool capability；repair 保持 exact-one，完成顺序不参与业务顺序。

### 变更

- dispatch/cleanup ownership、critical intent、receipt 和恢复判定进入冻结后台执行合同；unknown/partial/committed-result-lost 不会自动重跑或伪装成普通失败。
- E04-C 第二 Writer gate 明确 rejected；Toolbox 写入拓扑和正式 Publisher 没有被并行化。
- package 元数据更新为 `3.2.1`，顶层 Spec/TechDoc 同步自冻结基线，并通过 natural merge 包含正式发布的 v3.2.0 最终 `main` 合并提交。

### 兼容与人工边界

- E04-C/E05-C 未满足 gate 继续阻止 production 切路，legacy seam 保留；本版不新增用户开关。
- 发布负责人 `MatthewPZhong` 于 2026-09-03 明确确认资金、恢复、真实业务样本及稳定窗口人工验收通过；该签字只覆盖本次发布。最终 v3.2.1 资产产生后才能完成的 Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装和 `production/latest` canary 依据 Issue #220 在发布后逐项补做。
- Issue #220 授权本版通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 发布技术 stable Release；production strategy、feature flag 和 effective worker 继续 disabled/legacy。workflow 内置 `release-check` 获授权，本地 `scan:vars` / `check:vars` 未运行且不得声明为 PASS。
- PR #223 与 safe forward-fix PR #224 已普通合并，最终 `main=c547097c8829c1c39437fe9047b5accbf5f1e388`；annotated `v3.2.1` 精确指向该提交，Release run `33807861470` 与 Setup、portable、blockmap、`latest.yml` 四项资产均完成独立回读。

## v3.2.0（2026-09-03，正式发布）

v3.2.0 完成公共后台执行 Supervisor、协议/恢复控制底座与 VCC OP 多文件 parser pipeline；production enablement 保持关闭，既有金额、币种、月份、Workbook、事务、幂等和用户操作合同不变。

### 新增

- 固定入口白名单、冻结 context、单次 settle、取消/超时/退出竞态保护与有界 DTO 的公共后台执行 Supervisor。
- grant/reservation、operation receipt、inspector、Recovery Hold、artifact authority 与策略快照等恢复和审计基础。
- VCC OP 多文件 parser pipeline，只并行独立文件读取并准备 spool。

### 变更

- 主进程继续作为 IPC、TaskLifecycle、业务锁和正式文件发布的唯一控制面，不再要求长任务在事件循环中完成全部 CPU/读取工作。
- VCC OP 的完成顺序不参与业务顺序；月份归约、金额/币种处理、缓存切换、单一 writer、事务和 Publisher 仍串行收口。
- package 元数据更新为 `3.2.0`，顶层 Spec/TechDoc 同步自冻结基线。

### 兼容与人工边界

- capability 与 effective production strategy 分离，legacy seam 保留，生产仍关闭；本版不新增用户开关。
- 发布负责人 `MatthewPZhong` 于 2026-09-03 明确确认资金、恢复、真实业务样本及稳定窗口人工验收通过；该签字只覆盖本次验收。最终发布资产的 Windows 10/11 Setup/portable、SmartScreen、离线覆盖安装和 `production/latest` canary 依据 Issue #220 在发布后逐项补做。
- Issue #220 已授权本版通过受保护 PR、唯一 annotated tag 与 Windows Release workflow 发布技术 stable Release；production strategy、feature flag 和 effective worker 继续 disabled/legacy。PR/tag workflow 的自动检查不得替代人工结论；本地 `scan:vars` / `check:vars` 未运行且不得声明为 PASS。
- PR #221 已以 merge commit `92380fd84471b061b7a84842be7da001aa82db87` 合入 `main`；annotated `v3.2.0` 精确指向该提交。Release run `33731833335` 的 attempt 2 全部成功，四项公开资产的大小、SHA-256 与 `latest.yml` 中 Setup SHA-512 已独立回读一致；application production 仍为 disabled/legacy。

## v3.1.14（2026-08-21）

v3.1.14 修复 VCC 财务 OP 大批量明细在工作簿读取完成后的数据库收尾退化，并增加真实阶段反馈。本版已于 2026-08-21 通过受控 Windows Release workflow 正式发布为 latest stable Release。

### 新增

- 明细 progress 增加 `reading` 和 `committing` 两种真实阶段。每个完成读取的明细 sourceType 在最终读取提交后、分类提升调用前上报一次 committing；旧无 phase 事件继续按读取展示。
- 状态框在数据库阶段显示“正在校验并写入 {原表名称}：{rows} 行”。

### 变更

- staging 自引用列增加 partial index，消除外键清理的重复全表扫描；新库和已有 contract-v2 库均通过正常 ensure 幂等安装。
- 取消中忽略晚到的 reading/committing，保持取消回滚提示；后端取消与 120 秒终止合同不变。

### 兼容边界

- storage contract 继续为 v2；不改变金额、币种、幂等、异常、revision、归档或清理算法。
- 已创建索引的数据库回滚应用代码后仍保留索引和性能收益；只有未升级数据库或恢复旧备份才可能重新缺索引。

### 正式发布结论与人工边界

- 功能 PR #162 以 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` 合入产品代码，发布准备 PR #163 以 merge commit `225d07d17a7c211348ba549734aaf84f602253cb` 收口 `main`；annotated tag `v3.1.14` 的 tag object 为 `fee1498311854a69fea666fe275511da89d99836`，peeled 后精确指向该发布准备提交。
- Windows Release workflow [32508170702](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32508170702) 全部 15 步成功，并创建 [v3.1.14 latest stable Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.14)。Release 公开、非 draft、非 prerelease；GitHub 默认 latest 回读 `tagName=v3.1.14`。
- Setup、portable、blockmap 和 `latest.yml` 四项资产已通过无凭据公开 HTTPS GET 与独立摘要回读；实际大小/SHA-256 与 GitHub digest 一致，`latest.yml` 的 version/path/size/releaseDate 与 Setup SHA-512 均一致。两个 EXE 为 Windows PE32 GUI / Nullsoft Installer 自解压文件，认证与匿名下载逐字节一致。
- PR #163 body 已稳定记录实际批准人、完整豁免范围、理由及发布后逐项补做计划；最小 `main` 冻结窗口在 `Verify tag and main` 成功后闭合。workflow 首轮成功，未触发受控重跑；Release/资产未创建时的基础设施瞬时故障边界继续保留。
- Windows packaged VCC 阶段/取消体验、Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 离线覆盖和 `production/latest` canary 均为 `MANUAL / NOT RUN`。技术 Release 完成不是验收 PASS；任一补测失败都停止推广并发布更高补丁版本。
- GitHub API 当前 `isImmutable=false`；仓库仍把 tag 与资产视为不可变，不删除、替换或重传。

## v3.1.13（2026-08-20）

v3.1.13 调整工具箱主弹框、存档中心前端与模块状态框：工具箱新增合并/拆分状态反馈和运行保护，多文件拆分的同名覆盖确认把【取消】改为【返回】；存档中心默认展示全部日期的批次，并精简两个设置入口、设置统计和后台维护提示；平盘对账数据处理与对账单修复恢复“欢迎使用小助手”的成功初始化文案；所有状态框移除星星 SVG。本版不改变 Excel 内容、格式保真、存档数据、批次、对账结果或整批可恢复发布合同。

**工具箱界面**

- 状态框跨“合并表格 / 拆分表格”两行，左沿与“工具箱”标题对齐，上下沿分别对齐两枚【导入文件】按钮；144px 外框宽度严格等于 72px 标签布局宽度的两倍。
- 初始显示“等待操作”；合并、拆分读取和拆分导出分别显示运行中、完成、失败或取消状态。完整保存路径、格式转换提示和错误明细继续使用既有应用内提示框。
- 任一工具箱 IPC 运行期间，右上角关闭按钮隐藏，两枚【导入文件】同时禁用，遮罩关闭也被阻止；Promise 收口后统一恢复。

**多文件拆分**

- 输出目录中存在同名文件时，原生确认框显示【返回 / 覆盖全部】。
- 【返回】继续在文件计划和临时目录建立前整批取消，目标目录不产生新文件且旧文件不变；【覆盖全部】继续走原有可恢复发布。

**存档中心界面**

- 日期选择框默认留空，首次进入即展示现有查询返回的全部可见批次；用户仍可按日期、模块和批次号筛选，清空日期后恢复全日期范围。
- 存档设置齿轮直接位于“存档中心”标题右侧，文件总大小继续在标题栏右端显示。
- 设置页【变更】直接位于“存档位置”右侧，完整路径继续在下一行显示；“存储统计”、文件总大小、运行次数和最新批次不再展示，迁移进度和保留期限保留。
- 顶部提示栏不再展示后台维护的启动、进度、完成、失败或维护删除选中批次文案；维护完成后仍刷新列表和浏览页文件总大小，列表、迁移、删除等非维护错误仍正常提示。

**模块初始化状态**

- 平盘对账数据处理和对账单修复首次成功加载时继续同步真实 session、场景、待确认结果与按钮状态，但状态框保持“欢迎使用小助手”。
- 自动切出再切回只刷新数据和按钮，不覆盖当前进程内的导入、运行、导出或选择反馈；状态读取失败结果与 IPC 异常仍显示错误。

**全局状态框样式**

- 主页面 13 个静态状态框和工具箱动态状态框全部移除星星 SVG，只保留状态文字；不保留空图标容器或图文间距。
- 状态框的外框尺寸、位置、文字居中/换行、长内容滚动、色调、可访问性与更新逻辑保持不变；按钮和其它功能性 SVG 不受影响。

**兼容性**

- 工具箱、存档中心及两个对账模块的 preload/IPC 返回契约、输入文件类型、字段匹配、输出命名、格式保真、存档和恢复行为不变；金额、币种、匹配、回填与按钮判定不变。
- v3.1.12 及更早版本生成的文件和存档无需迁移。

**正式发布结论与人工边界**

- 功能 PR #159 已以 merge commit `9e68c0339427a91c1948f73bfae66f0a76d17b5c` 合入产品代码，发布准备 PR #160 再以 merge commit `099f2c9c8078c83785d71c499a68f2a818ab8c7c` 收口 `main`；annotated tag `v3.1.13` 的 tag object 为 `5d5c9c828869bc82931cd1861f4cff3a099b5f32`，peeled 后精确指向发布准备提交。
- Windows Release workflow [32455995895](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32455995895) 首次在真实 PowerShell snapshot 15 秒硬超时处 fail closed，构建和发布未开始；同一 tag/commit 受控重跑后全绿，并创建 [v3.1.13 latest stable Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.13)。
- Setup、portable、blockmap、`latest.yml` 四项资产均可无凭据公开下载；独立下载的大小、SHA-256 与 GitHub digest 一致，Setup SHA-512 与 `latest.yml` 一致。资产细节见 `docs/WINDOWS_RELEASE_RUNBOOK.md`。
- Windows 原生确认框、packaged 长任务交互、系统字体、Windows 10/11 Setup/portable、SmartScreen、`v3.1.12 -> v3.1.13` 离线覆盖安装与 `production/latest` 在线 canary 仍为 `MANUAL / NOT RUN`；技术 Release 完成不是人工验收 PASS。
- tag 与资产按仓库不可变规则管理，后续不得删除、替换或重传；GitHub API 当前未启用平台级 immutable 标记，若补测失败仍须停止推广并发布更高补丁版本。

## v3.1.12（2026-08-20）

v3.1.12 在保留 v3.1.11 文件批次与 VCC 存储安全合同的基础上，收口网银源文件确认、Windows 启动性能、VCC CNY/CNH 新导入口径和存档中心迁移/维护。本版仅对新导入建立新的币种与哈希合同，不迁移、不回填历史资金数据。

**网银源文件与启动**

- 网银账单每次生成只在业务执行前做一次“选择时快照 vs 当前文件”比较；缺失或变化时统一要求重新选择，业务输出和成功会话保持为零。实际读取仍有起止稳定性保护，大账号顺序证据在预检时冻结，后续不重读源文件。
- 窗口只在数据库、必要恢复、outbox、一次 VCC lineage/hold 门禁和模板同步全部成功后创建并显示；失败使用原生弹窗退出，不再保留加载页或 `initPending` 两阶段界面。
- 每次启动的无参数 `ANALYZE` 改为 `PRAGMA optimize=0x10002`；重复 VCC 核对删除，保留核对改为集合查询并补索引。非关键存档维护移到首次进入存档中心后的后台分页阶段。

**VCC 财务 OP 币种**

- 新导入接受标准大写 `CNY` 和 `CNH`，业务字段统一保存为 CNY；原始审计保留源文件词法，小写或混合大小写仍拒绝。历史数据、历史哈希和历史结果不修改。
- 非通道“我方币种”、通道实际选中的交易/清算/结算币种、Pending 两侧币种和系统财务 OP 都使用同一规范口径。普通明细合并计入 CNY，Pending 的 CNY/CNH 不再误判错币。
- 幂等内容哈希使用规范副本；只差 CNY/CNH 写法时跳过，金额或其它内容变化仍冲突。同主体同月同时出现 CNY 和 CNH 时拒绝该系统主体，其它完整主体继续。计算、校验、归档和 Excel 仍固定九币种且只展示 CNY。

**存档中心**

- 设置页第一行显示“存档位置”和右侧【变更】，第二行显示完整可复制路径；长路径换行显示，不再省略。
- 变更位置会暂停新存档、核验源文件、复制并逐文件校验目标、原子切换设置，最后清理旧根；切换前失败保留旧根，切换后清理失败进入可恢复状态。未知文件、越根路径和缺少 owner 证据的内容不会被读取、复制或删除。
- 每次启动首次进入存档中心时先显示批次列表，再后台分页执行 cleanup journal、元数据/指纹、保留期、目录化、受控孤儿和历史健康维护。新文件保存最终指纹；旧存档不全量补扫，只在打开、另存或迁移时按需核验。

**验收状态**

- 网银、VCC、启动、存档中心和 Windows 验收工具链分别经过独立 Reviewer 多轮反例复核，最终均无阻塞 P3+；自动门禁和测试数字记录在 `changes/3.1.12/implementation-notes.md`。
- 发布负责人于 2026-08-20 明确确认 v3.1.12 验收完成并授权合并至 `main`。仓库只保存该最终结论；数据库、WAL/SHM、用户目录及原始日志等敏感材料不随本次合并提交。
- v3.1.12 已于 2026-08-20 正式发布。PR #157 以 merge commit `a8c632bad119eab6bca27b949dfb5956805cf3ae` 合入 `main`；annotated tag `v3.1.12`（tag object `97462b6062dda9a31d409691b0d2c2dec94f0650`）触发 Windows workflow `32393079026`，并发布为 GitHub Releases 的 latest stable Release。
- Setup、portable、blockmap 和 `latest.yml` 四项资产均已公开且可匿名下载；3.1.12 安装包随包交付修正后的用户指南。v3.1.11 已发布安装包中仍含“未发布候选”的旧指南，旧 tag 与资产继续保持不可变。
- 本次 macOS 收尾没有执行 Windows `production/latest` 在线升级 canary；在 Windows 人工补测完成前，只能声明“3.1.12 正式发布”，不能声明“在线升级已验证”。

## v3.1.11（2026-08-19）

v3.1.11 同时收口存档中心的文件批次合同与 VCC storage contract-v1 升级边界：前端只显示至少一项真实文件证据的批次，无文件操作不发号；VCC 只允许可证明为空的 v1 自动升级为空 v2，任何非空 v1 都会在写入前停止。

**存档中心文件批次**

- 只有非空文件 manifest 与 File Batch 原子建立时才分配 `YYYY-MM-DD-NNN`；纯计算、确认、调整、归档、解归档、删除和配置保存只写内部 Task Run，不显示卡片、不推进序号。
- list/get/stats/latest/related 统一排除零 artifact 历史批次。已有真实文件证据的失败/取消文件任务仍按事实显示；取消 picker、deferred 零输出和 manifest 事务失败不占号。
- 关联任务沿用现有平铺列表。同 parent 关系继续兼容普通流程；Biz OP、Pending、前置资金对账以精确 dataset/run lineage 返回直接一跳输入与输出，不按日期、月份或 latest 猜测，不递归扩散。
- 63 file / 59 no-file / 117 exclude action 全部显式闭合；临时 allow-list 删除。Statement、Position、Acquiring、VCC 和 Toolbox 的文件路径只来自冻结 FilePlan。
- VCC import 在业务前 settle 输入并持久化真实 artifactId；ID 缺失或 owner、source operation、SHA/大小不符时 fail-closed。VCC output 与 Toolbox committed receipt 由原 File Task 跨重启接管。
- 017/018 只允许精确指纹 repair；001 保留失败输入证据，不伪造输出或成功状态。

**VCC 存储与界面**

- 空 v1 启动时原子替换为空的精简 effective schema，写入 contract-v2 marker、安装连接能力 guard，并回读外键和字段；重复启动幂等。
- 全新安装在首次初始化中直接得到无业务/审计数据的 v2；旧空 v1 静默升级为同一状态。两种情况都不会出现升级按钮、进度条、迁移弹窗或额外状态提示；正常初始化产生的空 module-state 结构单例不代表历史数据恢复。
- 非空 VCC 表、非空固定首月或未知非空 VCC 表都会触发 fail-closed；软件不会自动搬迁或删除历史财务数据，也不会继续按 v1 写入。
- 数据管理移除【优化存储】及对应 preload/main IPC。COW rebuild、journal recovery 和 v2 guard 仍作为内部恢复与一次性维护基础。
- 导入记录不再显示任何原始文件存档状态小字；内部 artifact 状态、失败主状态、计数和异常导出仍保留。
- 移除【标记已处理】及对应弹窗、IPC/API 和 unresolved 操作门禁。失败尝试不进入有效数据集，运行继续使用此前已生效的数据；旧处置字段只作兼容保留。
- 数据管理弹窗保持立即打开；快速读取不再闪现三条横向骨架，读取超过 150ms 才显示加载占位，读取完成、失败或关闭后自动清理。
- 当前机器既有非空 v1 已使用一次性 reset-only COW 完成处理，清空范围仅为 `vcc_fin_op_*` 业务/审计行；活动库由 36.44 GB 缩至 2.84 GB，切换后独立复验时 23 张 VCC 表合计 0 行，Archive batch/artifact/Blob/flow/issuance、其它模块和自增高水位守恒；后续启动可创建空的 module-state 结构单例。同目录 JSON 审计报告继续保留；旧 v1 备份在独立复验后按用户再次明确授权永久删除，回收约 33.94 GiB，当前机器不再具备旧 v1 整库回退能力。这不是发布给所有用户的自动 migration。

**正式发布与验收**

- 发布负责人于 2026-08-19 明确确认真实数据库副本、存档中心 UI、017/018/001、Biz OP/Pending/前置资金对账、VCC/Position/Acquiring 的文件与资金血缘门禁全部 PASS；原生产数据库未修改。
- Windows 10/11 Setup、portable、SmartScreen 实际提示和 `3.1.10 -> 3.1.11` 离线覆盖安装全部 PASS，未使用 Windows Runbook 豁免。
- PR #150 以 merge commit `782415ae1f606da2adebe881ba7ab56b1b045137` 合入 `main`；annotated tag `v3.1.11`、Release workflow `32219459465`、latest stable Release 与四项公开资产均已完成回读。
- 发布 commit 的完整门禁为 lint/smoke PASS、unit 5376/5376、integration 48/48 脚本与 2393/2393 断言 PASS。

## v3.1.10（2026-08-17）

v3.1.10 将 VCC 财务 OP 的长期原始数据真相从 SQLite 大字段转移到存档 artifact，并把逐行导入审计收敛为真正异常；同时提供显式、可恢复的 copy-on-write 物理重建。该版本已于 2026-08-17 通过受控 Windows Release workflow 正式发布。

**精简存储和可解释血缘**

- 有效行只保留计算、校验、幂等和最小来源字段；纯幂等跳过、正常回滚不再永久保存逐行原始值。真正的格式、键、内容冲突和系统主体异常进入紧凑异常表。
- 输入文件以 SHA-256、大小、导入记录和 Archive artifact 绑定；当前有效行对应的 artifact 由 business hold 保护。业务成功而存档失败时暂存 fallback，重试通过同一 SHA/size 后清除。
- 业务前 durable handoff、worker 首写前复核和 ready artifact expected SHA/size 冲突检查共同关闭“同路径 A→B”窗口；contract-v2 trigger 阻止 v3.1.9 连接继续写新 VCC 合同。

**异常明细和校验原表导出**

- 移除永久逐行“查看导入明细”，只在存在真正异常或文件级失败时提供六列【导出明细】；纯成功、纯幂等跳过不显示。
- 校验原表从已验证 artifact 按当前 effective 行重建。历史缺口允许二次确认后的部分导出，文件名和“导出说明”明确标出不完整；已绑定 artifact 损坏、SHA/大小或行级哈希不符则整次失败。

**维护模式物理重建**

- 【优化存储】先收敛 WAL、检查空间/完整性并阻止新任务，再创建候选库并验证六类计数、哈希集合、各月来源、结果、调整、归档、九币种余额、artifact 和 hold。
- journal 与 worker ready/ack 写锁交接覆盖切换和崩溃恢复。切换前失败保留旧库，切换后首次只读校验失败进入受控回滚；旧库仅按用户明确选择删除。

**发布状态和验收结论**

- 用户于 2026-08-17 明确确认三项发布门禁均为 PASS：真实约 27.42 GB 副本迁移后的逐表 `dbstat` 与至少下降 75% 目标、Windows installer/portable 的 SQLite/WAL/文件占用与恢复、主体×九币种和 archive SHA 血缘人工复核；Windows 门禁未使用豁免。
- 功能 PR #147 与发布收口 PR #148 已合入；PR #148 的 merge commit 为 `35f11e153962c34cba0e9d4c7084e9df85c9f209`。annotated tag `v3.1.10`、Release workflow `32005912319`、latest stable Release 和四项公开资产均已完成独立回读。
- 本次签字不自动覆盖未来月份、主体、输入来源或存储环境；后续处理仍应持续抽查资金事实、异常处分和文件 SHA 血缘。

## v3.1.9（2026-08-13）

v3.1.9 把存档中心升级为全部业务任务共用的批次与运行文件中心，并补齐 VCC财务OP校验、工具箱、目录化存储、位置迁移和统计界面。该版本已于 2026-08-13 通过受控 Windows Release workflow 正式发布。

**全局批次与任务生命周期**

- 新任务使用全局 `YYYY-MM-DD-NNN` 批次号，同一天跨模块和工具箱连续发放。实际处理、写入、导出和删除会计入运行次数；查询、预览、文件选择取消不会计次。失败、取消或删除后的号码不会复用，“最新批次”也不会倒退。
- 导入、运行、导出等独立任务各自保留状态，同一业务流程的多个批次在详情页显示为关联任务；关联关系可跨重启恢复，明确重跑会建立新流程。
- VCC财务OP校验已把真实导入、运行、调整、归档、解归档、删除和导出纳入批次；工具箱合并/拆分导出把真实输入与全部最终输出纳入同一批次。两者不再只是筛选名称。

**VCC 性能、兼容与保护**

- VCC 数据管理的月份、归档和删除信息改为后台读取，页面先显示可操作框架、加载状态和失败重试，减少大库读取期间的界面卡顿。
- VCC 人民币代码统一为 CNY：系统财务OP不再执行 CNY→CNH，币种校验和结果模板只接受/展示 CNY；历史原始审计不改写，存量派生结果兼容升级。
- 四类明细改为逐行过滤空键、格式异常和幂等冲突，正常行继续落库；系统财务OP按完整主体九币种快照过滤异常主体，其他完整主体继续落库。结构损坏、取消和已归档账期仍保持整体失败关闭。
- 标准 v3.1.7 四数据集旧归档可继续列出、预览、导出和受控解归档；未知结构或目标生产库状态不一致时明确停止。旧归档成功解归档后须继续使用 v3.1.9 重算和处理，不能由旧版应用继续写入。
- 调整、归档、解归档和删除在真正提交时重新核对预览依据与当前状态；期间数据变化、运行环境缺少安全能力或存在未知触发行为时，在资金事实变化前停止，不启用旧路径兜底。

**目录、迁移与界面**

- 运行文件按 `年份 / YYYY-MM / YYYY-MM-DD / 批次号` 组织。批次目录始终使用与 canonical Blob 独立的只读 copy，并校验大小和摘要；历史 hardlink 会在可信校验后脱钩。可证明的副本损坏可以 repair，存档真相不可信时停止并要求可信来源重试。
- 保留期限、锁定、手工删除和启动清理共用一致规则；共享文件只在最后一个引用消失后释放，并清理空的日、月、年目录。
- 存储位置支持完整迁移。根目录 marker 用于确认存档身份，根外 journal 记录复制、校验、切换与清理进度；异常退出可按记录恢复，旧默认根只在完整性证明成立时补齐身份，未知或冲突目录不会被接管。
- 存档中心显示文件总大小、运行次数、不可回退的最新批次及状态；列表使用两行布局，详情支持关联任务、锁定/解锁、打开只读副本和另存为。设置页显示“版本管理”和“返回”，保留期限快速连续修改以最后一次选择为准。

**发布状态与人工验证边界**

- PR #132—#145 已按堆叠顺序合入，最终 review 修复 PR #135 将 `main` 收口到 `3edf0527d6537d29cb19b48bda2a3f91f0ce6e32`。annotated tag `v3.1.9`、Windows Release workflow、latest stable Release 和四项公开资产均已完成独立回读。
- Windows installer/portable 实际运行、目标生产库 legacy/trigger 检查、约 16 GB 性能、约 700 万行多 Sheet 工具箱、跨卷与网络路径、Excel/WPS，以及主体×九币种、跨月、调整后余额、归档/解归档/delete、审计与备份恢复资金人工复核仍待完成，技术 Release 不替代这些人工验证。

## v3.1.8（2026-08-09）

v3.1.8 将 VCC 财务OP校验的输入、调整、归档生命周期和 Excel 输出收口为可以追溯、遇到异常会明确停止的完整流程。六项人工门禁已经用户明确确认通过，并已于 2026-08-09 正式发布。

**关键行为**

- Pending 新导入只接受 46 列 `VCC_移除归档Pending账单.xlsx`；旧 48 列文件明确拒绝，但历史 48 列原始记录、展示和重复导入判断会随升级保留。新原表没有“是否错币”和“金额差”，错币标记由系统派生。
- 系统财务OP数值单元格改为 Excel 底层精确数值优先；PPHK / JPY 样例保留 `135886024.59`。显示值与底层精确数值不一致时保留审计证据，但不再覆盖有效精确数值。
- 运行前和后台任务持久化前各做一次完整性校验。五类输入全部必需，充值清退、费用换汇、通道和 Pending 四张明细均至少 1 条有效数据，不提供零 Pending 豁免。
- 结果确认页展示完整九币种结果，允许对四类发生额/Pending 行追加一次性增量调整。同一次结果中的同一业务结果行与币种不可编辑、删除、冲销或在解归档后再调整；输入错误时只能删除全部未归档结果后重跑。
- 数据管理新增尾月解归档、固定首月期初删除和未归档结果整月删除。解归档只能从最新已归档月开始；保留基础结果、调整和审计。删除期初保留源数据和固定首月标记；删除结果会清理该月全部未归档结果及调整，已归档必须先解归档。
- 主页结果导出可选择任一一致已归档月。软件按 `VCC财务OP校验结果表_模板.xlsx` 的表头和定位标记生成结果，模板缺失或发生变化时会明确报错。九币种表头按生效差异复制模板正常/异常颜色，调整值与原因写入可见 M/N 列；原模板默认打印宽度 A:L，因此 M/N 默认不进入打印区。
- 统一生成 64 位 Windows 安装版和便携版，并校验两份 VCC 模板与应用版本；陈旧目录不得冒充本次产物。

**发布状态**

- 2026-08-09，用户明确确认六项均已实际完成并授权记录为通过：目标 Windows installer/portable 和两份 VCC 模板；Excel/WPS 字体、颜色、动态行、长原因换行、M/N 与 A:L 打印区；关键写入关窗安全；生产数据库副本只读扫描；真实连续两月逐主体×九币种财务核对；约 700 万行多 sheet 工具箱极限压力验证。
- 该通过结论来自人工明确签字，不由自动测试代替。annotated tag、Windows Release workflow、latest stable Release 和四项公开资产已完成回读；正式技术发布不改变或代替上述人工资金核对结论。

## v3.1.7（2026-08-03）

v3.1.7 将 Payment 线下调拨和 R5s2-recon 收口到同一份调拨对账单运行工作副本，固定 Payment 先运行，并增加付款账户、订单周边界和跨引擎消费保护。

**关键行为**

- 开启 Payment 时强制勾选并锁定“对账数据来源为中台调拨单表”；运行顺序为 Payment → R5s2-recon。历史 `Payment=true、reconSourceMid=false` 配置按派生表执行并显示提示。
- 调拨派生行新增“付款方式”和运行态“是否被使用”。每次运行统一重置为空；Payment 仅消费 `FundTransfer-in`，R5 跳过已使用派生行和 Payment 已消费的银行 `_rowId`。同值命中不标成实际改写，但仍消费双方。
- Payment 除原金额、币种、渠道、地区和大账号条件外，必须满足调拨“付款账户（卡号）”等于银行 `Drawee CardNo`。该条件不扩散到 R5s2-recon。
- 同一 ISO 周多个订单号日期取最早值；第一订单周取前一完整周，后续周取 `[前一周最早 FTA 日期, 本周最早 FTA 日期)`。订单周断档或非法 FTA 日期会在 Payment 和后续 R5 写值前阻断，R3 保留 7 天兜底。
- Payment 核对输出改为“匹配对照”“银行行-原始”“调拨对账单行-原始”，并使用回填前银行快照。未新增 ReconciliationId 重复检测、重复说明或“未命中场景”列。

**固定样本与人工门禁**

- 生产链路回放 1,831 条银行行与 223 条调拨订单：Payment 匹配 220、实际改写 190；R5s2-recon 后续改写 2；命中 192、未命中 1,639。220 条 Payment 配对的付款账号与 `Drawee CardNo` 全量相等。
- 这是 ReconciliationId 资金回填红线。自动基线验证不能替代人工复核，正式业务启用和公告前必须逐笔检查固定样本中的 220 条 Payment 配对和 2 条 R5 后续回填。

## v3.1.6（2026-08-03）

v3.1.6 新增「VCC财务OP校验」，把五类原表的流式导入、业务键幂等、发生额计算、系统余额比较、首月期初和跨月归档放进一条可追溯流程；同版修复平盘普通链接原始表在预检后被存档清单门禁误阻断的问题。

**关键行为**

- 充值/费用按订单号、通道按渠道订单号、Pending 按 PendingBizId 在各自原表类型内全历史唯一；同键同内容跳过且不重复计算，同键异内容整体失败并展示新旧双方原始字段和来源。
- 数据管理的“校验原表”直接展示七列导入记录，按已导入月份单选筛选；全部已识别类型会在批次开始时预登记，读取前取消或运行异常也有明确失败去向。每次成功、跳过、冲突、格式错误和事务回滚都可回查、分页查看并导出。有效原表删除后，对应成功类记录显示“已删除”，详情仍保留原导入结果和删除审计；失败记录只有填写说明并明确保留当前有效数据集后，才能解除运行门禁。
- 非通道按我方币种和方向计入；通道按 CITI、billDate 与月末边界选择交易/清算/实际到账口径；Pending 按两侧币种分别带符号汇总，J:K 差额直接计入当月发生额。
- 系统财务OP严格匹配内置正式模板的 16 列完整表头，选文件识别和正式导入二次校验均显示实际列数与差异列；主体取原表“主体”、账期取“账单日期”、比较金额取“财务余额”显示值，旧 `YYMMOP` 横表不再兼容。快照按“账期 × 模板主体”唯一，固定比较 AUD、CAD、CNH、EUR、GBP、HKD、JPY、SGD、USD，CNY 映射为 CNH；精确重放和异内容在失败批次内仍分别记跳过和冲突。输入和汇总金额最多 2 位小数、15 位有效数字，超界不自动舍入。
- 上月已归档计算余额作为本月期初；没有上月归档时必须一次性人工初始化九币种余额并填写说明。活动导入批次会阻断计算和归档；归档后账期冻结，不提供补数、撤销或原地重算，也不允许形成人工期初与上月归档的双重来源。
- 每个主体导出一个只含两个固定 sheet 的结果工作簿，使用 A4 横向和一页宽度打印；“选择导入账期”沿用业务OP所属日期弹窗结构，仅保留横向年份、月份下拉框，按钮顺序为“确定 / 取消”。导入完成后不再弹出导入记录框，完成摘要直接进入主页面状态框。“选择运行账期”移除可见“月份账期”标签，账期下拉框缩为原整行可用宽度的 25% 并与标题左侧对齐，下方操作区横线下移 15px。主面板、结果确认、期初初始化及导入记录均提供可见操作入口，应用重启后仍可继续导出最近归档结果。五个内置原表模板与当前导入表头契约保持一致。
- 数据管理三个页面标题与下方表格首列表头左边界对齐，左侧导航文字与“数据管理”标题左边界对齐；右下角按“删除 / 导出 / 返回”排列。导出按“月份账期 + 目标表”选择五类当前有效校验原表或五类校验表，百万行由 worker 流式生成并自动续 sheet；这是数据级恢复，不还原原上传文件样式。校验表“生成时间”取当前有效数据最近一次实际新增完成时间，幂等跳过、失败和归档均不改写，旧库不把归档状态时间误作生成时间。系统财务OP导入状态和详情按“币种数据行数 + 主体快照数”双口径展示，单主体九币种显示为 9 行、1 个快照，不与普通明细行直接混算。删除按同样双列结构选择五类原表之一，原子移除当前有效数据和对应校验表、使未归档结果失效，并在同一事务把对应成功类导入记录展示为“已删除”。归档月份、活动导入和运行中任务禁止删除；原导入结果、幂等/异常审计及人工期初保留，审计引用在删除前固化为快照。
- 平盘普通链接原始表的 apply 授权显式携带当前 pending operation token，解决 utility process 消息回调丢失异步上下文后输入清单仍为 0 条的问题；登记前后仍校验 owner、文件证据、manifest、schema 和 checkpoint，不放宽失败关闭边界。
- 平盘“对账数据管理”的状态列只显示状态名称，不拼接行数；链接原始表异常提醒统一留白、长内容换行和右对齐操作按钮。上述 UI 调整不改变原表行数、过滤结果或资金匹配。
- 真实生产路径回放 19 个 2026-06 分片、5,018,417 行三类明细，端到端约 10 分 09 秒、峰值 RSS 约 341.5 MiB；协作取消和 worker 强制终止恢复都未留下有效事实。另完成 2026-05 Pending 28,812 行及正式 16 列 PPHK 系统 OP 快照回放。

**人工门禁**

- 当前可访问的 PPHK 样本已扫描 5,047,229 行（三类明细为 2026-06，Pending 为 2026-05），四类业务键无空值或重复。上线前仍须扫描业务提供的全部历史月份，并人工复核主体、币种、方向、金额、账期、Pending J:K 和跨月余额；自动测试不能替代资金签字。
- 平盘现场失败已证明发生在侧库 apply 前且没有部分落库；Electron 开发环境的同一单文件重试尚未执行，技术发布后仍须补做主页面、存档和管理页全链路核对，不得记为已验证。

---

## v3.1.5（2026-08-02）

v3.1.5 正式承接未能产出公开资产的 v3.1.4，让中台调拨单和测试付款单中的明确无效证据行可以自动过滤，正常行继续落库，同时补齐异常报告、过滤墓碑、存档下载和运行过滤数据导出。

**关键行为**

- 白名单仅包含：非付款成功调拨缺金额/币种证据，以及目标证据有效的测试付款缺源金额/源币种。付款成功调拨缺证据、业务键或日期非法和其它错误继续整文件拒绝。
- 成功文件满足物理行 = 正常行 + 过滤行 + 完全重复折叠；过滤行不写来源表或链接表，不进入匹配候选、多候选、严格 1:1 或来源消费。过滤键与正常记录碰撞时整文件失败，不删除旧数据。
- 有过滤行时，导入完成弹框展示总行、正常、过滤、重复和链接行数，并提供可选“导出异常数据”；关闭后返回链接表管理。报告和输入进入同一平盘存档批次，可在存档中心下载同一字节文件。
- 活动过滤墓碑保存来源位置、业务键、行哈希、错误码和报告摘要；正常补数或范围删除会解除墓碑。运行冻结必要来源、月份、revision、墓碑及报告引用；必要来源全量过滤且无有效数据时阻断资金校验。
- 结果确认页始终显示“过滤数据导出”；无过滤数据时禁用，有数据时按运行冻结记录合并导出。该按钮不是确认前置条件，不更新普通结果 `exported_at`；报告缺失或摘要不符时导出与确认均失败关闭。
- 异常报告和合并报告对长单号、ReconID、账号及前导零值使用文本单元格，原因列换行展示；relationship-aware reader 不依赖 ZIP 条目顺序，同名表头按出现次序逐列保留。
- 七个真实文件的生产路径只读回放为六成功一拒绝：成功文件正常落库 902,204 行、过滤 409 行、生成链接 916,206 行；第三份调拨文件因付款成功但付款金额为空保持整文件 0 行提交。

**范围与人工门禁**

- 平盘匹配、金额、币种、方向、FundType、候选顺序和严格 1:1 消费规则不变；网关和清结算账户来源不启用自动过滤。
- 业务负责人已于 2026-08-01 确认调拨/测试付款白名单、409 行异常、第三份调拨硬拒绝以及真实候选与方向结果；该人工资金验收不由自动测试替代。

**发布恢复**

- v3.1.4 annotated tag 保留为审计记录；对应 Windows Release workflow 在构建和发布前因测试临时 SQLite 文件锁失败，没有 GitHub Release 或公开资产。
- v3.1.5 只修复两处单测资源回收顺序并增加 Windows PR 定向门禁；产品实现、数据契约和资金逻辑与已复核的 v3.1.4 候选一致。

---

## v3.1.4（未发布）

v3.1.4 只形成了 annotated tag。Windows Release workflow 在产物构建前失败，因此没有可下载安装的 v3.1.4 Release；全部功能改由 v3.1.5 交付。

---

## v3.1.3（2026-08-01）

v3.1.3 将平盘银行对账单和五类链接原始表的导入、范围管理、删除及调拨链接重建迁移到后台流式、增量和可恢复的处理链路。

**关键行为**

- 银行、调拨、测试付款、网关入账、网关出账和清结算银行账户表不再由 Electron main 全量读取工作簿或持有整批行、主键及派生集合；独立 utility process 按内存预算解析 shared strings 并逐行写库。
- 银行仍为所选文件整批原子替换；普通来源仍先整批预检再按文件分别提交；账户快照仍需确认后整表替换。checkpoint、revision、input proof 和业务行在同一事务中推进。
- 普通来源技术身份改为完整规范行 `row_hash`：完全相同记录折叠，同业务主键不同内容全部保留并独立派生、匹配和消费。
- 普通来源按记录增量生成链接行，不再读取全表后生成完整派生数组；隐藏、零派生、FundTransfer 双腿和链接顺序保持既有语义。
- 银行摘要、状态和范围列表复用覆盖索引上的一次聚合 snapshot；普通来源摘要由业务事务同步刷新派生缓存，缓存损坏时回退事实表；银行/来源删除和 FundTransfer 映射重建使用后台分批游标事务。
- 导入弹窗持续显示文件、扫描、接受、提交和耗时；长同步阶段用不虚增计数的心跳保持可见。提交前可取消，超时终止 worker 后按数据库证据恢复；汇总和最终提交阶段由 main 与 worker 双重拒绝取消。
- 写事务前执行磁盘空间门禁；staging、ledger、schema、hash、checkpoint 或 worker 恢复证据不一致时失败关闭，不自动回退到主进程旧 reader。
- 银行和账户在 COMMIT 后 worker 未回包时，可依据文件级提交凭证、checkpoint 和 SQL 聚合重建真实结果，防止重复提交。

**兼容与人工门禁**

- 平盘匹配算法、来源业务字段、状态过滤、金额/币种/日期、49 列结果以及既有确认流程不变。
- 本版只承诺百万级 Excel 的导入、管理、删除和链接派生重建，不承诺 300 万行资金性质校验运行或单文件 Excel 导出。
- 真实资金范围替换、派生结果和存档文件仍需业务负责人逐笔抽样；Windows 实机取消和文件锁行为需发布前人工验证，自动测试不能替代这些门禁。

---

## v3.1.2（2026-07-30）

v3.1.2 修复工具箱合并/拆分后日期变数字、长编号变科学计数法和样式丢失的问题，并把 `.xlsx`、标准 BIFF8 `.xls` 与 CSV 的全部工具箱入口收口到统一链路。

**关键行为**

- 合并、普通/大文件单拆、多文件拆分和自动分页统一保留来源数字/日期/文本格式、字体、填充、边框、对齐、换行、旋转、列宽、行高、隐藏与 outline；分页重放基准表头和列布局。
- 超过 Excel 安全精度的整数、科学计数词法和前导零标识符安全转成文本，避免近似值与科学计数法；字段扫描和导出使用同一匹配投影，保证 UI 中出现的值可以重新命中。
- General 数字底层词法带 `.0/.00`、实际显示为整数时，自动生成的非科学格式按有效小数位处理，结果继续显示整数，不再出现末尾小数点；数值和有效小数不变。
- 统一处理 1900/1904 日期系统、内置/自定义日期格式、纯时间和 `t=d`。无法安全转换的日期保留原文本，在成功弹框显示总数及最多 20 条样例；提示不标黄、不进入错误报告。
- 文件类型按 magic 识别：ZIP OOXML、OLE/CFB BIFF8、CSV 可混合使用，扩展名伪装不会让合并与拆分走不同 reader。标准 `.xls` 的 XF、Theme/XFExt、palette、布局与值层先严格对齐，再输出 `.xlsx`。
- workbook/rels/worksheet/sharedStrings/styles/theme 与 BIFF8 records/XFCRC/XFExt 全部失败关闭；BIFF8 `Dimensions` 按 65536 行 / 256 列的半开边界核对 Row/cell。截断、重复、错位、越界、CRC 不符或未知必需颜色不会产出部分结果或默认黑白样式。
- 输出样式按最终签名去重并执行组件预算；临时文件发布前严格解析 Content Types、包根/工作簿 relationships、全部 worksheet 和 styles，并核对内部关系目标、Sheet 声明闭包、逐页表头、数据行、样式数及结构扫描前后摘要。缺失包根关系、悬空内部关系、截断 XML、悬空/游离 Sheet、错表头、漏行或校验期间换文件均不发布。
- 单/多文件输出均先整批生成、校验，再通过 staging、journal 和恢复索引发布。固定索引会在任何 staging byte 写入前登记 preparing intent；写后 identity 贯穿 generation、staging 和 rename 后目标，同大小换内容也会拒绝。提交收尾另有 finalizing intent，journal 删除失败或 journal 已删但 index 未删都可安全重试；启动恢复失败时直接显示人工恢复路径并停止启动。
- 全文件哈希、staging 复制、fsync 和恢复在串行 Worker 中执行，不阻塞 Electron 主界面；Worker 异常退出会先恢复再报告失败。30 万行级低样式文件保持流式处理，路径矩阵覆盖 XLSX/BIFF8/CSV 的合并、单拆、多拆、分页、行数与顺序守恒。
- Windows 暂存文件以可写句柄执行落盘刷新，避免 `FlushFileBuffers` 对只读句柄返回 `EPERM`；该修复只改变 staging 句柄权限，不改变文件内容、哈希、hardlink no-replace、回滚或人工恢复口径。

**兼容与人工门禁**

- 正式发布依赖保存目录支持同目录 hardlink no-replace。Windows 本机 NTFS 等支持目录可正常使用；FAT 或部分网络盘不支持时会在改动正式目标前失败，禁止降级为可能覆盖并发文件的普通 rename。

- `.xls` 仅支持未加密的标准 OLE/CFB BIFF8；兼容 LibreOffice 全列 `ColInfo` 终止哨兵，并把零宽/默认隐藏布局转换成可再次导入的等价 OOXML，不写零默认行高且不生成第 257 列。BIFF2–5、加密、损坏和 XML Spreadsheet 2003 伪装文件明确拒绝并提示另存。CSV 没有来源样式，继续按文本值输出。
- 资金对账、平盘、模板映射、存档及既有拆分分组语义不变。
- Windows Excel/WPS 人工发布验收已于 2026-07-30 由用户明确确认通过；后续处理新的真实或脱敏 `.xlsx`/`.xls` 时仍应抽样复核日期、长账号、颜色、边框、行列布局和行数。

---

## v3.1.1（2026-07-29）

v3.1.1 在不放宽数据防丢边界的前提下兼容可证明为空的旧平盘侧库，并修复资金对账中 Credit/Inbound 行可能被调拨规则误改的问题。

**关键行为**

- 仅当旧平盘侧库的受支持十表结构完整、十张表全部为 0 行、SQLite 完整性正常，且主库无正式 checkpoint、无 pending 并存在合法 generation 0 bootstrap 时，才在原文件上补齐现代 schema 和 checkpoint history；事务前及取得写锁后会各证明一次全空。
- 任一表非空、结构未知或残缺、旧 marker、主库已绑定 checkpoint、bootstrap/pending/identity/generation/token 不符合要求或检查异常时均 fail-closed；不会自动删除、清空、替换或接管侧库。
- 新建路径也在写锁内证明候选没有用户 schema；路径检查后被外部进程抢先创建的表、数据和 journal mode 保持原样并阻断，不会被接管成平盘侧库；正常初始化提交后仍进入 WAL。
- 统一银行方向校验在候选生成阶段执行：FundTransfer-out、Ach Return、HX-out 必须为 Debit；FundTransfer-in、Wire Return、HX-in 必须为 Credit。主侧须合法非零，另一侧须为空或合法零。
- R3.5 Step1、R5s2 网关来源和调拨来源只有账号、币种、金额、日期（启用时）、方向及各自专属条件全部通过后才可候选、消费或改写。R3.5 Stage B 只有严格 Debit sibling 可置 `Charge`。
- R4 沿用 ReconID、MerchantId、Currency、方向金额、signed Extra Fee、网关金额和严格 1:1 的既有完整规则；共享方向校验器不改变其 no-op pair、退款过滤和告警口径。
- 调拨日期改为全局两阶段：所有调拨行先完成同日匹配，仅未命中行再进入前后 `±N` 天；日期差较小者优先，再按银行原始行序。关闭日期时完全跳过日期，但其它严格条件不放宽。
- R5s2 停用而 R3.5 启用时，多对多只读审计仍使用 R3.5 实际加载的调拨副本，不会因此启动 R5 写入。
- 三个调拨写入引擎的日期失败告警按银行原始行、期望方向和失败原因去重，避免密集来源产生 N×M 错误报告；不同银行行/方向/原因仍分别保留，资金结果不变。
- 管理页改为“调拨回填功能管理”，固定所有银行渠道；默认开启的“调拨单匹配日期 ± [1] 天”和优先级同一行显示（日期在左、优先级在右），日期勾选项与下一行首个勾选项左对齐，N 允许 1–999；策略同时服务 R3.5 Step1、R5s2 两种来源和多对多只读审计。
- 日期策略和 R5s2 只能由唯一 canonical 内置场景持有。该 owner 可启停和改配置，但不可删除、批删、转移或改掉身份；普通 CRUD/配置包不能克隆保留签名，缺失按完整 seed 恢复，重复或旧冲突阻断运行。
- `0016RF1210576`、`20260721UOVBSGSGBRT8522830` 两笔 Credit/Inbound 问题行不再被改成 `FundTransfer-out` 或 `Charge`。

**范围与人工门禁**

- 工具箱合并/拆分格式保真不在本版，留待 v3.1.2。
- 必须使用隔离旧侧库副本核对升级前后零行与 checkpoint，并用真实或脱敏样本逐笔复核方向、账号、币种、金额、日期和严格 1:1；自动测试不能替代资金验收。

---

## v3.1.0（2026-07-26）

v3.1.0 交付「平盘对账数据处理」第一期业务能力，完整打通银行与五类链接原始表的持久管理、资金性质判断、差异、结果回导和确认。

**关键行为**

- 平盘银行对账单接受严格 46/49 列，按 Channel+月份原子替换；49 列旧审计会清空后作为新输入处理。
- 五类链接原始表通过严格表头识别，逐文件原子导入并自动派生链接数据。清结算银行账户表更名后只保留状态正常的账户。
- 十组基础/FX FundType 由各自的 TradeType、ReconID、账号、币种、方向、日期和金额规则判定；订单类候选执行全局双向严格 1:1。
- 订单类 1:1 跨已确认运行持续生效：来源记录不能跨月份/重建后被其它银行行复用，同一银行 BizId 也不能改配其它来源。
- 调拨金额包含有符号 `Extra Fee`；Inbound 只有银行、订单、原始出金币种三者明确相同时才移除 `&FX`。
- 三类账户场景不读调拨单。银行账号和系统账号先归并为逻辑账户，再唯一识别自有和非自有账户并比较币种；多账户、多币种、多性质或别名冲突进入差异。
- 结果固定 49 列，只有实际改变的 FundType 标黄；回导仅允许在原基础/FX二元组内修改，确认前要求至少成功导出或合法回导一次。
- position side DB 保存原始值、工作值、血缘、差异、草稿和 revision；主库无批量明细。数据或映射变化会使旧草稿失效，第一期全局只保留一个待确认草稿；替换失败会保留旧草稿，关键 JSON 损坏会直接阻断。
- 首次启动由主库先保存 generation 0 bootstrap，再创建完全绑定的侧库；已有侧库但主库无绑定、仅旧 initialized marker、侧库缺失/空库、旧主库单独恢复、旧库回滚、同代或更高代次分叉时阻断使用。后续写入再用 checkpoint、operation token 和历史父链验证同批数据；备份恢复必须同时包含 `tool-data.sqlite` 与 `run-data/`。
- 平盘操作全局互斥，待完成记录、checkpoint 同步和清理都校验 operation token 所有权；侧库提交、业务成功或输出发布后的异常退出及同进程部分提交失败会恢复成正式存档批次或持久文件 outbox。
- 运行来源由原始银行行重新推导，已确认消费冲突数由逐行血缘重算；每条运行行保存完整性 hash，scope、snapshot、summary、结果、差异、消费和血缘即使共同改写也必须与当前银行/链接明细一致。已确认运行血缘还会与持久来源消费表双向核对。
- 静态模板与运行时 writer 共用标识符判定；结果、链接和原始表在列级固定 ID、账号、卡号、CustomerRef、客户编号、客户号、`accountReference`、`Account Reference`、大额行号和 VA 等文本格式，零数据工作簿也不会把长 ID 或前导零账号转成数字。
- 对账数据管理和链接表管理提供导入、导出、删除、差异汇总和独立账户映射；“已校验性质”不等于业务归档。
- 差异页把功能和月份移到表格上方的单选下拉框，月份默认最新并支持切换；表格不再重复显示功能和月份列，首列“银行渠道”按银行行 `Channel-地区` 展示。
- 链接表管理不显示“未归档”和操作栏，固定显示按月归并的数据日期范围和表库更新日期；底部“导出”先选择目标链接表，且仅“导入”为蓝色主按钮。链接原始表页只显示原始表名、日期范围和更新时间，底部使用蓝色“导出”和白色“返回”。
- 差异列表不展示失效或被替换草稿；有效待确认差异和已确认差异均可按批次导出，最终确认时才落“人工确认保留 / 人工修改后确认”状态。
- 差异导出按运行、Channel、地区、月份和状态隔离；Excel 日期时间往返不会被误判为篡改，真实时分秒修改仍会拒绝。
- 平盘成功输入、每次成功结果导出和结果回导均形成独立即时存档批次；业务返回成功前完成存档或持久登记可重试失败，正式存档不可用时由文件 outbox 跨重启重放。

**人工门禁**

- 必须使用真实或脱敏数据逐笔复核十组 FundType、账号别名、币种、方向、日期、正负手续费、1:1 冲突、差异和回导确认；自动测试不能替代资金验收。
- Windows Excel/WPS 打开五个链接模板和 49 列结果、大规模原始表内存峰值仍需人工确认。

---

## v3.0.26（2026-07-25）

v3.0.26 补齐前置资金不平结果的银行资金性质血缘，并将 R5 两种调拨回填来源和调拨多对多审计统一到含有符号手续费的银行金额口径。

**关键行为**

- 平盘模块的白色占位按钮由“对账表管理”改为“对账数据管理”；ID、槽位、样式和不接后端的范围不变。
- 前置资金“不平结果”在“交易类型”之后插入第 6 列 `FundType`，直接输出对应银行原始值。其余前置资金 sheet 和动态重复审计契约不变。
- C4 严格白名单兼容旧 19 列“对账结果”、旧 20 列“不平结果”和新 21 列“不平结果”，统一投影为既有 19 列修复数据；错列、错序和未知额外列仍拒绝。
- R5 默认调拨对账单来源、取消勾选后的网关来源及调拨多对多审计，统一使用 `abs(Credit-Debit) + signed Extra Fee`。空手续费按 0，非法非空手续费退出候选并进入主错误报告。
- R5 仍按现有分精度比较，先加总、合计后不再取绝对值。日期优先、账号、币种、方向池、稳定顺序、严格 1:1 和同值消费不变。
- DBS-Charge 明确保留旧 `bankAmountAbs` 口径，不因本迭代开始计算手续费。
- 资金链接表删除弹框标题固定为“删除数据”，但目标表选择、计数、删除路由和成功反馈仍保留具体表血缘。

**人工门禁**

- 使用真实或脱敏样本逐笔核对正负手续费、两种 R5 来源、回填 ReconciliationId、1:1 去向、多对多异常和 DBS-Charge 不变性；自动测试不能替代资金验收。

---

## v3.0.25（2026-07-23）

v3.0.25 修复设置页存档配置无法提交的问题，统一确认按钮，并彻底停止网银模板“不存档”策略继续影响新批次。

**关键行为**

- 设置页底部“完成”改为“确认”。存档设置修改保留期限后由这个全局按钮保存并关闭；失败会保留弹窗显示错误，无修改直接关闭。
- 存档设置删除独立“保存/取消”和网银模板排除区域。右上角关闭及返回箭头仍是不保存离开。
- 升级启动时，历史模板排除配置无论有效、损坏或为空都规范化为 `[]`。网银账单和月度余额从此恢复正常存档；其它明确使用通用 `skipArchive` 的场景不受影响。
- 自动更新页移除冗余说明，“已开启 / 已关闭”字号统一为 14px，设置行右边界与“确认”按钮左缘对齐。便携版下载提示保留。
- 存档设置删除保留期说明和“默认保留”标签，新增 60 天选项；缺失或非法配置默认按 60 天，既有合法设置不迁移。
- 平盘功能下拉第二项显示为“平盘对账数据处理”，内部 value、默认项和纯前端占位范围不变。
- 自动更新已下载时，自动更新页继续显示“稍后”；存档中心页面仍显示“确认”。

**范围**

- 不修改存档文件结构、更新检查/下载/安装机制或平盘业务后端。
- 存档打开、另存为、锁定、删除、重试和已有批次均不变。

---

## v3.0.24（2026-07-22）

v3.0.24 增加「平盘对账数据处理」前端占位模块，并让 Payment 线下调拨订单回填支持多个大账号，同时维持单账号兼容和严格 1:1 消费。

**关键行为**

- 新模块复用对账单修复的两行主页面结构，提供三个平盘功能枚举和五个可点击入口；本版所有入口只显示“后续版本开放”，不调用 IPC、读写数据或生成文件。
- 新模块是第 12 个主模块 ID，默认不启用；升级后可在“小助手功能收纳”的闲置区手动启用、排序和切换。它没有业务处理能力，因此不进入存档中心的 11 模块归档范围。
- Payment 大账号继续使用原字符串配置，以中文顿号 `、` 严格分隔多个账号。保存时拒绝空段、首尾/连续顿号、重复账号和中英文逗号。
- 引擎分别为每个账号建立候选范围。银行 `MerchantId` 必须与订单“收款账户（卡号）”trim 后大小写敏感精确相等；R1、R2 和 R3 都不能借用其它账号候选。
- 多账号共用现有渠道、地区及全局银行行/订单行消费集合；账号配置顺序不改变 Excel 原序、候选优先级、回填字段或核对 sheet。
- 非法历史配置不会合池或降级匹配，而是安全不回填并输出可见 warning。真实或脱敏双账号数据仍需人工逐笔复核。

---

## v3.0.23（2026-07-21）

v3.0.23 修复 C3 因网关 Channel 英文大小写不同而在场景执行前丢失候选的问题，并把四类 R4 资金性质判断从“R1 对账 ID 配对后整桶改写”收紧为完整条件下的全局严格 1:1。

### C3 专用候选池

- 一次数据库读取同时生成原大小写敏感 `exactRows` 和 C3 专用 `c3Rows`；相同行只解析一次并共享对象，不重复查询或深拷百万级数据。
- `c3Rows` 对银行和网关 Channel 先 trim，再按 SQLite `NOCASE` 忽略英文大小写精确匹配。`Maybank` 可候选 `MAYBANK`，但不能候选 `MAYBANK2`。
- 只有 C3 使用放宽池；R1、DBS-Charge、R4、R5 继续使用 `exactRows`。C3 场景内部显式 Channel 条件和对账字段仍区分大小写。

### R4 四类严格 1:1

- Ach Return、Wire Return、HX-out、HX-in 直接读取完整 `exactRows`，按固定 TradeType、ReconID、MerchantId、Currency、方向金额和 Extra Fee 执行完整匹配，不再受 R1 仅按对账 ID 预选候选的限制。
- 金额使用字符串十进制精确计算 `abs(主金额) + signed Extra Fee`；主金额必须合法且非 0，Extra Fee 空值按 0，相反方向空值按 0，非 0 或非法文本阻断。
- 四类共享银行消费集合。网关链接表原序优先，多个完整银行候选按 Excel 原序取第一条；重复候选、完整条件不符和方向异常均进入现有主错误报告。
- 匹配成功但 FundType 已是目标值时仍消费关系，不产生修改或标黄；没有同 ReconID 银行行时保持静默。
- R4 额外保留全部成功匹配关系，包括 FundType 同值的 no-op。退款引擎会精确排除其中 `ach-return` 实际配对的银行对象，避免该行再次参与退款匹配；不按 ReconID 或行号扩散到其它银行行。
- 匹配关系和字段修改保持分离：no-op 不会伪造 modification、标黄或改值统计，Wire Return、HX-out、HX-in 关系也不会触发 Ach Return 退款过滤。

### 范围与验收

- R1 及其既有退款过滤、DBS-Charge、R5 退款匹配规则、Excel 输出和高亮结构不变；数据库只幂等刷新四个内置场景的说明文案。
- HX 暂无真实样本；真实 Ach Return、Wire Return 和冲突候选逐笔资金复核仍为人工门禁，自动测试不得表述为业务验收完成。

---

## v3.0.22（2026-07-20）

v3.0.22 把“存档中心”加入设置页，为 11 个主模块保存当前启动周期内可证明来源的输入文件和第一次成功结果，同时保持业务处理与存档失败互相隔离。

**关键行为**

- ⚙️ 设置弹窗增加“自动更新 / 存档中心”左侧导航，每次打开默认仍是自动更新；存档中心不进入主模块切换或功能收纳。
- 有运行按钮的模块仅在运行成功后建批，无运行按钮的模块在结果生成成功后建批；只导入、失败、取消、后续另存、重复导出、聚合导出和历史重导不追加运行批次。
- 支持按日期、11 个主模块和批次号浏览；文件可打开只读副本、另存为，一般失败文件可按原源路径重试。批次支持锁定、解锁和二次确认删除。
- 默认保留 90 天，可选 30/90/180/365 天或永久；保留期在建批时冻结，锁定批次不自动清理。
- 文件按 SHA-256 和大小全局去重，主库只保存批次、逻辑文件和 Blob 引用；相同内容的多个逻辑文件共享物理文件，最后一个引用删除后才释放空间。
- 资金对账链接表和前置资金对账临时 MPT 在导入成功时独立建输入批次；活动批次按主模块、归档类型和 run key 隔离，共享 ReconID 修复入口按实际发起模块归档。
- 归档复制在业务返回后进入后台串行队列；业务完成时冻结轻量文件身份，排队期间文件变化会拒绝错存并要求重新执行业务。正常退出等待队列排空；失败不修改业务 DB、正常结果文件或原 IPC 返回。
- 显式运行号未命中时不回退最新批次；临时 MPT 修复按结果下标绑定同名文件，月度余额不抢占普通账单余额补录批次。

**兼容与边界**

- 错误报告、失败明细、模板/场景/规则包、工具箱、日志、数据库、缓存、更新包及 v3.0.22 以前的文件不归档。
- 当前版不持久化跨重启输入凭据或运行结果绑定，不补录历史文件；一般重试只读取原记录的源路径，源文件在业务完成后已变化时须重新执行业务生成新批次。
- 存档中心仅用于文件查找和复制，不提供数据恢复、重新导入、重新运行、内容预览、全文搜索、云同步或自定义存储路径。
- 不修改任何资金计算、对账规则、Excel 内容或既有业务保存位置。

---

## v3.0.21（2026-07-20）

v3.0.21 修复中台退款订单回填和 DBS-Charge 步骤2的网关类型、银行方向判断边界，避免无关网关行阻断退款，以及不完整条件把 DBS 银行行误改为 `outbound`。

**关键行为**

- 退款前置过滤改用 R1 的具体配对。只有配对网关 `TradeType` trim 后严格等于 `AchReturn`，才排除对应银行行；同 ID 其它银行行、`Inbound-VA`、空类型及大小写不一致均不触发。
- 合成回归与受控本地问题样本均证明 `Inbound-VA` 不再阻断对应 Ach Return 银行行，且可继续精准命中退款单；真实业务标识不进入仓库或安装包文档。
- DBS-Charge 步骤2只读取固定 12 类网关 TradeType；只有非白名单网关行的桶完全跳过并保持原 `Charge/outbound`，混合桶只使用白名单候选。
- 同对账 ID 存在白名单候选时，先检查银行 `Credit Amount`；按既有 R4 口径必须为 0 才继续金额币种判断。非零保持进入步骤2前的值、步骤2不新增改写并进入主错误报告；步骤1既有 sibling 归并仍保留，空值和非法文本按既有口径视为 0。
- DBS 步骤1、金额币种精确匹配、白名单桶内 `outbound -> Charge`、FundTransfer 保护及“仅修改 DBS 银行目标行”的渠道门控保持不变。

**兼容与边界**

- 不修改 IPC、数据库、Excel 表头或输出结构；白名单是固定代码常量，不依赖用户运行时提供附件。
- R4 同 ID 扩散、网关侧 DBS MerchantId/Channel、候选 1:1 消费、重复 ID 人工分流和全量过滤审计不在本次范围；其它网关渠道/商户下同 ID 白名单候选仍可能参与步骤2。
- 用户已在知悉真实脱敏样本逐笔复核尚未完成后明确授权发布；该项继续作为发布后跟进，不得写成已完成人工验收。

---

## v3.0.20（2026-07-20）

v3.0.20 修复 10 个主模块中状态图标/文字及 5 组标签/下拉框的垂直视觉偏移，不改变任何业务行为或水平布局。

**关键行为**

- 10 个目标状态框增加统一内容层，星形图标固定为 14×14px 并以块级 SVG 显示；单行状态对齐文字中心，多行状态对齐整段文字中心。
- 资金对账数据处理继续支持长文案框内滚动，短内容保持垂直居中，长内容仍可从顶部完整查看。
- “模式 / BU / 对账场景 / 账单类别 / 场景”五组标签与下拉框统一为 48px 垂直轨道和明确文字行高；BU 与对账场景标签按控件顶部定位。
- 前置资金对账的横向槽位、按钮间距和 `-14px / +14px` 位移不变；对账单修复标签继续右对齐。
- Clear 主题与 General 兼容样式同步，但 General 主题仍保持停用。

**兼容与边界**

- 「新开账户余额账单生成」状态框结构保持原样。
- 状态文案、下拉枚举、按钮状态、业务流程、IPC、数据库和 Excel 输出均不变。

---

## v3.0.19（2026-07-19）

v3.0.19 将工具箱「合并表格」从“每个文件只读第一张表”扩展为单文件/多文件的全部可见工作表合并，并保持现有输入格式、输出格式和大文件流式能力。

**关键行为**

- XLSX、XLS 读取全部可见非空 sheet，CSV 作为单表且三种格式可混选；隐藏、深度隐藏和完全空白 sheet 跳过。
- 每个参与 sheet 的首个有效行都是表头，必须在列名、大小写和列序上完全一致；错误信息同时给出基准与异常文件/sheet。
- 合并顺序为文件选择顺序 → sheet 标签顺序 → 行顺序；表头只输出一次，数据不去重、不排序、不增加来源列。
- XLSX 按 workbook 显示序流式读取；严格合并模式不改变拆分表格既有的“后续 sheet 可省略表头”续页规则。
- 普通结果只有 `COMMON`；超过 Excel 单页上限继续自动分页。成功、取消和失败路径统一清理临时目录，同名目标通过备份与原子替换发布，失败时恢复旧文件。

**兼容与边界**

- 单文件单 sheet、既有多文件单 sheet、CSV/XLS、默认文件名、IPC 返回和 by-name 格式保持不变。
- 不复制源样式、公式或合并单元格；不做相似表头对齐、去重或字段映射。
- 本迭代不包含 PR、合并、tag 和发布。

---

## v3.0.18（2026-07-16）

v3.0.18 为 Windows NSIS 安装版加入 GitHub Releases stable 在线升级基础能力，并增加设置入口、升级状态展示、业务繁忙重启闸门和不可变 tag 发布流水线。

**关键行为**

- 自动更新默认关闭。开启时立即检查，此后每次应用启动只后台检查一次；不设周期定时器。关闭会使尚未开始的启动检查失效并取消由启动/开启触发的自动下载；手动“立即检查”及其下载不受开关取消。
- 设置弹窗显示当前版本、安装类型、自动更新开关、最近检查时间、目标版本和下载进度；已下载状态同时通过文字与设置按钮状态点表达。
- 只在已打包 Windows NSIS 中加载 `electron-updater`，并显式关闭自动下载和普通退出自动安装。Windows portable 只打开 Releases 下载页，开发环境和其他平台不联网。
- 只接收 stable latest，不接收预发布、不允许降级、不使用 Web Installer。下载完成由用户选择立即重启或稍后，稍后时设置齿轮显示状态点。
- 安装前原子关闭新业务入口，再复查活跃业务、两把资金操作锁和 worker；繁忙时不退出。空闲后等待 worker、运行数据和使用统计清理完成，才调用安装器。
- 发布 tag 必须等于 `v${package.json.version}` 且指向当前 `main`。完整测试和更新资产校验通过后创建非 Draft Release；同名 Release 已存在时拒绝替换。
- 发布保护与 Windows 实机 canary 步骤记录在 `docs/WINDOWS_RELEASE_RUNBOOK.md`；GitHub Environment 和 branch/tag ruleset 需仓库管理员在远端配置。

**兼容与风险**

- 3.0.18 是引导版本，3.0.17 及更早用户必须手动覆盖安装一次；应用内升级从后继稳定版开始生效。
- 本版本无代码签名并设置 `verifyUpdateCodeSignature=false`，Windows 可能显示 SmartScreen。HTTPS 和 SHA-512 完整性校验仍保留，但不能替代发布者签名。
- 不包含 macOS/Linux 在线升级、定时检查、强制更新、灰度和测试版通道；本迭代不创建 tag 或 Release。

---

## v3.0.17（2026-07-16）

v3.0.17 为「中台退款订单回填」增加可选的银行打款流水号模糊匹配，并把工具箱按字段拆分扩展为最多 8 组的一次读取、多文件原子导出。

**关键行为**

- 退款开关默认关闭并进入现有场景 config；既有 S1-S4 先执行，新规则只处理最终普通未命中，不推翻已有人工结论。
- 流水号、大账号和币种 trim 后大小写敏感精确匹配；金额条件精确执行 `abs(abs(Credit-Debit)-退款金额)<10`，等于 10 不命中，非法金额转人工且不会让另一银行行抢占同一退款单。
- 新规则采用全局候选关系裁决双向严格 1:1；成功行标记「模糊命中」、写实际金额差，并只对现有模板中实际参与匹配的列标黄。
- 多文件拆分支持 1-8 组独立文件名/字段/值，分组可重叠、零命中仍产表头文件；旧单文件流程不变。
- 普通 XLSX、大文件/多 sheet worker、CSV/XLS 都在一次数据区遍历中并行判断全部分组。全部产物先写临时批次，再统一发布；覆盖失败恢复原文件，无法恢复时保留备份位置供人工处置。

**明确不做**

- `MPT_CHANNEL_OTHERS` 继续不做；不新增数据库表或迁移。本轮实现不包含 PR、合并、tag 和发布。
- 真实脱敏退款样本逐笔复核仍是资金负责人验收硬门禁。

---

## v3.0.16（2026-07-15）

v3.0.16 迭代「前置资金对账」：银行匹配金额纳入有符号 `Extra Fee`，并按附件固化 14 类 `FundType + 方向 -> gateway tradeType` 规则；临时 MPT 可定位明细错误新增错误 Excel 导出和逻辑删除重跑，原文件保持不变、排除记录可审计。

**关键行为**

- 平账必须同时满足非空对账 ID、渠道、币种、`方向金额 + Extra Fee` 精确金额及规则允许的网关 tradeType；同 FundType 多规则取类型并集后仍严格 1:1 消费。
- FundType 未配置、方向不符和无网关类型都作为可见不平结果输出原因，不消费候选；ExternalTransfer 的空网关类型不是通配符。
- Extra Fee 空值按 0，非空非法值阻断导入；十进制加法不使用浮点。两侧发生额均为 0 时仍跳过，即使手续费非零也不参与。
- MPT 严格导入发现明细错误时整文件回滚；可修复错误使用主进程短期令牌，重新读取并校验 SHA-256 后才允许导出或逻辑删除重跑。
- 错误报告按来源动态生成 INBOUND/OUTBOUND sheet，包含 33 个原字段和可无损重组的原始行分片；单 sheet 超过 Excel 行数上限时拒绝发布；修复批次保存有效/排除行统计和逐行排除审计。

**明确不做**

- `MPT_CHANNEL_OTHERS` 已取消，不再承诺具体支持版本；临时银行对账单和「缺渠道账单」未在 3.0.16 实施。

---

## v3.0.15（2026-07-14）

v3.0.15 新增独立「重复入金匹配」模块。用户一次导入一份标准 46 列银行对账单和一份标准 26 列单据对账单，软件按精确金额、双方姓名卡号、渠道和币种识别重复入金组，从全部保留月份的临时中台入金网关账单取得加款单号和 `oppBu`，再从单据取得客户号、账户号，输出召回邮件数据及人工判定明细。

自动化门禁已通过：unit **3563/3563**、integration **40 个脚本 / 1870/1870**、smoke、ESLint，并完成多月份 MPT 基准、9 万行真实单据流读、启动性能和 Electron 预览。PR #88 self-review 的 P0/P1/P2/P3/P4 Finding 均为 0；真实样本自动回放得到 **9 个成功组、1 个人工组**。Windows Excel/WPS 视觉检查与资金负责人复核仍是发布硬门禁。

### 🔴 对外契约变更（升级必读）

- **严格 1 Reversal + 2 Inbound**：Reversal 只读 Debit，Inbound 只读 Credit；金额用十进制字符串精确比较，分组文本不 trim、区分大小写。其它含 Reversal 的形态整组人工，纯 Inbound 只统计。
- **MPT 候选全局不复用**：只查全部保留月份的 `MPT_INBOUND_GATEWAY` 和 `Inbound-VA`；每条 Inbound 必须唯一命中，两条必须命中不同记录，同一记录不能跨组复用。零/多候选、复用或 MPT `oppBu` 为空/冲突全部转人工；MPT `business/clientId/accId` 不参与成功判定。
- **单据按 orderId 唯一回填**：两个非空 MPT `orderId` 必须分别唯一命中不同单据；两条单据的用户编号、账户号、业务部门须非空一致，业务部门还须等于 `oppBu`。失败只影响当前组，且不回退 MPT 客户/账户字段。
- **当前启动周期结果**：银行输入、单据输入和结果只存在本次应用启动周期；选中新文件、新 run、INBOUND MPT 变化或重启后旧结果不可导出。临时 MPT 批次本身仍跨重启保留。
- **固定双 sheet 输出**：导出文件为 `YYMMDD_重复入金召回邮件模板.xlsx`，只含「邮件模板」「匹配不成功需人工判定」；业务来源取 MPT `oppBu`，客户号/账户号取单据，Debit Amount 数据格式为“常规”。完全无结果时不允许导出。

**新增**

- 重复入金匹配页面和 `duplicateInboundMatch` IPC：双文件导入、运行、导出及三个进度事件；模块注册但不加入默认启用列表。
- 当前周期 side DB：流式保存单据匹配字段及非唯一业务订单号索引，并保存银行明细、运行结果和银行/MPT/单据血缘；主库仅保存两份文件 hash、快照 hash、计数、状态和侧库路径。
- 精确分组与三阶段裁决：结构化七元组避免字段碰撞；MPT 与单据候选冲突都不按顺序抢占；Reversal 行和各类结果执行守恒断言。
- 跨月 MPT INBOUND 批量查询：每个保留月份使用 TEMP reconciliationId 集合执行一次 JOIN，不读取 OUTBOUND 或持久网关链接表。
- 模板化原子导出：邮件模板固定 10 列，人工 sheet 为银行标准 46 列加「人工判定原因」；两个 orderId 均通过非空校验后按银行 Inbound 原顺序拼接。

**当时顺延（后续决策已变更）**

- `MPT_CHANNEL_OTHERS`、临时银行对账单、「缺渠道账单」实际运行；后续 3.0.16 也未交付，其中 `MPT_CHANNEL_OTHERS` 已取消。

## v3.0.14（2026-07-12）

v3.0.14 交付两项用户可见变更：① 资金对账「命中场景」收紧为只保留实际改值行，异常说明只在实际改值行上检测和输出；② 新增「前置资金对账」模块，3.0.14 只交付「缺网关账单」，用标准银行对账单联合临时 MPT 和现有网关对账单，按非空对账 ID + 渠道 + 精确金额 + 币种做严格 1:1 对账。完全重复网关记录仍按 `reconciliationId + 10 字段指纹` 折叠，但会按渠道动态追加「重复网关账单」审计页。最终 `npm run release-check` 全绿（unit **3483/3483** + integration **1842/1842**（39 脚本）+ smoke + lint），前置资金 side DB 端到端 **62/62**。

### 🔴 对外契约变更（升级必读）

- **「命中场景」只认实际改值**：同值赋值、锁定 no-op 和仅异常说明行不再进命中结果；实际改值行若同时有异常说明，说明保留，改值列继续标黄。
- **前置资金对账四字段严格平账**：对账 ID 必须非空；ID/渠道/币种 trim 后大小写敏感精确相等，金额按十进制规范值精确相等；任一项不同都不消费候选。
- **新资金对账文件契约**：按渠道生成 `资金对账不平_{渠道名}_XXXX年XX月XX日.xlsx`；前 5 个 sheet 固定为「不平结果 / 平账结果 / 网关账单 / 渠道账单 / 订单修复」，本渠道有完全重复网关记录时在末尾追加第 6 个固定 22 列「重复网关账单」，无重复保持 5 个。渠道集合取银行渠道与重复记录渠道并集，重复专属渠道仍导出且不串渠道；C4 读取器接受 4/5/6-sheet。

**新增**

- 前置资金对账模块：五槽位主面板，3.0.14 场景下拉只显示「缺网关账单」；存量用户默认关闭，可通过「小助手功能收纳」启用。
- 临时 MPT 网关账单：支持 `MPT_INBOUND_GATEWAY` / `MPT_OUTBOUND_GATEWAY` 的 txt/gz 流式解析和强校验，按逻辑表库分开汇总/删除，临时数据跨重启保留。
- 双生命周期 side DB：临时 MPT 和 run 候选/结果分库；新 run 或重启整文件回收旧结果，主库只保存轻量镜像。
- 完全重复网关账单审计：固定 22 列同时展示保留记录和全部被折叠记录；双方原始 JSON 按单片最多 30000 字符拆行，按对象和分片序号可无损重组。

**变更**

- 多对多异常说明检测只接收实际改值行；不改 R2 锁定、R5/C3 赋值和命中+未命中行数守恒。
- OUTBOUND 币种/金额使用 `bankDebit -> target -> origin` 成对优先级，不交叉拼接。
- 网关空 ID、无效行、完全重复折叠、未使用候选和多候选 ID 组均显示统计；完全重复还可从动态审计页追溯双方原始记录。INBOUND/OUTBOUND 的日期预统计和删除继续按 `sourceType` 隔离，删一类不影响另一类；网关候选池无可用非空 ID、运行结果丢失/损坏或数据源变化时禁止导出。

**当时后续规划（后续决策已变更）**

- 当时计划在 3.0.16 实现 `MPT_CHANNEL_OTHERS`、临时银行对账单和「缺渠道账单」；3.0.16 最终未交付，其中 `MPT_CHANNEL_OTHERS` 已取消。

## v3.0.13（2026-07-04）

v3.0.13 集中 **3 项资金对账口径收紧 + 2 项使用体验修复**：① 导入文件弹窗记住上次目录；② 网银账单生成在大账号自动识别失败、或识别到但未维护时拦截，不再静默套用其他大账号；③ 中台调拨对账单派生只纳入 `调拨状态=付款成功` 的中台行；④ 资金对账结果文件收口「命中场景」——只保留字段真实被改过、或带非空「异常说明」的银行行，并把多对多异常说明并入「命中场景」第 2 列；⑤ C3 多候选时优先选择赋值字段与银行旧值相同的网关候选，减少无意义覆盖和误改。`npm run release-check` 全绿（lint + smoke + unit **3318/3318** + integration **1780/1780**（38 脚本））。

### 🔴 对外契约变更（升级必读）

- **资金对账结果文件「命中场景」新增第 2 列「异常说明」**：第 1 列仍是「命中明细」，第 2 列为多对多等人工复核说明，原银行对账单字段整体从第 3 列开始。外部脚本若按固定列号读取「命中场景」，需整体右移 1 列适配。
- **不再单独生成「异常-人工判断 / 异常-人工处理」sheet**：多对多人工复核信息并入「命中场景」的「异常说明」列。纯异常说明、没有字段改写的行也会保留在「命中场景」；字段被改过且同时有异常说明的行仍会显示命中明细并给被改字段标黄。
- **「命中场景」不再展示纯 no-op 行**：只剩两类用户可看结果——字段实际被改过，或「异常说明」非空。R2 锁定但没有改字段、也没有异常说明的行不再出现在「命中场景」。
- **中台调拨派生过滤 `调拨状态`**：只有状态严格为 `付款成功` 的中台调拨行会进入调拨对账单派生；其他状态不再参与后续调拨对账、DBS-Charge 资金校验和 R5 调拨回填。

**新增**

- 导入目录记忆：所有业务导入文件弹窗按入口记住上次目录；某入口首次无记录时用最近一次全局导入目录兜底。背景图片选择等非业务入口不参与。
- 大账号识别失败拦截：多大账号模板导入时，若文件名 / 文件内容识别不到大账号，或识别到的大账号未在「维护大账号」中维护，直接返回可读错误并停止生成；多币种候选仍走既有选择弹窗。

**变更**

- 中台调拨对账单只处理 `调拨状态=付款成功`（🔴 资金口径）：`buildFundTransferReconRows` 在派生 in/out 调拨对账行前先过滤中台行；空状态、失败、处理中、已撤销等非成功状态均跳过。
- 资金对账结果「命中场景」收口（🔴 输出口径）：只把有真实字段修改的行放入 `modifiedRows`，并额外把多对多检测返回的非空异常说明行纳入；writer 把异常说明并入「命中场景」第 2 列、取消独立异常 sheet，标黄列偏移同步调整。
- C3 多候选优先同值赋值候选（🔴 对账写值口径）：直接取网关字段赋值时，如果某个候选的该字段值与银行旧值相同，则优先选该候选；自定义取值、银行旧值为空、找不到同值候选时仍取首个候选。

## v3.0.12（2026-06-28）

v3.0.12 集中 **2 项资金对账新功能 + 1 项资金红线 bug 修复**（team-lead 拆批 E/A/B/C/D 委托 dev 实施）：① 功能1 异常-人工判断 sheet——资金对账（银行对账单 run / 导出）结果文件新增「异常-人工判断」sheet，5 轮对账全部跑完后只读检测「银行对账单 ↔ 网关对账单 / 调拨对账单」多对多（同账号 + 币种 + 金额 + 日期，银行≥2 × 对手≥2），把涉及银行行汇总进该 sheet 供人工复核；纯附加、不改任何回填行为 / 字段 / 行数守恒；② 功能2 账户映射管理——「链接表管理」左下角新增「账户映射管理」入口，维护全局对照表「中台调拨单账户号 → 清结算系统银行账号」，调拨对账单派生时把 `big_account` 按映射换成清结算账号再去和银行单对账（🔴 资金红线·未配置则原样保留、映射表为空＝字节级零变化）；③ 修复C——「网关对账单赋值银行对账单」对账字段 currency 重启被清空的 bug（反转一条已变有害的历史迁移）。`npm run release-check` 全绿（unit **3272/3272** + integration **1771/1771**（38 脚本）+ smoke 全模块 PASS）。⚠️ 资金红线：功能2 改调拨对账单 `big_account` 派生口径（连带「中台调拨订单对账ID回填」R5s2-recon + DBS-Charge 资金校验 R3.5），功能1 只读不改写、修复C 仅反转有害迁移，均已人工复核 + 审 diff + 单测 + 跨接缝集成脚本。

**无对外契约变更**：功能1 纯附加 sheet（命中为空时主文件形态字节级零变化、既有 sheet 不动）；功能2 账户映射表为空时调拨派生字节级零变化；修复C 把存量错值改回正确值。

**新增**

- 异常-人工判断检测器 `detectFundTransferManyToMany`（功能1 · 🔴 资金红线·纯只读 · `scenario-engines/many-to-many-detector.js`）：5 轮对账跑完、`bankRows` 定稿后只读检测「银行 ↔ 网关 / 调拨」多对多。分组键 = 归一化账号 + 币种 + 金额（精确到分），同组内按日期 ±容差（默认 1 天、含同日）建二部图求连通分量，分量内 **银行≥2 且 对手≥2** → 该分量所有银行行命中（1v1 / 1vN / Nv1 不算）；网关、调拨各跑一遍按 `_rowId` 去重合并 + 中文说明。🔴 空值护栏（账号/币种为空、金额非有限数不进池）；🔴 绝不改任何 `bankRow` 字段 / `modifications` / 回填 / 行数守恒——只返回命中行引用 + 说明。复用既有金额/日期访问器（防字段漂移）。新增 `many-to-many-detector.test.js` + 集成脚本 `bank-statement-many-to-many-review-sheet.js`。
- 结果文件「异常-人工判断」sheet（功能1 · `exceljs-writer.js` + `bank-statement-io.js` + `reconciliation-orchestrator.js` + `main.js`）：writer 新增 `appendManyToManyReviewSheet` + 常量 `SHEET_MANY_TO_MANY_NAME='异常-人工判断'`，列 = `[异常说明, ...BANK_STATEMENT_FIELDS]`（银行列复用 `stripInternalFields`）；`writeBankStatementOutput` 加第 8 形参 `manyToManyRows`，仅命中非空时追加（空 / null → 主文件形态零变化）。编排器 R5 后调用、产出 `manyToManyReviewRows`（`{row, note}`）+ `stats.manyToManyReviewCount`（🔴 只读统计），经 `processingResult` 透传导出。
- 账户映射管理全局表 `fund_transfer_account_mappings`（功能2 · 🔴 风险敏感 · `migrations.js` + 仓储 + `database.js`）：新增全局对照表（`UNIQUE(mid_account_id)`，幂等 `CREATE TABLE IF NOT EXISTS`、不进 `ALL_TABLE_KEYS`）；仓储 `fund-transfer-account-mapping-repository.js`（`listMappings` / `saveMappings` 事务全删重插、空行跳过、半填抛错 / `getMappingMap` 归一化 `Map` + 🔴 空键护栏）；`database.js` facade 转发。新增 `fund-transfer-account-mapping-repository.test.js`。
- 账户映射管理弹窗 + 「链接表管理」入口（功能2 · `renderer-dialogs.js` + `preload.js` + `main.js`）：「链接表管理」左下角新增「账户映射管理」按钮（嵌套挂载、链接表管理留底层），打开 `createFundTransferAccountMappingDialog`（3 列「中台调拨单账户号 / 清结算系统银行账号 / 执行操作」）。新增 IPC `fund-transfer-account-mapping:list` / `:save`（保存前校验完整性 / 唯一性 / 长度≤128）+ preload `fundTransferAccountMappings.list/save`。补 preview 入口 `preview:fund-transfer-account-mapping`（四处镜像 `account-mapping-editing` 接法）。

**变更**

- 调拨对账单派生 `big_account` 套用账户映射（功能2 批B · 🔴 资金红线 · `fund-transfer-recon-builder.js` + `linked-derive-rebuild.js`）：`buildFundTransferReconRows(midRows, { accountMappingMap })` 新增可选第 2 参——in 行（收款账户）/ out 行（付款账户）的 `big_account` 命中映射 → 替换清结算账号、未命中 → 原样保留（`accountMappingMap.get(acc) ?? acc`；展示字段不动）；键值口径与 builder 一致（均经 `normalizeCellValue`，不再二次归一化防写错对账 ID）。`linked-derive-rebuild.js`（builder 唯一生产调用处、run / mid-allocation 导入两链皆经此）实时取 `database.getFundTransferAccountMappingMap()` 注入 → 单点注入两链统一生效；facade 缺失退空 `Map`、表空＝全 passthrough＝字节级零变化。新增集成脚本 `fund-transfer-recon-account-mapping.js` + `fund-transfer-recon-builder.test.js` 补映射组。

**修复**

- 「网关对账单赋值银行对账单」对账字段 currency 重启被清空（修复C · 🔴 资金红线 · `migrations.js` + `database.js`）：反转 v2.0.0-beta.3 历史迁移 `ensureC3GwFieldCurrencyCaseFix`（当年把小写 `currency` 改大写 `Currency` 对齐硬编码下拉枚举，当时正确）。v2.1.15 把 C3 下拉枚举源改读 `assets/网关对账单.xlsx` 表头（小写）、v2.1.16-beta.2 把 C3 引擎取数源切到 `linked_gateway_bill`（小写表头）后，UI/引擎都统一小写，唯独旧迁移仍每次开机无条件改大写 → 重启后大写值在小写下拉匹配不到落空值、引擎按小写 key 取不到值 → currency 维度静默不比对。新增 `ensureC3GwFieldCurrencyCaseRevert`：扫 `gateway-recon-join` 把 `reconFields[].gwField === 'Currency'` 改回 `'currency'`，一次性 marker（`c3_gw_field_currency_revert_done`）跑过即不再跑（不重蹈「每次开机无条件改写」覆盖用户后续合法改动）。`database.js` 改名转发。新增 `migrations-c3-gw-field-currency-revert.test.js`。

## v3.0.11（2026-06-23）

v3.0.11 集中 **1 项资金红线规则收紧 + 3 项体验/性能需求**（team-lead 拆需求 0/1/2/3 委托 dev 实施 + team-lead 审 diff/release-check/接缝核查/preview 兜底；需求 3 异步化「分批·导出独立」，本版只交付导入+运行不阻塞，导出流式化拆独立批次）：① 需求0 R5 场景3「银行行入桶 Debit 门槛」（🔴 资金红线）——双桶（一级 `ReconciliationId`/二级 `ChannelOrderNo`）建索引前加门槛，只有「无借方发生额」的行入桶（**口径B**：`Debit Amount` 为 0 或空白入桶、仅真实非零借方排除），杜绝有出金的脏行误当入金参与剔除匹配；② 需求1 链接表导入提醒框长文件名截断修复（前端）；③ 需求2 资金对账导出成功提醒框移除 error-report 行（文件仍生成）；④ 需求3（批1+批2）资金对账「导入/运行」不阻塞 + 统一防重入锁 + 按钮禁用（🔴 资金红线）。`npm run release-check` 全绿（unit **3218/3218** + integration 1728/1728（36 脚本）+ smoke 全模块 PASS）。⚠️ 资金红线：需求 0 改 R5s3 匹配池准入（连带 Credit 消歧/两级 fallback/1v1）、需求 3 异步化涉 run 路径但产物零变化（不碰 writer），已人工复核 + 审 diff + 单测重做/op-lock 互斥单测 + 接缝核查。

**无对外契约变更**：需求 0 仅收紧匹配池准入（剔除文件列结构不变、仅命中行可能减少）；需求 3 批1+批2 不碰 writer（产物 golden 字节级一致）；需求 1/2 前端展示。

**新增**

- 银行对账单处理统一 operation lock（需求 3 批1 + codex-P2 补强 · 🔴 资金红线 · `main.js`）：模块级单例锁 `bankStatementOperationLock` + `tryAcquire`/`release`，run/export/import **+ linked-table:import/delete-by-date-range** 共 5 个 handler 入口 acquire（争用返回 `{status:'failed', message:'正在处理中…'}`）+ finally 释放，统一一把互斥锁防并发撕裂 bank-statement 对账数据/会话态（含作为 R1-R5 输入的链接表）。新增 `bank-statement-op-lock.test.js`（源码接线 + 抽真实实现验五动作互斥/可重入）。
- 导入进度通道 `bank-statement:import:progress`（需求 3 批1）：handler 内联 100ms 节流转发器 → preload `bankStatement.onImportProgress` → renderer `formatBankStatementImportProgress` 刷「正在导入第 X/Y 个文件…」+ finally 退订。
- 按钮禁用统一闸 `state.bankStatementInflight` + codex-P3 修复（需求 3 批1 · `renderer.js`）：三动作任一进行中禁用《开始运行》《导出文件》《导入对账单》，三入口最外层设、最内层 finally 清。**codex P3**：中央 `updateBankStatementUi` 原无条件复活导入按钮（运行/导出期 UI 刷新触发）→ 导入按钮 disabled 也受 inflight 约束，堵住「刷新复活导入→点导入被拒 finally 清共享 inflight→运行/导出按钮中途复活」。

**变更**

- 需求 0 R5s3 入桶 Debit 门槛（🔴 资金红线 · `r5-platform-inbound-cleanup.js`）：入桶循环顶端 `parseNumber(bank['Debit Amount'])` 为 `null`（空/空白/非数字）或 `0`（含 `0.00`/`-0`）才入桶、真实非零借方跳过（双桶一致）；不改剔除行结构/触发方向/默认配置，`modifications` 恒 `[]`。单测重做（多候选 fixture 适配过门槛 + 门槛边界 + 门槛×fallback×1v1 交互）。
- 需求 3 批2 run 数据准备分块让出 + codex-P2 补强（🔴 资金红线 · `main.js`/`renderer.js`）：`prepare`→`reconcile` 间插 `prepare-clone-bank`/`prepare-gw`/`prepare-linked` 三处步骤边界 yield（🔴 不在 `structuredClone` 中途让出、不删 clone）。**codex P2**：linked-table 多步读取间让出须保证读取期不被并发改写 → 把 `linked-table:import`/`delete-by-date-range` 纳入同一把 op-lock（run 持锁期间并发改表被挡）→ 多步读取一致快照、三处让出全部保留。纯控制流，产物零变化。
- 需求 1 文件名换行（前端 · `styles-gemini-extra.css`）：`.alert-message` 加 `overflow-wrap: anywhere; word-break: break-word;`（未动共用 `.alert-card`）。
- 需求 2 导出框去 error-report（前端 · `renderer.js`）：`updateBankStatementUi` 已导出分支删 error-report 行；文件生成链路不动；配套单测断言反转。

**延后（独立批次）**

- 资金对账「导出文件」流式化（需求 3 批3+批4 · 🔴 资金红线）：「分批·导出独立」，导出异步化（`ExcelJS.stream.xlsx.WorkbookWriter` + 分块让出 + golden 字节级校验）拆独立批次/PR，不在本版。

## v3.0.10（2026-06-21）

v3.0.10 集中 **3 项**对账引擎收紧 + 退款回填输出改造需求（🔴 资金红线 · 无并入 spec）：① R4 资金性质校验加银行行借贷方向守卫（命中网关 TradeType 后再判银行行借贷方向——入账性质 Wire Return/HX-in 要求 `Debit Amount`=0、出账性质 Ach Return/HX-out 要求 `Credit Amount`=0，方向录反则不改写 FundType + 主错误报告告警）；② R5s4 退款回填加网关 reconid 前置过滤（银行候选行入池前先与网关 `reconciliationid` 集合匹配，命中网关的行静默移出退款池）；③ 退款回填输出文件改造（sheet1 命中字段交集标黄 + 银行段补 `Extra Information`/`Drawee Name` 两列 sheet1 31→33 + S4 命中标黄扩日期/大账号/金额/币种两侧 8 列 + sheet2 删「结果类型/退款单号」两列且银行段随之补 2 列 → 13 列 + 报错/提示并入信息列前缀 `【报错】`/`【提示】` + 删 refund-only 噪声行）。`npm run release-check` 全绿（unit **3196/3196** + integration 含跨接缝标黄 E2E + smoke 全模块 PASS）。⚠️ 资金红线：需求 1（R4 FundType 改写口径）+ 需求 2（R5s4 退款筛选口径）+ 需求 3.1（跨接缝标黄：引擎记命中列→export 浅拷贝→writer 标黄）均涉对账写口径/退款筛选/资金审计输出，已人工复核 + 跨接缝端到端测试 + codex review + `/check-vars`。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.10「对外契约变更」段）

- ① 退款回填报错 sheet2 改列（需求 3.2 + 退款输出细化 · 🔴 输出口径变更）：第 2 个 sheet（未匹配报错）删「结果类型」「退款单号」两列、银行段随 `REFUND_BANK_COLUMNS` 10→12（补 `Extra Information`/`Drawee Name`）→ 最终 13 列（银行 12 + 信息 1，与旧 13 列构成不同：旧 = 结果类型+退款单号+银行 10+信息）；报错/提示并入「报错/提示信息」列、按类型加前缀 `【报错】`/`【提示】`；删「只有退款单、无对应银行行」的 refund-only 收尾行（完全静默删除）。
- ② 退款回填模板 sheet1 银行段补 2 列（需求 3.1 退款输出细化 · 🔴 输出口径变更）：sheet1（回填模板）银行段按 `BANK_STATEMENT_FIELDS` 模板序新增 `Extra Information`（CustomerRef 后）、`Drawee Name`（Payment Detail 后、银行段末位）→ sheet1 31→33 列（固定 6 + 银行 12 + 中台 15）；命中单元格另有黄色填充。外部按旧 31 列解析退款回填 sheet1、或按旧 13 列/无前缀解析报错 sheet2 的脚本需适配。

**新增**

- R4 方向守卫一次性幂等迁移 `ensureR4DirectionGuardConfigMigration`（需求 1 · 🔴 资金红线 · `migrations.js`+`database.js`）：4 个 R4 子场景内置 seed 各加 `requireBankZeroField`（出账性质 Ach Return/HX-out=`Credit Amount`、入账性质 Wire Return/HX-in=`Debit Amount`）。因 `ensureReconRoundBuiltinScenariosSeed` 凭全局 marker 短路、老库已 seed 过拿不到新字段 → 守卫静默失效，故新增**无 marker、每次启动幂等补回缺失字段**的专用迁移（范式照搬 `ensureFundTypeAchReturnConfigMigration`：LIKE 粗筛 + `JSON.parse` 校验 subCategory 严格相等 + 事务 + 表不存在 no-op）；🔴 绝不覆盖用户已改的值（已含字段则跳过、哪怕被改成空串），二次启动 `updated=0`。注册三点 = `database.js` require/薄壳/调用（插在 `retireChargeOutboundOrphans` 之后）。新增 `migrations-r4-direction-guard.test.js`。
- R4 方向不符告警 cause 文案（需求 1 · `error-causes.js`）：`CAUSE_MAP` 加 `'r4-fund-direction-mismatch'`（「资金性质命中但银行行借贷方向不符（应为0的金额列非0），已跳过该行资金性质改写，请人工核对方向」），走既有主错误报告链路（场景名「资金性质校验」、5 列含对账 ID 与可读「可能原因」）。

**变更**

- 需求 1 R4 资金性质校验加银行行借贷方向守卫（🔴 资金红线 · `r4-fund-nature-check.js`）：R4 引擎主循环在 `applyHandler` 返回非空 decision（命中网关 TradeType）之后、改写 FundType 之前插方向守卫——读 `config.requireBankZeroField`，「应为0」金额列实际非0（`(parseNumber(bankRow[zf]) || 0) !== 0`）则不改写 + push warning（`r4-fund-direction-mismatch`）+ continue，方向满足走原有改写。「应为0」口径与全仓一致（空/garbage 当 0 = 满足）。守卫**只放主循环不放纯函数 `applyHandler`**（后者无 warning 权、且无法区分「网关没匹配（null 静默不 warn）」vs「命中但方向不符（才 warn）」）；叠加链每 handler 各判各的（某跳不符停在上一跳值）；no-op（`oldValue==decision`）不 warn 不 record。顶部 import 加 `parseNumber`。`r4-fund-nature-check.test.js` 加方向守卫组 + `applyHandler` 不读金额职责分离断言；`migrations-recon-round-seed.test.js`/`error-causes.test.js` 同步补期望。
- 需求 2 R5s4 退款回填加网关 reconid 前置过滤（🔴 资金红线 · `reconciliation-orchestrator.js`+`r5-refund-order-backfill.js`）：编排器把网关全量行（`safeGwRows`）经第 4 参 `gwRows` 传入退款引擎；引擎建网关 `reconciliationid`（小写）集合，bankPool 在既有两道筛（`FundType==='Ach Return' && !isFundTypeChanged`）后追加第 3 道筛——银行行 `ReconciliationId`（驼峰）命中网关集合即静默 drop（不回填/不进 sheet2/不留痕）。空键不参与（照常入池）；网关集合缺省退化为原行为；大小写敏感（`normalizeCellValue` 仅 trim、精确等值）。审计不变量不破（入池前过滤、退款引擎旁路、行数守恒）。`r5-refund-order-backfill.test.js` 加网关前置过滤组（命中静默移出/空键/缺省退化/大小写敏感）。
- 需求 3.1 退款回填 sheet1 命中字段交集标黄（🔴 资金红线跨接缝 · `r5-refund-order-backfill.js`+`refund-backfill-writer.js`）：各匹配策略命中诚实记「候选比对列」`_matchedColumns`，在 `buildBackfillRow` 单点收口过滤到「既参与匹配、又在 sheet1 列（`REFUND_TEMPLATE_HEADERS`）」交集、非空才挂；export 浅拷贝 `{...r}` 天然保 `_` 字段（main.js 不改）；writer 就地定义 `YELLOW_FILL`（argb `FFFFFF00`，注释指向 `exceljs-writer.js` 单一真相），sheet1 写循环按 `_matchedColumns` 标黄（列偏移 `getCell(i+1)`——退款 sheet1 无前导列，区别于主报告 `colIdx+2`）。交集标黄、零交集不标；命中即停单行单策略。新增跨接缝端到端集成脚本 `refund-backfill-yellow-fill-e2e.js`（引擎→浅拷贝→writer→ExcelJS readback 断言标黄列）+ 逐策略 `_matchedColumns` 链断言 + writer 标黄断言。
- 需求 3.1 退款输出细化：银行段补 `Extra Information`/`Drawee Name` 两列 + S4 标黄扩 8 列（🔴 资金红线/输出口径 · `refund-backfill-fields.js`+`r5-refund-order-backfill.js`）：`REFUND_BANK_COLUMNS` 10→12（按 `BANK_STATEMENT_FIELDS` 模板序插 `Extra Information`（CustomerRef 后）+ `Drawee Name`（Payment Detail 后、银行段末位），均 ∈ `BANK_STATEMENT_FIELDS` 启动断言①自动通过），传播至 `REFUND_TEMPLATE_HEADERS` 31→33 / `UNMATCHED_HEADERS` 11→13；让 S2-MTX/JPM-HK/S2b/S3b/S3c 命中 `Extra Information`、S3 命中 `Drawee Name` 时也标黄（不改 matcher 候选逻辑，靠列加入 sheet1 自动生效）。S4 命中 `_matchedColumns` 由 `[BillDate, valueDate]` 扩为按命中详情文案「退款提交日期+大账号+金额+币种」口径的 8 列（bank `BillDate`/`MerchantId`/`Debit Amount`/`Currency` + ro `valueDate`/`银行大账号`/`退款金额`/`币种`）；🔴 S4「金额」实际匹配口径为 `|Credit−Debit|` 绝对值，`Debit Amount` 列仅作展示列标黄。
- 需求 3.2 退款回填报错 sheet2 改造（🔴 输出口径，详见对外契约① · `refund-backfill-writer.js`+`r5-refund-order-backfill.js`）：`UNMATCHED_HEADERS = [...REFUND_BANK_COLUMNS, '报错/提示信息']` 删「结果类型」+「退款单号」、银行段随 `REFUND_BANK_COLUMNS` 10→12 → 最终 13 列（银行 12 + 信息 1）；报错/提示前缀（`【报错】`/`【提示】`）单点加在 `buildUnmatchedBankRow`（走该函数的 bank 形状行自动带前缀），保留 row 上 `结果类型` key（仅不进 sheet2 投影）兼容引擎内部 filter；删 refund-only 两段收尾循环（完全静默删除）；保留 bank-only NOTICE 行。审计不变量收窄为「银行侧全覆盖」（refund-only 不再产 notice 行）。`r5-refund-order-backfill.test.js` §⑩ 不变量组重写 + 文案前缀断言；`refund-backfill-writer.test.js` sheet2 13 列断言。

## v3.0.9（2026-06-18）

v3.0.9 集中 **1 项**核心需求（无并入 spec）：**工具箱「按字段值拆分」支持 800MB / ~700 万行多 sheet 大文件**。新建一条隔离的、worker 化的、内存有界的工具箱大文件拆分通道，复用 `big-table-import/` yauzl 流式原语（`zip-reader.js` / `row-scanner.js`），🔴 绝不碰 `streaming-xlsx-reader.js`（隔离资金红线复用文件）、🚩 前端零改动（回传契约 `valuesByField={field:string[]}` 逐字节一致）、小文件路径零回归（路由 fail-closed）。

**新增**

- 工具箱大文件按字段拆分隔离 worker 通道（`src/backend/toolbox-xlsx-stream/` 5 模块 + `src/main-process/` 2 模块）：① `multi-sheet-reader.js`（T1）多 sheet 当一张逻辑表流式读（复用 `openZipWithEntries`/`locateSheets`/`loadSharedStrings`/`scanSheetRows`，绕 `openWorkbook` 多 sheet 拒绝，续页语义 = 重复表头跳过 / 列数超表头报错）；② `bounded-values-accumulator.js`（T2）每列封顶 N=1000 有界去重 + 全局 maxTotalDistinct=200000，回传 `string[]` 同契约；③ `split-scan-fields.js`/`split-export-filter.js`（T3）扫字段 + 按值过滤流式写（peek 表头 O(1) 早退 + `writeRowsStreamed` 超 104 万行自动分 sheet）；④ `large-split-worker.js`+`toolbox-large-split-dispatch.js`（T4）worker_threads 隔离（`maxOldGenerationSizeMb=4096`）+ sharedStrings 护栏（>~1.2GB 可解释拒绝）+ heapUsed>~3GB 主动拒；⑤ `toolbox-large-split-router.js`（T5）`shouldUseLargeChannel` 只用 `collectEntrySizes` 判定（不解压、禁用全读 buffer 的 `readXlsxSheetMetaLite`），多 sheet 或单 worksheet ≥1.5GB → 大通道，否则 fail-closed。

**变更**

- `main.js` 工具箱两 handler（`toolbox:split:read`/`toolbox:split:export`）加大通道路由分叉（T6，唯一改动的既有 src 文件）：命中走 `dispatchLargeSplit`（worker），否则走现有小文件分支（一字未改、行为不变）；export 临时大文件改 `try/finally` 可靠清理。

**修复**

- B20 工具箱拆分成功路径临时目录不清理（split:export 半，随 T6 顺带修）：`toolbox:split:export` 各路径统一 `finally rmSync` 清临时 xlsx（`toolbox:merge` 半本迭代不碰、仍留 backlog）。

**已知限制（前端零改动的代价）**：OPEN-1 高基数列下拉只显前 ~1000 值无截断提示（按字段拆通常用低基数维度，影响有限）；OPEN-2 sharedStrings >~1.2GB 全唯一长文本文件 v1 可解释拒绝；OPEN-3 进度走后端 log、无进度条/cancel UI。

**无对外契约变更**（前端零改动 + 小文件零回归 + 回传契约逐字节一致）。

## v3.0.8（2026-06-16）

v3.0.8 迭代：共 **7 项**——5 项新反馈 + 2 份并入的 v3.0.7 资金红线修复 spec（team-lead 拆分委托 dev 分 W1~W6 实施，W4=需求6+需求3 合并工作流）。① 需求1 工具箱🧰（合表/拆表）——主界面左下角新增🧰按钮 → 脱离主对账流程的轻量 Excel 小工具：合并多个表头一致的表为一张（导入即一气呵成另存为 `合并-YYYYMMDDHHmm.xlsx`）、按某字段的某些值从一张表拆出子集（导入 → 选字段/值 → 导出 `拆分-值-YYYYMMDDHHmm.xlsx`），3 个 IPC（`toolbox:merge`/`toolbox:split:read`/`toolbox:split:export`）复用 file-service 读写，对既有链路零影响；② 需求2 场景管理退役 C3（`gateway-recon-join`，前端隐藏 + 新库不 seed，后端引擎/约束/已有库记录全保留可回滚）+ 两大功能分组（「资金性质校验」「中台订单数据处理」）三角折叠、默认收纳；③ 需求3 资金对账「开始运行」不阻塞（🔴 资金红线）——`bank-statement:run` 改 async + 轮次边界让出事件循环（不上 worker）+ 新增进度通道 `bank-statement:run:progress`，消除运行期窗口「未响应」，对账产物 golden 字节不变；④ 需求4 银行未命中场景 sheet 数据右移 B 列（🔴 对外口径变更）——sheet1 提醒独占 A1、表头/数据整体右移 B 列起；⑤ 需求5 BOC 调拨修复行 Type 2→1（🔴 资金红线/下游契约变更）——修复模板输出列 `Type` 由 `2` 改 `1`；⑥ 需求6 运行内存尖峰修复（🔴 资金红线，并入 spec A）——bank-deposit 入金表加消费方门控（关退款场景不读 ~1.2GB、注入 `[]`）+ gateway-bill 按 Channel 子集下推过滤读 + 删深拷（新增仓储 `readGatewayBillRowsByChannels`），根治 Windows「开始运行」卡死；⑦ 需求7 R5s3 两级 fallback + FundType 子串（🔴 资金红线，并入 spec B）——中台加款单脏数据处理引擎：`ReconciliationId` 匹配不上时用 `ChannelOrderNo` 兜底（两级 fallback、严格 1v1 跨两级共享、一级消歧失败不 fallback）+ 触发条件由精确判等 `FundType==='Inbound'` 改子串包含判定（大小写不敏感），防 `Inbound-VA` 等入金变体被误剔除。质量门 `npm run release-check` 全绿（unit + integration + smoke）。⚠️ 资金红线：需求 3/4/5/6/7 均涉对账 run 路径或输出口径，已人工复核 + golden/等价回归。

### v3.0.8 第二轮追加（2026-06-17，版本号并入 3.0.8 不 bump · 分支 `v3.0.8-userguide-bank-2cols`）

PR #77 合入 main 后第二轮迭代，**5 项**——① 迭代1 使用手册去技术术语 + 总览导航 + 46 列兼容说明（需求8，纯文档）；② 迭代2 银行对账单 44→46 列（需求9，🔴 资金红线，识别 + 字段下拉可选 + BU 回填兼容导入·不落库）；③ BUG2 场景管理弹窗用户自建 C3 误消失修复；④ BUG3 工具箱合并/拆分大文件（30 万行）OOM 闪退 / 误报「文件为空」改流式修复（🔴 顺带修 `streaming-xlsx-reader.js` 读值正则，银行对账单导入复用、升级必读）；⑤ 工具箱弹窗尺寸微调。`npm run release-check` 全绿（unit **3040/3040** + 34 集成脚本 + smoke 全模块 PASS）+ 用户手动测试 BUG2/BUG3 通过。

**🔴 对外契约变更（升级必读，详见 CHANGELOG「v3.0.8 第二轮追加 · 🔴 对外契约变更」段）**

- ① 银行对账单模板 44→46 列（迭代2 · 🔴 资金红线）：「渠道对账单」sheet 在 `'Transaction Description'` 后加「合并单号」「合并状态」；软件识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、不落库（新旧 44/46 列文件均识别、宽容超集校验、按列名取值防后移列错位、`bank_bu_recon_bank_imports` 列结构不动）；旧版 44 列文件行为不变、Pending 严格校验零波及。
- ② `streaming-xlsx-reader.js` 读值正则修复（含首尾空格字符串不再被读空）（BUG3 顺带 · 🔴 资金红线 · 影响银行对账单导入读值）：`V_CONTENT_RE` 改为容忍 `<v>` 任意属性（`xml:space="preserve"` 的含首尾空格单元格旧版被读空、本次修复，裸 `<v>` 仍匹配向后兼容）；该读取器被银行对账单导入复用 → 升级后此前读空的含首尾空格列会读到真实值，**建议真实数据回归银行对账单导入读值**。
- ③ 工具箱合并/拆分大文件改流式（30 万行不再闪退）（BUG3 · 🟡 性能）：SheetJS 全量读 → 流式读 + `WorkbookWriter` 流式写，输出与现状完全一致、超 104 万行自动分 sheet、csv/xls 回退；无对外列契约 / 文件名规则变化。

**新增**

- 迭代2 银行对账单 44→46 列（🔴 资金红线）：`BANK_STATEMENT_FIELDS` 44→46（「合并单号」「合并状态」插在 `'Transaction Description'` 后）+ `preload.js` inline 副本逐列同步；`table-signatures.js` `expectedHeaders` 复用自动跟随、`signatureHeaders` 指纹列不变（新旧均识别）；`validator.js` 加 `allowSupersetColumns`（银行宽容超集、Pending 严格零回归）；`reader.js` 改按列名 `headerIndexMap` 取值（防后移列错位）；`columns.js BANK_HEADERS` 保持 44 列不动=不落库。`assets/银行对账单.xlsx` 升级 + `header-superset-mapping.test.js` 新增 + 改 2 测。
- 流式 Excel 读写模块 `toolbox-stream-io.js`（BUG3 载体）：读侧 `.xlsx` 复用 `readXlsxStreamed`（内存恒定）、`.csv`/`.xls` 回退全量；写侧 `ExcelJS.stream.xlsx.WorkbookWriter` 逐行写 + by-name 格式（与 `writeWorkbookRows` 一致）+ 超 `1048575` 行自动开 sub-sheet。`main.js` 三 IPC（`toolbox:merge`/`toolbox:split:read`/`toolbox:split:export`）改走流式。

**变更**

- 迭代1 使用手册 `docs/USER_GUIDE.md` 全册去技术术语 + 1.4 总览导航 + 1.6.1 银行 46 列兼容说明（🟢 纯文档）：约 567 处技术术语 → 业务白话（6 段并行只读审查 → 单 agent 串行应用 → grep 验证，核心禁用词全册清零；软件界面名 / Excel 真实列名 / 渠道数据真值保留并配中文解释；历史 changelog 不洗——用户拍板）；SOP 沉淀 `knowledge/user-guide-dejargon-playbook.md`；零业务代码改动。
- 工具箱弹窗尺寸微调（🟢 体验）：`.toolbox-card width` 230→`min(94vw, 246px)`（左右各 +8）+ `.toolbox-body padding-bottom` 12→27 + `.toolbox-card transform: translateY(7.5px)`（口径 B：下沿净 +15、上沿不动，卡片高净 +15）；纯样式、preview 回归。

**修复**

- BUG2 场景管理弹窗用户自建 C3 在 v3.0.8 后误消失（🟢 体验回归 · `renderer-dialogs.js:7051`）：需求2 退役自带 C3 时前端过滤一刀切隐藏全部 `gateway-recon-join`，误伤用户自建 C3。过滤由 `s.category!=='gateway-recon-join'` 收窄为 `!(s.category === 'gateway-recon-join' && s.isBuiltin)`——仅隐藏自带 C3（`isBuiltin=true`）、保留用户自建 C3 可见可管理；运行口径 `hasC3Enabled` 未动（已有库手动启用的 C3 仍运行）。
- BUG3 工具箱合并/拆分 30 万行 OOM 闪退 / 误报「文件为空」（🔴 涉资金红线复用文件）：改流式（新增 `toolbox-stream-io.js` + 三 IPC 改流式）+ `readers.js` 内存错误（`isMemoryError`）回「文件过大」真实文案 + 🔴 顺带修 `streaming-xlsx-reader.js V_CONTENT_RE` 读值正则（含首尾空格字符串不再读空，银行对账单导入复用，向后兼容、建议真实数据回归——详见对外契约②）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.8「对外契约变更」段）

- ① BOC 调拨订单修复模板 `Type` 列 2→1（需求5 · 🔴 资金红线 · 下游契约变更）：`boc-dispatch-order-fix.js` 修复模板输出行 `Type` 由写死 `2`（v3.0.4 块 E D9 拍板值）改为 `1`（业务确认）。`Type` 仅落输出 Excel 给下游、src/ 内无按 `Type==值` 过滤逻辑，但下游按 Type=2 解析 BOC 修复模板的脚本/流程需适配 Type=1；匹配/组失败语义零变化。
- ② 资金对账「未命中场景」sheet 列位整体右移一列（需求4 · 🔴 输出口径变更）：sheet1「未命中场景」由「A1 提醒 + 表头/数据均从 A 列起」改为「A1 提醒独占首列 + 表头第 2 行/数据第 3 行均从 B 列起、A 列除 A1 留空」；外部按 A 列解析未命中场景表头/数据的脚本需整体右移一列。仅 sheet1；sheet2「命中场景」零变化；A1 提醒文案、行号不变。
- ③ 资金对账 run 入口 gateway 网关账单改「按 Channel 过滤读」（对账口径：消除跨渠道误匹配）（需求6 · 🔴 资金红线 · 带业务不变量的优化）：`bank-statement:run` 不再全量读网关账单表，改为只读本批银行单出现过的 Channel 子集（新增仓储 `readGatewayBillRowsByChannels`，下推 SQL 过滤 + 处理空/缺 Channel + 归一化口径对齐）。load-bearing 业务不变量（业务负责人已确认）：跨渠道对账永远不存在——Channel=X 的银行行只匹配 Channel=X 的网关行。不漏任何合法匹配；唯一被滤掉的是「跨渠道匹配」（业务定义那本是错配）→ 对账口径上消除跨渠道误匹配（非纯字节不变，已等价测试 + 业务不变量双重背书）。bank-deposit 门控（关退款场景注入 `[]`）为字节级不变优化。

### 新增

- 需求1 工具箱🧰（合表/拆表）：左下角 `background-tool-actions` 加第 4 个 🧰 按钮 → `createToolboxDialog` 弹框。合并表格 = 多选 ≥2 表头完全一致（列名 + 列序）文件 → 一致性校验（不同 → `FileValidationError` → alert 列差异并停止、不产文件）→ 合并（首文件表头 + 各文件数据行）→ 另存为 `合并-{YYYYMMDDHHmm}.xlsx`，一气呵成无独立导出按钮。拆分表格 = 单选文件 → `createSplitFieldPickerDialog`（单选字段 + 多选值、值随字段切换、空选不可导出）→ `[导出文件]` 过滤 `row[field] ∈ values` → 另存为 `拆分-{值拼接 sanitize}-{YYYYMMDDHHmm}.xlsx`（多选值 → 单文件含全部选中值的行）。3 个 IPC 复用 file-service `extractHeaders`/`readRows`/`writeWorkbookRows` + 端到端测试 + preview（4 处入口）。不做表头相似对齐 / 多字段组合筛选 / 一值一文件 / 复用主对账模板列映射币种归一化。
- 需求3 资金对账运行进度通道（🔴 资金红线）：新增单向 IPC `bank-statement:run:progress`（main→renderer，仿收单 `createRunProgressForwarder`），`preload` 暴露 `bankStatement.onRunProgress`，`renderer.js` `runBankStatementInternal` 订阅更新状态框；编排器 `runReconciliation` 改 async、轮次边界（R1→R2→R3.5→R4→R5 含 s2/s2b/s3/s4 子轮）插 yield + 进度上报。
- 需求6 网关账单按 Channel 过滤读仓储（🔴 资金红线）：`linked-table-repository.js` 新增 `readGatewayBillRowsByChannels`（仿 `readBankDepositAdmCandidates`），按 Channel 子集下推 SQL 过滤读；三个陷阱——空/缺 Channel（S 含空值时额外 `OR json_extract(...) IS NULL OR ...=''`）/ 归一化口径与引擎 `normalizeCell` 对齐 / 逐轮确认无越界 Channel 需求。`src/backend/database.js` 加 facade。

### 变更

- 需求2 场景管理退役 C3 + 分组折叠：前端 `createScenariosManagerDialog`（`refreshTable`/`renderRow`）过滤 `category==='gateway-recon-join'` 不显示；`migrations.js` `ensureScenariosSupport` 对新库不再 seed C3。不动 C3 引擎/dispatcher case/CHECK 约束/旧库已有记录（仅 UI 隐藏 + 新库不 seed，可回滚，与 R1 强制匹配无关）。按 `config.funcCategory` 归两组（`fund-nature-check`+`dbs-charge-fund-check`→「资金性质校验」、`platform-order`→「中台订单数据处理」），组标题带 ▶/▼ 三角、默认 collapsed（折叠态前端临时、不持久化）；CSS 加 `.scenario-group-header`/`.scenario-group-toggle`/`.collapsed`，preview 回归。
- 需求3 资金对账「开始运行」不阻塞（🔴 资金红线 · golden 字节不变）：`bank-statement:run` handler 改 async + 阶段边界 `await new Promise(r => setImmediate(r))` 让出；`reconciliation-orchestrator.js` `runReconciliation` 改 async / 注入 `onProgress`、仅轮次边界插 yield + 进度上报（轮次顺序/引擎入参/数据匹配逻辑零改动），消除运行期主进程阻塞致「未响应」。不上 worker_threads；进度只做状态框文案更新。
- 需求4 银行未命中场景 sheet 数据右移 B 列（🔴 输出口径，详见对外契约②）：`exceljs-writer.js` sheet1「未命中场景」表头 `getCell(idx+1)→idx+2`、数据 `getCell(colIdx+1)→colIdx+2`（仅右移列、行不变），A1 提醒不变、A 列除 A1 留空。仅 sheet1，golden 回归更新。
- 需求5 BOC 调拨修复行 Type 2→1（🔴 资金红线，详见对外契约①）：`boc-dispatch-order-fix.js` 修复模板输出列 `Type: 2 → 1` + 同步注释 + 单测断言 + golden 更新；匹配/组失败语义零变化。
- 需求6 运行内存尖峰修复（🔴 资金红线 · 并入 spec A，详见对外契约③）：① bank-deposit 消费方门控——`main.js` run 入口加 `refundBackfillEnabled` 谓词（逐字镜像编排器 r5s4 分桶条件），关退款场景注入 `[]` 替代 `structuredClone(readLinkedTableRows('bank-deposit'))`（曾 65.7 万行 ~1.2GB），退款场景关时编排器本就 no-op、结果字节级不变；② gateway-bill 按 Channel 过滤读 + 删深拷——收集本批银行单 Channel 集合 S、只读 `Channel ∈ S` 网关行，`gwRows` 全程只读 → 删 `structuredClone(readLinkedTableRows('gateway-bill'))`。🔴 银行行 `structuredClone(bankStatementSession.rows)` 必须保留（常驻 session、引擎原地改）。根治 Windows 导入约 2862 行普通渠道对账单（Channel=BOSH、CN）后点「开始运行」极卡（卡在 run 阶段全量读多张链接表）。
- 需求7 R5s3 两级 fallback + FundType 子串判定（🔴 资金红线 · 并入 spec B）：`r5-platform-inbound-cleanup.js` 三处——① 建双键索引（`bankByReconId`+`bankByChannelOrderNo`）；② 两级 fallback——网关同一 `reconciliationid` 值优先撞银行 `ReconciliationId`（一级），一级「查无此行」才退撞 `ChannelOrderNo`（二级）；🔴 一级消歧失败（0/≥2 条 Credit）不 fallback（保持 `no-credit-match`/`multi-credit-match` 警告并跳过——只补「查无此行」不补「有歧义」），二级同套 Credit 消歧（警告补「(按 ChannelOrderNo 匹配)」标记），`usedBankRowId` 跨两级共享严格 1v1；③ 触发条件由「`FundType !== 'Inbound'` 才剔除」改「`FundType` 不包含 `excludeFundType` 子串才剔除」（大小写不敏感 `ft.toLowerCase().includes(ex.toLowerCase())`，`ex===''` 显式走全产分支防 `includes('')` 恒真反转）。不动 `buildCleanupRow`/配置 seed（`excludeFundType:'Inbound'` 字段名与值不变）/`ChannelOrderNo` 只作匹配键。对现有 12 值 FundType 枚举零行为变化（仅 `'Inbound'` 含 "Inbound" 子串）。

## v3.0.7（2026-06-16）

v3.0.7 迭代：资金对账数据处理模块 体验/产出优化 + 一项 CI 打包红线修复——① 需求1 状态框文案重排（纯展示：「已处理」按「渠道-地区」分组多行、移除「N 警告」尾巴、新增「中台加款单脏数据处理」(R5场景3) +「中台退款订单回填」(R5场景4) 两行命中数，启用即显示含「0 条命中」）；② 需求2 面板简化 +「导入文件」通用入口（🔴 资金红线：删「导入不平表」及其「导出文件」网关按钮对，「导入对账单」改名「导入文件」并升级为按表头识别 + Channel 二次路由的通用导入——ADM/BOC/JPM-US 44 列文件落 `linked_bank_deposit` 链接表供 R1-R5 / R5 退款二跳消费、含常规渠道则走主处理；状态框合并跨两行增高、按钮零位移）；③ 需求3 命中明细格式重排（纯展示：结果文件命中明细 `字段名:旧值→新值`，数字→中文双引号 `"v"` / 否则→半角尖括号 `<v>`，多条 `; ` 单行连接、关闭 wrapText 不撑高行）；④ dist-size 守卫阈值校准（🔴 CI/打包红线：`check-dist-size` asar 上限 25MB→70MB，修复 main 自 v3.0.5 起 build 作业因 `app.asar≈57.5MB` 超阈值 `exit 1`）。质量门 `npm run release-check` 全绿（unit 2858 / integration 31 脚本 1424 用例 / smoke 全模块 PASS）。⚠️ 资金红线：仅需求2「导入文件」改了链接表数据来源（R1-R5 / R5 退款二跳）；需求1/3 纯展示/格式，不改对账值/匹配/派生。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.7「对外契约变更」段）

- ① 「导入对账单」改名「导入文件」并升级为通用导入入口（需求2）：id/handler/IPC 不变，升级为「识别+路由+落库桥接」——44 列文件先按 `BANK_STATEMENT` 识别再读 Channel 二次路由：非空 Channel 全 ∈ {ADM,BOC,JPM-US} → 整文件走 bank-deposit 链接表导入（+ ADM/BOC 派生，JPM-US 行落 `linked_bank_deposit` 供 R5 退款二跳）；含常规渠道 → 照旧 R1-R5 主处理。链接表是 R1-R5 / R5 退款二跳的数据来源，落库后仍进主处理；「链接表管理」入口与功能不变（两入口并存）。
- ② 退款回填务必「一次多选」导入退款单 + 银行单（🔴 资金红线操作约束）：分两次导入（先退款单后银行单）会触发既有「导入新银行单清空退款 session」逻辑 → run 时退款池空 → 退款回填静默失败、无文件产出；需求1 新增「中台退款订单回填:0 条命中」可作运行时自检信号。

### 新增

- 需求1 状态框命中提醒扩展（纯展示）：「已处理」改用 `stats.channelRegionHits` 按「渠道-地区」分组多行（渠道-地区口径复用 `channelEnumRepository.extractChannelRegionCombos`，旧数据缺字段回退 `hitScenarios` 旧格式不抛错）；新增「中台加款单脏数据处理」(R5场景3) +「中台退款订单回填」(R5场景4) 两行（场景启用即显示含「0 条命中」，`r5s3Enabled`/`r5s4Enabled` 门控）。
- 「导入文件」通用导入路由专项集成测试 `scripts/integration/bank-statement-universal-import-routing.js`。

### 变更

- 需求2 面板简化 +「导入文件」入口（🔴 资金红线）：删原 row2 两个网关按钮（导入不平表 / 导出文件，含 renderer DOM 缓存/事件/导出 disabled 网关分支清理）；「导入对账单」→「导入文件」（详见对外契约①）；原 row2(场景管理)+row3(链接表/状态框) 合并为单 control-row（2 列×2 行 grid），状态框跨两行 + `align-self:stretch` → 垂直高度由 110px 增至 ≈176px（上沿对齐场景管理、下沿对齐原下沿；场景管理/链接表管理/开始运行/导入文件 零位移，像素级实测复核）。
- 需求3 命中明细模板重排（纯展示）：结果文件命中明细 `字段名:旧值→新值`（`wrapHitValue`：trim 后含 `/\d/` → 中文双引号 `"v"`、否则 → 半角尖括号 `<v>`）；多条 `; ` 单行连接、命中明细单元格关闭 `wrapText` 不撑高行；OPEN-7 跨期提醒 append 由 `\n` 改 `; `。
- dist-size 守卫阈值（🔴 CI/打包红线）：`scripts/check-dist-size.js` `MAX_ASAR_BYTES` 25MB→70MB（实测 `app.asar≈57.5MB` + 余量），修复 main 自 v3.0.5 起 build 作业 "Check dist size" `exit 1`（PR 跳过 build job 故未暴露）；纯配置常量、零运行时改动、不删依赖、保留防回归。

### 移除

- 资金对账面板「导入不平表」及其右侧「导出文件」网关按钮对（网关 ReconID 修复仍可经「对账单 ReconID 修复」模块使用，后端零改动）。

## v3.0.6（2026-06-16）

v3.0.6 迭代：资金对账数据处理模块，三需求 + 一项退役（team-lead 拆分委托 dev 分 T1~T11 实施）——① 需求1 调拨对账单派生（「链接表管理」导入「中台调拨订单」后自动派生隐藏表「调拨对账单」，一行中台单 → FundTransfer-in / out 两行）；② 需求2 中台调拨订单对账ID回填「数据来源二选一」（R5 场景2 新增勾选框「对账数据来源为中台调拨单表」，默认勾选，勾选用调拨对账单回填、取消沿用网关对账单）；③ 需求3 DBS-Charge 资金校验（原全渠道「Charge转outbound」整体重写为 DBS 专属，对账编排新增 R3.5 轮）；④ charge-outbound 退役（非 DBS 渠道不再 charge→outbound，v3.0.4 块 G「多 Charge 取 Debit 最大行」移除，旧库每次启动幂等删除）。质量门 `npm run release-check` 全绿（unit 2803 / integration 30 脚本 / smoke 全模块 PASS）。⚠️ 多处资金红线：需求1 派生表是需求2 / 需求3 的数据来源（大账号按方向取卡号、全角括号列名漂移=大账号全空）；需求2 / 需求3 均改写银行 `ReconciliationId`（需求3 还改 `FundType`）；需求3 R3.5 在 R4 前演化 `bankRows` 同一引用（叠加链跨轮保留）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.6「对外契约变更」段）

- ① 非 DBS 渠道不再有 charge→outbound（charge-outbound 退役）（需求3）：原全渠道「Charge转outbound」子场景（含 v3.0.4 块 G「同 ReconciliationId 多 Charge 取 Debit 最大行」边界）整体退役，全渠道不再发生 charge→outbound 改写；改由仅 `Channel=DBS` 生效的 R3.5 承接。存量非 DBS 渠道升级后原被改写的行保持 `Charge`，下游 `outbound→HX-out` 链行数减少；旧库 `charge-outbound` 条目每次启动幂等 DELETE（含级联删关联表）。
- ② 「中台调拨订单对账ID回填」默认数据源由网关对账单改为调拨对账单（需求2）：R5 场景2「请选择适用的银行渠道」弹窗新增「对账数据来源为中台调拨单表」勾选框，默认勾选。勾选（含老库无字段缺省）→ 用需求1 派生的调拨对账单与银行 `FundType=FundTransfer-in/out` 行按日期[同日优先+±1天兜底]+大账号+金额+币种匹配回填 `ReconciliationId`；取消 → 沿用原 R5s2 网关对账单。存量用户升级后默认走调拨对账单，依赖网关的需取消勾选，且须先导入「中台调拨订单」派生出数据源。
- ③ 新增 R3.5「DBS-Charge 资金校验」轮次（默认启用，改写 DBS 银行行 `ReconciliationId` + `FundType`）（需求3）：编排 R3 后 R4 前新增 R3.5，默认启用（写死场景 seed `enabled=1`）。触发=`Channel=DBS`；步骤1 调拨对账单（付收渠道=DBS）↔DBS 银行单按大账号+金额+币种 1v1 匹配，命中标 `FundTransfer-in/out` + 赋 `ReconciliationId`、同 `ReconID` 其他 DBS 行归 `Charge`；步骤2 剩余 Charge/outbound 候选与同 `ReconID` 网关 amount/currency 相等→outbound、未命中→Charge（语义翻转）。`chargeSiblingsScope` 默认 `dbs-only`；DBS 空/调拨对账单空时整体 no-op。

### 新增

- **需求1 调拨对账单派生**（🔴 资金红线）：「链接表管理」导入「中台调拨订单」后自动派生隐藏表「调拨对账单」（`linked_fund_transfer_recon`，不进 `ALL_TABLE_KEYS`/`linked_table_meta` 隐藏红线，与 BOC 两张派生表同构）。派生纯函数 `buildFundTransferReconRows`（仿 `adm-bank-deposit-builder.js`）：一行中台调拨订单 → FundTransfer-in + out 两行，字段经 `FT_RECON_FIELD_MAP` 常量单一真相取（中台源列含全角括号，半角化即取空 → 大账号全空资金红线）——调拨单号 / `BillDate`(交易时间) / `ReconID`(渠道流水号) / 付款账号 / 收款账号 / 付收渠道 / 金额 / 币种，in 行取收款侧、out 行取付款侧。🔴 决策 D1：大账号 `big_account` 派生阶段即按方向固化（in=收款卡号 / out=付款卡号），下游匹配引擎零方向分支。导入成功提示追加「已生成 N 条调拨对账单」（N=中台单行数×2）。
- **需求3 DBS-Charge 资金校验引擎**（🔴🔴 资金红线核心）：对账编排新增 R3.5（`runDbsChargeFundCheck`），整体替换全渠道 charge→outbound，仅 `Channel=DBS` 生效，【对称模型】：步骤1 调拨对账单（付收渠道=DBS && `big_account` 非空）↔DBS 银行行按 `big_account`+金额+币种严格 1v1（多候选取原序首行+warning），命中标 `FundTransfer-in/out`+赋 `ReconciliationId`、同 `ReconID` 其他行归 `Charge`（🔴 两阶段化：in/out 行 `ReconID` 相同，拆「阶段A 先匹配标记入保护集 → 阶段B 再归并」防覆盖）；步骤2 剩余 `FundType∈{Charge,outbound}` 候选与同 `ReconID` 网关 amount/currency 相等→outbound、未命中→`Charge`（语义翻转）。`chargeSiblingsScope` 默认 `dbs-only`；改写 `ReconciliationId`+`FundType` 标黄留痕。写死场景 `DBS-Charge资金校验`（`funcCategory='dbs-charge-fund-check'`=R3.5 分流键 / `subCategory` 同字面=seed 幂等键，区别于已退役 `'charge-outbound'`），默认 `enabled=1`，独立 marker 补种。

### 变更

- **需求2 中台调拨订单对账ID回填「数据来源二选一」**（🔴 资金红线）：新引擎 `runRound5FundTransferReconBackfill`（与原 R5s2 同口径，唯一差异对手方=调拨对账单 `reconRows`）：调拨对账单 `fund_type=FundTransfer-out/in` 行 ↔ R4 后银行同值行，命中回填调拨对账单 `ReconID` 进银行 `ReconciliationId`（标黄）；两方向独立；金额绝对值精确到分（复用 `bankAmountAbs`）；日期两阶段（同日优先消费 → 未命中 recon 用 `±dateToleranceDays` 兜底、天数差升序）；严格 1v1（`usedBankRowId`）。编排器二选一 gating：`config.reconSourceMid !== false`（默认勾选，老库缺省视为勾选）→ 勾选路注入 `fundTransferReconContext.reconRows` 走新引擎；`=== false` → 取消路沿用 `runRound5FundTransferBackfill`（网关 `gwRows` 逐字保留）。seed 默认 `reconSourceMid: true`。UI 勾选框「对账数据来源为中台调拨单表」仅 `subCategory==='fund-transfer-backfill'` 场景显示（与 Payment 行同 gating），加载口径 `reconSourceMid !== false`。
- **charge-outbound 退役（需求3 配套）**（🔴 资金红线）：R4 资金性质校验内置子场景 5→4（移除 `charge-outbound` 及 v3.0.4 块 G「仅转 Debit Amount 最大行」边界），R4 退化为纯叠加链（其余四子场景 Ach Return / Wire Return / HX-out / HX-in 零变化）；旧库孤儿 `charge-outbound` 条目由 `retireChargeOutboundOrphans` 每次启动幂等 DELETE（含级联删关联表）。

## v3.0.5（2026-06-15）

v3.0.5 迭代：三大块、约 5 个 PR 串行合入——① 体积 / DB 治理 + 启动优化（Part A 打包瘦身 + Part B Phase0~4：备份治理 + 主库一次性 VACUUM 止血 + acquiring / biz-op / bank-bu 对账 run 级数据迁 per-月侧库 + 启动窗口先行 + 守卫固化）；② 外汇交割表 + 银行入金表「整表覆盖 → 幂等累加」合并导入 + 跨期重复命中提醒（🔴🔴 资金红线）；③ 中台退款订单回填规则增强 R1~R6 + 输出模板扩列 O1~O4（🔴 资金红线）。质量门 `npm run release-check` 全绿（unit 2673 / integration 30 脚本（含 OPEN-7 跨期命中 e2e + acquiring / biz-op / bank-bu 三套侧库 parity byte-for-byte + linked-fx 合并等价性 + refund codex 修复专项）/ smoke 全模块 PASS）。⚠️ 多处资金红线：块 ② 入金表 / 外汇交割表落库由覆盖改累加 + BOC 调拨单号全量重算 + export 新增回写命中标记写路径 + 删除扩展三表（不可逆）；块 ③ R1~R6 匹配规则面扩张 + S4 容差方向收紧 + R6 DTD 美式 MDY 解析 + 模板列契约 14→31；块 ① 三模块对账 run 级数据存储位置变更 + 主库一次性 VACUUM（升级首启执行）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.5「对外契约变更」段）

- ① 外汇交割表 / 银行对账单入金表导入「整表覆盖 → 幂等累加」（块 ②）：外汇交割表（键=交易编号）/ 入金表（键=`BizId`）由每次清空全表改为按幂等键跨次累加（同键覆盖 / 新键追加 / 空键拒入计数）；一次多选 N 文件不再只剩最后一个；不再随导入清空，只保留某批数据须改用「按日期范围删除」；导入完成框显示「覆盖 N / 拒入 N」。🔴 `BizId` 行级唯一性以覆盖计数为观测口径。
- ② 外汇交割表导入全量重算所有组（含历史组）BOC 调拨单号 + 组号每次重编号（块 ②）：累加语义下任意外汇交割表导入基于全库重算分组 / 调拨单号 / 链接ID 并重编号 1..N；中台调拨订单表两次导入间变动则历史组调拨单号随下次外汇交割表导入刷新；升级首启清空两张 BOC 派生表并引导重导外汇交割表恢复。
- ③ 「按日期范围删除」由仅网关扩展到三表（块 ②）：删除弹框加「目标表」下拉（网关 / 外汇交割表 / 入金表）；删除后联动重建派生 + 清理悬挂命中标记；不可逆，沿用网关防误删门控。
- ④ 跨期重复命中提醒（OPEN-7）+ 入金表新增 `last_hit_run` / `last_hit_at` 标记列（块 ②）：累加后历史残留入金行被对账再次命中时输出端追加「疑似历史残留」提醒（口径=所有以入金表为来源的命中：matchJpmUs + R3 / R5 / R6）；🔴 资金对账数据处理导出成功后新增回写入金表命中标记的写路径，写入失败仅 warning 不阻断产物，同批反复运行 / 导出不误报。
- ⑤ 中台退款订单回填输出模板 14→31 列 + 新增「命中类型」列 + 命中详情文案变化（块 ③）：sheet1 14→31（固定 6 + 银行 10 + 中台 15，银行侧加 `Payment Detail`），sheet2 12→13；新增「命中类型」列（精准 / 模糊）；删「匹配成功:」前缀；S4 改固定文案「命中唯一值:退款提交日期+大账号+金额+币种」——按列序 / 列名解析的外部脚本需适配。
- ⑥ 中台退款订单回填 S4 容差 10→21 天 + 改单向 + R6 原单日期按美式 MDY 解析（块 ③）：S4 由 ±10 双向改单向 `0 ≤ BillDate − valueDate ≤ 21`（银行早于退款提交日期不再命中、走报错）；R1 正则 `T54SWIC` → `T54[A-Z]{4}`（命中仍严格等值）；新增 R2 / R3 / R5 / R6 四条二跳命中路径。🔴 R6 原单日期 token（`DTD05/21/2026`）按美式 `mm/dd/yyyy`（MDY）解析，建议用真实退款单核验。
- ⑦ acquiring / biz-op / bank-bu 对账 run 级数据落 per-月侧库（存储位置变化）+ 打包瘦身 build.files 白名单（块 ①）：三模块 run 级批量数据由主库改写各模块侧库 `{userData}/run-data/{模块}/month-{YYYY-MM}.sqlite`，主库只留 run 元数据，对账算法 / 差异表 byte-for-byte 零改动；升级首启执行一次性主库 VACUUM 止血（迁移式幂等、磁盘×1.2 前置检查）。打包 `build.files` 改白名单（仅留 `docs/USER_GUIDE.md`，排除 previews / iterations / analysis / prs / scripts / CHANGELOG / README / app-icon-source）+ `@napi-rs/canvas` 移 devDependencies + `check-dist-size.js` 守卫。

### 新增

- **块 ② 外汇交割表 + 银行对账单入金表「覆盖 → 幂等累加」合并导入**（🔴🔴 资金红线）：bank-deposit 累加全仿 v3.0.1 网关先例（migration `biz_id` 列回填 + 去重 + UNIQUE，65 万行全 SQL 侧幂等可重入；`upsertLinkedBankDeposit` 数组 + 流式内存恒定双路；ADM / BOC bank 派生触发与缓存清理零改动）；fx-settlement 累加（交易编号单键，合计行非数字文本归一为空拒入）+ BOC 派生改 DB 全量重算（新增 `orig_group_no`；per-file scan + offset 续编 = 文件边界=组边界 → 全库 upsert → `orig_group_no` 聚合全局重编号 → 重跑 `matchBocToMidAllocation` 逻辑零改动 → 2.2 后 compact 展示组号连续）；跨期重复命中提醒（入金表新增 `last_hit_run` / `last_hit_at`，export 成功后三步时序回写、失败仅 warning）；删除三表化（IPC 加 `tableKey` 缺省网关、白名单三表各走日期列、删后联动重建 + 清悬挂标记）；前端导入完成框「覆盖 N / 拒入 N」+ 删除弹框「目标表」下拉。
- **块 ③ 中台退款订单回填规则增强 R1~R6 + 输出扩列 O1~O4**（🔴 资金红线）：基于 387 行真实样本（HK 196 / US 191）。R1 JPM-HK 提取正则 `T54SWIC` → `/T54[A-Z]{4}\d{6}/`（前缀 SWIC / LCIC / CCBT，仍严格等值）；R2 新层 S2b（限 JPM，payNo 二跳取入金 CustomerRef + 守卫黑名单归一 + 长度≥6 + token 边界后与 bank 附言包含匹配，独立成层防拖垮 165 主流）；R3 JPM-HK CustomerRef 二跳回落（`matchCustomerRefTwoHop` 共享）；R4 S4 单向 `0≤BillDate−valueDate≤21`（`signedDayDiff` + 三态 `classifyS4Window`，不动 `dayDiffWithin`）；R5 新层 S3b（Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate sameDay）；R6 新层 S3c（附言 DTD 美式 MDY + FOR 金额含千分位 + 币种 ↔ 入金二跳，抢 S4 前）；O1 新增「命中类型」列（层属性透传）；O2 删「匹配成功:」前缀 + S4 固定文案；O3+O4 `REFUND_BANK_COLUMNS` 9→10 + 新增 `REFUND_RO_COLUMNS` 15 → 模板 14→31 / sheet2 12→13 + 启动断言；depIndex 双 Map 索引（`ordOf` 行优先一致，4 条二跳 O(n)→O(1)）。codex 资金红线复审修复 6 项（depIndex 行序 / R2 token 边界 + 黑名单归一 / R6 金额千分位 / R6 DTD 美式 MDY / R4 三态报错 / depIndex 空批早退）。

### 变更

- **块 ① 体积与启动性能优化（Part A 打包瘦身 + Part B 主库治理 + 启动窗口先行）**（🔴 资金红线 / DB 迁移 / 启动时序）：PR-1 Part A 打包瘦身（`build.files` 白名单封堵宽 glob 复发 + `@napi-rs/canvas` 移 devDependencies + `check-dist-size.js` 守卫 asar≤25MB / 禁止路径 / 必需文件反向保护 + CI 显式 step，安装包 135MB→≤90MB）；PR-2 Phase0 备份治理（保留最近 2 份 + PROTECTED 双保险）+ 主库一次性 VACUUM 止血（迁移式幂等 / 磁盘×1.2 前置检查 / VACUUM 后 `wal_checkpoint(TRUNCATE)`）；PR-3 Phase1 acquiring 三表迁 per-月侧库（新增 `run-data-store.js`，三表 DDL byte-for-byte 平移 + monthKey 正则防注入 + 孤儿扫描，`runCheckCore` git diff 空、parity 19/19）；Phase2 biz-op + bank-bu 推广侧库（防主库从其余模块复发膨胀，算法零改动 parity bank-bu 17/17 + biz-op 16/16，biz-op 月初 T-2 跨月用「月末 D 冗余副本」方案）；Phase3 启动窗口先行（`whenReady` 立即建窗 loading 态 + register*Handlers 上移，点击到可见 ≤300ms 实测建窗 ~90ms / 总 ~713ms，回退开关 `DEFERRED_WINDOW_STARTUP=0`）；Phase4 守卫固化（新增 `rules/run-scoped-data-policy.md` 对账 run 级数据禁写主库规则 + important-variables 升格侧库符号）。

## v3.0.4（2026-06-11）

v3.0.4 迭代：七块、单 PR 合入 main——① 块 A JSZip 崩点止血 + 链接表报错可见性；② 块 B 挂账 pending 导入迁移大表引擎；③ 块 C 业务OP biz-op 流水侧导入迁移引擎；④ 块 D 银行对账输出三点修复；⑤ 块 E BOC调拨订单修复；⑥ 块 F Payment线下调拨订单回填；⑦ 块 G Charge转outbound 多行行为收紧。质量门 `npm run release-check` 全绿（unit 2390 / integration 含 BOC 集成 + parity pending 45 / biz-op flow 47 + 收单回归锁 45 / smoke 全模块 PASS）。⚠️ 多处资金红线：块 B/C 入库真理源 + pending 6 表覆盖删除链；块 D F1 输出金额符号翻转；块 E 修复行生成 + bank-deposit 白名单 13→14；块 F 向 ReconciliationId 写值；块 G R4 FundType 改写语义收紧。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.4「对外契约变更」段）

- ① C3 Extra Fee 列数值符号翻转（块 D F1）：差额由写原值改为写相反数，三出口（主输出/命中明细/命中场景行报表）同步——存量 C3 场景升级后同输入产出相反符号。
- ② 错误报告与命中场景行报表目录互换 + 错误报告第 3 列「行号」→「对账ID」（块 D F2+F3）：错误报告改落 `error-reports/{date}/`、命中场景行改落 `bank-statement-process/{date}/`；按旧路径读取 / 按列名解析的外部脚本需适配。
- ③ 银行对账单表（链接表）落库字段 13→14（块 E）：新增 `Payment Detail`，存量数据需重新导入银行对账单表才支持 BOC 回填。
- ④ BOC链接表调拨单号 stale（块 E）：中台调拨订单表重导后调拨单号不自动重算，需重导外汇交割表。
- ⑤ pending / biz-op flow 导入换引擎（块 B/C）：回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_PENDING` / `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`；多 sheet 文件由静默读第一个改为明确报错；错误超 1000 截断计数语义随引擎变化。
- ⑥ ≥2GB 单 entry 文件导入改为明确中文报错（块 A）：上限 2147483648，不再抛 JSZip 天书错误。
- ⑦ Charge转outbound 多行行为收紧（块 G）：同 ReconciliationId 多条 Charge 行由逐条全转改为仅转 Debit Amount 最大行（并列取原序首行）——存量多行场景 FundType 改写行数减少，下游 HX-out 链随之减少。

### 新增

- **块 A JSZip 崩点止血 + 报错可见性**（🟡 防御护栏）：入口尺寸预检（yauzl 读中央目录无符号 entry 尺寸，3 落点，≥2^31 弹明确中文错误，fail-open 不误伤）+ 链接表导入失败落 error 级 activity log + C3/运行前两入口消费返回值弹 per-file 失败明细。
- **块 B pending 挂账导入迁移大表引擎**（🔴🔴 资金红线）：契约模块（31 列全列 / 6 表覆盖删除链逐字平移 / 月元数据 COMMIT 前原子 / sha 去重 / 1000 上限）+ 共享 dispatch（`resourceLimits` 4096）+ 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_PENDING` + parity 45 断言（legacy vs 引擎 byte-for-byte）。
- **块 C biz-op flow 流水侧导入迁移引擎**（🔴 资金红线）：flow 契约（28 列全列 / 3 条 date 级覆盖删除 / validateFlowRow 三态）+ 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`（业务OP 侧 OPEN-1 不迁）+ parity 47 断言。
- **块 E BOC调拨订单修复**（🔴 资金红线）：F1 内置写死场景「BOC调拨订单修复」（序号 2 / 默认休眠 / 独立 marker）；F2 两张隐藏链接表（外汇交割表分组 → 中台调拨匹配调拨单号 → 银行单 Channel=BOC 派生「银行单交易编号」→ 按 id 幂等回填对账ID；🔴 BANK_DEPOSIT_FIELDS 13→14；交割表强制数组路径防丢物理行号）；F3 整组匹配修复引擎 `runBocDispatchOrderFix`（D1-D11 全从严 / 整组失败不产出 / Type=2 / Reference+Amount 行级 override）。
- **块 F Payment线下调拨订单回填处理**（🔴 资金红线）：R5s2 弹窗按 subCategory 条件渲染勾选行 + 三输入框（银行渠道/地区/大账号，inline 校验不关弹窗 / placeholder 不预填 / 加载完成前禁保存）；config 浅合并保留 seed 五字段；ISO 8601 周数 + FTA 解析（四元组锁口径）；R5s2b 引擎（三条件银行池 / 周+1 日期语义 join / Q6 同日算晚于 / 差错池二轮放宽周数）；🔴 网关回填优先互斥（`usedBankRowIds` + `excludeBankRowIds` union）；mid-allocation 导入清 processingResult 防 stale。

### 变更

- **引擎扩展包 E1-E5**（块 B/C 共同前置 · PR-B）：契约可选扩展（不声明 = 引擎行为与 v3.0.3 完全一致，收单契约一字不改）——E1 多语句覆盖删除 / E2 COMMIT 前事务内收尾 / E3 空文件整批拒绝 / E4 错误上限 1000 + cells 捕获 / E5 写侧跨文件去重 Set；收单回归锁 45 + 19 断言全绿（合并门）。
- **块 D F1 C3 Extra Fee 写盘取相反数**（🔴 资金红线）：差额写入银行行 `Extra Fee` 取相反数（匹配语义不变，DS1-DS9 零改动全过）。
- **块 D F2 两类产物目录互换**：错误报告 → `error-reports/`、命中场景行 → `bank-statement-process/`（`exportRootDir` 本体未动）。
- **块 D F3 错误报告第 3 列「行号」→「对账ID」**：三级回退 reconciliationId → reconId → rowId → ''，io 层按 `_rowId` enrich 覆盖 modifiedRows + unmatchedRows 全集。
- **块 G Charge转outbound 多行取 Debit Amount 最大行**（🔴 资金红线）：R4 charge-outbound 子场景同桶多条 Charge 行仅转 Debit Amount 最大行（转分比较 / 并列取原序首行 / 单行桶不变 / 其余四子场景维持全转 / 桶级 target 初始快照预选防双网关行误转次大行）。

## v3.0.3（2026-06-10）

v3.0.3 迭代：四个块、10 个 PR，分属三个领域——① 块 A 收单单据模块导入/对账性能批次；② 块 B 资金对账数据处理模块状态框「渠道:场景序号」明细；③ 块 C USER_GUIDE 重点补缺 6 章节 + 口语化；④ 块 D 通用大表导入引擎（导入侧）抽取 + 收单首迁（W4 达成）。质量门 `npm run release-check` 全绿（unit 2179 / integration 22 脚本（1086 断言）/ smoke 全模块 PASS）。⚠️ 多处资金红线：块 A 收单导入是金额/币种入库真理源 + 对账 SQL（以同 fixture 全流程 byte-for-byte 为放行闸）；块 D 导入链路整体换引擎（四方 harness + 全链 34 断言 byte-for-byte + 单行回退开关三重放行闸）；块 B 改资金对账处理模块展示层 + hitScenarios 统计结构（带 fallback 兼容旧落库数据）。

### 新增

- **通用大表导入引擎（导入侧）+ 收单首迁**（块 D · 🔴 资金红线 · PR-G1/G2/H）：把收单 yauzl + 手写字节扫描解析、rels 正解 sheet 定位、prepared INSERT 管道、大事务/整批拒绝/peek 预检/覆盖导入/checkpoint 等机械部分抽成带契约参数的共享库（`src/backend/big-table-import/`），收单作为首个迁移用户。PR-G1 引擎核心：zip-reader rels 正解定位唯一 sheet（多 sheet 显式报错）+ 🔴 row-scanner 单遍字节状态机（Buffer 扫 `<row` + 白名单 ref 串直接定位 + 仅取值局部解码）+ contract 三层防护，50w 解析段 4.26s vs P1b 9.87s = 2.32x、四方 harness（sax≡手写全列≡P1b≡引擎）全等。PR-G2 管道 + worker 化：多文件并行解析 → 按文件序单写 INSERT（rowid 序=串行 byte-for-byte）、4-worker 3.06x、cancel<5s、PRAGMA 第 5 处契约、内存闸。PR-H 收单迁移接线：契约模块 contract-flow（白名单 `{0,6,28,29}`）/contract-bill（全列）、session dispatch 引擎 worker（接口对 `main.js` 不变）、🔴 单行回退开关 `USE_BIG_TABLE_IMPORT_ENGINE`、新旧全链对比集成脚本 34 断言（六场景逐行含 rowid + 报错逐字符 byte-for-byte）、50w 端到端 11.2s→7.3s（1.53x）、导入全程主进程零阻塞（W4 达成）。
- **资金对账数据处理模块状态框「渠道:场景序号」明细**（块 B · 🟡 展示层 + hitScenarios 统计结构 · PR-E）：状态框原 `场景 1、3` 在多渠道下有歧义。hitScenarios 增加 `channelId`/`channelName`（双维派发路径），去重键改 `` `${channelId}:${scenario.id}` ``（场景×渠道多对多不再吞并，`scenarioHitCount` 原语义不变）；状态框汇总行括号内按渠道分组换行（`已处理：45 行命中（场景\nJPM:1、3\nCITI:2），3 警告`），旧数据无 `channelName` 回退旧格式；🔴 legacy 单维路径结构不变（21+ 测试 0 regression）；防爆框护栏 `#bankStatementStatusBox` 加 `max-height: 140px` + 滚动，preview 已回归。
- **USER_GUIDE 重点补缺 6 章节 + 口语化**（块 C · 🟢 纯文档 · PR-F）：新增「数据备份与恢复 / 设置参数指南 / 错误排查与日志 / 链接表管理详解 / 场景管理通用指南 / Windows 性能建议」6 章；§1.4 术语段口语化改写（保留 ⭐/🔴 标记惯例）。

### 变更

- **收单单据模块导入/对账性能批次**（块 A · 🔴 资金红线 · PR-A~D + PR-P1）：PR-A flow 表 `raw_json` 永久停写（O-1 决议，列保留恒写 `''`、无 migration、存量行不动）+ bill 模板键列下标预计算 → 50w 行 flow 导入段实测 6.36x。PR-B 收单索引瘦身 v2 迁移（DROP 4 冗余索引 + 建 2 covering 索引）→ 对账统计段实测 5.2x（3 次 JOIN 合 1 + COALESCE 空集守卫）。PR-C PRAGMA 契约补齐 `temp_store=MEMORY`（两处 worker）+ 收单导入 COMMIT 后 `wal_checkpoint(TRUNCATE)`（Windows 写放大 W2）+ 对账多 worker 启用阈值 30w 行（O-2 决议直接合入）。PR-D Windows OneDrive 存储检测提示（一次性提醒，W5/O-3 决议：检测提示 + 文档）。PR-P1 解析列白名单裁剪 + 直接定位（flow 4/48 列），解析段 1.20x 收口（O-5 五次修订：实测天花板 ~1.4x，性能债务转引擎 PR-G 字节层）。

## v3.0.2（2026-06-10）

v3.0.2 迭代：3 项需求分属三个模块——① 业务OP数据核对「导入流水表」批量多选导入 + 回滚 v3.0.1 左列右移；② 「对账单 ReconID 修复」改名「对账单修复」（纯 UI 文案）；③ 网关对账单修复场景配置新增「修复订单字段取值」+「修复订单ID取值」启用开关（含用户修订：字段取值限定「网关1v1渠道」模式 + 两功能 row 改垂直布局）。质量门 `npm run release-check` 全绿（unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过）。⚠️ 两处资金红线：需求1b 流水批量导入单事务合并、单次 clearByDate；需求3 字段取值赋值不污染原始行 + 分组 seq 全程 Number + idEnabled=false 保留原值。

### 新增

- **业务OP数据核对「导入流水表」批量多选导入**（需求1b · 🔴 资金红线）：「导入流水表」从单文件改为「先选日期 → 一次多选多个流水表 → 合并入库到该日期」（多文件 = 该日期完整流水快照，与「重导替换该日期」一致）。🔴 worker / 同步 fallback 两条路径均**单进程单事务合并、单次 `clearByDate`**（首个数据行触发只清一次、各文件累加 INSERT，绝不循环调用 `runFlowImport` 致互相覆盖丢数据）；任一文件任一行校验失败整批拒绝（全 ROLLBACK，聚合错误报告标注来源文件名）；单文件行为零回归；完成框报「导入 N 个文件共 M 行」+「会替换该日期已有流水」。IPC `pickFlowFile`/`runFlowImport` 改 `filePaths`（数组）；业务OP 文件（`kind='bizOp'`）不在范围、不动。
- **网关对账单修复「修复订单字段取值」**（需求3 · 🔴 资金红线）：网关子模式新增/修改场景对话框新增「修复订单字段取值」（独立开关 `config.fieldValue.enabled`，默认关，可与「修复订单ID取值」同时启用）。多行规则 = 主分组 + 网关字段「取」从分组 + 渠道字段；对账匹配成功后把从边渠道字段值赋给主边网关字段，叠加进订单修复导出（14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板，目标列落 14 列内才体现）。🔴 helper `applyFieldValueOverrides` 只写新建 overrides 不污染 `mainRow`/`oppRow`；分组 seq 全程 Number（`Set<Number>.has` 误存字符串会静默失效，UI 归一 + 引擎 `Number()` + 校验三道防线）。config_json 自由 JSON 承载，无需 DB migration、不 bump bundleVersion（旧场景缺省零回归）。**（用户修订）限定「网关1v1渠道」模式**：勾选 1v多 / 多v1 时字段取值不可用（UI 开关自动禁用 + 灰显 + 「仅"网关1v1渠道"模式可用」提示 + 自动取消启用；校验拦截；引擎入口 gate 强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值，双重防御）。**（用户修订）UI 垂直布局**：两个 gateway row 改垂直布局——标题行（label + tooltip + 启用开关）在上、内容（radio / 规则行）在下。

### 变更

- **「对账单 ReconID 修复」改名「对账单修复」**（需求2 · 🟢 纯前端文案）：模块显示名 +「单据对账修复」「网关对账单修复」两个场景类别 label 去「ReconID」字样；内部 id（`recon-id-fix`/`gateway-recon-id-fix`）/ IPC 模块标识 / usage-stats 统计 key（`FUNCTION_REGISTRY` `'对账单 ReconID 修复'` 与 `trackedIpcHandle` 第二参 3 处配对）/ scenario category / DB schema CHECK 全部不动（沿用 v2.1.14 先例，零风险、统计连续）。
- **网关「订单修复ID取值」改名「修复订单ID取值」+ 启用开关**（需求3 · 🔴 资金红线）：原「订单修复ID取值」行改名 +「启用该功能」开关（`config.output.idEnabled`，默认启用=保持现有必填）；取消勾选跳过 Reference 赋值与校验、三选一 radio + commonId 灰显，导出保留网关账单原 Reference 值（不把 Reference 放进 overrides → `buildOutputRow` 取 srcRow 原值，比清空安全）。

### 移除

- **业务OP数据核对左列「整体右移」回滚**（需求1a · 🟢 纯 UI）：删除 v3.0.1 需求2 给该模块左列加的 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px) }` 平移规则，左列两元素回到平移前位置；保留同段其它 v3.0.1 样式（`.gateway-recon-picker-card`/`.linked-table-delete-range-card`）不动。

## v3.0.1（2026-06-09）

v3.0.1 迭代：资金对账数据处理模块 1 项资金红线增强（需求1）+ 3 项 UI 修复（需求2/3/4）。质量门 `npm run release-check` 全绿（unit 2075 / integration 19 脚本 / smoke 全过）。本迭代与另一资金对账工作流（需求5「R5-2 覆盖非空原值告警移除」）并行落地，需求5 由该线定稿（见 PRD §十一/§十二）。

### 新增

- **网关对账单链接表批量导入 + 跨次幂等累加**（需求1 · 🔴 资金红线）：网关对账单落库从「整表覆盖」改为按幂等键 `ReconBillBizId` 跨次累加（一次多选多个文件不再互相覆盖丢数据）。含 schema 迁移（`recon_bill_biz_id` 列 + UNIQUE 索引 + 存量空键/重复键清洗）、网关专用 `upsertLinkedGatewayBill`（数组 + 流式，单事务全 ROLLBACK 红线保留）、导入完成框「覆盖 N / 拒入 M」提醒、链接表管理新增《删除》按钮（按数据日期范围闭区间删除，直接删、无二次确认，后台计数门控防误删；红色警告框经用户 UI 迭代去掉）。⚠️ 已知限制：对账维持读全表，累加多期 + reconid 跨期复用的 R1/R5 漏匹配作为已知限制被接受（PRD §十 Q7=A）。

### 变更

- **ADM 派生提醒仅在派生出数据时弹**（需求4）：导入不含 `Channel='ADM'` 行的银行对账单表时不再误弹「ADM银行对账单链接表已创建」（`buildAdmDeriveHtml` 加 `total` 守卫，后端不动）。
- **业务OP数据核对左列右移**（需求2 · 纯 UI）：BU 下拉 + 导出差异按钮整体右移 D/2+12=85.5px（专属 `#bizOpReconModulePanel` 选择器，右列与另 3 个 `.pending-board` 模块不受影响）。

### 修复

- **网关对账单修复「场景选择弹框」样式错乱**（需求3 · 纯 UI）：对齐窄弹框范式，专属 `gateway-recon-picker-card` class + CSS（标题 16px、加内边距），逻辑零改。

## v3.0.0（2026-06-09）

v2.1.16-beta.6 转正 v3.0.0。四大块 7 项需求：块 A 资金对账模块弹框/状态框治理、块 B 链接表大文件流式导入、块 C R5 场景3 Credit/Debit 方向匹配、块 D 场景管理批量 CSS 偏移修复。质量门 `npm run release-check` 全绿（unit 2061 / integration 18 脚本 / smoke 全过）。

### 新增

- **链接表大文件流式导入**（块 B · 🔴🔴 资金+数据红线）：65.7 万行 / 147MB 渠道账单原报"文件为空或不可读"（SheetJS 全量读 OOM），改用流式引擎 `readXlsxStreamed` 全链路改造——detector 表头识别流式化（+ `readXlsxSheetMetaLite` 替代 listSheetNames 的 ~3.9GB OOM）、落库 `replaceLinkedTableStreaming`（单事务整表覆盖逐行喂入）、ADM 派生 `readBankDepositAdmCandidates`（Channel=ADM SQL 下推过滤，消 ~1.2GB 读回尖峰）。实测落库 657,757 行、内存有界不 OOM、值口径与现状逐格一致。
- **状态框「渠道-地区」前缀**（块 A 需求 1）：导入银行对账单后状态框文件名前加 `渠道-地区` 前缀（唯一 `CITI-HK:文件名` / 多组合全列出）。

### 变更

- **去导入明细确认框**（块 A 需求 2a）：删与状态框重合的明细框，失败/跳过信息并入常驻状态框。
- **C3 提醒改向链接表网关对账单**（块 A 需求 2b · 🔴 防静默漏对账）：C3「数据就绪判据」从 `gatewayReconSession` 改向链接表 `gateway-bill` 行数（严格 >0）+「导入文件」改调链接表导入。
- **退款回填提醒对齐 C3**（块 A 需求 3）：导入/运行点提醒统一 C3 框结构 + 候选预检（无 `Ach Return` 不提醒）+ 运行点链式编排。
- **R5 场景3 Credit/Debit 方向匹配**（块 C · 🔴 防剔除清单错位）：同 ReconciliationId 多候选改取 `Credit Amount` 有值行；0 或 ≥2 行跳过 + 警告不阻断。

### 修复

- **场景管理批量勾选列表格偏移**（块 D · 纯前端）：勾选列百分比化 + 其余列按比例补偿（总和=100%）+ 清重复 CSS。
- **链接表/预加工导入 read-error 误报文案**（块 B / O-6）：区分真空文件 / 不可读 / OOM-读失败。

## 2.1.16-beta.3（2026-06-07）

v2.1.16「资金对账数据处理」**阶段三·中台退款回填前置基础设施 + 引擎设计**。交付 ①Channel 枚举沉淀、②银行对账单入金表链接库两块可用功能 + ③中台退款订单回填引擎设计文档（仅设计不实现）。①② 是 ③ 的前置依赖。质量门 `npm run release-check` 全绿（unit 1768 / integration 952 / smoke 全过）+ team-lead 端到端自测 21/21 + 用户手测入金表导入通过。

### 新增

- 银行对账单入金表链接库（②· 🔴 数据红线）：「链接表管理」新增第 5 个表库「银行对账单入金表」，模板取 `银行对账单.xlsx`，存 C~N+FundType 共 13 字段（`linked_bank_deposit`，整表覆盖）；复用现有「导入」按钮，新增 `BANK_DEPOSIT_SIGNATURE` 仅进 `LINKED_IMPORT_SIGNATURES`、`ALL_TABLE_SIGNATURES` 不含它（与主表同构 44 列隔离防 ambiguous）；导入按 13 字段名裁列（裁列在 44 列校验后 + 加载期 assert ⊆ `BANK_STATEMENT_FIELDS`）
- Channel 枚举沉淀（①）：导入银行对账单后去重沉淀 `Channel` / `<Channel>-<地区>` 两类值（`channel_enum_values`，UNIQUE 去重 + seen_count 累加），供后续 ③ JPM 分支 + 审计，纯沉淀无 UI；地区空只落 channel 不生成脏值、Channel 空跳过、沉淀失败 `appendActivityLogEntry` warning 不阻断导入
- ③ 中台退款订单回填引擎设计文档（仅设计）：4 基数×4 策略决策矩阵 + JPM-HK/US 双分支 + 数据筛选/统一回填/命中详情/双 sheet 导出，集成 = R5 场景4，12 条歧义经用户确认；本版不实现代码，作后续实现蓝本

> 阶段三·beta.3 收口：①② 前置基础设施落地测通过，③ 引擎完成详细设计待实现。

## 2.1.16-beta.2（2026-06-07）

v2.1.16「资金对账数据处理」能力扩建的**阶段二·5 轮对账核心引擎**（beta.1 地基层已随 PR#61 合并 main）。在「资金对账数据处理」预加工流程里对银行对账单跑 **5 轮对账**（R1 对账ID 1v1 匹配 → R2 复用现有 first-match-wins dispatcher → R3 占位透传 → R4 资金性质校验 → R5 中台订单数据处理），产出改写后银行对账单 + 中台加款单剔除文件；网关数据从链接表 `linked_gateway_bill` 读回。⚠️ 多处资金红线（R4 改 `FundType`、R5 场景2 回填 `ReconciliationId`、R5 场景3 剔除行、FundType 枚举改错拼）。质量门 `npm run release-check` 全绿（unit 1731 / integration 952 / smoke 全过）。⚠️ 本版用户仅手测「场景管理列表 UI」，5 轮端到端 + Q1 网关 TradeType 真实取值核对等留待下版一起测（清单见 `changes/v2.1.16-beta.2/TASKS.md`）。

### 新增

- 5 轮对账编排器（🔴 资金红线 · `reconciliation-orchestrator.js`）：`runReconciliation` 串联 R1→R2→R3→R4→R5，按 `funcCategory`/`subCategory` 分桶内置场景，跨 5 轮累积标黄列；返回 `{modifiedRows,unmatchedRows,modifications,errorReport,stats,platformCleanupRows,rounds}`，行数守恒 `modifiedRows+unmatchedRows=bankRows`；不改 `scenario-dispatcher.js`（R2 仍复用其 first-match-wins）
- R1 对账ID匹配引擎（`r1-recon-id-match.js`）：`reconciliationid===ReconciliationId` 大小写敏感 1v1 匹配，产 `matchedGwRows`/`pairs`；不改字段、不产 modification、不标黄
- R4 资金性质校验引擎（🔴 资金红线 · `r4-fund-nature-check.js`）：「R1 匹配网关行 × R3 全量银行行」按 reconid 关联，5 可插拔 handler 按 priority 改 `FundType`（Ach Return / Wire Return / Charge→outbound / HX-out / HX-in，判定条件 config 化复用 `evaluateCondition`）；**唯一允许同一行多次改 FundType** 的轮次（叠加链），改写行标黄不进 N5 报表；⚠️ 网关 TradeType 真实取值 / priority 顺序待用户核对、已 config 化可调
- R5 场景2「中台调拨订单对账ID回填」（🔴 资金红线 · `r5-fund-transfer-backfill.js`）：网关 `FundTransfer-out/in` ↔ R4 后银行同 `FundType` 回填 `ReconciliationId`（两方向独立）；`merchantid/currency` + **发生额绝对值 `|Credit−Debit|` vs `|amount|` 精确到分** + 日期两阶段（同日 → ±1day）；严格 1v1、覆盖发 warn 仍写、tie-break 同日优先；复用 `normalizeDateExportValue`（新建 `engine-date-utils.js`）
- R5 场景3「中台加款单脏数据处理」（🔴 资金红线 · `r5-platform-inbound-cleanup.js` + `constants/platform-cleanup-template-fields.js`）：网关 `Inbound-VA` ↔ R4 后银行行按 reconid 1v1 命中、`FundType!='Inbound'` 时生成剔除行（加款单号=网关 `orderid`、附言=`<R4 后 FundType>，中台加款单已关闭。`、C~O 13 列拷贝银行行）；15 列模板单一真相 + C~O ⊆ `BANK_STATEMENT_FIELDS` 守卫
- 中台加款单剔除文件导出（🔴 资金红线 · `platform-cleanup-writer.js` + `bank-statement-io.js`）：启用场景3 有剔除行 → 与银行对账单同目录输出 `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`（主输出为空落 `exportRootDir`）；writer 仿 `scenario-hit-rows-writer.js`（15 列加粗 + watermark）；graceful 失败不阻塞主流程；无剔除行不生成
- 网关数据源 `readLinkedTableRows`（`linked-table-repository.js` + `database.js` facade）：从链接表读回整行（解析 `raw_json` 还原真实表头、`ORDER BY id ASC`、损坏行跳过），编排器网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取——R2/C3 网关源由 `gatewayReconSession` 切链接表；`fx-option` 返空
- 5 轮对账内置场景 seed migration（`migrations.js` + `database.js`）：`ensureReconRoundBuiltinScenariosSeed` 插 5 R4 + 2 R5 内置 `builtin-fixed` 场景（config 带 `funcCategory`/`subCategory`/`roundPhase`/`priority`/`involvedFiles`），幂等定位键 `config_json LIKE '%"subCategory":"X"%'` 已存在跳过不覆盖；排在 `ensureScenariosCategoryBuiltinFixed` 之后

### 变更

- 场景管理列表「功能类别」按业务分组显示（前端 · `renderer-dialogs.js`）：builtin-fixed 列表「功能类别」列按 `config.funcCategory` 映射——`fund-nature-check`→「资金性质校验」、`platform-order`→「中台订单数据处理」（旧称「中台订单校验」更名）；无 `funcCategory` 的既有场景回退既有标签（`'银行对账单赋值自身'`）不回归；实际展示列保持 6 列（序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动）
- FundType 枚举补值 + 修错拼（🔴 资金红线 · `assets/FundType枚举值.xlsx` + 一次性 migration）：补 `Ach Return` / `HX-in` / `HX-out`（R4 子场景改写目标值）；修错拼 `Ach Ruturn → Ach Return`（一次性 migration 迁移存量 config 旧值，引用面低风险）；`InternelFundTransfer → Internal` 本版不改；`loadFundTypeEnum` 读出新值、存量 config 不破坏

> 阶段二·beta.2 收口：5 轮对账核心引擎 + R4 资金性质校验 + R5 中台订单数据处理 + 中台加款单剔除导出。⚠️ 本版未做端到端手测（用户 2026-06-07 拍板仅测场景管理 UI，其余下版一起测，清单见 `changes/v2.1.16-beta.2/TASKS.md`）。

## 2.1.16-beta.1（2026-06-07）

v2.1.15 之后「资金对账数据处理」能力扩建的**阶段一·地基层**（表头自动识别 + 链接表持久化 + 批量导入合并对账 + 自带写死场景优先级）。仅落地基与数据通路，资金性质校验 + 5 轮对账引擎 + 网关 reader 留待阶段二。⚠️ 批量导入「多银行对账单合并对账」涉及对账数据集合并（资金红线）。

### 新增

- 「导入对账单」改多选批量导入（🔴 资金红线）：一次多选 Excel，逐文件按表头自动识别表类型并路由（银行对账单读行；中台退款订单 / 入账原始订单本阶段开关默认关跳过；歧义 / 未识别 / 读取失败逐条记明细，不整批回滚）。**多份银行对账单 = 合并对账（不覆盖）**：第一个建 session、后续校验表头完全一致才追加，合并后统一重编号 `_rowId`（跨文件全局唯一）保证行锁不串行
- 链接表管理导入持久化：「链接表管理」导入由 v2.1.14 占位改为真正落库——网关对账单 / 中台调拨订单 / 外汇交割表 3 表库整表覆盖写入（键列 + 日期范围列 + 整行 raw_json）+ 元数据（数据日期范围 / 行数 / 来源 / 更新日期）；外汇期权表本阶段占位（模板缺失，导入拒绝）
- 自带写死场景「管理」弹窗加优先级输入框：原优先级固定 0，现可调该内置场景在 dispatcher 执行顺序中的优先级
- 表头自动识别地基：以特征表头列为签名识别表类型（唯一命中 / 歧义 / 未识别 / 读取失败四态），按 scope 分预处理表 / 链接表两候选子集

### 变更

- 链接表「中台调拨订单」数据日期范围用「交易时间」（每行均有值），不用「业务日期」（空值率高）；DB 列名建表即对齐 `transaction_date`（链接表 v2.1.16 全新引入、无存量、零迁移）

> 阶段二待续：资金性质校验 + 5 轮对账引擎 + 网关 reader + 外汇期权表模板与表库。

## 2.1.15（2026-06-07）

v2.1.14 之后 1 轮迭代，5 个工作项（性能 + 网关对账单赋值增强 + 入口整合 + 主题精简）。⚠️ ①②③ 资金红线；② 为破坏性变更。

### 新增

- 网关账单字段运行时读 xlsx 表头（🔴 资金红线 + **破坏性**）：C3「网关对账单赋值银行对账单」的「网关账单字段」下拉枚举改读 `assets/网关对账单.xlsx` 表头（新增 `gateway-recon-headers-loader.js` + IPC，复用 C2 FundType 模式）；缺失降级旧硬编码、剔除 `__CUSTOM__`。**破坏性**：新表头与旧硬编码几乎全不一致，存量 C3 场景引用旧字段名需重配
- C3 差额写入 `Extra Fee` + 标黄（🔴 资金红线）：勾选「金额不一致」匹配成功后，差额写入银行行 `Extra Fee` 并标黄；原值=差额则只锁定不标黄；assign 与 Extra Fee 写盘解耦、1v1 红线不变
- 「网关对账单修复」入口：「资金对账数据处理」模块「场景管理」弹窗内新增入口，打开 ReconID 修复模块的网关场景管理（复用 `createScenariosManagerDialog(['gateway-recon-id-fix'])`），仅资金对账入口显示

### 变更

- 收单「写差异文件」提速（🔴 资金红线 · 输出不变）：`writeDiffWorkbook` 由 LIMIT/OFFSET 深分页改为游标遍历（新增 `iterateDiffRowsByDateRange`），消除整月单 segment 的 O(N²)；50 万差异行实测 ~61.6s→5.2s（≈11.9x），新旧 xlsx 逐行逐列对拍一致

### 移除

- 调色盘「切换页面风格」+ 弃用 General 风格：删调色盘风格切换 UI + General 链路；老库 `ui_style='General'` 启动迁移 Clear；`src/styles.css` 文件保留不删

## 2.1.14（2026-06-07）

v2.1.13 之后 1 轮**纯前端迭代**（不涉及后端）：① 应用主标题「网银账单小助手」→「清结算小助手」（含启动失败弹窗 / 安装包 `productName`）；② 模块「银行对账单处理」→「资金对账数据处理」（仅显示名，`module.id` 不变）；③ 该模块面板改 control-row 三行布局 + 新增「导入不平表」按钮（复用现有不平结果表导入）与「链接表管理」入口；④ 新增「链接表管理」弹窗（4 表库骨架，UI 占位）；⑤ 场景配置弹窗微调（C2「自己输入」/ C2·C3 标题不加粗 / C2 赋值下拉缩窄 / 去 # 序号）；⑥ assets 模板入库。纯前端、无业务逻辑变更。

### 新增

- 链接表管理弹窗（UI 骨架）：「资金对账数据处理」面板新增入口，列 4 张链接表库（网关对账单 / 中台调拨订单表库 / 外汇期权表库 / 外汇交割表库），导入占位不持久化
- 导入不平表按钮（复用现有 `importGatewayRecon` IPC）：面板主动入口导入「资金对账不平结果表」
- 场景配置 C2「自己输入」：「银行对账单赋值自身」赋值 FundType 值下拉加「自己输入」→ 切文本输入框（可填枚举外的值）
- assets 模板入库：中台加款单剔除模板 / 中台调拨订单 / 中台退款订单 / 中台退款订单回填模板 / 入账原始订单 / 外汇交割表vPayment / 网关对账单

### 变更

- 应用改名：标题 / 启动失败弹窗 / `package.json` description + `build.productName`「网银账单小助手」→「清结算小助手」（`appId` 不变）
- 模块改名：「银行对账单处理」→「资金对账数据处理」（仅 `name`，`module.id='bank-statement-process'` 及引用 / DB schema / 统计 key 不变）
- 资金对账数据处理面板重构：control-row 三行（左两组导入/导出 + 状态框，右三按钮「开始运行 / 场景管理 / 链接表管理」）；左侧每组按钮往两侧张开各 14px
- 场景配置弹窗微调（C2/C3）：标题「— 类别名」后缀不加粗；C2 赋值两下拉缩窄 160px（C3 保持原宽）；去账单类型 #x.x + 对账字段 #x 序号

### 工具

- 修复 `check-vars` skill 的 `src/**/*.js` pathspec glob 坑（漏 src/ 顶层文件），改为 `-- src/` 筛 `.js`

## 2.1.13（2026-06-06）

v2.1.12 之后 1 轮迭代，围绕「银行对账单处理 / 对账单 ReconID 修复」两个场景模块的场景管理体验重构 + 跨渠道写死场景 + Win 端字体可读性：① 新增「自带写死场景」(builtin-fixed) 内置类别（前端无新建入口、仅「通用」渠道可见、序号固定 / 优先级 0 / 执行操作仅「管理」，原内置「从银行对账单的信息里提取调拨订单对账ID」归入此类，可通过「管理」弹窗多选「适用银行渠道」**跨渠道生效**，默认全选 = 全渠道）；② 新增「复制场景」（配置弹窗右上角从同类别其他场景复制配置，覆盖 config、不覆盖名称）；③ 银行对账单处理模块面板沿中线左右镜像；④ 一批文本改名；⑤ Win 端（仅 Windows + 默认 Clear 主题）页面文本英文/数字改 Courier New、中文改 Noto Sans SC（思源黑体随应用打包），大标题保留原字体，macOS 不受影响。⚠️ 资金/对账红线护栏：builtin-fixed 路由复用原 C1 提取逻辑、提取结果 byte-for-byte 不变；DB 新增 category 枚举 + 多对多关联表均为幂等迁移、老库不破坏。

### 新增

- **自带写死场景（builtin-fixed）类别**（业务规则 · UI · 引擎 · DB / `category=builtin-fixed`）：新增内置场景类别，前端无展示入口（不出现在「新建类别」下拉），仅在「银行对账单处理」模块的「通用」渠道可见，序号固定（置顶）、优先级 0、执行操作列仅「管理」按钮（无转移/删除）、保留启用勾选；原内置「从银行对账单的信息里提取调拨订单对账ID」由 `extract-recon-id` 归入此类；执行引擎 `runScenario` 新增 `builtin-fixed` 路由（按 config 形态复用原 C1 `extractByFeature` 提取逻辑，提取结果不变）
- **场景适用银行渠道（多对多）**（业务规则 · UI · 引擎 · DB / `scenario_applicable_channels` 关联表）：自带写死场景可通过「管理」弹窗多选「适用银行渠道」——默认全选 = 对全部渠道生效（无任何关联行 = 适用全部）；运行某渠道时，适用列表含该渠道、或为空，则该写死场景纳入执行（跨渠道生效）；dispatcher 在通用阶段按「行 matchedChannel 是否在适用列表内」逐行过滤候选行，保持 priority 0 兜底语义不变、只缩小候选行集
- **复制场景**（UI · 配置复用）：新增/修改场景的 C1–C4 配置弹窗右上角新增「复制场景 / 选择」入口，可从同类别其他场景复制配置——覆盖 config，不覆盖场景名称；「银行对账单处理」按「银行渠道 + 场景」两级下拉选择来源，「对账单 ReconID 修复」按「场景」单选

### 变更

- 银行对账单处理模块主面板沿中线左右镜像布局（与 v2.1.12 VCC 模块面板镜像同款手法）
- 对账单 ReconID 修复模块场景管理去掉「银行渠道」下拉与「管理」（按 category 隔离、不引入渠道维度），复制场景按「场景」单选
- 文本改名（UI 文案，DB category / 统计 key 均不变）：功能类别「提取ReconId-From 网关」→「网关对账单赋值银行对账单」（`gateway-recon-join`）；功能类别「银行对账单字段赋值」→「银行对账单赋值自身」（`offset-bill-mark`）；模块「月度 Pending 数据核对」→「月度Pending数据核对」（去空格）
- Windows 端字体（仅 Windows + 默认 Clear 主题）：所有页面文本英文/数字改 Courier New 等宽、中文改 Noto Sans SC（思源黑体随应用打包，字体定义见 `src/fonts.css` 本地子集），大标题保留原比例字体；机制为字符级 fallback；macOS 不受影响
- C3「网关对账单赋值银行对账单」配置弹窗微调：金额不一致勾选项文本加粗；勾选后右侧显示说明文本「输入框的差额用于网关账单与银行对账单的金额比对」，原「网关对账单金额 + 输入框 = 银行对账单金额」公式行下移
- 多项弹窗 UI 微调：复制场景弹窗 / 适用渠道弹窗 / 类别选择下拉的宽度、居中、按钮间距等
- 数据/技术：DB 新增 `scenarios.category` 枚举值 `builtin-fixed`（重建 CHECK 约束 5→6 值，幂等）+ 原内置提取场景迁移成 `builtin-fixed` / priority 0 / channel_id=1（config 不变）；新增 `scenario_applicable_channels` 多对多表（scenario_id × channel_id，幂等，缺表兜底全渠道生效）

### 移除

- 移除「提取ReconId-From Self」（`extract-recon-id`）新建类别选项：原场景已归入自带写死场景，新建场景的「类别」下拉不再列出该项

## 2.1.12（2026-06-01）

v2.1.12 α（PR #56）之后的 β 性能架构阶段，三块互相独立的大文件/大计算量提速，全部 🔴 资金红线 byte-for-byte 守恒：β.1 收单对账 multi-worker（大数据量 JOIN 对账并行）+ β.2 bizOp（业务OP数据核对）导入流式 + worker 化（百万行 xlsx 导入不 OOM）+ 收单导入解析器 sax→手写字节扫描（收单单据币种校验导入提速）。⚠️ 3 个🔴资金红线（三块各一）：① β.1 diff_rows 多 worker 与单 worker byte-for-byte 一致 ② β.2 worker 内五条资金红线（整批拒绝 / D+1 原子替换 / bu_name 改写 / 失败报告 / flow 跨 BU 清）全保住 ③ 收单导入新旧 reader 全行 SHA1 完全一致。质量门：`npm run release-check` 全绿（unit 1473 / integration 952 / smoke 全过）；三块均合成数据 byte-for-byte 已充分验证，真实大文件由用户手测把关（合并门槛硬要求）。提 PR 后经 self-review + reviewer 评论修复 5 问题（β.1 资金 C1/C2 + β.2 I1/I2/I3 + MW cancelToken），均补回归测试。

### 新增

- **β.1 收单对账 multi-worker write-splitting**（🔴资金红线）：`acquiringBillCurrency` 对账 stage 4'（`INSERT INTO diff_rows SELECT … JOIN …`）500万行单 worker 慢，多 worker 并行直跑撞 SQLite WAL single-writer → SQLITE_BUSY。方案 plan-b（POC 拍板）= 主进程按 OFFSET/LIMIT 拆 N chunk → M worker 并行 `SELECT JOIN`（只读 WAL 并发不冲突）→ 各 worker 写自己的 temp db → 主进程按 chunkIndex 升序 ATTACH 汇总 INSERT（顺序不变量）；50万行实测 **2.3–2.7x**（M=4，前提 chunk 数 >> worker 数）；决策 D29（默认 worker 2 / 上限 4 / `cpus-2`）/D30(plan-b)/D31(**<100万行或 chunk<worker→回退单 worker**)/D32(每模块独立 pool)/D33(默认 2、`freemem<2GB`→1)/D34(流式进度)/D-β-1(resume→单 worker)；自适应分片目标 chunk ≈ 4×worker（下界 2000）；新增 settings `acquiring_bill_worker_count`（默认 2 / 范围 1-8 / 幂等 migration）；🔴 diff_rows 多 worker 与单 worker byte-for-byte 一致、失败仅清本 run diff 不留半套数据（contract 20 例 + 嵌套 worker 拓扑集成测试）；合并门槛 = 500万真实数据手测
- **β.2 bizOpRecon（业务OP数据核对）导入流式 + worker 化**（🔴资金红线）：SheetJS `XLSX.readFile` 全量进内存，百万行 xlsx 撞 V8 512MB 静默返回空；新增流式 reader `reader-streamed.js`（JSZip + SAX 扫 `<row>`，复用 `streaming-xlsx-reader`，镜像 SheetJS 语义 / 真实行号 / 表头校验）+ 导入移入 child-process worker `import-worker.js`（`utilityProcess.fork` / Node `spawn` fallback，边流式读边分批 INSERT 不堆数组）；IPC 改调 worker（传 dbPath 与 acquiring worker 同库 WAL 并发，`onProgress` 透传 renderer），无 dbPath 回退旧同步；🔴 worker 内五条资金红线（整批拒绝 ROLLBACK / (date,BU)+D+1 替换原子事务 / `bu_name` 改写 / 失败报告 xlsx worker emit→主进程写 / flow 跨 BU 清）；reader contract 11 + worker contract 10；合并门槛 = 真实大文件手测
- **收单导入解析器 sax→手写字节扫描**（🔴资金红线）：profile POC 定位收单导入 50万行 122s、解析占 ~90%（非 insert/raw_json）；POC 实测纯解析 sax→手写 8.7x(50万)/9.1x(100万)，JSZip 在 100万行（~3.8GB 解压）崩 yauzl OK → 最优架构 = yauzl(保留)+手写扫描、**不引入 JSZip**；新建 `reader-handrolled.js`，`reader.js` 纯追加导出 helper 作基线 + 一行回滚，生产路径 `acquiring-bill-currency-session.js:16` 单行 require 切换；🔴🔴 数字 cell 取 `<v>` 原文本逐字对齐 sax（**绝不 parseFloat** 否则 `"1000.00"`→`"1000"` 改金额，改写专用 `parseAcquiringRowXml` 不复用含 parseFloat 的 `parseRowXml`）；**实测端到端 5.6x（122s→22s/50万，500万外推 ~20min→~3.8min）**、内存更低；🔴 双层资金闸 = contract 18 例（sharedStrings / number cell / 稀疏行 / 中文实体 / 表头错 / peek）+ 真实规模 scalediff（50万/100万行全行 SHA1 + importedCount + monthKey 完全一致）

### 变更

- 收单导入默认解析器由 sax 切到手写字节扫描（`acquiring-bill-currency-session.js:16` 单行切换；`reader.js` 保留一行回滚恢复 sax）
- bizOpRecon（业务OP数据核对）导入默认走 worker 化入口（流式 reader + child-process worker）；无 dbPath 自动回退旧同步
- β.1 多 worker 回滚：settings `acquiring_bill_worker_count=1` 即全程单 worker
- 测试基线：unit 1390 → **1473 case**（β.1 contract 20 + β.2 reader 11 / worker 10 + 收单导入 contract 18 + worker pool / settings worker_count + self-review/review 回归 6：C1/C2 temp·resume + I1/I2/I3 + MW cancel）；integration **952 断言**（含 β.1 嵌套 worker 拓扑）；smoke 0 regression

### α/β 收口

- **v2.1.12 β（本版）**：β.1 收单对账 multi-worker + β.2 bizOp 导入流式 worker 化 + 收单导入 sax→手写；全部纯性能架构提速、对用户行为透明（更快、结果不变）
- **🔴 合并门槛**：三块均为🔴资金红线，合成 fixture 已证 byte-for-byte，真实大文件由用户手测把关（① 收单对账 ≥100万行多 worker vs 单 worker 一致 ② bizOp 真实大文件导入五条红线 ③ 收单导入入库金额/币种抽样对原文件）

## 2.1.12-alpha.1（2026-05-31）

v2.1.11 之后 1 轮迭代（α 阶段 = 业务 + 收尾），2 个用户需求 + 1 个提示修正 + 1 批收尾清债：需求1（**新功能** 第 6 个模块「VCC业务OP计算」`vcc-op-calc` — 仅导入流水对账单、按月聚合发生额出/入、期末OP = 期初OP + 发生额、落库 + 显示余额、JSZip 流式 reader 支持百万行级大文件）+ 需求5（C3「提取ReconId-From 网关」场景 extra fee 额外费用匹配）+ 需求6（资金对账不平跳过提示加数据侧候选行预检）+ 收尾批（SR-log-1 删旧双写 / I6 bundle C2 防御测试 / I7 important-variables 升格）。⚠️ 2 个🔴资金红线（需求1 发生额求和 + 期末OP；需求5 改 C3 网关核销金额匹配）+ 1 个🔴破坏性变更（SR-log-1 停旧 activity log 写入、历史文件保留不删）。

### 新增

- **需求1 第 6 个模块「VCC业务OP计算」**（**新功能** · `module.id = vcc-op-calc` / 🔴资金红线）：UI 复用第 4 模块「月度银行对账单BU回填校验」面板/按钮/状态框样式，仅「导出差异」→「显示余额」；输入仅「流水对账单」xlsx（28 列，复用第 5 模块 `FLOW_COLUMN_DEFS` 结构），按「出入方向」对「对账金额」求和、月份取「账单日期」；业务语义 `发生额 = 发生额入 − 发生额出`、`期末OP = 期初OP + 发生额`（期初OP 用户手填上月 OP）；2 张新 DB 表 + FK（`vcc_op_calc_runs` 按月汇总 + `vcc_op_calc_run_files` 逐文件明细，金额列 TEXT，**不落流水原始行**，允许同月多 run、显示余额取最新）+ 2 索引；6 个 IPC（pick-files / scan / compute-amounts / save / list-months / get，资金类用 `trackedIpcHandle`）+ scan 进度事件（每 5 万行）；**JSZip 流式 reader（弃 SheetJS/exceljs）**——实测 78.7 万行/811MB worksheet，SheetJS 超 V8 单字符串 512MB 硬上限静默返回空、exceljs 又因 zip data descriptor 报 `invalid signature`，改 JSZip 走 central directory + SAX 扫 `<row>` + 多 sheet 定位 + 损坏文件提示 + 进度回调（实测 7.8s / RSS 778MB 优于 exceljs 16.9s / 2GB）；session 流式聚合（合并 scan+compute 一次读、不存全量行、内存恒定）；前端 MODULES 第 6 项 + `vccOpCalcState` + 3 dialog（F1 月份确认 / F2 计算框点计算即调 save 后端整数分算 endOp 原子落库、前端不自算 / F3 显示余额按月查月末 OP）+ 主面板镜像布局 + 4 处 preview 入口；后端 gap 修复 `ALL_MODULE_IDS` 补 `'vcc-op-calc'`（避免重蹈 v2.1.2/2.1.3 漏注册 `Invalid module id` 历史 bug，默认隐藏经🔄收纳弹窗启用）；🔴 资金红线护栏 = **整数分精度**（乘 100 转整数分求和最后除回，规避浮点漂移）+ **混币种全量合并求和**（所有币种不分币种合并 = 跨币种金额合计、非货币余额，已确认）+ **整批拒绝**（出入方向非法/多月份混杂/非数字行 → 整批拒绝 + 错误报告）+ session 单测 17 case（正/负/小数/空）+ **真实大文件核销发生额 2,223,798.77**

### 变更

- **需求5 C3「提取ReconId-From 网关」场景 extra fee 额外费用匹配**（🔴资金红线 · 业务规则 · UI · 引擎 / `category=gateway-recon-join`）：C3 场景新增/修改弹窗左下加勾选框「网关对账单金额与银行对账单不一致」，勾选后出现「网关对账单金额 +」`[输入框]`「= 银行对账单金额」，匹配时网关订单金额 + extra fee 后再与银行对账单金额比对；config 新增嵌套 `extraFee:{enabled:false,amount:0}`（与 v2.1.8 N2 `assign` 成组语义一致）；🔴 引擎方案 A1 = fee **仅作用于"银行侧字段 = 发生额绝对值"那个字段对**（零歧义，避免多金额对场景错配），该对网关值 `+fee` 后比银行值、其余 reconField 不变；🔴 允许正负（代数 `gw+fee=bank`，正=加/负=减）+ 允许小数 + 加法处 `Math.round((gw+fee)*100)/100` 归一到分（规避浮点）+ 4 字符仅视觉宽度不硬 maxlength；🔴 undefined→null 双防御（`runC3Scenario` 内算 fee 缺失→null + 引擎入口 `Number.isFinite(fee)?fee:null` 兜底，防旧调用不传 fee 致 `gwNum+undefined=NaN` 大面积回归）；旧场景惰性兜底无 migration（缺 `extraFee` 即关、旧 bundle 自动兜底）；校验勾选后 amount 必填+必须数字、未勾不校验；🔴 绝对不变量 = fee 未勾/=0 时与 v2.1.11 **byte-for-byte 一致**、1v1 严格消费红线不动；护栏 = 单测 DS1-DS9（含零回归 byte-for-byte）+ smoke C3 extra fee 端到端 + **真实网关+银行账单端到端人工核对核销**（合并前硬要求）
- **需求6 资金对账不平跳过提示加数据侧候选行预检**：银行对账单模块两处 C3 提示弹窗（导入后 `maybePromptGatewayReconImport` / 运行时 `shouldPromptGatewayReconAtRun`）现状只判"是否启用 C3 场景"（场景维度），即使启用 C3 但本次导入数据无任何能命中该类场景的行时仍弹「将跳过」；修复 = 现有启用判断后追加"数据侧候选行存在性"判断（启用 C3 AND 数据存在 ≥1 条命中 `gateway-recon-join` 场景 conditions 的行才弹）；新增只读 helper `countC3BankCandidates`（与 C3 引擎 conditions 语义完全一致）+ 1 IPC（main 查 session C3 候选行数）+ renderer 双 gate；边界：预检"无候选行"≠"不运行 C3"只是"不提示跳过"，不碰资金红线
- **I6 bundle 旧结构 C2 端到端防御测试**：补 `scenarios-bundle-ipc.test.js` 构造旧结构 bundle（v2/v3 含 C2 `category`+`billTypes≥1`+`conditions`+`reconFields`）→ 导入升级 → 断言 config 字段完整 + 能被 `runC2Scenario` 消费
- **I7 important-variables 升格**：`rules/important-variables.md` 新增 `config.billTypes`（C2 命中筛选数组 ≥1，归 Risk-sensitive ⚠️资金红线，与 `runC2Scenario` 同层）+ `config.conditions` 独立条目并与 `conditionsLogic` 交叉引用（此前 `billTypes` 仅在描述行内、`check:vars` 扫不到）；重跑 `npm run scan:vars` 刷新自动统计
- **测试基线**：unit 1338 → **1390 case / 327 suites**（vcc session 17 + reader 流式 / c3 extra fee DS1-9 + 零回归 / ALL_MODULE_IDS 8→9 / bundle C2 防御）；integration 943 → **952 断言 / 16 脚本**；smoke 0 regression

### 移除

- **SR-log-1 删 `app_activity_log.txt` 旧双写**（🔴破坏性变更 · 删数据红线护栏）：`logger.js` `appendActivityRecord` 移除旧 txt 写入，仅保留新结构 `appendStructuredLog`（`logs/{YYYY-MM}/{MM-DD}/{level}.log` JSON Lines）；`initializeActivityLog` 不再建/写 `app_activity_log.txt`、启动日志改走结构化日志；返回值改新 jsonl 路径；🔴 **停止新写入但保留历史文件不删**（老用户/脚本可能直接读旧 txt，删除 = 删数据事故；护栏 = 只停写不删，v2.1.11 及更早历史记录可继续查阅）

### α/β 收口

- **v2.1.12 α（本版）**：需求1 VCC 模块 + 需求5 extra fee + 需求6 提示预检 + 收尾批（SR-log-1 / I6 / I7）
- **不做边界（α）**：VCC 不导出 Excel（仅显示余额）/ 不跨月汇总；extra fee 仅 C3 不含 C4；biz-op-recon 第 5 模块流式改造（保留全量行 join、回归风险高）独立子任务评估、本版不含

## 2.1.11（2026-05-29）

v2.1.10 之后 1 轮迭代（β 范围），3 个用户追加需求（性能主线 A3-multi-worker / F5-cont 另起 spec）：T1（单元测试运行日志 — 终端 `N/N PASS` + 落盘带时间戳日志）+ T2（**新功能** pending 月度移除核对 — 导入移除归档文件入库 + 对账后自动用对账规则把移除数据与 `missing` 行匹配 + 导出 2 张新 sheet）+ T3（C2「银行对账单字段赋值」3 项增强 — 账单类型多条件 AND / FundType 严格下拉 / 对账字段可空）。⚠️ 1 个资金/对账红线护栏（T2 匹配复用对账规则 matchFields + compareFields + 数值归一化）+ 1 个向后兼容迁移（T3 C2 单条件→多条件惰性迁移）。质量收尾：3 路 adversarial self-review + SR-FIX round 1。

### 新增

- **T2 pending 月度移除核对**（**新功能** / 数据核对 · 导出契约）：「月度 Pending 数据核对」模块导入流程上叠加移除核对——导入某月数据成功后弹「是否核对移除pending数据」；选「否」流程零变化，选「是」导入「移除归档 Pending 账单」xlsx 入库（关联该月，作后续对账"上月"/`missing` 来源）；新增 DB 表 `removed_pending_rows`（全 46 列 raw_json + 6 索引列）+ `pending_removal_matches`（对账后匹配结果），幂等 migration、不动现有 `pending_rows`/`diff_rows`/`diff_runs`；新建 `removed-reader.js`（取第一个 sheet + 46 列表头映射）+ `removal-match.js`（对账后自动用对账规则 `matchFields` 多轮 fallback 配对 + `compareFields` 内容核对，与 `engine.js` 同语义）；导出（仅单 run）追加最右 2 sheet——「missing核对移除」（末列「移除核对状态」三态：`核对无误` / `核对有差异：字段(missing值≠移除值)` / `missing有_移除无`）+ 条件 sheet「移除有_missing无」（未配对移除行还原 46 列）；🔴 资金红线护栏 = 复用对账规则语义 + 数值字段归一化 + unit/integration/manual 三层
- **T1 单元测试运行日志**（测试基建）：`npm run test:unit` 解析 `node --test` 输出，终端打印仿 integration-runner 的 `==== N/N PASS ====` + 每文件用例数/耗时；每次运行落盘 `logs/unit-tests/unit-<YYYYMMDD-HHmmss>.log`（gitignore）；退出码透传语义不变、`release-check` 串联不变；reverse sync 修正根 `CLAUDE.md` "No unit test framework" 过时表述

### 变更

- **T3 C2「银行对账单字段赋值」3 项增强**（业务规则 · UI · 引擎 / 类目 `offset-bill-mark`）：① 账单类型支持多筛选条件 AND 全满足（`billTypes` 由 `[{seq,field,op,value}]` → `[{seq,conditions:[…]}]`；条件行加「新增」按钮插空白条件行；按 seq 分组 + 子序号 `#1.1`/`#1.2`；引擎改 AND 全满足才归类）；② 字段 = `FundType` 时值改严格单选下拉（仅枚举、运行时读 `assets/FundType枚举值.xlsx`，缺失降级文本输入），作用于条件行 + 赋值行；③ 对账字段放开非空校验，允许留空/删到 0 行（与引擎 `reconFields=0` 对齐）；④ 老单条件场景读取时惰性迁移为多条件结构（向后兼容、配置不丢、引擎入口兜底归一化）；已跑 `/check-vars` + `npm run preview:scenario-config-c2`

### 修复（SR-FIX round 1）

- 🔴 C1 资金红线：removal-match 数值字段比较前统一数值归一化（复用 `engine-utils` `isNumericFieldName`+`parseNumber`），修复"100" vs "100.00" / 千分位串系统性失配导致同一笔同时误报两张 sheet
- 🟡 I1 对账完成文案追加移除核对摘要（匹配 N 条/未匹配 M 条）；I4 `DELETE pending_removal_matches` 挪进与 INSERT 同一事务保原子性；I5 FundType 严格下拉保留旧值为 disabled option 防误覆盖
- 手测修复：markValue 校验误报；「移除核对状态」列接入 compareFields 逐字段内容核对、输出差异字段明细

### 测试

- unit 1338 case / integration 943 断言（新增 `pending-removal-reconcile.js`；C2 多条件/迁移覆盖在 unit）/ smoke 0 regression

### α/β 收口

- **v2.1.11 β（本版）**：T1 + T2 + T3 三个用户追加需求
- **v2.1.11 后续 Phase（另起 spec）**：性能主线 A3-multi-worker（多 worker 并行）+ F5-cont（C4 算法重写）

## 2.1.10（2026-05-29 — 已发布 / PR #54 merged 2026-05-28T15:48:39Z）

v2.1.9 之后 1 轮迭代（β 范围），4 主线：A3（runCheck 跨进程化 — worker_threads + 独立 DB + 跨进程错误回传）+ A4（SQL JOIN chunked 分批 — chunk size 10w + cancel chunk 边界）+ N4-cont-1（raw_json 体积治理 — 7 天保留 + idle 自动 + sentinel `''` v0.3）+ N4-cont-2（FK CASCADE — `diff_rows` 2 FK ON DELETE CASCADE + 8-status migration）。⚠️ 2 个🔴破坏性（N4-cont-2 DB schema 不可逆 + N4-cont-1 raw_json 不可逆清空）+ 3 个资金红线护栏 + 5 个 important-variables v12 升格。

### 新增

- **A3 runCheck 跨进程化**（架构级）：worker_threads + 独立 DatabaseSync 连接（D24=a 验证）+ 6 条 PRAGMA 强制；新建 run-check-worker.js + run-check-worker-pool.js + serialize-error.js；提取 runCheckCore 共用；setupIdleCleanupTimer 加 isBusy 守卫 + 30s grace；cancel 5 阶段间检查 + ROLLBACK；worker crash 自动 cold-start + op lock 释放 + Notification；主进程 event loop lag 65.7ms → 1.3ms（48.7x）/ worker cold-start ~11ms / IPC ~0.010ms
- **A4 SQL JOIN chunked 分批**（性能 + cancel 响应）：insertDiffRowsByJoinChunked 替代单条大 SQL；chunk 10w（spec §3.2 选定）+ 独立事务边界；runs.chunk_progress 列 + setRunChunkProgress / getRunChunkProgress；resume IPC handler 暴露（UI v2.1.11+）；cancel < 0.01ms 同步抛；chunked vs non-chunked 0.99x **byte-for-byte 一致**
- **N4-cont-1 raw_json idle 自动清理**（体积治理）：clearStaleSuccessfulRawJson 单 SQL UPDATE WHERE id NOT IN diff_rows + imported_at < N 天；settings 单键 retention_days（默认 7 / 范围 1-30 / 范围外回退）；复用 v2.1.9 N1' idle 30min cleanup 计时器追加回调；用户无感 0 UI（D27=N/A）；差异行 raw_json 永远保留；失败 graceful；目标 6 月体积 ~24GB → ~8GB（~99% 节省）；**v0.3 sentinel `''`**（v0.2 原 NULL 与 v2.1.8 N4 NOT NULL 冲突）
- **N4-cont-2 FK CASCADE 改造**（DB schema 不可逆）：acquiring_bill_currency_diff_rows.bill_import_id + run_id 加 ON DELETE CASCADE；ensureDiffRowsCascadeMigration_v2_1_10 + 8-status state machine（沿用 v2.1.9 N5 范式）+ 复用 v2.1.9 SR-backup-1 createBackupFn 注入；跨版本 v2.1.7/v2.1.8/v2.1.9 → v2.1.10 一步迁；PRAGMA foreign_key_check 0 violation 是 hard requirement；失败 ROLLBACK + 备份保留

### 变更

- **runCheck IPC 路径** main.js:10758-10785：直调 → workerPool.dispatchRunCheck；onProgress 改 worker 内部 forward；notifyResult / releaseOpLock 路径保留
- **setupIdleCleanupTimer** main.js:11155-11178：加 `runCheckWorkerPool.isBusy()` 守卫（spec §2.3.2）+ N4-cont-1 raw_json cleanup 回调追加（独立 try/catch + activity log）
- **rules/important-variables.md** v11 → v12：升格 5 条（Critical 4 + Important-skeleton 1）+ 更新 1 条（bill_imports.raw_json 扩 N4-cont-1 sentinel 语义）
- **集成测试** 9 脚本 / ≥ 497 case → **15 脚本 / 809 case**（v2.1.10 新增 5 脚本 / 164 case：a3-phase1 + a3-phase2 + a4-phase3 + n4-cont-1-phase4 + n4-cont-2-phase5）

### 修复（SR-FIX）

- **N4-cont-1 sentinel v0.3 修订**：原 v0.2 SET raw_json = NULL → Phase 4 T28 集成发现违反 v2.1.8 N4 NOT NULL 约束 → 用户拍板 Option A 改 SET raw_json = ''；所有 idempotent 守卫 / SQL 查询从 IS NOT NULL 改 != ''（commit 740fdc8）

### α/β 收口

- **v2.1.10 β（本版）**：4 主线如上
- **v2.1.11+ 继续延期**：A4 resume UI / N4-cont-1 settings UI / chunk size settings 化 / SR-log-1 双写删旧 / F5-cont C4 ILP

## 2.1.9（2026-05-27 — 待发布草稿）

v2.1.8 之后 1 轮迭代（α 范围），9 项主题：N5（银行渠道区分场景 — 🔴 资金红线 + DB schema 破坏性 migration）+ N6（状态框换行修复）+ N7（场景模板按渠道导入/导出 — 新 bundle 类型）+ SR-backup-1（sqlite VACUUM INTO 备份基建）+ G1-cont（单元测试 37 文件全量铺）+ SR-policy-1（integration-runner 清单自动同步）+ N1-settings（idle 阈值 settings 化）+ N4 重构（migration 备份切到新 API）+ SR-log-1（全局告警日志化 + JSON Lines）。⚠️ 1 个🔴破坏性（Sheet 3 主输出撤除 → 独立报表）+ 3 个资金红线护栏。

### 新增

- **N5 银行对账单按"银行渠道"区分场景**（🔴 资金红线 + 破坏性 migration）：channels 表 + 「通用」内置（id=1, is_builtin=1, 不可删不可改名）+ scenarios.channel_id FK ON UPDATE CASCADE；启动期 N5 migration（VACUUM INTO 备份 → 事务建表/加列/backfill 通用）；场景管理顶部「银行渠道」过滤 + 「管理」按钮 + createChannelManagerDialog；场景行「转移」按钮（搬运语义）；footer 「批量操作」+ 勾选列 + 批量转移/删除；dispatcher 双维 first-match-wins（专属优先 + 通用兜底，spec §2.1）；导入按 `<Channel>-<地区>` 匹配 → 未命中走通用兜底但保留原始 channelKey
- **N5 Sheet 3 拆出**（🔴 对外契约）：v2.1.8 N3-2 主输出 Sheet 3 撤除 → 独立报表 `命中场景行-{原文件 basename}-{timestamp}.xlsx` 落 `error-reports/{date}/`；列 = 44 原 + 匹配渠道/匹配状态/命中场景
- **N7 场景模板按渠道导入/导出**：独立 `scenarioBundleVersion=1` 与 `bundleVersion=4` 互认隔离；多选导出单文件多渠道；导入二阶段（needs-confirm → apply）+ 缺失渠道弹框 + 同名场景跳过；事务包裹
- **N6 状态框换行修复**：renderer.js 删冒号后冗余 \n（仅 2 行）；updateStatusBox 内层不动；其他 5 模块零外溢
- **SR-backup-1 sqlite 安全备份**：`src/backend/database/backup.js` 用 `VACUUM INTO`（POC 后 spec 反向同步，DatabaseSync.backup 不存在）；label 白名单防 SQL 注入 + tmp atomic rename
- **N4 重构**：N4 migration 备份切到新 createBackupFn（删 fs.copyFileSync + wal_checkpoint）；备份路径前缀 / 标志位 / 9 字段裁剪不变（v2.1.8 已发契约护栏）
- **N1-settings idle 阈值 settings 化**（D21=c 修订）：v2.1.8 硬编码 30min 改 settings 表 `acquiring_bill_idle_cleanup_minutes`（默认 30 / 范围 5-180）；启动期 loadIdleCleanupMsFromSettings 读取 + getter 兜底；**不做 UI** — 用户用 sqlite3 改 settings 表 + 重启生效
- **SR-policy-1 integration-runner 自动同步**：in-place 编辑 `rules/integration-test-policy.md §七`（全 PASS 才写）+ 时间戳东八区 + stdout
- **SR-log-1 全局告警日志化**（数据待 Phase 8.8 完成定稿）：preload reportLog + main IPC + renderer wrapper hijack + main 49 处 console.error 改造 + 新结构 `logs/{YYYY-MM}/{MM-DD}/{level}.log`（永久保留）+ JSON Lines + 双写兼容 app_activity_log.txt
- **G1-cont 单元测试全量铺**（数据待 Phase 1.5 完成定稿）：第 1 层 13 + 第 2 层 24 = 37 文件；累计 case 目标 ≥ 400（v2.1.8 baseline 123）

### 变更

- **N5 spec Reverse Sync 三轮**：v0.6 VACUUM INTO + v0.7 channelId 字段 + 不渲染删除按钮 + v0.8 createAppSettingsDialog 新建 + N4 调用方契约 + regex 兼容
- **集成测试改造**：`bank-statement-hit-scenario-sheet.js` 26 → `*-report.js` 44 case；6 脚本 / 324 断言
- **tasks T18/T26 笔误**：实际接入 main.js:3077（dispatcher） + main.js:3140（独立报表）

### α/β 拆分

- **v2.1.9 α**（本版）：9 主题如上
- **v2.1.10 β**（拆出）：A3 worker 跨进程化 + A4 SQL chunked + N4-cont-1 raw_json 治理 + N4-cont-2 FK CASCADE 改造
- **v2.1.11+ 继续延期**：F5-cont（C4 ILP 重写） / N5-channels-scale（虚拟滚动评估）

## 2.1.8（2026-05-26）

v2.1.7 之后 15 commit 收敛，6 项主题：F5（C4 算法重设 4/5 根因）+ G1（单元测试框架建立）+ N1→N1' v0.7（cleanup 改 idle 30min 触发 + 差异保留 + FK 反向同步）+ N2（C3「自取值」）+ N3（银行对账场景号修复 + Sheet 3）+ N4（差异表 29→12 列瘦身 + 破坏性 migration）+ v2.1.7-cleanup（10 项 minor）。⚠️ 2 个🔴破坏性（N4 raw_json 删 17 字段 + N4 输出契约 29→12）+ 3 个资金红线护栏 + 7 个 important-variables v11 升格。

### 新增

- **F5 C4 manyToOne 算法重设**（🔴 资金红线，4/5 根因）：BillDate 数字日期 fix + maxSize 动态档位 + 复合排序 + currency 等值过滤；TEST2.xlsx 28→43 行；根因 #5 subset-sum 剪枝延期 v2.1.9
- **G1 单元测试框架**：Node 22+ 原生 `node:test`（零 devDep）+ `tests/unit/` + `npm run test:unit` 28 suites / 123 case；G1 全量铺延期 v2.1.9
- **N1' (v0.7) cleanup idle 30min 触发 + 差异保留**（🔴 FK 反向同步）：3 层触发（idle 主 + before-quit 兜底 + 进入模块崩溃恢复）+ `cleanupAfterRunBackground` 加 `includeDiff=false` 仅清 flow（bill 因 FK 必须保留 + diff/runs 也保留作有效数据 + 元数据）
- **N2 C3「自取值」**：第二下拉新增 `__CUSTOM__` + 静态字符串输入框；DB migration 给历史场景加 `mode='direct'`；引擎 `mode='custom'` 分支
- **N3-1/N3-2 银行对账场景号修复 + Sheet 3「命中场景行」**：dispatcher `hitScenarios` 带 `displayIndex`；writer 可选 `includeHitScenarioSheet`；INTERNAL_FIELDS 加 `_hitScenarioDisplayIndex`
- **N4 收单差异表 29→12 列瘦身**（🔴 破坏性）：模版 9 列 + 单据_对账币种 + 流水侧 2 列 = 12；DB 破坏性 migration `ensureBillRawJsonV2Slim`（自动备份 → 事务 rewrite → 标志位），**永久删 17 字段**（ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间）

### 变更

- **F5 (T08) Reverse Sync F5-D4**：reader 入口 → c4 引擎入口（资金红线扩面收敛）
- **N1 → N1' Reverse Sync** β 方案降级为退出兜底，主触发改 idle 30min
- **N1' v0.9 FK 反向同步**：smoke caseP FK 错误 → bill_imports 必须连带保留
- **N4 输出契约破坏性变更**：3 轮 Reverse Sync（v0.8 → v0.9 → v0.10）后稳定收敛
- **`cleanupAfterRunBackground` 签名**：新增 `includeDiff = false` 参数；默认安全（仅清 flow）
- **v2.1.7 minor 10 项收尾**：8 已修 + 2 不可修记录

### 移除

- **N4 差异表输出 17 列**：ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间（仅输出 + DB raw_json 同步删除）

## 2.1.7（2026-05-21）

v2.1.6 之后 7 轮迭代收敛，50 commit。6 项主功能（F1-F4 / F6-F8）+ R3 状态框中文「：」全局换行 + B5 全局 wiring 加固 + B4 CSS flex/grid 嵌套 4 round 收敛。F5（C4 BillDate 数字日期 + 算法重设）延期 v2.1.8 与 A3（worker_threads）联合主题。5 资金红线（F2/F4/F7-A1/F8/R5）+ 4 全局影响（F7-A1/R3/B5/F4）+ 10 important-variables 升格。

### 新增

- **F1 C1 提取ReconId-From Self AND/OR 切换**（⚠️ R5 三层护栏）：dialog "条件" label 下方 AND/OR radio；新建默认 AND / 老 scenario fallback OR；引擎 fallback OR 保 v2.1.6 行为
- **F2 C3 提取ReconId-From 网关 1v1 化**（🚨 资金红线）：`usedGwRowIdx` Set 单向消费 gw 池，避免一笔网关被多笔银行重复"幽灵核销"
- **F4 「账单打标」→ 「银行对账单字段赋值」**：类目名 + 子 row 名「打标值」→「赋值」+ 默认空 + 校验放宽（账单类型 ≥ 1 / 对账字段允许 0）+ 衍生方案 A 无条件赋值
- **F6 收单单据币种校验进度提示**：导入文件 / 6 阶段运行业务化文案 + setImmediate 让 IPC 送达
- **F7-A1 全局 SQLite PRAGMA**（⚠️ 全局影响）：WAL + NORMAL + 64MB cache + 256MB mmap；用户备份 DB 必须同时备份 `*-wal` + `*-shm` 旁文件（USER_GUIDE §5.1）
- **F7-A2 source_file 索引 + ANALYZE**
- **F7-B1 完成系统通知**：macOS 通知中心 / Windows 任务栏原生
- **F8 银行账单结果第 2 sheet「未命中场景行」**（🚨 资金红线 baseline）：dispatcher 反向 filter `unmatchedRows` + writer 第 2 sheet；`modifiedRows` 完全不动
- **knowledge 沉淀**：`knowledge/css-flex-grid-overflow-pitfalls.md` — flex/grid 嵌套穿透 max-height 必修两条线（每层 min-height: 0 + grid 父 grid-template-rows: 1fr）

### 变更

- **R3 状态框中文「：」全局自动换行 + B5 wiring 全局加固**：3 处 setStatus 漏接修复 + smoke 新增 wiring 审计断言防再漏；C-1 self-review fix 删 `#bizOpReconStatusBox` ID specificity 覆盖
- **大账号确认页 4 round 收敛**：F3 文件名 grid 3 列 + B2 multi 字母 + B3 单 grid 表格 + B4 真根因 `grid-template-rows: 1fr`（DevTools 实测锁定）

### 文档

- PRD/spec/tasks v0.11/v0.9/v0.8（含 §二十三 50 commit 实施记录 + spec 反向同步 3 处）
- `rules/important-variables.md` v9 升格 10 条（Critical 3 + Important-skeleton 2 + Risk-sensitive 5）
- USER_GUIDE §五 v2.1.7 新增能力

## 2.1.6（2026-05-18）

v2.1.5 之后追加 patch 迭代，2 块独立改动：**Module A 个人痕迹元数据**（package.json author/copyright/publisherName + 跨库 watermark + 启动 log 头 + 构建时 git short SHA）+ **Module B 新增模块「收单单据币种校验」**（独立第 8 个主模块，按月对比收单流水表 vs 收单流水单据表币种 + 差异表 29 列对比区 1 对 1 输出）。OPEN ISSUE 全部拍板（PRD §六）。

### 新增

- **Module A 个人痕迹**（无业务影响）：
  - package.json author 对象化 + electron-builder 注入 Windows 文件属性 publisher = `pzhong`
  - 跨库 `applyWatermark()` 在 8 个 writer 共 17 处调用前注入 `lastModifiedBy = 'pzhong'`
  - 启动 log 头新增一行 `crafted by pzhong (pzhong1212@gmail.com) · build {sha}`
  - 构建脚本 `scripts/gen-build-info.js` + prebuild 钩子注入 git short SHA
- **Module B 新增「收单单据币种校验」模块**（⚠️ 资金红线）：
  - 主导航第 8 个独立面板（月份下拉 + 4 按钮 + 状态栏）
  - 按月组织：导入收单流水表（多 xlsx）+ 导入收单流水单据表（多 xlsx）
  - 关联键：流水 `对账主Id` ↔ 单据 `主对账Id`，1:1 严格关系
  - 币种判定：`LOWER + TRIM` 归一后比较（`usd` ≡ `USD`）
  - 流水金额入库 ABS（`recon_amount_abs`）
  - 差异表输出 29 列 = 单据原 26 列 + 末尾 3 列对比区（`单据_对账币种` / `流水币种` / `流水金额绝对值`）
  - 仅含差异行（不一致 + 缺失）；一致行 + unmatched 不入差异表
  - 1 对 1 输出：每个输入单据 xlsx → 1 个差异 xlsx；0 差异行也输出仅表头版
  - 4 张 SQLite 表（`acquiring_bill_currency_{flow_imports,bill_imports,runs,diff_rows}`）+ 5 索引 + UNIQUE(month_key, recon_main_id)
  - 7 个 IPC（`acquiringBillCurrency:*` 命名空间）
- smoke 用例新增 `scripts/smoke/acquiring-bill-currency.js`：A-G 7 case + A1 watermark 集成 = 26 assert
- reader 选型：ExcelJS streaming 4.4.0 race bug → 改 SheetJS dense

## 2.1.5（2026-05-15）

v2.1.4 之后追加 patch 迭代，3 块独立改动：N1 对账单 ReconID 修复模块名加空格 + 修 usage-stats long-standing bug；N2 对账单 ReconID 修复场景下拉空状态统一；N3 银行对账单处理 C3「提取ReconId-From 网关」场景配置 dialog 新增「条件」栏。OPEN ISSUE 全部拍板（PRD §十）。

### 新增

- **N3 — 银行对账单处理 C3「提取ReconId-From 网关」场景新增「条件」栏**（PRD §5.3）：`createScenarioConfigDialogC3` 在「优先级」与「对账字段」之间插入「条件」栏 + 行级 AND 预过滤
  - 条件行：`[侧↓ 网关/银行] [字段↓] [操作↓] [值] [×]`，操作沿用 `SCENARIO_CONDITION_OPS`（7 项）；左一切「网关/银行」时左二字段下拉重渲并清空
  - 字段枚举源：网关 → `GATEWAY_RECON_FIELDS`（31 列）；银行 → `BANK_STATEMENT_FIELDS_FOR_C3`（45 项含虚拟「发生额绝对值」）
  - **柔性校验**：conditions 可 0 行（兼容旧场景）；≥ 1 行时 side/field 必填 + 非空值/非空值 op 的 value 必填 + side 与 field 一致性校验
  - **AND 语义**（区别于 C1 的 OR）；运行时引擎 `runC3Scenario` 入口加 Step 0 拆分 + 过滤 `gwRows` / `bankRows` 后传入既有比对循环；银行侧虚拟字段「发生额绝对值」由新增包装函数 `evalCondition(row, cd, { useC3BankValueGetter })` 走 `getBankRowValueForC3` 计算
  - DB 兼容：v2.1.4 旧 scenario `config.conditions` 缺失 → 引擎兜底 `[]`，无需 migration
  - confirm 预览段在 conditions ≥ 1 行时追加文案

### 变更

- **N1 — 对账单 ReconID 修复模块名加空格**（PRD §5.1）：`对账单ReconID修复` → `对账单 ReconID 修复`（ReconID 前后各加一个空格）
  - 改动 6 处字面：`MODULE_REGISTRY.reconIdFix.name` + 3 处 `trackedIpcHandle` moduleKey + 1 处 error message + `usage-stats.js` `FUNCTION_REGISTRY` key
  - 不动：`module.id = 'recon-id-fix'` / `scenario.category` 字段值 / IPC channel name（preload + DB schema 依赖）
- **N2 — 对账单 ReconID 修复场景下拉空状态统一**（PRD §5.2）：3 档行为简化
  - 档 1（账单类别空）：保持真空白下拉 + disabled
  - 档 2（账单类别非空 + 0 场景）：改为真空白下拉（去掉「请先在场景管理中创建场景」提示文案）
  - 档 3（账单类别非空 + ≥ 1 场景）：去掉「请选择场景」占位项；fix1.2 修订：scenarios 加载完成后**自动选第 1 个枚举值**（撤回 v0.2 `selectedIndex = -1` 设计）

### 修复

- **⚠️ N1 顺手修 usage-stats long-standing bug**（PRD §2.1）：`FUNCTION_REGISTRY` 注册 key `'单据对账ReconID修复'`（多了"单据"两字）与 `trackedIpcHandle` 第 2 参 `'对账单ReconID修复'` 不匹配 → 防御性静默丢弃 → 对账单 ReconID 修复模块从 v2.1.0-beta.1 起统计计数全部丢失。本版改 registry key 为 `'对账单 ReconID 修复'` 全链路一致 + 与 N1 改后的模块名对齐
  - 旧 `.usage-stats.txt` `[单据对账ReconID修复]` section 在 v2.1.5 启动后下次 flush 时不再被写入；事实上历史 section 字段值全为 0，无有效数据丢失，未做 migration

### 内部

- 引擎接入：`c3-gateway-recon-join.js` 新增 `evalCondition` helper + `runC3Scenario` 入口 Step 0；模块导出 `evalCondition`
- dialog 数据流：`createDefaultScenarioConfig('gateway-recon-join')` 加 `conditions: []`；`validateScenarioDraft` + `buildScenarioConfirmDetailHtml` 的 `'gateway-recon-join'` 分支
- fix1.1 — C3 条件 row 列宽固定：CSS 加 `.scenario-config-c3-cond-row` grid 布局（`100px / 240px / 100px / 1fr / 22px`）+ `.scenario-config-c3-cond-field` 240px 固定列；不复用 `.scenario-config-multi-row` flex 避免影响 reconFields / billTypes 行；两套主题 `src/styles.css` + `src/styles-gemini-extra.css` 同步加规则
- fix1.2 — 场景下拉默认选第 1 个：`reloadReconIdFixScenarios` 末尾检测未选 + 自动赋 `state.reconIdFixSelectedScenarioId = scenarios[0].id`；下游 `refreshReconIdFixStatus` 触发；`renderReconIdFixScenarioSelect` 末尾 `selectedIndex = -1` 兜底分支删除
- smoke：`scenario-engines.js` 新增 8 case（C3 conditions 7 op + AND + 0 条件 + 银行虚拟字段，全 31 case）+ `usage-stats.js` 新增 3 case（FUNCTION_REGISTRY key 注册 + 旧 section 不再写入 + 三 fnKey 累加，全 61 case）
- preview：8 张重跑入库（main-page / module-cabinet / module-switcher-open / account-mapping / recon-id-fix-panel + business + gateway / scenario-config-c3）

### 不影响

- 不动 C1 / C2 / C4 dialog（仅 C3）
- 不动 C3 引擎核心 `gwMatchesBank` / assign / `getBankRowValueForC3` 写值逻辑
- 不动 IPC channel `'recon-id-fix:xxx'` / `scenario.category` 字段值（DB 兼容）
- 不动 v1.5.x / v2.0.0 / v3.0.0 等其他分支
- 业务OP数据核对模块名保持原状（用户已撤回该项）

## 2.1.4（2026-05-14）

v2.1.3 之后追加 patch 迭代：主页面工具栏小改 + 新增「小助手功能收纳」弹窗 + 对账单ReconID修复账单类别默认 gateway + 顺手修 v2.1.2/v2.1.3 遗留的 `CURRENT_MODULE_VALID` 枚举漏更新 bug。4 块改动 OPEN ISSUES 7 项 + V1 版本号格式全部拍板。

### 新增

- **小助手功能收纳弹窗**（PRD T3）：主页面右下角 🔄 按钮 → 弹窗双区域（闲置 / 启用）+ ➡️/⬅️ 移动 + 启用区行末 ⋮⋮ 拖拽手柄 + 两阶段提交（Fix1.2 修订）
  - 持久化：SQLite `app_settings.enabled_modules`（JSON 数组）；首次启动 seed 默认 3 个启用模块（网银账单生成 / 银行对账单处理 / 对账单ReconID修复）；点「完成」一次性落库，点「取消」/×/overlay 外部 丢弃所有变更
  - 启用区至少保留 1 个（O3）+ 当前激活模块被移出时自动切到启用区第 1 个（O4）
  - 闲置区始终按**视觉宽度**升序展示（Fix1.5 修订 — 撤回原 v0.1 O1 String.length 排序；CJK 字符算 2，其它算 1，让"月度银行对账单BU回填校验" 24 排在 "月度 Pending 数据核对" 21 之后）
- **左上角模块切换菜单**改为按 enabled_modules 动态渲染（旧版静态 7 个 button → 动态按启用列表生成 + event delegation）

### 变更

- **使用手册按钮换皮**（PRD T1）：文字按钮 → 圆形 emoji 📕（与左侧 🎨 统一），class 由 `text-action background-guide-btn` 改为 `palette-trigger`；点击行为不变
- **对账单ReconID修复账单类别默认 gateway**（PRD T4）：删占位项「请选择账单类别」+ 默认 selected 「网关对账单」+ DB 历史空值启动写回 gateway（O2）；旧用户已选的 business 不强制覆盖
- **USER_GUIDE 版本号 + 模块列表**：顶部 v2.1.1 → v2.1.4（v2.1.2/v2.1.3 写正文时漏更新顶部版本号字段，本次一并修订）+ §一 模块列表补齐第 7 个"业务OP数据核对（v2.1.3 新增）"（v2.1.3 漏同步）+ §一 加 v2.1.4 收纳说明 + §1.5 末追加 + §1.8 新增「主界面工具栏与模块收纳」章节

### 修复

- **⚠️ 关联 bug 修复**：`src/backend/database/settings-repository.js` 的 `CURRENT_MODULE_VALID` 在 v2.1.0-beta.1 写定后只列 5 模块 ID，v2.1.2 / v2.1.3 新增 `bank-bu-recon` / `biz-op-recon` 时只动 renderer 没同步 backend 校验 → 用户切到这两个模块 `setCurrentModule` 抛 Invalid current_module。本次提炼 `ALL_MODULE_IDS` 全集 7 ID，`CURRENT_MODULE_VALID` 与 `setEnabledModules` 校验共用

### 内部

- IPC：`settings:get-enabled-modules` / `settings:set-enabled-modules`（2 plain handler）；`app:get-info` 扩展返回 `enabledModules`
- settings-repository.js：`ALL_MODULE_IDS` + `DEFAULT_ENABLED_MODULES` 常量 + `getEnabledModules` / `setEnabledModules` 函数
- AppDatabase facade：`getEnabledModules` / `setEnabledModules` 方法
- renderer.js：`renderTopModuleSwitcher` 函数 + startup currentModule fallback + state.enabledModules
- renderer-dialogs.js：`createModuleCabinetDialog` 工厂
- CSS：`src/styles-gemini-extra.css` 加 `.module-cabinet-*` 样式块（含 grid 布局 / 选中 / 拖拽视觉反馈）
- preview：新增 `preview:module-cabinet` + `applyModuleCabinetPreviewState` + 加入 `preview:all` 链
- smoke：未拓展（本迭代仅 UI / state 改动，资金/对账算法零变更）

### 未改动

- 既有 7 个模块对账逻辑 / 算法 / smoke case
- v1.5.x / v2.0.0 / v3.0.0 等其他分支

### Fix1 修订（v0.2 — 2026-05-14 用户验收后反馈）

- **弹窗布局**：左右区域内缩对齐标题（28px padding）+ 高度 -32px
- **撤回 O6 "即时落库"**：改两阶段提交（完成 / 取消）；取消还原到打开弹窗前数据
- **➡️/⬅️ 上移**：与第一行 item 顶部平行
- **toggle 选中**：再次点击同一选中行取消选中
- **闲置区排序**：由 String.length 改为视觉宽度（CJK×2 + 其他×1），修正"月度银行对账单BU回填校验" 应排在 "月度 Pending 数据核对" 之后的感知问题
- USER_GUIDE §1.8.2 + §1.8.5 同步更新

---

## 2.1.3（2026-05-13）

v2.1.2 之后追加 patch 迭代：**新增模块「业务OP数据核对」**。每日 T-2/T-1 业务OP + T-1 流水对账单 → 「T-2 期末 + 当日流水 = 计算 T-1 OP」对账规则 → 逐行精准比对（epsilon=1e-2）+ 1:N 精准标差异 + 账户增减检测。OPEN ISSUE 18 项全部拍板（PRD §6.1）。

### 新增

- **新模块「业务OP数据核对」**：每日维度对账模块（第 5 个主模块）
  - 主菜单第 5 个入口 + 模块面板 3 按钮（导入文件 / 开始运行 / 导出差异）+ BU 单选下拉框
  - 「导入文件」→ 业务OP 日期对话框（年±1 / 月 1-12 / 日 1-31 三下拉不联动）→ 文件选择 → 校验通过 INSERT，失败弹错误报告对话框；第 1 日导入完成弹「续导确认」；多日后自动进入流水对账单导入流程
  - 「开始运行」→ 对账日期对话框（仅"三件齐"日期 = T-1/T-2 业务OP + T-1 流水按 BU 过滤齐全）→ 4 步对账算法
  - 「导出差异」→ 两 radio（单日 / 区间）→ 另存为对话框 → 写入用户指定路径
  - 数据库：4 张表（`biz_op_recon_imports/_flow_imports/_runs/_diff_rows`），共主 DB；与 v2.1.2 完全独立
  - **资金红线**：
    - 业务OP 双重校验（#1 拍板 B + #5 整批拒绝）：`发生额 == 入 - 出` AND `期末 == 期初 + 发生额`，epsilon=1e-2；任一不过整批拒绝 + 失败报告 xlsx
    - 流水出入方向枚举（#3 拍板）：仅「入」/「出」，入=+ 出=-；其他视为脏数据 → 整批拒绝
    - 多 OP 行精准标差异（#6 拍板 A）：同账户号 N 条 T-1 行各自独立比（v0.3 fix2.4：差异表无颜色高亮）
    - BU 比较语义（#7 拍板 C）：`normalizeBu = String(v).trim().toLowerCase()`，与 v2.1.2 一致
    - 重新导入清空旧 runs + diff_rows（#15 拍板 A）：避免"旧 runId 套到新数据上"
  - 差异表字段：业务OP 原 23 列 + 4 新增字段（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）
  - **fix1+fix2 UI 微调**（v0.3 — 2026-05-13 手动测试回归）：BU 下拉空白占位切换 + option label 去行计数 + 业务OP/流水日期 dialog 默认值 = 系统日期-1 + 校验失败状态栏文字（去 ErrorReportDialog）+ **差异表无黄底**（#10 拍板回滚为 E）+ BU 行 CSS 宽度对齐
  - **fix4 资金红线 bug 修复**（v0.4 — 2026-05-13）：multi_op_account_count 在 onlyInT1 路径漏算（详见 PRD §3.5.4）；smoke 新增 Case I（I-1/I-2/I-3，15 assertion）防回归
  - **fix5 PRD 拍板修订**（v0.5 — 2026-05-13）：多 OP 账户 N 行全进差异表（不论相等/不相等），原"相等行不进表"规则回滚；`compareT1OpWithComputed` 相等多 OP 分支 push diffRows，meta = 相等/空/是；进表条件扩展为 `比对T-2日 非空 OR 比对测算金额 == 不相等 OR 同账户号多个OP == 是`；smoke 新增 Case J 防回归。便于资金审计逐行追溯。
  - **fix6 PRD #14 拍板回滚**（v0.6 — 2026-05-13）：区间导出由 N sheet 改单 sheet「差异」（所有日期合并）。按 data_date + 账户号排序；**不加新列**，依靠原表 Billdate 区分；`writeDateRangeDiffWorkbook` 重写 + 写 `console.warn` 日志告警 Billdate ≠ data_date（不弹 UI）；smoke 新增 Case K 防回归（sheet 数 > 1 / 表头列 > 27 / 排序失序均失败）。DB schema + session 层 + 单日 writer 均不变。
  - **round 1 self-review 修订**（v0.7 — 2026-05-14，PR #45 提 PR 后 reviewer agent 反馈）：1 critical（C1 资金红线 `clearByDateBu` LOWER+TRIM 与 `getRowsByDateBu` 对齐）+ 3 important（I1 13 个 v2.1.3 新符号升格 `rules/important-variables.md` Critical 2/Important-skeleton 4/Risk-sensitive 7 共 13 条；I2 落库前 BU trim 归一；I3 `computeT1Op` T-2 NaN end_balance 加 console.warn + summary 新增 `t2AnomalyAccountCount` 字段 + DB schema 新增字段 + 状态栏「T-2 异常 W 个」）+ 5 minor（M2 `AMOUNT_EPSILON` 提取到 columns.js 等）+ 3 新 smoke（Case L T-2 NaN 防回归 / Case M C1 大小写防回归 / Case N I2 BU trim 防回归）。known issue：v2.1.2 月度BU 模块 `createBankBuReconFileImportPromptDialog` UX 对齐留 KI-1 给下一 round。
  - **round 2 self-review 修订**（v0.8 — 2026-05-14，round 1 完成后再过 reviewer agent）：0 critical + 3 important（R2-I1 状态栏文案 `t2AnomalyAccountCount` 仅 > 0 显示「T-2 异常 W 个」；R2-I2 PRD §3.5.5 关键不变量补"部分 NaN 容错路径"描述 — 同账户号多行仅全 NaN 才标 anomaly，任一 valid 不退化；R2-I3 smoke Case L↔M swap + 新 Case O I2 BU trim 边界扩展）+ 5 minor（R2-M1 spec §三 IPC 表删假 handler `pick-biz-op-date` / `pick-flow-date`；R2-M2 `computeT1Op` 函数签名 spec ↔ code 对齐为 `(t2OpRows, flowAggMap)` 返回 `{ map, anomalyAccountSet }`；R2-M3 console.warn 文案 spec 跟 code 走；R2-M4 `subOneDay` 双源说明 + 升格 Risk-sensitive；R2-M5 `AMOUNT_EPSILON` spec §5.0 描述位置同步 columns.js）。rules/important-variables.md v2 → v3。
  - **round 3 self-review 修订**（v0.9 — 2026-05-14，round 2 完成后 Codex 自动 review 反馈）：1 P1 ⚠️ 资金红线（流水重导清该 date 所有 BU 的 runs/diff_rows — `runFlowImportAsync` 事务内新增 `clearRunsAndDiffsByDate(db, date)` 调用；按 date 跨所有 BU 清，与业务OP 重导按 (date, BU) 单 BU 清的 `clearRunsAndDiffsByDateBu` 区分语义不可混；smoke Case P 防回归）+ 2 P2（lockfile 同步 2.1.3 顶层 version 字段 / usage-stats 接入 `FUNCTION_REGISTRY` 注册「业务OP数据核对」+ 共 15 个 `bizOpRecon:*` IPC，5 个核心 action 用 `trackedIpcHandle` 包装 + 10 个 query/dialog/helper 保持 plain）+ 1 P3（`package.json:71` `preview:all` script 串入 `preview:biz-op-recon`）。rules/important-variables.md v3 → v4：升格 3 条（`runFlowImportAsync` Critical / `clearRunsAndDiffsByDate` Risk-sensitive / `clearRunsAndDiffsByDateBu` Risk-sensitive）。
  - **round 4 self-review 修订**（v0.10 — 2026-05-14，round 3 完成后 Codex 自动 review 反馈）：1 P1 ⚠️ 资金红线（业务OP 重导清下一日 (date+1, BU) runs/diff_rows — `runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + 新增 `addOneDay(date)` helper UTC 实现避免时区抢跑；业务OP 某日数据双角色：当天 T-1 + 下一日 T-2 输入，漏清下一日 → stale 差异表 = 资金事故；与 round 3 P1 流水跨 BU 清**互补**：业务OP 单 BU 跨 2 日清 / 流水跨 BU 单日清；smoke Case Q 防回归）+ USER_GUIDE 流水汇总性质解释段（用户明确要求："流水对账单业务上就是该日所有部门的流水汇总"，BU-A/BU-B 共用同一份流水文件按 normalizeBu 过滤 — 这是流水重导跨 BU 清的根因；与 round 4 P1 业务OP 跨 2 日清说明合并到 USER_GUIDE §1.7.x 重导规则小节）。rules/important-variables.md v4 → v5：升格 2 条（`runBizOpImportAsync` Critical 与 `runFlowImportAsync` 对齐 / `addOneDay` Risk-sensitive 与 `subOneDay` 对齐）。
  - **round 5 self-review 修订**（v0.10.1 — 2026-05-14，round 4 完成后 Codex 自动 review 反馈）：1 P3 — 5 处归档文档残留旧口径"17 IPC trackedIpcHandle"，全部统一改为"5 tracked + 10 plain = 15 IPC"。无代码改动 / 无 smoke 改动 — 纯文档口径回填。
- **IPC**：新增 15 个 `bizOpRecon:*` handler；preload 暴露 `window.desktopApi.bizOpRecon.*`
- **smoke**：新增 8 用例（A 核心 / B 多 OP / C 账户号差 / D 流水累加 / E 整批拒绝 / F 区间导出 / G BU 隔离 / H 重新导入清空）+ helper/validator 单测，资金红线全覆盖

### 不影响

- v2.1.2 4 个老模块（月度银行对账单BU回填校验 + 对账单ReconID修复 + 银行对账单处理 + 月度 Pending 数据核对）+ 新开账户 + 网银账单生成 主模块**完全保留原状**

## 2.1.2（2026-05-13）

v2.1.1 之后追加 patch 迭代：**C4 dialog 文案变更** + **新增模块「月度银行对账单BU回填校验」**。资金红线（OPEN ISSUE #10 v0.5 → v0.8 重新拍板）：1:1 / 1:N / N:1 视为对账成功；N:M 视为数据异常 → 跳过 + 写入差异表 Sheet 3「异常」（不中断运行）。BU 比较（OPEN ISSUE #5 v0.9）：trim + toLowerCase + 空值归一（容忍 `Flowmore` vs `FlowMore` 大小写差异）。

### 新增

- **新模块「月度银行对账单BU回填校验」**：T-1 月 Pending 数据管理 + 银行对账单导入 → 1:1 / 1:N / N:1 对账成功 → 3-sheet 差异 Excel 导出（Pending / 银行对账单 / 异常）。
  - 主菜单入口 + 模块面板 3 按钮（导入文件 / 开始运行 / 导出差异）
  - 「导入文件」→ 月份对话框 → 文件提示 + 选择 ×2
  - 「开始运行」→ 月份选择对话框（仅 ready 月份）→ 触发对账
  - 「导出差异」→ 选指定月份 / 所有月份汇总 → 另存为对话框 → 写入用户指定路径
  - **资金红线**：1:1/1:N/N:1 视为正常匹配（精准标差异子对：仅标 BU 不等的子对）；N:M（双侧 ≥2）跳过 BU 比较 + 写入第 3 个「异常」sheet（不中断运行）
  - 资金红线对账（v0.8）：Pending.主对账单号 ↔ 银行对账单.ReconciliationId — 1:1 / 1:N / N:1 视为成功；N:M 视为异常（写 Sheet 3，不中断）
  - BU 比较语义（v0.9）：`normalizeBu = String(v).trim().toLowerCase()`（空值 → ''），加大小写归一化（容忍 `Flowmore` vs `FlowMore`）；对账单号匹配 `normalizeKey = String(v).trim()` 仍区分大小写
  - 差异表 sheet：Pending（20 列）+ 银行对账单（44 列）；BU 差异行整行 `FFFFFF00` 黄底
  - **v0.8 已删除**纯文本异常报告（旧 `error-reports/.txt` 设计）；N:M 异常改写入差异表第 3 sheet「异常」（不中断运行）
  - SQLite 主 DB 新增 3 张表（pending_imports / bank_imports / runs）；与 Pending 模块独立 DB 完全隔离
- **10 个 IPC handler**（`bankBuRecon:*`）+ preload API 暴露

### 变更

- **版本号**：2.1.1 → 2.1.2
- **C4 dialog 文案变更**（仅 ReconID 修复 / `isReconIdFixCategory` 分支）：
  - 「账单类型」→「对账字段」（dialog label / 按钮 / 错误消息 / 确认弹窗）
  - 「对账字段」→「对账内容」（同上）
  - 不动：内部变量名 / data 属性 / C1/C2/C3 dialog 同名文案
- **smoke 扩展**：A-E + F-H + I 覆盖导入回归 + 5 normalize 单测 = 36 assert（v0.8 修订；v0.9 BU 大小写归一；PR #43 Codex P1/F3 资金红线 regression）
- **preview 入口**：新增 4 张截图脚本

## 2.1.1（2026-05-12）

v2.1.0-beta.3 之后追加 patch 迭代：**PDF 整体移除**（破坏性变更）+ C4 dialog 文案优化 + **BillDate ±N 可配置** + tooltip + 按钮文案。6 个主 task / 8 个实现 commit / 单 PR 合并（PR #41 累计 17 commit，含 PM + 实现 + PR 草稿 + 用户反馈 fix + PR review round-1/2/3 fix + self-review-final fix）。

### ⚠️ 破坏性变更

- **PDF 导入功能整体移除**：完全卸下 `pdfjs-dist` + `tesseract.js`（含 OCR 训练数据）+ `pdf-worker.js` 子进程 + readers.js PDF 分支 + main.js dialog filter + `SUPPORTED_EXTENSIONS` 删 `.pdf`。安装包减小 ~25 MB。v2.1.0 及之前用户若用 PDF 导入会被破坏。

### 新增

- **C4 引擎 BillDate ±N 可配置**：取代硬编码 ±1day；`scenario.config.billDateRange = { enabled, days }`；不勾选保持现状（零回归）；勾选 + N 替换 Step 2/3.2/3'.2 容错窗口；用于跨日扎单对账场景。
- **C4 dialog "BillDate 日期范围" 区**：勾选框 + 输入框（1-999）+ tooltip ⓘ；独立一行渲染在"匹配模式" 下方。
- **C4 dialog "修复结果输出" / "订单修复ID取值" tooltip**：解释输出方向 + commonId 取值语义。

### 变更

- **C4 dialog 文案精简**（business 子模式）：
  - "匹配规则" → "匹配模式"
  - 3 个勾选框文案 "主边单据 X v Y 从边单据" → "主边 X v Y 从边"
  - gateway 子模式（"网关 X v Y 渠道"）保持不变
- **银行对账单处理 C3 提醒 dialog 按钮文案**：`跳过 C3 直接运行` → `直接运行`（不暴露内部代号）
- **smoke 扩展**：billDateMatches 加 4 个 days 单测；engine + engine-gateway 各加 BillDate ±N 端到端用例 + PR #41 review fix defensive fallback 用例（business **45/45**，gateway **13/13**）
- **preview 重跑**：4 张 C4 dialog 截图

### 移除

- `pdfjs-dist` / `tesseract.js` / `@tesseract.js-data/chi_sim` / `@tesseract.js-data/eng`（4 dep + 17 传递依赖）
- `src/backend/file-service/pdf-worker.js`（整文件）
- `readers.js`：`readPdfRows` / `shouldStopPdfMatchedRows` / `shouldSkipPdfMatchedRow` / `isPdfFile` 参数
- `scripts/smoke/scenarios.js`：`pdfMatchedRows` 用例
- USER_GUIDE.md：line 21 PDF 类型说明

---

## 2.1.0-beta.3（2026-05-11）

v2.1.0-beta.2 之后追加迭代：将"单据对账 ReconID 修复"模块扩展为 **对账单ReconID修复** 通用模块，下挂"单据对账单"（已有）+ "网关对账单"（新增）两个子模式，共用 C4 dialog + 引擎骨架 + IO 层；主面板新增"账单类别"一级筛选下拉。13 个 task / 5 个 commit / 单 PR 合并。

### 新增

- **对账单ReconID修复 — 网关对账单子模式**：新增 `scenario.category = 'gateway-recon-id-fix'`（与已有 `recon-id-fix` 并列）；scenarios.category CHECK 约束扩 5 值（幂等迁移函数 `ensureScenariosCategoryGatewayReconIdFix`）。
- **网关子模式 4 sheet 字段常量**：网关账单 31 列 / 渠道账单 16 列 / 订单修复 14 列（无 SubBizType）/ 对账结果 19 列；preload inline 副本同步。
- **主面板"账单类别"下拉**：枚举 `网关对账单 / 单据对账单`（初始空）；位置 = 原"场景"位置；持久化到 `app_settings.recon_id_fix_bill_category`；切换时级联清空 + 重新过滤场景下拉。
- **主面板行 2 wrapper**：[场景下拉 + 场景管理 + 导出文件] 同行，账单类别空时隐藏；"场景"从行 1 下移至与"导出文件"同行。
- **C4 dialog 双模式化**：函数内部从 draft.category 推导 subMode，9 处 mode-switch（匹配规则勾选框文案 / 字段下拉枚举源 / 标签文案 / 输出选项文本 / commonId-source 下拉枚举 / "网关账单"radio 在 1v多/多v1 时禁用 / SubBizType 取值栏整段不渲染 / locked fieldPair 默认值按 mode 选字段名 / errors + 预览文案）。
- **网关子模式引擎写值规则**：
  - 1v1：双 Type=0 + Reference 按 dialog "订单修复ID取值"选项决定（main=网关.reconciliationId / opp=渠道.reconciliationId / both=按 commonId.source）；
  - **1v多 拆账**：输入 1 笔网关丢弃 + 输出 n 笔（基于 mainRow 数据，Type=1 / Amount=对应渠道.receiveAmount / Reference 按选项）；
  - **多v1**：输出 n 笔（基于对应 mainRow，Type=2 / Amount 保持原值 / Reference 按选项）；
  - 全局约束：每笔渠道账单全局只能被一次消费；
  - 输出列：gateway 14 列（无 SubBizType），business 仍 15 列。
- **IO 双模式化**：reader/writer 按 subMode 选 sheet 名 + 字段常量；文件名前缀切换（业务 `单据对账修复-...` / 网关 `网关对账修复-...`）；session.subMode vs scenario.category 一致性校验。
- **网关引擎 fixture 化单测**：基线 6 用例（1v1×3 / 1v多 拆账 / 多v1 / 全局约束）+ constants sanity；PR #39 review 期间扩至 9 用例（mode='both' suffix 拼接 / source='' 空值 / UI 默认 config）→ 10/10 PASS；注册到 npm run smoke。
- **网关子模式 preview**：4 张新截图（主面板 business/gateway + dialog 默认/1v多 禁用）。

### 变更

- **版本号**：2.1.0-beta.2 → 2.1.0-beta.3。
- **主面板模块下拉项文本**：`单据对账 ReconID 修复` → `对账单ReconID修复`；module.id 保留 `recon-id-fix` 不变。
- **场景管理列表"功能类别"**：单据对账修复 → 单据对账单修复；网关对账修复 → 网关对账单修复。
- **算法层适配 gateway 字段名**：`findAmountLockedPair` 优先按 `locked === true` 识别 + 字段名 fallback；池子算法用 `amountPair.leftField/rightField` 取 cents（不再硬编码 'Amount'）；引擎入口对 gateway 渠道行做 createTime→BillDate 字段映射。
- **C4 dialog commonId 区域增强**：取值来源下拉新增空值 option（空值时 suffix 必填，校验失败弹错误框返回 dialog 保留编辑）；gateway 子模式同样渲染"加上 + 输入框"，Reference = source.reconciliationId + suffix（source='' 时仅 suffix）。
- **renderer-dialogs.js helper 抽取**：`isReconIdFixCategory(category)` / `reconIdFixModeFromCategory(category)`；9 处单一 category 判断统一替换。
- **主面板布局精修**（9 个 fix commit）：账单类别为空时保持 beta.2 完整布局 + 行 2 始终显示；场景管理保持行 1；下拉固定 165px；CSS grid 3 列严格对齐 + statusBox/pending-pair 等宽 292px；label/select 样式同模式（.select-label / .template-select 48px pill）；账单类别空时场景下拉真空白；5 元素整体微调左移；错误框去 "• " 前缀。
- **smoke 新增 2 用例**：mode='both' + suffix 拼接 / source='' 空值 + 仅 suffix（self-review P0 回归保护）。

### 修复（PR #39 review round 1-3 + self-review 收尾）

- **dispatcher C4 集合过滤**（P1）：`filterOutReconIdFix` 用 C4_CATEGORIES 集合（含 `gateway-recon-id-fix`），防 gateway 子模式场景误入银行对账 dispatcher。
- **状态隔离修复**（P2）：`clearResultCacheForCategory` + 删除场景刷新分支用 ReconID 子模式集合识别，防误清/误刷新银行对账模块。
- **新增 IPC `recon-id-fix:clear-session`**（P2）：切换账单类别清 main 端 session/result，防旧 session 回流。
- **UI 默认 config gateway 引擎匹配修复**（P1）：`createDefaultScenarioConfig` + "+ 新增对账分组" + 归一化 ensure 三处按 subMode 决定 `rightField`；新增 migration `migrateGatewayReconIdFixFieldPairs` 修复 DB 旧场景。
- **smoke 回归保护**：gateway smoke 6 用例 → 10 用例（含 mode='both' suffix / source='' 空值 / UI 默认 config 进引擎匹配）；ipc-handlers 20 → 21（clear-session T21）；migrations 15 → 19（H5/H6 migrateGatewayReconIdFixFieldPairs 用例 — 主路径 / 幂等 / 非 gateway 不动 / 防御性 unlocked 不动）；dispatcher smoke 扩展 gateway 剔除。

### 未改动

- C1/C2/C3 dialog 业务逻辑；C3 网关对账 join 模块与本次"网关对账ReconID修复"完全不同的模块（仅字段列名相同）。
- 单据子模式（business）现有 C4 引擎默认路径：输出 byte-for-byte 与 v2.1.0-beta.2 一致。
- BrowserWindow 配置 / module.id `recon-id-fix` / scenarios 表列结构与 UNIQUE 约束（仅扩 CHECK 枚举值）。

## 2.1.0-beta.2（2026-05-11）

v2.1.0-beta.1 用户实测后的 UI 精修 + 场景管理跨模块隔离 + 窗口控制按钮 hit-test 修复迭代。39 项改动 / 4 轮用户测试迭代（PR-A 业务隔离 / PR-B 6 项 UI / Round 2 13 项 / Round 3 v2 8 项），单 PR 合并提交。

### 新增

- **场景管理跨模块隔离**：dialog factory 接收白名单参数 + helper 让 11 处 reopen 链路透传白名单 + 全局状态 `state.activeScenarioListFilter`。
- **类别选择窗按入口过滤**：单类别入口（如 ReconID）跳过类别选择窗，直接进对应配置 dialog。
- **场景管理 dialog 右下"完成"按钮**：关闭 + 刷新主面板下拉。
- **场景管理 dialog 序号 1-based 顺序**：序号 = 列表内顺序，dataset.id 保留真实 id 用于 IPC。
- **单类别入口 compact 模式**：filter.length === 1 时隐藏 优先级 + 是否启动 列。

### 变更

- ReconID 主面板布局重排（行 1 左 [场景下拉 + 场景管理] / 右 [导入文件 + 开始运行]；导出文件按钮平移至场景管理下方；transform translateX 整体右移 + 缩距）。
- 状态框宽度固定 292px，左对齐导入文件 + 右对齐开始运行；初始文本统一 "欢迎使用小助手"。
- 场景下拉宽度收窄至 3/4。
- 4 个 scenario config dialog actions 顺序改 `[确认 取消]` 右下对齐。
- C4 dialog 大量 UI 精修：标题省略类别后缀、label 简化、勾选框单行、按钮文案、grid 对齐、Amount 锁定行视觉对齐、"="居中、场景名称 input 宽度、各类间距与防换行调整。

### 修复

- 全局窗口最小化 / 最大化 / 关闭按钮无响应（hit-test 被拖拽区域罩住，CSS 单 rule 修复）。
- 场景管理跨模块未隔离（v2.1.0-beta.1 遗留 bug）。

### 未改动

- ReconID 业务引擎 / 5 阶段算法 / 7+5 赋值规则。
- C1/C2/C3 dialog 业务逻辑。
- scenarios 表 schema / IPC 通道 / BrowserWindow 配置。

---

## 2.1.0-beta.1（2026-05-11）

新增**第 5 个顶级模块「单据对账 ReconID 修复」**（C4 类场景）。基于 4 sheet xlsx 跑用户配置的对账场景，按 5 阶段算法 + 7+5 条赋值规则修复主从单据，输出「订单修复」与「未匹配单据」双文件。整个迭代分 3 PR 实施。

### 新增

#### 单据对账 ReconID 修复模块

- **「单据对账 ReconID 修复」顶级模块**：第 5 个 module-panel + module-switcher 第 5 项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ 主面板「场景」单选下拉（控制行 1，「导入文件」与「开始运行」之间）+ statusBox 6 状态文案（含 unmatched 档）。模块入口与现有 4 模块完全独立。
- **5 阶段算法（Round 4 subset-sum 重构 + Round 5 Step 2 微调）**：`runC4Scenario(scenario, sheets) → { fixedRows, warnings, unmatchedRows, stats }`。Step 1 同 BillDate + 全部对账字段 AND 全等 1v1 严格；Step 2 BillDate ±1day 容错 1v1（多候选 4 阶 tie-break 选 1 + 双向一致性校验）；Step 3.1/3.2 池子 1v多（subset-sum + 其他对账字段 AND 全等过滤候选 + size ≥ 2 + DFS 全遍历找全局最优 + 4 阶 tie-break：spread → distToMain → size → firstIdx）；Step 3'.1/3'.2 池子 多v1 对称。BillDate 字段名主从 sheet 都叫 `BillDate`；浮点 Amount ×100 整数化避精度坑。
- **7+5 赋值规则**：mode='main'/'opp' 单边修复 R1-R7（R1 主边 1v1 / R2 主边 多v1 Type=2 / R3 从边 1v1 / R4 从边 1v多 / R5/R6 SubBizType 自动查 reconResult / R7 SubBizType 手填覆盖）；mode='both' 主从都修复 RB1-RB5（RB1 1v1 双 Type=0 + 共同 ID / RB2 多v1 主 Type=2 从 Type=0 / RB3 同 RB1 / **RB4 1v多 双 Type=0**（Round 3 修订）/ RB5 复用主从单边 SubBizType 路径）。
- **C4 类场景配置弹窗（5 行布局）**：行 1 场景名 / 行 2 单据匹配规则（3 勾选框：1v1 / 1v多 / 多v1，1v多 与 多v1 互斥）/ 行 3 账单类型（动态行：序号 + 主/从联动字段下拉 + 7 op 下拉 + ❌ + 「+ 新增」）/ 行 4 对账字段（动态行：分组 block + Amount/Amount 锁定 + 组内 AND + 组间 OR + 「+ 新增字段对」/「+ 新增 OR 分组」）/ 行 5 修复结果输出（互斥勾选「主边/从边/主从都修复」+ 主从都修复展开共同 ID 区 + SubBizType 三选一互斥：自动查 / 主边手填 / 从边手填）。
- **未匹配单据告警 report（Round 3 新增）**：算法跑完后未配主从行单独写 unmatched.xlsx（sheet 名「未匹配单据」+ 6 列：场景名 / 单据来源 / OrderId / BillDate / Amount / 未配原因），随主文件一并由 `recon-id-fix:export` IPC 一次返回 `mainFilePath + unmatchedFilePath`。文件名联动主名（`{用户主文件 stem}-未匹配.xlsx`，同目录）。
- **共同 ID 拼接（PR-B Q2=a 决策修订）**：mode='both' 共同 ID = `源端单据.reconId + 输入框文本`（原方案 `src.OrderId + suffix` 改为 `src.reconId + suffix`）；下拉 option 文案"主边/从边单据 ID"改为"主边/从边单据 reconId"。
- **C4 dialog Amount 字段对锁定（Round 3 新增）**：reconGroups 默认带 `Amount/Amount` 锁定 fieldPair 作为第一行，select disabled + 隐藏 ❌ 删除按钮；新增 OR 分组也默认带 Amount 锁定行。Migration `migrateC4ReconGroupsAmountLockedFieldPair` 老库无损升级（3 路径）。
- **4 个 IPC channel**：`recon-id-fix:import` / `recon-id-fix:run` / `recon-id-fix:export` / `recon-id-fix:session-status`，全部走 main 进程内存 session（不持久化）；preload 暴露 `desktopApi.reconIdFix.{import, run, export, sessionStatus}`。
- **资金红线 defense in depth（双层防御）**：第一层 — 4 个 `scenarios:*` IPC 入口主动按 category 分流清缓存（'recon-id-fix' 清 reconIdFixResult；C1/C2/C3 清 processingResult；未知 category 双清 + warn 兜底）；第二层 — `recon-id-fix:export` 入口被动校验 `scenariosSnapshot`（`stableJsonStringify` 递归按 key 排序避免 SQLite round-trip 误判 stale），不一致 → 拒导出 + alert 让用户重新跑场景。`bank-statement:run` / `bank-statement:export` / dispatcher 入口 `filterOutReconIdFix` defense in depth 排除 C4。
- **scenarios 表 CHECK 约束扩 4 值 + reconGroups 数据迁移**：CHECK `category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix')`（migration `ensureScenariosCategoryReconIdFix` 走 RENAME-CREATE-INSERT-DROP-COMMIT 重建表，幂等）+ migration `migrateC4ReconGroupsStructure`（reconFields[] → reconGroups[]，按 leftTypeSeq+rightTypeSeq 聚合 fieldPairs，仅扫 category='recon-id-fix'，幂等三连 smoke 验证）。
- **类别选择 / 场景管理对话框扩展**：`createScenarioCategorySelectDialog` 三选一扩四选一；`createScenariosManagerDialog` 「功能类别」列追加 `'recon-id-fix' → '单据对账修复'`；编辑/查看类别 → dialog 路由追加 `'recon-id-fix' → createScenarioConfigDialogC4`。
- **新增 4 sheet 字段常量**：`src/constants/recon-id-fix-fields.js` — `RECON_RESULT_FIELDS`（18 列）/ `BUSINESS_BILL_FIELDS`（23 列，主边）/ `OPPONENT_BILL_FIELDS`（22 列，从边）/ `ORDER_REPAIR_FIELDS`（15 列，输出）+ 4 sheet 名常量；preload 同步 inline 一份副本（preload sandbox 不允许 require）。
- **fixture 入库**：`samples/单据对账导出不平.xlsx`（真实场景）/ `samples/单据对账导出不平-对平例子.xlsx`（识读规律样本，PR-C 取消后保留备查）。

### 变更

- **版本号 bump**：`2.0.0` → `2.1.0-beta.1`。
- **`scenarios.category` CHECK 约束**：3 值 → 4 值（新增 `'recon-id-fix'`）；`scenarios-repository.js: VALID_CATEGORIES` 3 → 4；`updateScenario` 显式拒绝改 `category` / `is_builtin`。
- **renderer state 扩展**：`state.reconIdFix{Session,Result,Export,SelectedScenarioId,Scenarios}` 5 字段；`MODULES.reconIdFix = 'recon-id-fix'`；`elements` 缓存 6 个新 DOM；`setCurrentModule(moduleId)` 加分支调 `reloadReconIdFixScenarios()`。
- **`current_module` 持久化合法值追加**：`settings-repository.js: CURRENT_MODULE_VALID` 数组追加 `'recon-id-fix'`，切到第 5 模块后重启可保留模块选择。
- **`scenario-dispatcher.js`**：dispatcher 入口加 `filterOutReconIdFix` 过滤（C4 不走 first-match-wins 调度）+ 返回 stats 加 `skippedC4Count`（资金红线 defense in depth）。
- **使用统计**：`src/backend/usage-stats.js: FUNCTION_REGISTRY` 加 C4 模块（IPC + 按钮埋点）。
- **测试脚本新增 6 件套（108 用例）**：`migrations-recon-id-fix`（15 / 含 reconGroups 迁移 G1-G5 + Amount 锁定 H1-H3）/ `recon-id-fix-engine`（43 / 含 subset-sum helpers + 多解 tie-break + 浮点精度 + 大候选集性能 + 多v1 对称 + Round 5 Step 2 微调 6 用例）/ `recon-id-fix-io`（13 / 含 round-trip + writeUnmatchedReport + buildUnmatchedReportFileName 联动签名）/ `recon-id-fix-ipc-handlers`（20 / 含 P3-A 默认名 + P3-B 联动 + P3-C 同语义同 snapshot + 资金红线 stale-snapshot T12/T13）/ `recon-id-fix-end-to-end`（6 / 5 阶段端到端 mode=main/opp/both + 基金 fixture 全量回归）/ `recon-id-fix-scenario-ipc`（11 / scenarios:* 4 IPC 按 category 分流清缓存）。

### v2.1.0-beta.1 系列 PR 汇总

- **PR-A 骨架**（PR #35，merged 2026-04-30，commit `6e5ebaf`）：模块入口 + 场景 CRUD + DB schema 扩展 + C4 dialog 骨架 + 类别选择四选一 + 资金红线分流 + 18 用例 smoke。9 task / 35 改动文件。
- **PR-B 对账引擎**（PR #36，merged 2026-05-09，commit `844d1d5`）：4 sheet IO + 5 阶段算法 + subset-sum 池子 + 7+5 规则 + 4 IPC + unmatched 双文件 + scenariosSnapshot defense in depth + reconGroups Q1=B 决策回写 + Amount 锁定 Round 3 + Round 4 subset-sum 重写 + Round 5 Step 2 多候选 tie-break。16 task / 28 改动文件 / 7 轮 review。
- **PR-D 收尾**（本 PR）：版本号 bump + 文档三件套 + 整体 smoke / preview / check-vars / scan-vars 回归。5 task。
- ~~**PR-C 识读规律**~~（已取消，2026-05-09）：用户决策不再实施识读规律自动填表功能；§三 D7 / §六 F3 / §七.1 / §七.4 / §十.2 等章节标 DEPRECATED 保留历史决策痕迹。

### 明确不做

- 不预置 builtin C4 场景（区别于 v2.0.0-beta.3 的 3 个 builtin）；
- 不复用 `scenario-dispatcher.js` 调度（本模块单场景独占跑，无 first-match-wins）；
- 不接入大模型；识读规律功能整体取消；
- 主输出无标黄需求（区别于 v2.0.0-beta.3 银行对账单处理），用 `xlsx-js-style` 写出（不引入 exceljs writer）；
- 浮点精度处理：Amount ×100 整数化做 subset-sum，不依赖二进制浮点；
- BillDate 字段名固定为 `BillDate`（主从 sheet 都叫这个）。

---

## 2.0.0（GA 2026-04-30）

### 新增

- **错误报告加「可能原因」列**：3 个模块（生成网银账单 / 月度 Pending / 银行对账单处理）的 error-report 文件统一加「可能原因」字段，口语化文案（如 `多个字段抓到的对账ID不一致，无法判断该用哪个` / `一对多匹配，可能有重复数据`）。统一映射表覆盖 22+ 已知 code，未知 code fallback。
- **隐藏 `.usage-stats.txt`**：`~/Documents/网银账单生成小助手/.usage-stats.txt` 记录软件使用统计（打开次数 + 各模块各功能使用次数 + 总计），dot prefix 隐藏，关闭 + 每 5 分钟混合写盘。

### 变更

- **版本号**：`2.0.0-beta.3` → `2.0.0` GA 正式版。
- **所有导出表头字号统一 10pt**：4 处 writer 同步；`pending-session.js` 从 `xlsx`（CE 不支持 styles 写出）切到 `xlsx-js-style`。
- **使用手册另存为简化**：仅 `.html` + `.txt` 两种格式，默认 HTML。

### v2.0.0 系列收官说明

本版本为 v2.0.0 GA 正式版，包含 v2.0.0-beta.1 / beta.2 / beta.3 / beta.4 全部已交付功能。详见各 beta 版本段落（下文）。

---

## 2.0.0-beta.3

### 新增

- **「银行对账单处理」顶级模块**：第 4 个 module-panel + 切换器项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ statusBox 5 状态文案动态展示；模块入口与 v1.x 主面板、Pending 模块完全独立。
- **3 类场景调度器（C1/C2/C3 + first-match-wins）**：`runAllScenarios(bankRows, gwRows, scenarios)` 全局行锁；按 `priority desc, id asc` 排序；返回 stats `{ totalRows, hitRowCount, scenarioHitCount, hitScenarioIds, warningCount, skippedC3Count }`。
- **C1 场景（提取ReconId-From Self）**：根据特征/其他字段提取 `ReconciliationId`；多字段值不一致 → error-report，不写入。
- **C2 场景（账单打标）**：双类型行配对（一一对应 CustomerRef + Credit==Debit）；一对多 / 多对一 → error-report；rightType 行字段被打标。
- **C3 场景（提取ReconId-From 网关）**：与「资金对账不平结果表」按 4 字段 AND 匹配（含发生额绝对值虚拟字段）；多匹配取首条 + warn；未导入 gw 文件时整类被过滤 + `skippedC3Count` 提示。
- **3 个内置场景**：默认存在，可编辑、可禁用、可删除；不提供"恢复出厂"（C1/C2 默认启用，C3 默认禁用）。
- **场景管理表（6 列 CRUD + toggle）**：`序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动`；toggle 实时写库；序号取最小未用 ID（gap-filling）。
- **4 个场景配置弹窗**：`createScenarioConfigDialogC1 / C2 / C3 / createScenarioConfirmDetailDialog`（创建/编辑/查看三模式共用）；通过 renderer-side `state.scenarioDraft` 跨弹窗共享状态。
- **xlsx 标黄输出（exceljs）**：命中场景的行入主输出，被修改单元格黄底（FFFFFF00 ARGB）；非修改行不导出；error-report 独立 xlsx 产物。
- **导出文件支持另存为**：原生 saveDialog 选保存路径；文件命名 `银行对账单-YYYYMMDDHHmm-处理结果.xlsx`（统一格式）。
- **5 个 IPC channel**：`bank-statement:import / gateway-recon:import / bank-statement:run / bank-statement:export / bank-statement:session-status`；session 仅 main 进程内存。
- **`scenarios` 表 + 6 IPC channel**：CRUD + toggle-enabled；migrations 包含 builtin seed + 名称同步迁移 `ensureBuiltinScenarioNamesUpdate`。
- **资金对账文件提示时机**：导入银行对账单成功后，若启用了 C3 类场景且未导入 gw 文件 → 立即弹 confirmDialog（"导入文件 / 稍后再说"）。
- **状态框换行展示（white-space: pre-line）**：导入双文件 / 已导出含 error-report 时分行；命中场景以序号显示在 `（场景 1、3）`。

### 变更

- **版本号 bump**：`2.0.0-beta.2` → `2.0.0-beta.3`。
- **运行 / 导出成功 alert 移除**：内容直接写入状态框；failed / cancelled 仍走 alert。
- **状态框 5 状态优先级**：已导出 > 已处理 > 已导入双文件 > 已导入单文件 > 初始。
- **导出默认目录改用户另存为**：原 `Documents/网银账单生成小助手/bank-statement-process/{date}/` 自动落盘 → 改 saveDialog 让用户选；error-report 仍走默认目录。

### 移除

- **覆盖原 ID warning**：C1 `overwrite-existing-recon-id` + C3 `overwrite-existing-value` 不再产生 error-report 记录。⚠️ 资金红线提醒：原值非空被覆盖时无 warning 痕迹，需依赖 modifications 列表追踪。

---

## 2.0.0-beta.2

### 新增

- **页面风格切换（Clear / General 二选一）**：调色板顶部新增「切换页面风格」下拉 + 「应用」按钮，二次确认后即时切换（不 reload）。Clear = v2.0.0 全新主线（来自 Claude Design 38 份 HTML 设计稿）；General = v2.0.0-beta.1 之前的旧风格（向下兼容）。猫猫 GIF 跨风格保留（D8）。
- **SQLite `app_settings.ui_style` 字段（数据底座）**：存储 UI 风格（`'Clear'` | `'General'`），默认 `'Clear'`；首次启动若不存在则自动写入（D4 升级迁移）。
- **风格切换 IPC + preload API**：`settings:get-ui-style` / `settings:set-ui-style`；renderer 通过 `desktopApi.settings.{getUiStyle, setUiStyle}` 调用；`app:get-info` 返回体扩 `uiStyle` 字段。
- **风格-背景色联动（D16）**：Clear 默认背景 `#ffffff`，General 默认 `#efe8da`；切风格时仅当当前色是"另一风格默认色"（魔法值）时自动同步，不覆盖用户自定义颜色。
- **preview 脚本支持双风格**：`APP_PREVIEW_STYLE=clear|general npm run preview:all` 输出到 `docs/previews/<name>.png` 或 `docs/previews/_general/<name>.png` 两套截图（35×2 张）。

### 变更

- **版本号 bump**：`2.0.0-beta.1` → `2.0.0-beta.2`。
- **HTML 结构对齐 Clear**：`index.html` 基线整体重写（DOM 对照 `Clear/main.html` + `Clear/pending.html` 重组）；同时保留所有现有控件 ID 与 JS handler 不变。
- **dialog factory 双套适配**：alert / confirm / export-scope / remember-order-mismatch / 大账号管理 / 模板管理 / 拆分合并账单 / 账户映射 / 大账号选择 / 顺序提取 / Pending 系列对话框 / 调色板等全套 dialog 在 Clear 风格下视觉重写；General 风格通过条件渲染节点退化（5 类：`.gemini-gradient` / `.status-spark` / `.module-switcher-icon` SVG / `.select-shell` / `.alert-body+icon`）保持原视觉。
- **状态框 SVG-spark 装饰保留**：`updateStatusBox` / `setStatus` / `setNewAccountStatus` / `setPendingStatus` 改为写 `.status-box-text` 子节点（避免 textContent 整体覆盖清掉 spark）。
- **执行操作列 4 个 dialog**：Clear 风格表格列宽固定（`table-layout: fixed`）消除编辑/view 切换时的列位移；按钮组左对齐 + 第一个按钮 `padding-left: 0`，"修改"按钮左缘对齐"执行操作"列头。
- **Clear 风格右下角 Version 字体**：等宽（Courier New）。

### 移除

- 死代码 `legacyCreateBigAccountManagerDialog` + `legacyCreateTemplateManagerDialog`（共 -444 行）。其余 17 个 legacy 函数因运行时间接依赖暂保留。

---

## 2.0.0-beta.1

### 新增

- **顶部模块切换按钮改下拉（3 选 1）**：原二选切换器追加第 3 项 `月度 Pending 数据核对`。首次启动默认 `网银账单生成`，切模式不持久化（关闭重开仍回首项）。三个模块容器互不影响，切换时仅 hide/show。
- **全新顶级模块「月度 Pending 数据核对」**：独立业务链路 `导入 → 入库 → 规则化对账 → 差异落库 → 导出 xlsx`，覆盖财务/运营每月比对 Pending 数据的核心痛点。布局两行：第一行 `规则管理 / 导入文件 / 开始运行`；第二行 `导出差异 + 状态框`。对现有两个模块零侵入。
- **独立 SQLite 数据库 `tool-data-pending.sqlite`**：与主 DB 隔离；5 表幂等 schema（`rule` 单行全局 / `pending_months` / `pending_rows` 31 列中文原名 + row_hash / `diff_runs` / `diff_rows`）+ 5 索引。删除该文件即可完全清空 Pending 模块数据，主 DB 不受影响。
- **Pending 模板 31 列固定表头**（打包内置 `assets/Pending.xlsx`）：启动时读一次缓存整个会话期间复用。关键列 `pending资金类型` 允许任意文本（含空值）；导出差异按**实际出现值**动态分 sheet。
- **规则管理（单条全局）**：两组多选下拉——`对账字段`（JOIN key，至少选 1 项）+ `对账内容`（比对字段，可空）。全部选项来自 31 列表头。保存走"完成 → 二次确认 → upsert"覆盖当前规则；每次运算 JSON 快照随差异 record 存档做历史回溯。
- **多文件合并导入**：一次可选 N 个 xlsx 归为同一月份。child process 解析（带 `--max-old-space-size=8192`），主进程 `webContents.send` 转发 progress 事件到状态栏实时显示"正在导入 {YYYY-MM}：{file}（已处理 N 行）"。
- **严格校验链**：表头顺序 + 内容严格一致（任一不一致整批拒绝）→ 全月行级 hash 去重（SHA-1 + SOH 分隔符）。行级冲突整批 rollback，状态栏提示"导入失败，发现 N 条重复行，点击导出报错文件"；点击导出 xlsx 错误报告（schema = source_file / sheet_row / severity / message + 31 原列）。
- **覆盖前自动留底 xlsx**：同月重复导入 → 弹"{year}-{month} 已有 N 行"确认；确认覆盖前先把旧月全行写 `Documents/网银账单生成小助手/pending-archives/{YYYY-MM}/{YYYY-MM}-backup-{YYYYMMDDThhmmss}.xlsx`。写入阶段 `BEGIN → deleteMonth → 批量 INSERT → COMMIT`，失败 `ROLLBACK`。
- **开始运行（对账引擎）**：选两月 → 二次确认 → 相邻校验（跨年 `2025-12 ↔ 2026-01` 算相邻；不相邻弹 alert 并保留已选）→ benchmark 外推预计时间（固定采样 10000 行，精度 ±20%）→ 三段 SQL 产出 `new / missing / changed`。全部 SQL 用 `IS / IS NOT` 处理 NULL 友好；`changed` 按值严格相等（字符串 `===`，OT-8 不做 hash），由规则设计者保证上游数据清洗一致。
- **状态栏完成文案**：无差异 `对账完成：{下月} vs {上上月} 无差异。`；有差异 `对账完成：{下月} vs {上上月} 找出 N 条差异（X 新增 / Y 消失 / Z 变更），可点击"导出差异"另存。`。对账中 + 导入成功态挂 `data-tone="success"`；报错态挂 `data-tone="error"` + `.is-clickable`（视觉红框 + 鼠标手势反馈）。
- **导出差异 xlsx（单月选 run / 汇总取最新）**：
  - 单月：Sheet1 `汇总`（31 原列 + `diff_type` + compareFields 动态展开的 `{col}_before` / `{col}_after`）+ Sheet2~N 按 `pending资金类型` 实际出现值动态分 sheet。`changed` 行 31 列用下月 / `_before`=上上月、`_after`=下月；`new` 行 31 列用下月，`_before` / `_after` 空；`missing` 行 31 列用上上月，`_before` / `_after` 空。
  - 汇总：每 `(upper, lower)` 对取最新 run；Sheet1 `按月维度区别汇总`（最老 → 最新，空行 + 月份 label 隔开）+ Sheet2 `汇总`（扁平）。compareFields 取所有 run 的并集展开为列。
  - 第 1 行表头字体 `Courier New`（延续 v1.5.3 约定），数据区字体不变；sheet 名走 `sanitizeSheetName` 防非法字符。

### 变更

- **资金敏感修复：diff_runs 排序 tie-breaker**：`ORDER BY created_at DESC` 末尾加 `, id DESC`（AUTOINCREMENT 单调）。原因：`Date.toISOString()` 毫秒精度在同毫秒多次 run 时无法保证稳定排序 → 用户"导出最新 run"可能误取旧 run。修复后 reconcile 测试连跑 5 次 23/23 全绿。
- **renderer state 扩展**：`state.pending` 统一管理 `rule / months / latestRunResult / latestRunId / importing / importingText / currentYearMonth / running / runningText / errorReportAvailable / errorMessage / lastImportSummary`。状态栏文案按 UI 态分支映射。
- **新增 15 个 IPC + preload 暴露 `window.desktopApi.pending`**：`columns / rule:{get,save} / months:list / import:{pick-files,start,progress} / error:export-report / reconcile:{benchmark,run} / diff:{runs-list,runs-for-month-pair,latest-run-for,export-single,export-aggregate}`。
- **测试脚本新增 4 件套**（85 断言）：`test:v2.0.0:pending-import`（21 / 7 场景）/ `pending-session`（19 / 5）/ `pending-reconcile`（23 / 7，含手工 4×4 资金敏感样本）/ `pending-export`（22 / 2）。
- **版本号 bump**：`1.5.3` → `2.0.0-beta.1`。

### 明确不做

- 不支持 CSV / PDF 导入（仅 xlsx）；
- 不支持单月差异总条数超过 1,048,576 行（XLSX 单 sheet 上限）；
- 不提供规则"多条具名库"（单条全局；历史 run 保存 JSON 快照做回溯）；
- 不自动运行（必须手动点"开始运行"）；
- 不支持非相邻月份对账；
- 不修改现有"网银账单生成"和"新开账户余额账单生成"两个模块的业务逻辑。

## 1.5.3

### 新增

- **主页面「模板」下拉改为「模式」**：label 文本由「模板」改为「模式」，下拉值域收窄为两条——`制作网银账单`（默认选中，内部隐式使用 v1.5.2 的 `__FILENAME_MAPPING__`）和 `导出月度余额账单`（R1 新增）。真实模板与虚拟 ID 不再出现在主页面下拉，仅在「导出月度余额账单」模式的弹窗内出现。`制作网银账单` 模式下所有 v1.5.2 行为保留不变。
- **导出月度余额账单模式（R1）**：新增独立导出入口，点击「导出余额」弹出「请选择需要导出月度余额账单的银行渠道」对话框（模板下拉默认选中 `全部银行渠道`，另含全部普通模板；年份范围 = 近 10 年 ~ 今年+1；月份必须主动选）。完成后装配月度余额 records → 写入临时 xlsx → 再由系统保存对话框另存。文件命名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`，单文件单 sheet 合并所有模板/大账号/币种；表头固定取自 `assets/余额账单模版.xlsx`，模板未提供的字段空字符串补位。
- **Q2 最新余额定义**：优先取 `billDate === 月末最后一日` 的 seed；无则按 `billDate ≤ 月末最后一日` 取最大的一条（兜底）；全部 seeds `billDate > 月末` 或完全无 seed 则跳过该大账号（不报错）。多币种大账号按币种拆多行。
- **按钮可用/禁用矩阵**：`导出月度余额账单` 模式下 `导入文件 / 导出明细 / 账户映射` 置灰禁用；`导入模板 / 模板管理 / 导出余额` 可用。E1/E2/E3 校验（模板空 / 时间空 / 两者都空）通过 `createAlertDialog` 弹框，确认后重开弹窗保留已填值；E4 所选范围无余额记录时弹「所选模板在 {年}年{月}月的月末及更早均无余额记录，无法生成月度余额账单」。
- **自有账号合并入大账号表（R2）**：`template_big_accounts` 表新增列 `account_nature TEXT NOT NULL DEFAULT 'client'`（取值 `'client' | 'own'`）。导入银行账号信息 Excel 后，客资 + 自有都进入「维护大账号」对话框 tbody（UI 不加颜色/标识区分；view 态下 own 行 merchantView 前加 `[自有] ` 前缀，input 值保持裸 merchantId）。
- **§3.1 自有账户隔离规则（跨需求一致性约束）**：自有账户**仅在 R1「导出月度余额账单」场景参与**，其它所有场景（大账号排序、大账号选择弹框、明细账单生成、大账号检测、字段固定分配、余额管理、账户映射等）一律过滤。实现：SQL 层软过滤（`getTemplateBigAccounts` 默认只返客资；R1 装配链路显式传 `{ includeOwn: true }`）+ 维护大账号对话框初始化改走独立 IPC `big-account:get-with-own` 拿含自有的完整列表。
- **历史 own-accounts/*.json 启动迁移（D15/D16）**：启动时执行一次性幂等迁移，按 bankName 匹配模板展平 `{merchantId, currency}` 写入 `template_big_accounts`（nature='own'），冲突保留已有记录并写 `[CONFLICT]` 日志。迁移幂等 flag = `app_settings.own_accounts_migration_v1_5_3_done='1'`。迁移日志独立写 `{storageRoot}/own-accounts-migration-v1.5.3.log`。原 `own-accounts/*.json` 文件**保留不删除**，作为回退兼容。迁移失败不阻塞启动（D15），状态栏以 error tone 显示告警；orphan bankName 跳过不告警（D16）。
- **导出 xlsx 表头字体统一为 Courier New（R3）**：明细（COMMON）、余额（BALANCE）、月度余额、多模板合并文件、新开账户模块导出的 xlsx **第 1 行表头**字体统一改为 Courier New（字号/颜色/粗体/合并单元格属性保持原样）。数据区字体不变；**无 CJK 回退链**（Q10 决策，CJK 渲染依赖系统字体替换，风险由用户承担）。新依赖 `xlsx-js-style@^1.2.0`，仅在 `writers.js` 局部 `require`（其它文件仍用 `xlsx`）以减少打包体积增长；合并场景需在 `mergeGeneratedXlsxFiles` 内部局部 shadow 为 `xlsx-js-style` 并补一次字体注入，否则合并产物 styles.xml 会被 xlsx 社区版 writer 重建为 Calibri。报错 xlsx / error-reports 字体不改。
- **账单拆分合并浮点精度修复（R4/D17 hotfix）**：`buildMappedRows` 合并分支 `net = sumCredit - sumDebit` 结果套 `roundAmount(...)` 强制 2 位小数 round，吃掉 IEEE 754 浮点噪声。`2377.49 + 178.31 = 2555.80`、`65572.01 + 4917.90 = 70489.91`、`(0.1 + 0.2) - 0.3 = 0`（静默跳过合并组）等场景现在稳定输出精确值。初稿方案 `roundAmountHighPrecision`（12 位）对样本 2 不收敛，改用 `roundAmount`（2 位）覆盖全部样本。

### 变更

- **主页面 state 新增 `mode` / `monthlyBalanceReady` / `monthlyBalancePreview`**；`selectedTemplateId` 默认值改为 `FILENAME_MAPPING_TEMPLATE_ID`。`updateTemplateSelect` 重写为只同步下拉 value ↔ `state.mode`；option 改为静态 HTML（不再遍历 `state.templates` 构造）。
- **`handleExportBalance` 按 `state.mode` 三路分流**：月度余额模式未装配 → 弹月度余额导出对话框；已装配 → 调系统保存对话框另存；制作网银账单模式 → 保留 v1.5.2 原链路。切模式时清前端 `monthlyBalanceReady / preview`，后端 `lastGeneratedExports.monthlyBalance` session 保留。
- **新增 IPC**：`monthly-balance:assemble` / `monthly-balance:export` / `big-account:get-with-own`。`preload.js` 新增 `window.desktopApi.monthlyBalance = { assemble, export }` 和 `window.desktopApi.bigAccount.getWithOwn`。
- **Bundle v3 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `v3` 不升 v4。bundle 导出项 `bigAccounts[].accountNature` 字段可选携带（v1.5.2 读时忽略向后兼容；新版读旧 bundle 时缺省 `'client'`）。`groupBigAccountRows` 分组 key 扩展为 `merchantId::accountNature`，防止 client + own 同 merchantId 被错误合并。
- **`saveMappings` 透传 `accountNature`**：白名单校验 `'client' | 'own'`，非法/缺省默认 `'client'`；`expandBigAccountConfigurations` / `validateTemplateConfiguration` / `buildCompatibleBigAccounts` 同样保留字段。
- **SQL 过滤一致性（§3.1 落地）**：`listTemplates / getTemplate / listChildTemplates` 的 `bigAccountCount` 子查询加 `AND ba.account_nature = 'client'`；维护大账号对话框 `bigAccountCount` 不含自有，但 tbody 初始化另走 `big-account:get-with-own` 拿全量。
- **新开账户模块导出表头字体变为 Courier New**（D14 决策接受的副作用）：`new-account:generate` 共用 `writeBalanceWorkbook`，字体注入自动生效。

### 废弃保留

- `src/backend/own-account-store.js` + `big-account:save-own-accounts` IPC + `preload.js:bigAccount.saveOwnAccounts`：前端不再单独依赖，但过渡期**并行写**（json + 数据库同时写）以兼容旧代码路径（Q6）。原 `own-accounts/*.json` 文件保留不删除，作为 v1.5.2 回退兼容 fallback。

## 1.5.2

### 新增

- **按表头自动识别模板**：主页面「模板」下拉顶部新增虚拟枚举值「按文件名映射模板」并设为**默认**选中。导入时系统遍历所有模板，用 `matchesTemplateHeaders(filePath, template)` 逐个试表头自动匹配——用户无需在映射管理中配置任何字段（原映射管理对话框中的「按文件名映射模板」输入框模块**已删除**）。0 命中报 `FILENAME_MAPPING_NO_MATCH`、≥2 命中报 `FILENAME_MAPPING_AMBIGUOUS`，均**整批截断本次导入**；唯一命中直接按该模板解析（不再有 HEADER_MISMATCH 报错）。`filenameFixedField` 数据层保留不动（DB 列、Repo/IPC/Bundle 透传均在，只是 UI 删除，未来可能重新启用）。
- **表头唯一性校验**：导入模板文件时新表头与已有模板全量比较，完全相同则拒绝（`TEMPLATE_HEADERS_DUPLICATE`）；Bundle 导入时每个 entry 校验，重复则跳过并写 activity log 警告。确保按表头自动识别不会命中多个完全相同的模板。
- **多模板合并导出**：多个文件匹配到不同模板时，每组按各自模板独立生成（银行名称 / 所在地各自正确），合并为汇总文件：`{模板数量}-COMMON-{日期范围}.xlsx` / `{模板数量}-BALANCE-{日期范围}.xlsx`。合并方式为直接复制单元格保留格式，session 只 append 一次。
- **大账号确认页「单个账号匹多个文件」（M:1 映射）**：「提取大账号顺序」按钮右侧新增「单个账号匹多个文件」勾选框（**默认不勾选**）+ 编辑和完成**合并为 1 个 toggle 按钮**。勾选时不发生文本平移（visibility 占位），编辑态勾选 block 位置不变。完成后排序：uncovered 在前保持原序，covered 在后按组 a→z 排（组内按原文件顺序）。编辑还原：点编辑恢复原排序，保留已有映射供修改（不清空 multiGroups）。已映射 block 不参与「提取大账号顺序」，确认弹窗不显示已映射 block。左侧文件名左边新增字母列。勾选粒度 = **block**：同一文件的多个 block 可独立归属不同组或不归属任何组；支持"先左后右"与"先右后左"两种操作顺序。对话框主「完成」按 block 粒度把 `multiGroups` 展开为多条 `assignments`（key = `rowIndex`，同组多条 rowIndex 共享 MerchantId + Currency），与 1:1 部分合并后发送给后端。
- **主 / 子模板名校验**：映射关系管理「完成」按钮前置执行"子名.includes(主名)"字符串校验；勾选「设为子模板」+ 选中主模板时若当前模板名不包含主模板名，弹出提醒框「子模板与主模板模板名匹配不上，请检查。」，**整个 save 流程被阻断**，用户确认后重新打开对话框。未勾「设为子模板」或未选主模板时不触发校验。

### 变更

- **模板数据结构**：`templates` 表新增 `filename_fixed_field TEXT NOT NULL DEFAULT ''` 列（数据层保留，UI 已删除输入框）；`listTemplates` / `getTemplate` / `listChildTemplates` / `listTemplateBundleEntries` 的 SELECT 追加 `t.filename_fixed_field AS filenameFixedField`；新增 `saveTemplateFilenameFixedField(db, templateId, value)` 仓储方法。
- **Bundle v4 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `4` **不升 v5**。`filenameFixedField` 作为 v4 schema 下的透明扩展字段由 bundle 自动携带；旧 v4 bundle 导入时回退为空串；`bundleVersion > 4` 仍然拒绝。Bundle 导入时新增表头唯一性校验，重复 entry 跳过 + 日志警告。
- **大账号确认页 row 结构扩展**：`buildBigAccountSelectionRows` 每 row 追加 `fileIndex` 字段；前端新增状态机 `multiMode / multiEditing / multiGroups / pendingGroup`。
- **大账号确认页 UI**："导出当前文件"更名为"导出**当前批次文件**"；"导出所有"更名为"导出**所有批次文件**"。
- **固定模式与 M:1 互斥**：`rememberCheckbox` 与 `ba-multi-mode-checkbox` 双向 `disabled` 互斥；mode 切换时清空 `multiGroups / pendingGroup`。
- 新增 IPC `template:save-filename-fixed-field`；`preload.js` `templates` 对象追加 `saveFilenameFixedField`。
- **虚拟 ID 短路 helper**：`main.js` 与 `renderer.js` 各自定义 `isFilenameMappingMode(templateId)` helper，避免虚拟 ID 流入真实 DB 查询。

### 移除

- 映射关系管理对话框中的「按文件名映射模板」输入框模块（配置 filenameFixedField 的 UI 已删除，数据层保留）

## 1.5.1

### 新增

- **主/子模板**：模板可声明为「主模板」或「子模板」。映射关系管理 dialog header 新增「设为主模板」「设为子模板」checkbox，互斥逻辑；选「设为子模板」时出现主模板下拉框。模板管理页面新增「模板管理」标题；主模板行带 ▶/▼ 展开折叠按钮，子模板缩进显示。
- 主页面模板下拉框自动过滤子模板（只显示主模板）；文件导入时按 headers 精确匹配候选模板，在大账号选定后重建 rows。
- **账户映射按模板隔离**：`account_mappings` 表重建，以 `(template_id, bank_account_id)` 为联合唯一键；同一银行账号在不同模板下可配置不同映射。首次打开账户映射会检测迁移 flag 并弹「迁移分配对话框」引导用户将旧数据分配到具体模板。
- **账户映射 UI 调整**：表头文案「网银大账号ID」→「网银账单账户号」、「清结算系统大账号ID」→「清结算系统银行账号」；执行操作列编辑/完成切换交互，按钮左对齐；币种 ⓘ tooltip 展示说明文本；提取大账号顺序时如检测到桥接匹配 + 多币种会弹提醒框。
- **Bundle v4**：模板包导出/导入支持主/子模板关系（`parentTemplateKey`）和账户映射（`accountMappings`）。`SUPPORTED_BUNDLE_VERSION = 4`。导入时三阶段还原（模板 → 父子关系 → 账户映射）。
- **重复判定增强**：文件导入按「路径 > 文件名 > 内容（SHA-256 哈希）」三维度判重，提示框显示重复原因。

### 变更

- 移除账户映射弹框的 `noCurrency` checkbox，改为根据币种输入框值自动判断。
- 重复判定对话框改为两按钮（覆盖旧记录 / 取消本次导入），移除「保留两份」选项。
- 账户映射缺失不再阻断导入。
- Bundle v3 向下兼容（缺失字段默认空值）；`bundleVersion > 4` 的 bundle 仍然拒绝。
- `template:get-mappings` / `listAccountMappings` / `saveAccountMappings` / `listTemplates` / `listTemplateBundleEntries` 等 DB 层方法签名扩展 `templateId` / `isParent` / `parentTemplateId` 等参数。

### 移除

- 账户映射弹框的 `noCurrency` checkbox。

## 1.5.0

### 新增

- **发生额精度提升到小数点后 12 位**：`Credit Amount` / `Debit Amount` / 发生额 / 余额均支持最多 12 位小数，原始值有几位就保留几位，不补零。Excel 导出默认数字格式；有效数字超过 15 位时自动切换为文本格式保持精度。
- **「提取大账号顺序」功能**：网银账单解析大账号确认页左下角新增按钮，自动从文件识别账户号并在「确认大账号顺序」弹出页展示，支持双输入框编辑 + 精准匹配校验。「完成」按钮按条件覆盖右侧大账号顺序表。
- **「记住顺序」持久化增强**：固定模式下勾选「记住顺序」会持久化「文件个数 + 各文件账户数与账户号 + 排序」。下次导入按文件个数和账户匹配自动回显；文件数不匹配时切回「账号顺序不固定」模式；账户信息匹配不上时弹提醒框供用户选择「变更配置」或「确认」。
- **英文日期格式解析**：支持 `DD Mon YYYY`（`09 Apr 2026`）、`Month DD YYYY`（`April 9, 2026`）、以及「逗号 + 时间 + AM/PM」形式（`09 Apr 2026, 06:26:26 PM`）。
- **导入模板包同名覆盖确认**：`template:import-bundle` 在循环前扫描同名模板，用 Electron 原生 `dialog.showMessageBox` 弹确认框，避免静默覆盖。
- **使用手册导出格式扩展**：支持 `txt` / `md` / `html` 三种格式。HTML 使用 `marked` 库渲染 Markdown 后保存（新增 `marked` 依赖）。
- **指定账单实现功能**：按正负号 / 按字段区分发生额有值时出现「指定账单实现功能」勾选框 + 多选账单序号下拉。副区域有值未勾选指定时全部 Credit/Debit 禁用；勾选指定时被指定行禁用、未指定行保留行级 Credit/Debit 直接映射。

### 变更

- **模块名称**：新开账户模块按钮文本由「新开账户生成网银账单」改为「新开账户余额账单生成」。
- **大账号确认页重构**：页面标题和文案统一；主页面左右面板支持同步滚动。
- **提取大账号顺序弹框**：DOM 重构为 `.extract-scroll-container`，改为单滚动条。
- **大账号选择对话框条件单滚动条 + 文本化**：勾选「记住顺序」时切为单滚动条 + 右面板文本化只读显示；取消勾选恢复双滚动条 + checkbox 列表。
- **映射字段列位置固定**：`.concat-field-picker` / `.mapping-field-editor > button[hidden]` / `.bill-split-group-btn[hidden]` 改用 `visibility: hidden + pointer-events: none` 保留占位空间，不再因 `display: none` 导致列平移。
- **映射字段下拉框宽度固定**：`.mapping-select` 固定 `min-width: 260px; max-width: 260px`，长文本在下拉框内截断显示。
- **按正负号下拉框宽度**：`.bill-split-sub-row .mapping-select` 由 `min-width: 200px` 改为 `min-width: 260px; max-width: 260px`。
- **映射互斥补全**：发生额互斥由单向改为完整 3 选 1（按字段区分 / 按正负号 / 均无），修正空值误判为激活的 bug。
- **拼接字段预览文本截断**：移除 `.concat-preview` 的 `max-width: 200px` 硬限，截断阈值由 40 字符提升到 120 字符。
- **六列表格 UI 优化**：账单序号表头不换行；行级「完成」后 4 个 select 改为纯文本显示（表格 `table-layout: fixed` 防抖）；账单序号列抬头/数字缩进（`padding-left` 1em/2em）；维护大账号币种校验失败改为弹框提醒，不再只在状态栏显示。
- **主页面初始状态框文本**：启动文本由「已加载内置枚举表：COMMON枚举.xlsx」改为「欢迎使用小助手」。
- `roundAmount` 新增高精度版本，保留原实现兜底短精度路径。

### 移除

- 六列表格的「发生额」列（合并/拆分场景下不再需要）。

## 1.4.9

### 新增

- 映射关系管理新增「账单拆分合并管理」分组：`是否拆分/合并明细账单`（默认 `否`） + `复用模块字段的映射关系`（默认 `是`）两行开关。
- 启用 `是否拆分/合并明细账单` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额`、`按字段区分发生额` 形成 **四方互斥**。
- 新增「拆分/合并账单映射关系设置」弹框（宽度 `80vw`），用于在 `复用模块字段的映射关系 = 否` 时为非金额字段单独配置映射；右上角 `导入当前映射关系` 按钮可从主模板复制配置（自动排除 `Currency` / `Credit Amount` / `Debit Amount`）。
- 新增「拆分/合并账单映射关系管理」弹框：包含 `合并账单` 勾选框、`需要拆分成几份账单` 数字输入 + `拆` 按钮、六列表格（`账单序号` / `Currency` / `Credit Amount` / `Debit Amount` / `发生额` / `执行操作`）和副区域「拆分/合并账单——发生额映射关系管理」。
- 弹框二的合并账单 picker 为 checkbox-panel 多选样式；删除合并组内的拆分行时，会先弹出受影响合并组列表的二次确认（外科手术式解散）。
- 弹框二支持行级落库：`需要拆分成几份账单` 输入数字 N 后点 `拆` 生成 N 行，每一行的 `完成` 按钮单独锁定该行；行变只读后按钮变成 `编辑`，再点可解锁继续修改。
- 导入流程新增按弹框二配置展开 N 行输出的能力（`expandBillSplitForRow`），并按 `merged_group_seq` 分组求净值合并输出（`applyBillSplitMergeForRow`）。
- 新增 4 张 DB 表：`template_bill_split_meta` / `template_bill_split_mappings` / `template_bill_split_rows` / `template_bill_split_amount_rules`，配套 10 个 IPC handlers。
- 多文件导入时新增「以下文件全部未命中拆分/合并规则，请检查规则配置：…」聚合告警，与 1.4.8 的「按字段区分发生额」全部未命中告警平行独立。
- `Drawee Name` / `Payee Name` / `Drawee CardNo` / `Payee CardNo` 在拆分场景下按每个拆分行自己的收支方向独立分配，`reuseModuleMapping` 为 `是` / `否` 两条路径行为一致。

### 变更

- 单行拆分行的 `Credit Amount` 与 `Debit Amount` 同时为 0、或合并组净值为 0 时改为 **静默过滤** 不输出，不再报错或弹提示；合并组 `Currency` 不一致时仍然报错 `BILL_MERGE_CURRENCY_MISMATCH` 阻断导入。
- `bundleVersion` 升级到 `3`，导出 entry 新增 `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 四个字段；旧 `bundleVersion = 2` 的 bundle 按 4 张表的默认值兼容；`bundleVersion > 3` 仍然拒绝。
- `template:get-mappings` IPC 返回值补齐 `billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 5 个字段，修复冷启动后首次打开「拆分/合并账单映射关系管理」弹框只显示初始页面的 bug。

### 移除

- 无

## 1.4.8

### 新增

- 映射关系管理新增 `按字段区分发生额` 配置项（归入 `ADVANCED_MAPPING_FIELDS`，放分组末尾），下拉选项为空白（默认）/ `是`；选 `是` 时右侧出现 `发生额映射关系管理` 按钮。
- 启用 `按字段区分发生额` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额` 形成 **三方互斥**：选 `是` 自动清空并禁用另外三行；切回空白时按钮隐藏，弹框配置草稿独立保留，再切回 `是` 时回显。
- 新增「发生额映射关系管理」弹框：固定 2 行规则——一行 `当 [字段] 的值为 [输入] 时，[字段] 映射为 Credit Amount`，一行映射为 `Debit Amount`；4 个下拉框选项来自 `template.headers`，排除 `自己输入` / `需要拼接字段` 特殊值；同行内 `条件字段 ≠ 目标字段`。
- 条件值匹配规则：默认按字面值精确匹配（整串、大小写敏感、源值先 trim、不做数字归一化）；输入 `/pattern/flags` 形式按正则匹配，支持 `i` / `g` / `m` / `s` / `u` 等 JS RegExp flags；不支持多值，多值场景请用 `/^(C|CR|Credit)$/` 这类正则分组代替。
- 新增 DB 表 `template_amount_split_rules` 和 IPC `template:get-amount-split-rules` / `template:save-amount-split-rules`。
- 多文件导入时新增「以下文件全部未命中收支规则，请检查规则配置：…」聚合告警；按文件独立判定 + 跨文件聚合后弹一个合并告警框。
- 新增 `bundleVersion` 顶层字段（v2），导出 entry 包含 `amountSplitRules`；导入时 `bundleVersion > 当前支持版本` 被拒绝（v1.4.8 自身不会触发，为后续版本预埋）。

### 变更

- `saveMappings` 签名扩展为 6 参，最后一个参数 `amountSplitRules`（`null` = 保留原值，`[]` = 清空）。
- 无效正则保存时报错 `正则表达式语法错误`；同行内条件字段等于目标字段时报错。

### 移除

- 无

## 1.4.7

### 新增

- 大账号选择对话框重写为左右分栏布局：左侧按文件顺序展示，右侧按勾选序位展示，并新增搜索定位与勾选序号回显。
- 多账号账单导入新增 **账号顺序固定 / 不固定** 模式：固定模式下要求一次勾选全部大账号且按指定顺序导入，并支持「记住顺序」在下次导入时回显配置。
- 日期解析支持 BNI 点号时间格式 `HH.MM.SS`、Excel 日期序列号被字符串化后的解析（如 PAB-CN 的 `46102`）；`DD-MM-YY` 不歧义场景下 fallback 到 `MM-DD-YY`（`month > 12` 时）；`YYMMDD` 优先于 Excel 序列号识别。
- CSV 导入新增纯文本解析器 `parseCsvText`：所有值保持字符串、不过 `xlsx` 的类型推断，解决 20 位以上长数字（交易流水号）后几位被截断为 0 的问题；支持引号包裹 / 转义引号 / CRLF / LF / UTF-8 BOM。

### 变更

- 大账号对话框：`remember` 复选框在不固定模式下灰显而非隐藏；切换搜索关键字时重置选中索引；模式切换时清空搜索状态；初始化期间禁用交互；报错后保留对话框供用户重新设定。
- 新开账户模块的导出文件命名规则适配单 / 多账号场景。
- 新开账户余额账单的最晚日期改为「到昨天」。
- 全部账号 0 笔交易时直接报错 `没有账号存在交易数据`，不再进入大账号选择；修复 `identifyAccountBlocks` 空块 fallback 假块的问题。
- `MerchantId` 自动去除中间空格（如 `NRA 7101 2023 0223 63` → `NRA71012023022363`）。
- `Currency` 字段从映射对话框的多选拼接里排除，下拉不再出现 `需要拼接字段` 选项。
- `splitTemplateName` 修复多段 `-` 时的所在地取值：`BNI-ID-SG` 模板的 location 取第二段 `ID`，不再是 `ID-SG`。
- 修复 `rowsWithEmptyBlocks` 未持久化导致固定模式校验失败、空块 `sourceRowNumber` 回退值错误、元数据行被误当成数据行导出的问题。
- `xlsx` / `xls` 文件不受 CSV parser 改动影响，仍走 `XLSX` 库读取。

### 移除

- 移除映射对话框的日期格式下拉（`dateFormatSelect` 变量及 `saveMappings` 内 `dateFormat: dateFormatSelect.value` 一并删除）。

## 1.4.6

### 新增

- 新增「导入银行账号信息」入口：从 Excel 解析客资账号写入大账号表，自有账号写入独立 JSON 存储。
- 新增「余额管理」弹窗：按 `大账号 + 币种 + 日期 + 余额附加值 + 备注` 维护余额附加值；附加值会在余额导出时按 `MerchantId + Currency + BillDate` 累加注入到生成的余额账单。
- 新增 IPC channels：`bigAccount` 系列 + `balanceAdjustment` 系列。

### 变更

- 维护大账号弹窗的币种输入框小写自动转大写；多币种浮动面板溢出修复（`overflow-y: auto`）。
- 模板选择框启动时显示 `请选择模板` 占位符；未选模板时阻断导入操作；删除模板时清理相关缓存。
- 新开账户余额账单改为开户日到今天 **逐日生成**（上限 3650 天），不再只输出开户日和月末日。
- `维护大账号` / `账户映射` 等弹窗按钮新增文本溢出保护样式（`.primary-btn.small` 等）。

### 移除

- 无

## 1.4.5

### 新增

- 新开账户模块的多币种下拉新增固定搜索框，支持按币种代码、显示标签和中文名进行模糊匹配。
- 新增账号行现在会在 `银行账号` 文本右侧显示 `删除` 按钮，可直接删除当前行。

### 变更

- 新开账户模块中，`所在地` 输入框宽度缩窄为原来的三分之二，`币种` 列相应扩宽。
- 新开账户模块单币种下拉在未选择时改为空白占位，不再显示 `请选择币种`。
- 新开账户模块的多币种下拉在点击面板外空白处时会收起，并保留当前勾选结果与位序。

### 移除

- 无

## 1.4.4

### 新增

- 背景调色盘按钮右侧新增 `使用手册` 文本按钮，可将内置 `docs/USER_GUIDE.md` 另存为 `使用手册.md`。

### 变更

- 新开账户模块中的单币种输入改回下拉选择；勾选 `多币种账户` 后，币种控件会切换为带数字位序的多选下拉，并支持点击面板外空白处收起且保留已勾选结果。
- 新开账户模块在单币种切换到多币种时，会自动把原单一币种带入多选列表并标记为 `1.`；切回单币种时，会回填当前顺序中的第一个币种。
- 账户映射弹窗中的 `网银大账户ID` 文案统一改为 `网银大账号ID`，并同步更新相关校验报错文案。
- 账户映射弹窗中，`清结算系统大账号ID` 输入框宽度调整为与左侧输入框一致；其右侧新增 `删除` 文本按钮，`有账户号无币种` 勾选框移动到 `删除` 右侧。
- 版本迭代时需要固定同步更新的文档清单扩展为：`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。

### 移除

- 无

## 1.4.1

### 新增

- 网银账单生成模块支持导入 `PDF` 文件，覆盖表格式 PDF、扫描版图片型 PDF 和多页跨页续表 PDF。
- 映射关系管理支持多选源字段，并在保存时弹出多选顺序确认弹窗。
- `MerchantId = 自己输入` 场景支持多行大账号 / 币种分配弹窗，并可通过 `固定` 保存当前分配顺序和值。
- 新开账户模块支持通过 `银行账号` 右侧的文本按钮 `新增` 继续追加完整账号行。

### 变更

- 当 `MerchantId` 为固定映射且不为 `自己输入` 时，`Currency` 现在允许为空，导出的明细和余额账单也会保留空币种值。
- 应用中的币种输入统一升级为“文字输入 + 全量下拉 + 虚影补全”交互。
- 新开账户模块在多账号场景下会将所有账号合并导出为 1 份 `NEW_BALANCE` 文件，文件名中的账号部分固定写为 `多账号`。
- 左上角 GIF 缩小为当前尺寸的一半。

### 移除

- 无

## 1.4.0

### 新增

- 无

### 变更

- 这是一次内部治理与结构重构版本；之前的主要功能、导出结果和前端 UI 保持不变。
- `scripts/smoke-test.js` 按能力拆分为多个 smoke 场景与公共支持模块，继续保留 `npm run smoke` 入口。
- `src/backend/file-service.js` 拆分为文件读取清洗、标准化、行映射与写出等后端子模块，对外 API 保持原样。
- `src/backend/database.js` 拆分为迁移、模板仓储和设置仓储等内部模块，`AppDatabase` 继续作为门面层对外提供原有方法。
- `src/main.js` 中的账单导入会话和导出聚合逻辑被提取到独立模块，主进程入口更聚焦于装配和流程协调。
- 渲染层中的弹窗工厂与 preview 逻辑拆到独立脚本中，界面布局、按钮位置、文案与交互顺序保持不变。

### 移除

- 无

## 1.3.5

### 新增

- 网银账单生成模块支持一次导入多个原始账单文件。
- 同一模板在当前软件打开期间已导入过 2 次及以上时，点击 `导出明细` / `导出余额` 会弹出“导出当前文件”或“导出所有”的选择框。

### 变更

- 混合币种账单不再因为 `Currency` 多值而无法生成余额账单；系统会按币种分别计算余额，再把所有币种结果整合到同一个余额文件、同一个 sheet 中导出。
- “导出当前文件”明确表示“当前这次导入批次”，“导出所有”明确表示“当前软件打开后该模板导入过的全部文件”；统计范围只按模板，不再按大账号 / 币种拆分。
- 导出所有时，多个大账号和多个币种会整合到同一个 COMMON / BALANCE 文件里，导出文件名不再带大账号。
- 主模块余额文件命名中的 `Balance` 统一改为 `BALANCE`。

### 移除

- 无

## 1.3.4

### 新增

- 无

### 变更

- 修复多大账号模式下，导出明细和余额文件中的 `MerchantId / Currency` 会严格使用本次选中的 `大账号 / 币种` 组合，不再把内部固定标记写进导出文件。
- 原始网银账单自动清洗增加表尾汇总区过滤，`总收入笔数 / 总收入金额 / 总支出笔数 / 总支出金额` 之后的汇总行不再进入明细和余额链路。
- 收紧日期兜底解析，`0 / 1 / 0.00` 这类值不再被错误标准化成日期；首次确实缺少上一账单日余额时，会重新触发补录提示。

### 移除

- 无

## 1.3.3

### 新增

- 无

### 变更

- 映射关系管理中，`MerchantId` 选择 `自己输入` 后改为直接由“维护大账号”接管 `MerchantId + Currency`；当只维护出 1 条 `大账号 / 币种` 组合时，导入时会自动直通，不再弹选择框。
- `Currency` 行全局移除 `自己输入` 选项；在 `MerchantId=自己输入` 模式下，`Currency` 行直接隐藏，最终值取自“维护大账号”里的币种配置。
- 映射关系管理保存失败时，系统会先弹出错误提示，确认后回到原编辑内容继续修改，不再丢失当前草稿。
- 收掉了 `MerchantId / Currency` “选择自己输入后必须填写内容”的旧强校验实现，并兼容历史上使用固定 `MerchantId / Currency` 的模板配置。

### 移除

- `Currency` 的“自己输入”能力。

## 1.3.2

### 新增

- 新增版本功能变更清单文档 `docs/VERSION_FEATURE_HISTORY.md`。

### 变更

- 模板管理弹窗中，`执行操作` 标题与行内按钮组重新做了左边界对齐，底部 `导入模板文件 / 导出模板文件` 调整为右对齐按钮组。
- 模板管理中的单固定大账号摘要改为直接显示完整账户号，超长时省略显示并支持原生 tooltip 查看完整值。
- “维护大账号”弹窗新增行内 `完成 / 修改 / 删除` 状态切换，并优化多币种摘要显示规则；`修改 / 删除` 按钮组与 `执行操作` 标题左边界对齐。
- “维护大账号”弹窗中的多币种下拉改为浮层式渲染，修复展开内容被遮挡的问题。
- “新开账户生成网银账单”模块中，`银行名称 / 所在地 / 币种 / 银行账号 / 开户日期` 五个字段标签整体向右微调一个汉字宽度。

### 移除

- 无

## 1.3.1

### 新增

- 启动失败时新增系统错误框提示，并将异常记录到 `app_activity_log.txt`。

### 变更

- 修复 `1.3.0` 老版本用户升级后可能无法启动的问题；数据库迁移改为先补齐 `template_key`，再创建唯一索引。
- 补充 smoke test，覆盖旧数据库迁移和启动失败兜底行为。

### 移除

- 无

## 1.3.0

### 新增

- 网银账单生成模块支持直接导入原始网银账单，并自动定位真实表头、清理前置脏数据行、左侧脏列和右侧空尾列。
- 映射关系管理新增 `按正负号拆分的发生额`。
- 模板管理页新增 `大账号` 列、`重命名`、`导入模板文件`、`导出模板文件`。
- 新增模板库同步文件 `文档/网银账单生成小助手/templates/template-library.json`。

### 变更

- `BillDate` / `ValueDate` 导入后会自动清理时分秒、补全年月日位数，并按统一日期格式导出。
- `MerchantId` 支持维护多个“大账号 + 币种”配置，并在导入时选择本次使用的组合。

### 移除

- 无

## 1.2.13

### 新增

- 无

### 变更

- 模板管理页面中，模板列表 `执行操作` 列的行内按钮文案恢复为 `修改`；主界面入口按钮仍保持为 `模板管理`。
- 同步刷新用户使用文档，使文档内容与 `1.2.13` 的界面和导出规则一致。

### 移除

- 无

## 1.2.12

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块中，“多币种账户”文案的第二行“账户”调整为居中显示。

### 移除

- 无

## 1.2.11

### 新增

- 无

### 变更

- 统一 `Credit Amount` / `Debit Amount` 同时为 `0` 或空值时的过滤规则，这类记录会同时从明细账单和余额账单中过滤。
- 补充 smoke test，防止“明细已过滤但余额未过滤”的分叉行为再次出现。

### 移除

- 无

## 1.2.10

### 新增

- `Balance` 映射新增固定选项 `通过发生额计算`。
- 本地余额种子文件新增 `生成方式` 字段，用于区分 `账单里的余额`、`通过发生额计算` 和 `人工录入`。

### 变更

- 应用运行时所有面向用户的“模版”文案统一为“模板”。
- “新开账户生成网银账单”模块中，“多币种账户”复选框文案调整为上下两行显示。
- `app_activity_log.txt` 统一改为写入 `文档/网银账单生成小助手/`。

### 移除

- 无

## 1.2.9

### 新增

- 网银账单生成模块新增本地余额种子机制。
- 新增“因首次导入余额，请导入上一个账单日余额用于余额校验”提示状态；点击状态框可补录上一账单日日期和余额。
- 新增独立用户说明文档 `docs/USER_GUIDE.md`。

### 变更

- 余额种子文件按银行拆分保存在 `文档/网银账单生成小助手/balance-seeds/`，并支持重复录入确认覆盖。
- 当模板启用了 `Balance` 时，`MerchantId` 成为余额链路必填项。

### 移除

- 无

## 1.2.8

### 新增

- 映射关系弹窗底部新增“根据发生额做映射的户名 / 账户号”规则。
- 导出明细前新增 `Credit Amount` 与 `Debit Amount` 不能同时有值的强校验。
- 应用首次启动时会创建 `app_activity_log.txt` 记录关键操作与报错。

### 变更

- “映射关系设置”统一更名为“映射关系管理”。
- “新开账户生成网银账单”模块优化多币种下拉框宽度，开户日期默认显示为空白。
- 新生成余额账单命名规则调整为 `银行名称-所在地-银行账号-币种-NEW_BALANCE.xlsx`。
- 报错文件命名规则调整为 `YYYYMMDD-HHMMSS-模版名-错误步骤.txt`。

### 移除

- 无

## 1.2.7

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块在多币种账户场景下，导出文件名中的币种段固定输出为 `多币种`。

### 移除

- 无

## 1.2.6

### 新增

- “新开账户生成网银账单”模块新增多币种账户模式，可从 `币种映射表.xlsx` 的 C 列多选币种并批量生成多行账单。

### 变更

- “新开账户生成网银账单”模块中的开户日期默认显示为空白。
- 调色盘面板尺寸调整为 `6.8cm * 6.8cm`，“导入背景文件”按钮改为单行显示。

### 移除

- 无

## 1.2.5

### 新增

- 新增 `npm run icon:sync` 图标同步脚本。

### 变更

- Windows 安装包、portable 可执行文件、桌面快捷方式和任务栏窗口图标统一改为自定义应用图标。

### 移除

- 无

## 1.2.4

### 新增

- 无

### 变更

- 修复余额账单在“同一账单日期存在多条余额记录”场景下的推导逻辑，优先按 `上一余额 + Credit Amount - Debit Amount` 匹配期末余额。

### 移除

- 无

## 1.2.3

### 新增

- 无

### 变更

- 明细账单导出时不再保留 `Balance` 列。

### 移除

- 从明细账单导出中移除 `Balance` 列。

## 1.2.2

### 新增

- `Currency` 映射新增“自己输入”。

### 变更

- 明细账单导出时保留 `Balance` 列但不再输出该列数据。
- 若 `Credit Amount` 与 `Debit Amount` 同时为 0 或空值，对应记录不会写入导出的明细账单，并会在状态提示和报错文件中说明。
- `Balance` 字段在导入转换时会像收支字段一样清洗，仅保留数字和 `.` 后按数值参与余额账单计算。
- “新开账户生成网银账单”模块的导出文件命名规则调整为 `银行名称-所在地-银行账号-币种-新开银行账户余额录入-最早日期~最晚日期.xlsx`。

### 移除

- 无

## 1.2.1

### 新增

- 内置 `assets/币种映射表.xlsx`，用于非英文币种自动替换。

### 变更

- 网银账单生成模块主界面按钮文案调整为“模版管理”。
- `Credit Amount` / `Debit Amount` 导出前会清洗为仅保留数字和 `.`，并按数值格式写出。
- `Currency` 若不是纯英文，会模糊匹配映射表 A/B 列并替换为 C 列英文简称；匹配失败时保留原值导出并生成报错文件。

### 移除

- 无

## 1.2.0

### 新增

- 新增“新开账户生成网银账单”模块。
- 所有用户侧报错统一生成详细报错文件，状态框在有报错时支持点击导出。

### 变更

- 明细导出文件命名规则调整为 `模版名-COMMON-最早账单日期~最晚账单日期.xlsx`。
- 映射关系设置允许多个模版字段指向同一映射字段。
- `Channel` 从映射弹窗移除并改为固定取模版名称 `-` 前的值。
- `MerchantId` 新增“自己输入”模式并贯穿明细、余额及相关取值链路。
- 微调“新开账户生成网银账单”模块底部布局。

### 移除

- 从映射弹窗中移除 `Channel` 的手动映射项。

## 1.1.1

### 新增

- 无

### 变更

- 余额账单模板固定读取 `assets/余额账单模版.xlsx` 当前版本，不再回退到其他路径。
- 明细账单导出改为始终输出完整模版字段；未映射或源值为空时，字段保留且单元格留空。
- 余额账单导出改为按余额模板第一行字段动态补齐列，模板第二行及之后的旧示例数据会在写入前清空。
- 更新 smoke test，覆盖“未映射字段仍保留空列”和“余额模板额外字段保留空列”的导出场景。

### 移除

- 移除余额模板的路径回退逻辑。

## 1.1.0

### 新增

- 将 `COMMON枚举.xlsx` 作为应用内置资源随安装包分发，启动后自动加载。

### 变更

- 状态框改为展示内置枚举加载状态，不再承担枚举表导入入口。
- 更新运行说明与打包配置，移除 `init:enum` 启动前置步骤。
- 调整 smoke test，改为校验内置 `COMMON枚举.xlsx`。

### 移除

- 移除首次导入枚举表的运行依赖。
- 移除 `init:enum` 启动前置流程。

## 1.0.9

### 新增

- 无

### 变更

- 固定导出格式：`Credit Amount`、`Debit Amount` 输出为数字格式。
- 固定导出格式：`BillDate`、`ValueDate` 输出为日期格式。
- 固定导出格式：`MerchantId`、`Channel` 输出为文本格式。

### 移除

- 无

## 1.0.8

### 新增

- 新增账户映射弹窗预览图脚本。

### 变更

- 将“管理模版”和“账户映射”按钮调整为横向并排居中显示。

### 移除

- 无

## 1.0.7

### 新增

- 新增“账户映射”按钮和账户映射弹窗。
- 新增网银大账户ID校验规则。

### 变更

- 导出时若模板映射字段中存在 `MerchantId`，会按账户映射表把对应单元格值替换为清结算系统大账户ID。

### 移除

- 无

## 1.0.6

### 新增

- 无

### 变更

- 左上角 GIF 调整为距上方和左侧各 `0.5cm`，尺寸改为 `1.5cm * 1.5cm`。

### 移除

- 无

## 1.0.5

### 新增

- 无

### 变更

- 主标题字栈调整为以 `OpenAI Sans` 为首选、中文无衬线字体为回退。

### 移除

- 无

## 1.0.4

### 新增

- 无

### 变更

- 继续放大主标题“网银账单小助手”字号。

### 移除

- 无

## 1.0.3

### 新增

- 无

### 变更

- 主标题文案调整为“网银账单小助手”，并进一步增大字号。
- 左上角 GIF 调整为距上方和左侧各 `1cm`，尺寸改为 `2cm * 2cm`。

### 移除

- 无

## 1.0.2

### 新增

- 新增左上角固定循环 GIF 展示。
- 新增界面预览图生成脚本。

### 变更

- 主页面标题更新为“网银账单生成小助手”，字体调整为微软雅黑 Light 加粗并增加字间距。
- 管理模版弹窗移除标题文本，仅保留关闭按钮。
- 枚举表改为首次运行后由用户导入并持久化。
- 状态框首屏提示“请导入网银账单枚举表”，并支持点击状态框导入或覆盖枚举表。
- 仅允许导入文件名带有“枚举”的 `.xlsx` 作为枚举表，空文件或不可读文件会在状态框提示。
- 右下角版本文案改为 `Version`，字体调整为 `Courier New`。

### 移除

- 移除管理模版弹窗标题文本。
- 移除根目录静态读取枚举表的逻辑。

## 1.0.1

### 新增

- 新增 Windows `portable` 免安装打包目标。
- 新增 `npm run dist:win:portable` 和 `npm run dist:win:setup` 脚本。

### 变更

- `npm run dist:win` 默认同时生成安装版和免安装版。
- GitHub Actions 同时上传 `windows-installer` 和 `windows-portable-exe`。
- 为 Windows 主进程补充 `AppUserModelId` 设置。

### 移除

- 无

## 1.0.0

### 新增

- 初始化 Electron 桌面端应用骨架，支持 Windows 10 / 11。
- 实现自定义窗口栏、拖拽窗口、最小化 / 最大化 / 关闭。
- 实现模版导入、模版列表管理、映射关系设置与删除确认。
- 实现基于 SQLite 的模版和映射关系持久化。
- 实现 Excel / CSV 导入校验、COMMON 枚举加载、账单转换和 Excel 导出。
- 实现按日期生成输出目录与日志文件。
- 在页面右下角显示应用版本号。
- 补充版本迭代说明和版本回溯文档。

### 变更

- 无

### 移除

- 无
