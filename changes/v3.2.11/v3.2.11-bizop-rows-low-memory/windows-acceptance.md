# Windows 低内存待验收操作说明

用户已确认暂时没有 Windows 环境。本文件准备后续 T7 所需材料；当前不表示 Windows、正式安装包、真实业务或 Excel/WPS 已通过。

## 1. 当前可直接运行的完整组件脚本

在包含本分支源码、锁定依赖和 tests/helpers 的独立检出目录执行。该脚本使用真实 Worker 与领域 Main 组件，自动生成合成输入和临时数据库，结束后只清理本次临时目录，不加载日常应用数据。

普通开发机逻辑回归：

```powershell
node scripts/verify-low-memory-capacity.js --rows 20000 --repeat 3 --output normal-low-injected.json
```

Windows 上使用项目 Electron 自带 Node 运行，以记录正确 runtime 版本：

```powershell
$runtimePath = Resolve-Path .\node_modules\electron\dist\electron.exe
$env:ELECTRON_RUN_AS_NODE = '1'
& $runtimePath scripts/verify-low-memory-capacity.js --rows 20000 --repeat 3 --real-system true --pressure-band none --output windows-normal-components.json
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

已由隔离测试机提供真实压力时，分别运行：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $runtimePath scripts/verify-low-memory-capacity.js --rows 20000 --repeat 3 --real-system true --pressure-band 512 --output windows-512-components.json
& $runtimePath scripts/verify-low-memory-capacity.js --rows 20000 --repeat 3 --real-system true --pressure-band 768 --output windows-768-components.json
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

输出路径必须不存在，防止覆盖失败记录。脚本不会制造内存压力、修改页面文件或关闭其他进程。`--pressure-band` 检查每次 grant 时实际可用内存是否落在目标 ±96 MiB；区间外返回 FAIL，不能只靠设定目标值写 PASS。整个运行区间的实际样本仍需评审，grant 区间通过不是全程压力稳定的证明。

## 2. 脚本记录和局限

记录源码／锁文件身份、Node/Electron/平台、合成源摘要、各 phase 耗时、grant profile/policyDigest、实际系统内存、PID RSS 与采样线程 heap/external。RSS 包含同 PID 的 Worker；heap/external 是采样线程，不能据此声称每个 Worker 的堆峰值。独立读回的开销单列。

业务链路：metadata → 显式单字段 → rows Worker → 输出验证 → Publisher → 恢复；OP 导入 → 计算 → 六类导出 → 各自发布／校验 → 恢复。普通／低档比较业务结果摘要；说明页只规范每次变化的 UUID、摘要、激活／发布时间。

脚本始终标记 `productionEvidence:false`，因为它不是完整应用 Main/GUI，也没有包体安装、真实数据、Excel/WPS 人工检查。它不能自动生成合格生产 manifest。当前产品没有面向 Renderer 或环境变量的低档强制开关；真实 Main 的低档验证需在隔离验收装配中使用可信 non-production runtime，不能伪造正式 PASS 证据来绕过资格门禁。该平台装配及 GUI 运行纳入 T7。

## 3. T7 必须补齐的验收

| 项目 | 要求 | 当前状态 |
| --- | --- | --- |
| 最终构建 | 冻结源码、依赖锁、Electron/Node、应用版本、Windows 架构和包体 SHA-256；记录内存、CPU、磁盘和页面文件。 | NOT RUN |
| 完整应用入口 | 从选文件开始，覆盖真实 Main、Preload、Renderer、归档和恢复；普通对照与 512／768 MiB 各至少 3 次。 | NOT RUN |
| 样本矩阵 | 小文件、高唯一文本、高样式、宽行、跨 Sheet、CSV/XLS 阈值与 65 MiB 公共字段扫描；记录全部业务输出一致性。 | NOT RUN |
| OP 故障 | 错误行、文件级错误、超过 1000 样本、报告失败；真实业务结果与报告状态分开核对。 | NOT RUN |
| 恢复／排他 | 发布中断、COMMITTED 待确认、程序强退、重启、载体未退出、旧服务存活、新 legacy 请求阻断。 | NOT RUN |
| OP／合表并发 | 异常导入后自动报告先登记 publication 并等待资源，合表随后发布；normal／low、同 normal 优先级、夹普通请求、取消队首分别核验。合表与错误报告均完成，原件／输出和归档／ACK 完整，结束后租约及活动归零。 | NOT RUN（本地隔离集成已通过） |
| IO 故障 | Windows 文件锁、权限不足、磁盘满、慢盘、取消；原件保护和恢复义务保留。 | NOT RUN |
| 用户体验 | 基础扫描、值入口、单列、多组、重试、低档反馈；含加载中双向切模式、删除／改动共享请求发起组。GUI 响应和总耗时阈值在正式计分前固定。 | NOT RUN |
| Excel/WPS | 输出行数、顺序、编号文本、日期、金额、错误／布尔和受支持样式人工核验。 | NOT RUN |

样本只用脱敏代表数据或明确合成数据；合成结果不能自动升级为真实业务验收。

## 4. 生产资格冻结

`memory-qualification.json` 当前 `status:pending`，不发布实验阈值。通过上述验收后，按 `memory-evidence.js` 合同记录：

- 最终 sourceTreeSha256、dependencyLockSha256、appVersion、platform、arch、nodeVersion、electronVersion 和 artifactSha256。
- 每个准确 profileId/policyDigest 对应 evidenceId、PASS、非仅合成证据与完整 inventory 结论。
- normal 至少 3 份独立报告；low 的 512／768 MiB 各至少 3 份。每条报告记录 reportSha256、源码／包体摘要和真实压力事实。
- prepare／rows-generation 的每档报告必须完整覆盖 xlsx/csv/xls；其余 phase 的记录为 phase-complete。当前没有按格式部分放行机制。

任何源码、依赖、runtime、配置或支持格式变化都重新判断资格。更新资格后再核验最终打包内容；未提交开发状态不填写虚构 commit SHA。当前交付不包含资格启用、提交、推送、构建、合并或发布动作。
