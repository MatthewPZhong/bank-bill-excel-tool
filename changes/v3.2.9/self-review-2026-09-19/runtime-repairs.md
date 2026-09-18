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
