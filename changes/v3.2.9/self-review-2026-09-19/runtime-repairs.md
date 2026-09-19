# SST 与高位文件身份修复审查

本轮基线 `5ffaabb0c3dcf65377e70997706290c32ed80c33`，修复提交 `30317ee5a9ad8227db0562354d20554edb9e6ae4`。本记录补充 [发布前自审](../release-review-2026-09-19.md)，新候选身份和最终门禁状态以 [release.md](../release.md) 为准。所有实验使用合成文件、隔离 SQLite 和临时目录。

## 已复现 Findings

| Finding | 证据与影响 | 修复与回归 |
|---|---|---|
| P2：VCC 磁盘 SST 的 LRU 未设置字节预算 | 真实 inspect/import/calculate/prepare/extract，1,100 条合法 32,700 字符 Pending 备注；旧配置仅限制 8,192 条，实存 UTF-16 文本 71,942,020 B，缓存计费 107,980,431 B，指标却为 0，超过 64 MiB。red 实验仅在内存加载原 `5ffa` 模块，源码 SHA 与 Git blob 一致。 | VCC 调用明确传 `cacheMaxBytes=64 MiB`；保留 shared provider 其他调用者默认行为。新真实回归逐条校验 1,100 个 ID/原文、单物理文件扫描和清理，真实缓存独立求和与指标一致，峰值 67,049,348 B。48 张业务/Archive/设置表安装持久写失败触发器，并从独立连接验证保护，prepare/extract 通过。 |
| P2：Archive 高位身份被拒绝或丢失 | Windows 必需检查的删除、只读副本、迁移和受管源失败签名指向身份 guard；真实生产函数的高位 stat 注入证明超过 2^53 的可靠身份因 Number 转换被拒绝或丢失。Windows 日志没有原始 inode，因此不声称直接测得该 runner 的值。正常路径通常 fail-closed，未复现 Archive 误删。 | 单次 BigInt stat 的兼容视图保留无损十进制 dev/ino，从同一返回的纳秒重建原小数毫秒；持久字段仍为既有 TEXT/JSON。保留 owner、原指纹、父链、摘要、共享引用及替换拒绝。新集成覆盖真实 DB 关闭重开、只读副本删除、共享 Blob 保留、同内容且 Number 不可区分的替代 inode 拒删。 |
| P2：SST 清理使用舍入身份可认领替代目录 | 目录/文件原 inode 与替换 inode 相邻且超过 2^53，转 Number 后相同。真实 close 关完句柄后替换目录；旧 provider 未拒绝，修复后在清理前报告目录身份变化并保留两份替代文件。该故障为隔离实验，未观察到用户数据事故。 | 创建和清理的 5 个 lstat/fstat 入口统一 `{ bigint: true }`；保持独占目录、文件归属和非递归清理规则。复用真实目录替换回归，Windows 可在句柄关闭后实际构造该竞争。 |

## 验证与夹具修复

- VCC 新 SST 真实回归：Node 24.13.0 / macOS，1/1 PASS；峰值内存字典 67,051,201 B、峰值 LRU 67,049,348 B，单文件扫描，FD 关闭及 spill 清理 PASS。
- SST 归属、VCC storage-v3 与 toolbox rows 相关 34 项 PASS；旧 provider 的新目录替换回归 FAIL，修复后 PASS。
- Archive 基础家族 210/210 PASS，高位身份家族及新回归 417 PASS（作者最初使用 Node 25.8.0）；独立 Node 24 新回归 2/2 PASS、8 组真实文件时间兼容及 16 类非法身份拒绝 PASS。最终 Node 24 全门禁 PASS：501 单测文件、7,864 PASS / 0 FAIL / 3 平台专用 SKIP，59 集成脚本、2,575/2,575。
- SST 四文件也经独立复审，未发现新增 P2+；64 MiB 限制针对保留的 SST 字节，不是进程 RSS 上限。
- 独立审查未发现本身份补丁新增 P2+；检查了单次取证、旧 schema、只读 fd/路径连续性、迁移 hardlink 类型、调用遗漏及 TOCTOU。普通路径 API 仍不等同于操作系统级原子身份删除。
- Windows 测试的附带修复：数据库/Worker 先关闭再移除目录；SST 替换发生在真实句柄关闭后；路径使用原生 path API；历史 fixture 取证不再写入舍入的 inode；仅在隔离 fixture 中恢复只读目标权限再构造替换。保留所有原拒删、内容和重启断言。
- 更新已有 `archive-center-permanent-delete` 集成，原 49 项保留，并增加高位身份跨层场景；Node 24 原生 50/50、高位注入 50/50 PASS。最终完整门禁中该脚本实际 50/50 PASS，不手工改 runner 的通过统计。

## Windows 与发布边界

`5ffaabb0` 的 [必需运行 35380925888](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35380925888) 已失败：7,858 tests，7,641 PASS / 199 FAIL / 15 cancelled / 3 SKIP；build 跳过，产物为空。失败集合未揭示不同于上述身份及 fixture 问题的新独立根因，但必须由新候选真实 Windows 复验确认。

旧候选的原生时间、真实 Main、设置、VCC Electron/ASAR 和小样本专项步骤通过。因三项生产修复使旧候选失效，已保全证据并取消旧运行，以验证新候选；取消后的完成情况按真实上传 JSON 另行核对，不将缺失用例记为通过。这些结果不能证明新后端修复。PF 原独立 Worker RSS 要求与 worker_threads 架构冲突的决策仍待用户答复，原 Spec/TechDoc 的阈值和度量合同未改；真实 drain 的本机补充验证已通过；正式 Windows PF、安装版、Excel/WPS 等必要验收仍未闭环。

完整原始证据保存在本地忽略目录 `logs/verification/release-v3.2.9/repair-sst-file-identity/`，`manifest.json` 记录 SHA-256；可重跑回归随源码纳入 Git。完整本地门禁、最终提交、CI 和人工签字分别记录，不互相替代。


## 真实背压与取消观测

新增观测仅在性能验证器：包装生产 SQLite pageRows 游标，读取真实 SheetStream 的 drain 等待、原 listener 和恢复事件，不预读、不物化、不改变生产预算。取消必须发生在输出暂停且生产 drain 等待已持续至少 100 ms 时；随后验证 abort、原 listener 移除、游标 return、DB/output 关闭和暂存清理。恢复用例要求等待期间游标不前进，真实 drain 后才继续取行，并与完整 E/A/X、回读结果对齐。证明的是写入阶段 manifest 游标停读，原件 XLSX 此时已完成抽取。

256 条高基数长文本的小样本真实链路：暂停/恢复与取消均 PASS；取消 8 ms、forced=false、输出未恢复，最终游标没有继续读取。独立复审未发现新增 P2+；使用原函数重放两份 trace 2/2 PASS，14 个独立缺事件/读取推进/未清理负对照全部拒绝。仅阶段变化或约 30 秒输出有界进度计数；同步计算阻塞时不保证日志准点，不能凭静默判定 hang。

这两个独立验收脚本不属于 release-check 的 lint/src、单测或集成调用链，单独语法、lint 及完整门禁后的最终 runner 动态验证均 PASS：普通 smoke 19 Sheet 回读成功；10,000 Pending 在真实 drain 等待期间取消，43 ms 收口、forced=false、stageBoundaryOnly=false、cleanup=PASS，游标 return 1 次，取消后的 sourceRows 固定为 12,372。两次均为 macOS/Electron 36.9.5 补充证据，acceptance 保持 NOT_RUN。实际测试时 HEAD 仍为 `5ffaabb0` 且 productionDirty=true；原记录保留该事实，提交后的输入哈希比对证明代码已纳入上述修复提交。原百万样本、1 MiB/s、5 秒停写、队列预算、RSS 和 Windows/人工门槛均未修改，正式 PF 仍待验。

完整门禁日志 SHA-256：`dee26fc40765ac8f035c9e006e95efa08501a1444695be7f11d1d20756b1afc0`。初始固定 1,484 个输入，另核对 46 个先前清单中未变的非 ASCII 路径资源；提交时逐项比对，仅两份独立 PF 验证器使用其已单独验证的新摘要。结构化结果见 [runtime-repairs-summary.json](runtime-repairs-summary.json)。

## Windows ctime 回归夹具修正

候选 `50062ca02dd80947181dd042159ac851c2b8d0c1` 的 Windows 完整检查出现一项可见失败：hardlink 的 ctime 拒删用例预期保留文件，实际返回已删除。原测试只调用 `chmod(0600)`，未确认时间确实改变；[Node 文档](https://nodejs.org/api/fs.html#file-modes)说明 Windows 仅处理写权限。受控 no-op 实验复现相同结果，但没有原 Windows stat 日志，不能将其写成实测该次 ctime 未变。生产判断仍要求 ctime 一致，只有冻结计划内链接确实减少时才允许对应变化；本次未发现该判断被绕过的证据。

修订仅作用于原单测：对该 fixture 的私有 fs，只将匹配真实 dev/ino 的对象 ctime 偏移；明确保持 mode、mtime、nlink、内容与两条实际路径不变。重试必须返回恰好两个 `ARCHIVE_DELETE_FILE_CHANGED`，保留两条文件及 cleanup job。该文件 59/59 PASS，hardlink 子集 13/13 PASS；只在内存移除 ctime 判断的负对照正确 FAIL，证明不靠其他字段差异通过。

生产代码和依赖与 `30317ee5` 相同。完整本地门禁 7,864 PASS / 3 SKIP、集成 2,575 PASS 保留其原始执行身份；本次变动只有一个已全文件复验的测试输入，不能表述为在新提交重新跑过完整命令。修正后的 `e47e2a60` 同名用例已在真实 Windows PASS；该候选完整门禁仍有其他 45 项失败，详见下方完整终态，平台门禁未闭环。原始失败、受控复现和正负例位于 `logs/verification/release-v3.2.9/windows-ctime-fixture/`。

## Windows SSD 基准准入 P2

后续审查确认独立性能验证器存在错误准入：原查询以 `MSFT_PhysicalDisk.DeviceId == MSFT_Disk.Number` 关联介质，但这两个字段不是同一类设备标识。受控拓扑中，测试卷的 OS Disk 1 实际对应 HDD 或未知介质，另一块 SSD 的 PhysicalDisk DeviceId 恰为 `1`，实际未修改的 `baseline()` 都返回了环境 PASS。两个正确编号对照分别返回 HDD 的 NOT_RUN 和 SSD 的 PASS。该结果是原函数加受控 Windows 查询适配器的复现，不是本次 GitHub runner 已选错磁盘的实测证据。

错误环境准入会允许正式 PF 在不符合 SSD 要求的卷上继续；PF02 的其余断言成功时还可能被记录为单项 acceptance PASS，因此定为 P2。本次修复限定于验证器的同实例卷、设备身份和介质取证；原 SSD、16 GiB、样本规模、队列预算及独立 Worker RSS 合同保持不变。该版修复通过代码级复审；后续真实 Windows 采证暴露 PowerShell 枚举转换失败，修正待平台复验，暂不宣布整版无 P2。

实现从现有 case 文件经 CIM 关联取得卷、分区和 OS 磁盘，保留同实例原始证据；使用唯一标准 VPD 身份、格式、序列号、容量和总线交叉核对介质，未知或冲突保持 NOT_RUN。两份新增采集/判定脚本纳入运行时源码哈希。Hypervisor/VBS 标记及同盘其他用途不单独拒绝目标，普通 MBR/IFS/FAT 与 GPT 数据分区均有正例；未获底层介质证明的虚拟目标继续待验。

Node 24/macOS 专属回归 **44/44 PASS**，独立探针 **25/25 PASS**，语法/lint/差异检查通过。Root 实跑最终脚本的 Electron smoke：19 Sheet、40 行、独立回读和清理 PASS、exit 0；5 个脚本哈希与冻结版本一致。当时 HEAD 为 `e47e2a60`、productionDirty=false，验证器修改尚未提交。上述是本机记录，不等于真实 Windows PowerShell/CIM 已验证，也不替代正式 PF；后续短诊断实际失败见下节。完整本地门禁未为本次独立验证器和专属测试重跑，保留原执行身份。

微软定义及关联接口依据：[OS 磁盘身份](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-disk)、[物理磁盘身份与介质](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk)、[按实际文件取得卷](https://learn.microsoft.com/en-us/powershell/module/storage/get-volume?view=windowsserver2025-ps#-filepath)、[卷到分区的对象关联](https://learn.microsoft.com/en-us/powershell/module/storage/get-partition?view=windowsserver2025-ps#-volume)。原始复现、修复验证和复审记录统一保存在 `logs/verification/release-v3.2.9/ssd-baseline-identity/`。

候选 `e47e2a60` 的 11 项 PF 原已因介质 Unspecified 停止在环境预检，继续保持 NOT_RUN；旧候选仅保存磁盘编号与 SSD 字样的结果也不能补成完整设备归属证据。新实例的采集不能回填旧实例缺失的身份。环境取证修复完成后，仍须完成原 PF 和必要 Windows/Excel/WPS 人工验收。

## 50062ca0 Windows 完整门禁与剩余修复

[必需运行 35390006217](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35390006217) 最终失败：501 个单测文件、7,867 tests，7,819 PASS / 45 FAIL / 0 cancelled / 3 SKIP。完整日志共 45 条 not ok；门禁停止于单测，集成及后续 Windows 专项、build 没有执行。原始完整日志及逐条审计保存于 `logs/verification/release-v3.2.9/acceptance-50062ca0/windows-required-final/`。

- 1 项 ctime 夹具：已在 `e47e2a60` 的真实 Windows 日志观察到该用例 PASS；仍不代表整套通过。
- 4 项只读副本、2 项平盘来源：受控 Windows 覆盖拒绝与路径语义适配器复现旧版 6 FAIL，最小夹具修正后完整两文件 15/15 PASS，原生 macOS 同样 15/15 PASS。生产 guard 不变：只读替换先保留原件再放独立 inode，父目录替换保留原子文件身份；注入尚未返回的 fd 由夹具收口。平盘持久目标使用与生产相同的异步 realpath。后续短诊断 `382928f8` 的原生 Windows 两文件 15/15 PASS；不改写本节旧完整门禁失败。
- 38 项存档根迁移：包含无故障注入的正常迁移，当前完整日志未提供身份字段差异。已准备只操作临时夹具的 Windows 原始 stat/原函数诊断，取得具体差异后再修生产根因；不能将上述 6 项夹具修正冒充全部闭环。

## e47e2a60 Windows 完整门禁终态

候选 `e47e2a6077877b76b7d5cb490d4a01034a2fec27` 的 [必需运行 35392054677](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35392054677) / job `105752414750` 于 `2026-09-18T21:26:35Z` 终态失败。501 个单测文件、7,867 tests：**7,819 PASS / 45 FAIL / 0 cancelled / 3 SKIP**；全部 45 条 `not ok` 与最终统计一致，没有 TAP bailout。lint/smoke 通过，单测 exit 1；集成未执行，后续 Windows 专项与 build 跳过。

ctime 的同名 #1076 在本次原始日志 L19139 明确 `ok`，耗时 6721.7302 ms。剩余失败为 **迁移 39、只读副本 4、平盘来源 2**，不是旧 `50062ca0` 去掉 ctime 后的相同 44 项。两次共同失败 36 项：23 项错误/位置/调用栈相同，13 项诊断或到达阶段不同；9 项旧 FAIL 转本次 PASS（ctime + 迁移 8），9 项旧 PASS 转本次 FAIL（全部迁移）。迁移源码和测试在这两个提交间未变，不能把本次通过的迁移项记为已修复，也不能据阶段波动猜定某个身份字段的根因。旧 `50062ca0` 的 38 项迁移与原日志仍保留在独立目录。

原始 log/API metadata、完整审计 Markdown/JSON 与 `manifest.json` 保存于 `logs/verification/release-v3.2.9/acceptance-e47e2a60/windows-required-final/`；清单记录四个逐一复制的普通文件 SHA-256，不递归复制或跟随目录符号链接。[完整审计](../../../logs/verification/release-v3.2.9/acceptance-e47e2a60/windows-required-final/windows-build-e47e2a60-final-audit.md) 包含全部失败栈及 54 项失败并集的 old/new 对比。

隔离 Windows 短诊断已完成，完整结果及身份边界见下节；不能用它替代本节失败的完整门禁。

## Windows 短诊断 382928f8 实际结果

[Run 35397405456](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35397405456) / job `105769281602` 于 `2026-09-18T21:35:13Z` 终态 failure。head `382928f8cb0435fb69515878f1e5f9111ba74bbf`，生产基线 `e47e2a6077877b76b7d5cb490d4a01034a2fec27`；Windows x64 / Node22.23.2，workingTree 与 productionDiff 均空。checkout 日志、artifact identity 与 12 个源文件 SHA 绑定同一提交；Windows CRLF 文件的哈希均与该提交 blob 经 CRLF checkout 转换一致。未将本地 LF 字节差异误判为代码变化。

- SSD 准入专属回归 44/44 PASS；readonly + position 两文件 15/15 PASS，两者 process exit 0，无 skip。原生 Windows 的修正夹具验证通过，原 owner、独立 inode/父目录、替代文件保留与 held 保护断言均仍执行。
- 实际 PowerShell/CIM 采集 **FAIL**：`Cannot convert value "SAS" to type "System.Int32"`。PowerShell 子进程虽 exit 0，返回 JSON 含 error，wrapper 正确以 exit 1 使步骤失败；磁盘身份/SSD 证明保持 **NOT_RUN**，未把错误吞成环境 PASS。后续枚举处理修复须重新做原生采集，本次不预填修复结果。
- 迁移 `captureStatus=PASS` 仅代表诊断成功捕获失败，`productTestPassed=false`、产品子进程 exit 1。生产 guard 标量字段唯一差异为 `ctimeMs: 1789767302527.9363 → 1789767302529.9492`，dev/ino/size/mtime/birthtime/mode/nlink 均相同。诊断 `differing` 的 root/parents 是对象引用比较项，深比较内容一致，不能误报父链变更。
- 同实例原语对照中，0444 + hardlink 在最后句柄关闭后 ctimeNs 由 `1789767301944771700` 变为 `1789767301946784600`；0600 hardlink、0600 独立 copy、0444 独立 copy 在 close 时未见此变化。这明确了一条实际迁移失败的触发机制，不能宣称已解释或修复全部 39 项。后续发布身份时序修复及完整 Windows 门禁仍待验证，不能放宽 ctime、inode 或父链保护。

证据包位于 `logs/verification/release-v3.2.9/acceptance-e47e2a60/windows-short-diagnostics-382928f8/`：逐一归档原 artifact 普通文件、完整 final.log/final.json、根审计、独立审计及文件绑定记录；`manifest.json` 保存 SHA-256。[独立审计](../../../logs/verification/release-v3.2.9/acceptance-e47e2a60/windows-short-diagnostics-382928f8/windows-short-diagnostics-independent-audit.md) 区分测试通过、采集失败和迁移产品失败；该短诊断未运行完整 release-check、正式 PF、安装包或人工验收。

## Windows close、SSD 枚举与陈旧 prefix 追加修复

在旧 `382928f8` 诊断之后，第一版修复针对已复现的迁移发布时序 P2：Windows 只读 hardlink 的原写 fd 关闭后更新 ctime，先前快照因而过期，正常迁移被身份 guard 拒绝。新顺序先在原 fd 仍存续时绑定只读 witness fd、完整身份及原根/父链，再仅允许本次真实 chmod 所产生的 mode/ctime 过渡；关闭写 fd 后由原 witness 读取最终身份。未 chmod 时 ctime 仍须不变，同 SHA 替代 inode、mtime/nlink、父目录替换以及持久化后的 ctime 变化继续拒绝。未放宽 owner、原件、共享引用、journal 或删除授权。

另修复实际 PowerShell 显示枚举 `SAS` 不能转 int、祖先遍历提前停止的问题：从 CIM 属性取带类型的原 UInt16 值，保留原值/显示值，不把未知类型推定成 SSD；使用原生 FileInfo/DirectoryInfo 遍历到卷根。三文件只涉及采集器及回归，原设备身份准入、SSD 条件和 PF 预算保持不变。

新增迁移→重开→删除集成同时复现陈旧 prefix 清单 P2：正常删除已经移除空分片后，pause/close 的只读孤儿扫描仍 lstat 旧路径并抛 ENOENT。修复只容忍重新确认缺失的 prefix；根离线、权限、路径类型、符号链接仍失败。独立审查又发现第一版 fallback 可把同路径普通文件当空目录；最终补充二次存在检查，重新出现的文件/目录均拒绝，cursor 不推进且替代文件保留。

| 本机验证（Node24.13.0/macOS） | 结果及边界 |
| --- | --- |
| migration 正常 close 回写 | 原代码 + 最终私有 fixture 2 FAIL，修复后 2 PASS；仅模拟同一真实 dev/ino 的 close ctime 回写 |
| migration 全文件旧时点 | 114/114 PASS（原102 + 最初12），之后再加4条 witness open 负例；当前定义118，不声称完整118已重跑 |
| 最终新增16项 / 独立14负例 | 16/16、14/14 PASS，均无 skip；原 fd→witness 的文件/父链替换和未 chmod ctime-only 均拒绝 |
| SSD 三文件 | 44 PASS / 0 FAIL / 1 Windows PowerShell 专属 SKIP；受控 Storage 对象不替代实际 CIM |
| prefix 消失与错误边界 | 前态2 FAIL / 3 PASS；最终专项9/9、完整 archive-service 文件76/76 PASS |
| prefix 独立类型替换 | 第一版 rejected=null/cursor1；最终 ARCHIVE_BLOB_PATH_INVALID/cursor0，替代文件内容保持 |
| 永久删除真实集成 | 52/52 PASS，覆盖 Lifecycle owner→migration→DB/controller重开→确认token→删除及外部原件保护；运行早于 prefix 最终二次存在确认，未记为最终十文件冻结后重跑 |

第一版迁移五文件与 prefix 两文件的本机独立复审未见新增可行动 P2+；随后原生失败推翻了迁移仅在 chmod 后需要吸收 close 元数据变化的假设，迁移 P2 保持未闭环。本轮十个冻结文件及所有对应日志、差异和独立探针逐一归档于 `logs/verification/release-v3.2.9/repair-windows-migration-close/`，`source-manifest.json` 绑定代码 SHA，`manifest.json` 绑定证据 SHA。[证据摘要](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/summary.json) 与 [prefix 独立复审](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/orphan-prefix-review/review.md) 可追溯到各次实际输入；旧 handoff 与失败日志保留原时点，不覆盖。

原生最终修复诊断 [run35399134894](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35399134894) / head `68ed9cb7351977219e66d605b7360f0e6255ead5` 已终态失败。独立完整审计得到ArchiveService76/76 PASS（含prefix9项），迁移118项55 PASS/63 FAIL，合计194 tests、131 PASS/63 FAIL；新增16项原生7 PASS/9 FAIL。集成36 PASS后第37个正常迁移失败，后15项含新增close两例均未执行。capture明确产品FAIL：canonical mode33206、未chmod时，自有link/unlink后的writer.close仍使ctime变化，只有该标量变化。这推翻第一版“仅chmod需要接受close元数据变化”的假设，作者继续修复；本节所有本机PASS仅保留其实际输入适用范围。SSD45项及实际查询成功，8级祖先及原UInt16证据完整，但虚拟机缺宿主介质证明，SSD证明仍NOT_RUN；19个源码SHA与诊断head及CRLF转换逐个一致。该head仅为隔离诊断分支，不表示 release 修复已提交。本轮 release 工作树改动尚未提交，最终完整门禁未重跑；旧 e47 完整 Windows 门禁仍为失败，最终 Windows、SSD 证明、PF、候选包及人工验收均不预填 PASS。

## 第二轮 Windows 短诊断 68ed9cb 完整审计

[Run35399134894](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35399134894) / job105774763495于2026-09-18T22:00:35Z终态failure；head `68ed9cb7351977219e66d605b7360f0e6255ead5`、Windows x64/Node22.23.2。完整日志/API/artifact身份一致，workingTree为空，生产差异只有ArchiveService及storage-root-manager。19/19文件SHA匹配Git blob经Windows CRLF checkout后的字节；其中10个匹配第一版修复冻结LF清单。后续工作树修订不得反向改变本次运行身份。

完整TAP194项：ArchiveService76/76 PASS、迁移118项55 PASS/63 FAIL；0 cancelled/0 SKIP，无bailout。178个顶层项及16个嵌套项全部纳入；63条失败由62个testCodeFailure及1个subtestsFailed父项组成，与Node最终统计相等。prefix九条顶层#44–52全部PASS，可在输入SHA不变时复用。迁移新增16项在原生为7 PASS/9 FAIL，不能用本机通过替代。

capture明确产品FAIL：`_copyBlobs`的canonical发布在`_publishMigrationTarget:1769`比较失败，mode33206/0666，ignored=[]；唯一标量差异`ctimeMs:1789768575103.0813→1789768575105.5935`，dev/ino/size/mtime/birthtime/mode/nlink均相等。这证明自有link/unlink即使未chmod，也可能在writer.close回写ctime；第一版仅chmod假设不成立，迁移P2继续修复。63项其余失败还包括未抵达注入阶段、目标尚未生成、Windows替换EPERM；例如#169 wx witness-open file实际是`ARCHIVE_MATERIALIZATION_FAILED/EPERM`，不能称身份guard已通过。三个FileHandle GC关闭警告及DEP0137保留原日志，不凭警告推定独立产品根因。

集成脚本退出1、signal=null，前36项PASS，第37项正常迁移失败（fixture:288→integration:585），后15项NOT_RUN，两条新增close场景未执行。readonly+position15/15 PASS。SSD45/45 PASS、0skip，新增PowerShell contract实际执行；实际CIM查询成功，8级祖先、原始类型记录完整，目标Bus10/SAS、MBR1、VPDformat3、Media0/Unspecified；主机明确为虚拟机，缺宿主介质证明，因此SSD准入NOT_RUN正确，未运行正式PF样本。

证据追加至`logs/verification/release-v3.2.9/repair-windows-migration-close/native-68ed9cb/`，`manifest.json`逐文件记录SHA-256。[完整审计](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/native-68ed9cb/windows-second-diagnostics-complete-audit.md)列出全部63条失败，JSON保留原诊断栈及194条TAP索引；[SSD独立审计](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/native-68ed9cb/ssd-enum-repair/windows-second-audit.md)记录原生采集和NOT_RUN边界。此短诊断不替代完整release-check、Windows build、PF或人工验收；第三版修复与新原生运行结果尚未在此记录预填。

## 第三轮 Windows 迁移修复 8779c029 闭环

[Run35400518166](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35400518166) / job105779109165于2026-09-18T22:17:52Z终态success，head `8779c029ac94c859681d582bff378b426686dc09`，Windows x64/Node22.23.2。最终迁移完整121/121 PASS，0FAIL/0cancelled/0SKIP；111顶层及10嵌套ok与最终统计一致。永久删除集成52/52 PASS，包括第二轮未执行的link/wx写句柄关闭回写ctime→重开DB→确认token→真实删除两例。产品取证captureStatus=PASS且productTestPassed=true、identityDiffs=[]；三个过程均exit0/signal=null。全文无FileHandle GC关闭或DEP0137警告。

此版只在本次确实完成link成功、nlink加一、staging unlink成功且nlink恢复的元数据事务，或本次真实chmod后，允许原writer.close的ctime过渡。mode仍仅由真实chmod解释，wx无link/chmod仍严格拒绝ctime变化；inode/size/mtime/birthtime/nlink、原父链、关闭前witness绑定、关闭后路径比较及持久journal ctime保护均保留。Windows替换夹具先移位并保留原inode再放新对象；最后的夹具加固只保证底层close确实成功后重复close幂等，首次hook异常仍抛出，底层close失败不伪装成功。生产SHA在夹具最后加固前后始终相同。

| 验证时点 | 实际结果 |
| --- | --- |
| 新canonical link/unlink正例前态 | 受控原代码1FAIL，保留原失败日志 |
| 本机最终fixture加固前 | Node24.13.0/macOS，全文件120/120、集成52/52；当时新增边界18/18 |
| 最终fixture加固后本机 | 新微回归前态1FAIL；最终相关19/19 PASS、独立微回归1/1 PASS；没有本机完整121重跑记录 |
| 最终原生第三轮 | 完整迁移121/121、集成52/52；最终相关19项均包含在121中实际通过 |
| 独立审查 | 最终五文件manifest一致，无未解决可行动P2+；早期4项与后续1项各保留自己的输入摘要 |

19/19运行源码SHA与诊断Git的LF或Windows CRLF checkout字节逐一匹配；最终五文件又同时匹配release当前磁盘字节、冻结manifest与诊断Git。生产文件`storage-root-manager.js`的SHA-256为`43d6d98ad5ba0e1b2c91d2778251625a3211a4d57199285f8212dda4b05a723c`；最终测试/fixture分别为`866ccef6ea245c6b5943d1b843b71e187d2942873cc9fe87993d9a1434205607`、`9bbbd2cc940829cf43ee6699fd43751b5b1315f1524707473f00852d40f3ce72`。两份集成文件自第二轮未变，完整五文件清单随证据归档。

14/19输入与第二轮相同。ArchiveService76/76及prefix9项、SSD45/45与readonly+position15/15保留其第二轮原生证据，可按未变化输入复用，不称本轮重跑。Service76项属于第二轮合并测试进程的通过段；该合并进程因迁移失败exit1，不能写成Service独立进程exit0。第二轮实际CIM查询成功，但虚拟机无宿主SSD介质证明，SSD准入仍NOT_RUN；第三台runner未做磁盘取证，不能把前一实例的环境结果移植过去。旧失败和当时的待验报告均按历史时点保留，不覆盖。

迁移close P2在冻结修复和专项原生验证范围内闭环。最终本地`release-check`已启动，当前RUNNING（root session67830、日志`release-check-windows-repairs.log`，冻结清单`gate-inputs-windows-repairs.json`），不得沿用旧7864/2575门禁作本次PASS；完成后仍须核对实际测试结果及最终候选输入未变化。本记录生成时本轮候选待提交，最终门禁进行中；实际候选SHA以后续PR与外部记录为准，诊断head不表示main/tag/发布。最终完整Windows gate/build、正式SSD PF、原始独立Worker RSS以及必要Excel/WPS人工均未完成；没有修改原PF或RSS验收合同。

本轮限定证据位于`logs/verification/release-v3.2.9/repair-windows-migration-close/native-8779c029/`，`manifest.json`仅包含逐个白名单普通文件与SHA；最终五文件副本、作者manifest、旧120本机/最终19日志、独立review和完整原生artifact/API/log均保留。[第三轮独立审计](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/native-8779c029/windows-third-diagnostics-audit.md)、[最终五文件manifest](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/native-8779c029/windows-migration-diagnostics/migration-round3-files.json)及[复用证据索引](../../../logs/verification/release-v3.2.9/repair-windows-migration-close/native-8779c029/reuse-index.json)可追溯到原prefix审计及第二轮SSD证据。仅追加证据，不重跑或覆盖前两批归档。
