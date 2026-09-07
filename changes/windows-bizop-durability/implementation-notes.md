# Implementation Notes

## Baseline

- 需求、约束与未知见 spec.md。基线 v3.2.7 / efd4c302。
- 用户要求 Windows 新版完整可用；不采用仅恢复启动并回退旧模块的方案。

## Decisions

- Windows 探针已证明目录可写句柄可真实落盘：共享目录屏障、Publisher 和旧文件回收改用 Windows 可写目录句柄，候选分片用 O_RDWR。POSIX 目录保持只读；不更换存储格式或迁移策略，不忽略新增错误。
- 既有稳定版本与原工作目录保持原状，开发在独立 worktree / 分支进行。
- 文件原件、用户数据库和日志仅只读；复现使用临时 SQLite 与合成旧业务数据。

## Evidence

- Windows 探针 run 34099429931 / ac6aa4dc 成功；Node 22.19.0、libuv 1.51.0、Windows 10.0.26100.0。文件和目录 r 均 fsync EPERM，r+ 与 O_RDWR|O_SYNC 成功；原生 Win32 GENERIC_WRITE/READ_WRITE + BACKUP_SEMANTICS + FlushFileBuffers 成功，GENERIC_READ 失败。不使用卷级 flush 或主动开启备份/恢复权限；runner 结果不代替目标用户权限验收。链接：https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/34099429931 。
- Electron 36.9.5 / Node 22.19.0：隔离故障复现 3 PASS / 0 FAIL / 0 SKIP。两类预检失败的外层 ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED 和内层错误均与日志一致；未创建激活记录或升级 Task，旧行、设置、旧月文件和外部原件摘要一致。
- 微软 FlushFileBuffers 文档要求 GENERIC_WRITE；卷级 flush 需要管理员权限，不能作为普通用户产品的默认路径：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers 。
- Electron 实际 libuv 1.51.0 对应源码：https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c 。

## Remaining Unknowns

- Windows 源码正常应用全链路已经通过；完整合同回归、打包程序与普通目标设备权限验收尚待完成。
- 当前不宣称安装包已交付或人工验收完成。

## Implementation Findings

- 完整本地回归发现最小候选验证入口用 copyFile 复制只读归档，会继承只读权限；封存改用可写句柄后暴露 EACCES。仅将新建的自有候选设为 0600，原件权限和字节不变；正常 XLSX 导入/计算生成的分片已有写权限。
- 资源预检保留现有 1 GiB 阶段预算和有界拒绝合同，错误文案增加实际可用预算与预算上限；不通过低报 worker 占用来绕过保护。本机正常 Electron 启动实际触发该预检，不能将本地启动记作通过。
- 复核输入归档至导出交付路径，存档中心的归档、物化、根目录迁移及 outbox 也存在同类只读目录调用；一并修正 Windows 打开方式，保持各自原有错误传播/兼容处理，纳入既有归档回归。
- 本地归档补充回归 126 PASS / 0 FAIL / 0 SKIP；落盘/Publisher 86 PASS；候选/升级资源补测 46 PASS。首轮完整 429 项中的 12 个只读副本失败已在对应候选套件补测覆盖；不把首轮整体结果改写为 PASS。
- Electron default_app ESM 初始断点不适合验收控制，改成正常启动后连接 loopback inspector。独立临时探针以测试 Host 预激活数据库，仅验证接入：真实主窗口、单实例锁、ACTIVE / recoveryReady IPC 和正常退出成功。此探针不证明正常首次激活或完整业务流程；Windows 正式验收不使用预激活捷径。
- 草稿 PR #238。Windows 完整合同与源码/打包正常应用验收仍等待实际 CI 结果，不交付半成品。

## Blindspot Review

- 已覆盖：不再把只读句柄 EPERM 解释为平台必然不支持；所有 BizOP 候选/旧文件回收和归档至 Publisher 路径均检查句柄方式。错误/unsupported 保护、句柄关闭和原件不变保持原合同。
- 已覆盖：副本继承只读权限的问题已定位到最小候选验证入口；只修改新建副本权限，没有改变归档原件或业务内容。
- 无新增金额、币种、账户识别、结果行处置或迁移清理范围变化；未发现由本次修改引入的资金红线。计算/输出和各提交边界恢复由现有完整业务合同与实际 IPC 验收覆盖。
- 存活验证项：Windows 普通目标设备人工验收、真实在线升级后启动，以及最终打包产物验证。不得用本地 fixture 激活、源码应用或原生 API 探针替代这些结论。

## Windows Full Contract Findings

- run 34102085643 / 1bda3a21 实际执行 555 项：522 PASS / 32 FAIL / 1 macOS 专属 SKIP，约 20 分钟。未把目录能力成功等同于新版完整可用。
- 产品问题：export-validator 将 Windows 大文件编号以 Number 写入导出候选凭据，引发 CANONICAL_JSON_INTEGER_UNSAFE，并使多个导出、Publisher 故障恢复和终态测试提前在候选生成阶段结束。改为 BigInt 无损的 fileIdentity v2；兼容读取旧安全数值证据，金额与工作簿合同不变。
- 测试问题：两个 manifest 取消注入使用固定 `/`，在 Windows 未触发；归档目录 EIO 注入只识别 r，没有识别修正后的 r+。改为宿主路径/访问方式，仍要求故障实际注入并阻断提交。
- 测试清理问题：升级崩溃测试先注册 root 删除，后注册 Host 关闭；SST 测试先注册 Host 删除，再注册 spool 关闭。Windows EBUSY 暴露 FIFO 清理顺序，后续故障注入未正常复原产生连带错误。调整为先关闭自有 SQLite/spool 再清理，SST 生产关闭实现暂不改动，待真实 Windows 再验证。
- 第二轮本地导出/大 SST/文件身份/归档补测 76 PASS / 0 FAIL / 0 SKIP。新增相邻超大 inode 的无损区分、可序列化性、新旧身份兼容与文件变更拒绝检查。
- b7297de3 本地完整 release-check 已完成：7287 PASS / 3 SKIP / 0 FAIL；53 个集成脚本、2488 个检查全部通过。该结果在第二轮导出凭据修复之前，不替代后续 Windows 与最终提交完整 CI。

## Final Production Code Validation

- 045524a6 本地完整 release-check：7289 PASS / 3 SKIP / 0 FAIL，53 个集成脚本 2488/2488 PASS。Node 25.8.0 / macOS；生成的统计文档单独保存，不混入修复。
- 相同提交的 macOS 正常 Electron 应用 21 个步骤 PASS。使用真实首次激活与生产配置，不再使用预激活 fixture；启动时本机空闲内存已回升至约 4.25 GiB，真实资源预检通过。此前低预算失败仍保留为独立事实。
- Windows 正常应用 job 101689257082 / run 34105439921 实际 PASS：Windows / Electron 36.9.5 / Node 22.19.0 / 3.2.8，21 个步骤、单实例锁、首次激活、四类数据目录、计算、七类导出、删除和导入中断恢复通过；原件摘要不变，恢复任务为 failed / BIZOP_NOT_COMMITTED。
- Linux job 101689265666 / run 34105442854：294 PASS / 0 FAIL / 0 SKIP。
- Windows 同轮完整合同触及 30 分钟 job step 上限；已输出到 128 个真实来源恢复测试通过。已输出段只有一条 succeeded / Hold=true / retry 用例失败，子进程 45 秒后 status 为 null；邻近通过用例总耗时为 20～32 秒。该轮不能记作 PASS。
- 据此将 C2 恢复与业务/归档合同分组，原测试文件集合和断言不减少。Windows 终态恢复测试子进程上限调整为 120 秒并同步输出阶段日志、错误码和信号，便于区分仍然卡住与实际磁盘恢复成本；POSIX 原 45 秒与生产所有等待合同不变。
- 用户已确认“直接合并修复 PR，以 3.2.8 发布”。完整 Windows 和打包门禁通过后直接合入 main；普通用户设备、安装器和在线升级人工项目继续分别记录。
- run 34109145371 / 99ecb246：正常 Windows 应用与目录探针再次通过。归档合同实际 201 PASS / 0 FAIL / 1 macOS 专属 SKIP，C2 恢复实际 61 PASS / 0 FAIL / 0 SKIP；两组在测试完成后被 PowerShell 默认不区分大小写的 `# SKIP` 搜索误判，匹配到了汇总 `# skipped 0/1`。修正为仅匹配 TAP 用例结果上的完整 SKIP 指令，并用两份真实日志及新增未知 skip 样本核对守卫。
- 分组复核发现 32/128/1024 个真实 Task 的规模恢复实际位于 biz-op-v327.test.js，将该文件与 C2 一起放入恢复组。原 27 文件分为 20/2/5，文件并集不变、无重复；生产源码和版本不变。
