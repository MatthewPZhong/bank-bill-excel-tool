# 本地验证与待验收 — BizOP／按行拆分低内存

> 2026-09-30；分支 `v3.2.11-bizop-rows-low-memory`；固定基线 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`。
> 第二轮 R4 并发修复后的完整本地实现及最终 `release-check` 已通过，退出码 0。Windows 验收按用户答复保留待办；生产低档资格保持 pending。

## 实现范围

资源配置与实时准入已接通 prepare、rows 全链和 BizOP 全链；获批配置确实约束 reader、缓存、SQLite、writer 和验证器。字段值改为显式按需读取。28 个原生载体点与默认 Main IPC／已定位后台维护加入活动观察，实际 exit 之前不释放。

生产资格保持 pending。候选档在明确的 non-production 自动验证中运行；普通生产路径仍用兼容额度，因此目前不能声称用户 Windows 上的原始痛点已正式关闭。

## 审查修复

R1／R2／R3 及 `forkChild` 修复保持；第二轮补齐 R4 并发排队缺口，见 [第二轮修复报告](review-fixes/2026-09-30-r2/fix-report.md)。内部观察只在证明队首依赖当前 legacy 活动时先执行，随后仍执行完整资源和 scope 检查。空恢复继续经过真实 discovery／execute；共享 Publisher 保持基线兼容资源约定，BizOP legacy 观察保留既有额度，获批档位预算、未知增长观察和真实退出屏障均有回归。

## 自动检查

| 检查 | 当前结果 | 证据范围 |
| --- | --- | --- |
| `npm run release-check` | PASS，exit 0 | 最终完整执行 lint、architecture、smoke、全量 unit 和 integration；历史失败保留在下节。 |
| 发布恢复专项 | 18/18 PASS | 真实 Governor／IPC wrapper／协调器／Worker；空启动、错误保留、normal/low、实际退出，以及同优先级队首、错开截止时间、取消队首。 |
| R4 定向单测 | 88/88 PASS | 新增 16 项 continuation 用例，含中间普通请求、无关队首、资源不足、身份伪造及过期。 |
| 自动报告＋合表 | 2/2 PASS | 真实异常导入、自动报告先排队、Main execute／生成 Worker／Publisher／归档／ACK；normal/low 均成功。 |
| 全量 unit | 9512 PASS／0 FAIL／4 SKIP（9516 总计） | 590 个文件；4 项跳过均要求 Windows PowerShell 或 Windows packaged canary 环境。 |
| architecture | PASS | 779/779 文件解析通过，31 active；原有 2 个未解析项和 33 个动态位置按现有基线检查，未声称全图静态可解析。 |
| 全量 integration | 73/73 脚本 PASS | 72 个脚本报告合计 2942/2942；另一个 nested Worker 脚本未报告数量，退出码为 0，不混进 2942 的分母。 |
| Renderer 生命周期 | 241/241 PASS | 真实 Electron Renderer 夹具；Toolbox 20/20，含新增 6 个异步竞态用例；不等同于 Windows 完整应用人工验收。 |
| 既有大文件回归 | 50/50＋31/31 PASS | 保留默认 30 万行，以及 50 万／150 万行多 Sheet 规模和原内存判定阈值。 |
| 普通／低档完整链路 | 4/4 PASS | 实际 Worker、rows 发布和恢复、OP 六类导出；1000 行合成输入，512 MiB 为调度注入。 |
| 65 MiB CSV 公共读取 | 4/4 PASS | 普通档真实 Worker metadata 与单字段；rows 超限拒绝，无公共 64 MiB 门槛。 |
| CSV 基线语义对比 | 512/512 相同 | 固定 main 公开 readRows 的确定性样本摘要；包含引号、换行、Unicode 与空值错误分支。 |
| 样式 LRU 与 rows 回归 | 17/17 PASS | 淘汰重载、样式/文本/日期、9 份真实输出和归档、失败、取消、恢复。 |
| OP 低档专项 | 4/4 PASS | import/compute/六类 export、含错误行及超过 1000 样本的真实自动错误报告。 |
| 资格与活动观察 | PASS（并入全量 unit） | 旧源码／依赖／runtime／重复报告／缺格式／注入数字拒绝；未知增长、旧 runtime、真实 exit。 |
| 2 万行完整探针 | 2/2 PASS，结果相同 | 独立进程 normal/low 各一次；实际系统采样，但 512 MiB grant 条件是注入值。源码摘要已与最终工作区核对相同。 |

机器可读证据见 [最终门禁摘要](local-gates-summary.json)，完整输出见 [通过的 release-check 日志](../../../logs/low-memory/20260930-r2-release-check-2.log)。该轮运行覆盖最终代码和测试；之后只更新交付文档与文件摘要。

## 完整探针与复现

[最终完整链路报告](local-capacity-probe.json) 绑定源码摘要 `bb537fa243d6f2c77f0e29a28829be1485d4bf53b4d79f3674165e874117b884`，运行环境为 macOS arm64／Node 25.8.0。两档分别完成 20,000 行合成输入、21 个记录阶段、34 次资源 grant；覆盖 8 类 phase profile。rows 输出及 OP 六类导出业务摘要完全一致。

| 档位 | grant 可用内存输入 | 实际选中的阶段额度 | 结果 |
| --- | --- | --- | --- |
| normal | 注入 2048 MiB | 256／768 MiB | PASS |
| low | 注入 512 MiB | 128／256／384 MiB | PASS |

这些额度是候选配置和调度账本数值。探针使用真实 Worker、SQLite 和发布文件，但未制造物理内存压力；PID RSS 包含 Worker 及独立结果验证器，不能把该报告当作“在 512 MiB 实际空闲内存下通过”或内存下降百分比证据。测试与全量门禁并行，耗时也不作为正式性能基线。

复现时在本功能 worktree 执行，输出路径需为新文件：

```sh
npm run release-check
node scripts/verify-low-memory-capacity.js --rows 20000 --repeat 1 --output <新的报告路径.json>
```

Windows 真压力运行及正式计分要求见 [待验收操作说明](windows-acceptance.md)。历史 `local-capacity-attempt-3-passed.json` 与 `local-capacity-attempt-4-passed.json` 保留当时源码身份；不替代最终报告。

## AC01—AC24 对照

LOCAL 表示实现和本地自动证据已具备；涉及真实容量、平台行为的子项仍受 Windows 待验收限制，不能据 LOCAL 声称整项正式验收通过。

| AC | 当前结果与证据 | 仍需的平台验收 |
| --- | --- | --- |
| 01 | LOCAL：H/Bcompat 与 F 分开，Governor 不重复扣 U。 | 最终 Windows 构建复核。 |
| 02 | LOCAL：准入实际 grant 替换阶段额度；512 注入下完整链路通过。 | **生产低档未启用；真实低内存可用性待验收。** |
| 03 | LOCAL：grant 前新鲜采样、排队变化、重入／取消反例。 | 系统压力下真实采样。 |
| 04 | LOCAL：低档排他、28 载体 guard（含解构别名）、Main 工作、旧 runtime 和未关闭负例。 | Windows 特有载体与完整 Main 并发。 |
| 05 | LOCAL：Bcompat=0、稳定拒绝、后继低档、取消／释放；其他 action 保留兼容门槛。 | — |
| 06 | LOCAL：metadata 不返回全字段集合；prepare 探针包含 Worker 创建前。 | 真实 GUI 从选文件开始测峰值。 |
| 07 | LOCAL：共用 SPLIT 计数，隐藏／空／跨页和重复表头回归。 | 代表工作簿。 |
| 08 | LOCAL：生产 Renderer 懒加载、默认首字段／单列、多组、重试和迟到隔离；加载中双向切模式及删除／改动发起组均可选值提交。 | Windows GUI 操作复核。 |
| 09 | LOCAL：cancel/destroy/异常关闭之后清理和释放，缺 closed 保留租约。 | Windows 强退／文件锁。 |
| 10 | LOCAL：SST 强制 spill 与高唯一文本完整探针，内容一致、目录关闭。 | 大样本真实峰值。 |
| 11 | LOCAL：样式 LRU／metadata 预算、writer 释放后回读；峰值采样机制。 | 高样式与叠加峰值正式证据。 |
| 12 | LOCAL：SST/ZIP/SQLite 构造、取消、关闭失败及残留所有权回归。 | 平台清理失败。 |
| 13 | LOCAL：normal/low 行数、顺序、拆分边界、编号文本与样式对比。 | Excel/WPS 人工核验。 |
| 14 | LOCAL：真实 write callback 等待、慢消费者、流关闭／错误及单条预算。 | Windows 慢盘完整峰值。 |
| 15 | LOCAL：全产物验证后一次发布；故障、目标变化、journal 恢复回归。 | Windows 中断恢复。 |
| 16 | LOCAL：N／1000 份／64 MiB 作用域、65 MiB 公共读取、拒绝与资源失败。 | CSV/XLS 格式容量。 |
| 17 | LOCAL：OP 导入、计算、六类导出、独立业务摘要相同。 | 脱敏代表业务样本。 |
| 18 | LOCAL：1100 错误行触发既有 1000 样本上限，自动报告真实发布；不改计数规则。 | 故障／真实业务接受度。 |
| 19 | LOCAL：直接 IO 租约统一选择 phase；Publisher、自动报告验证和恢复获得配置。 | 生产资格取得后实际低档启用。 |
| 20 | LOCAL：借用观察、真实载体关闭、恢复和跨代排他；legacy wrapper 内观察沿用原额度；包含受阻队首的间接依赖也能完成，自动报告与合表真实并发链成功。 | Windows 强退重启完整链。 |
| 21 | LOCAL：外部资源变化可经定时复核和重试感知；已资格目标不依赖启动 F。 | 关闭外部程序后真实重试。 |
| 22 | LOCAL：压力技术错误、权限／空间／取消／发布崩溃保护回归。 | Windows 系统压力、磁盘和权限。 |
| 23 | **PENDING WINDOWS**：本地注入与真实样本分开，验证器开销单列。 | 正常／512／768 MiB 真压力。 |
| 24 | **PENDING QUALIFICATION**：源码／依赖／runtime／格式／报告 gate 已实现，生产 pending。 | 最终包体、性能阈值和支持矩阵冻结。 |

## 保留的失败记录

- 本次第一个完整门禁在 ARCH-PLATFORM-CORE 发现 core 直接依赖 Main 活动模块，已改为静态 provider 注入，最终完整门禁重新通过；[失败日志](../../../logs/low-memory/20260930-r2-release-check.log) 保留。首次并发业务夹具遗漏真实 Archive controller，已补入；[失败诊断](../../../logs/low-memory/20260930-r2-business-concurrency-diagnostic.log) 保留。

- `local-capacity-attempt-1-failed.json`：合成 fixture 使用过多 fill，命中既有安全上限，产品上限未放宽。
- `local-capacity-attempt-2-failed.json`：导出说明页技术身份不同导致摘要不等；业务页一致，对比脚本已精确规范动态字段。
- 65 MiB CSV 曾触发 Worker OOM，随后修复逐字符拼接工作集并通过固定基线语义及真实 Worker 回归。
- 首轮全量单测为 9488 PASS／6 FAIL／4 SKIP（9498 总计）；公共依赖方向已修正，精确新增 IPC 清单与旧形态断言已更新。修复后的相关 82 项通过；最终完整门禁也已通过。
- 第二轮完整门禁的 unit 为 9495 PASS／0 FAIL／4 SKIP；integration 为 69 个脚本通过、2 个失败。两项失败来自提取 Main 源码的测试宿主未注入新增 owner；补入真实 factory 与窗口 sender 后分别通过 2/2。当轮生产源码未因此调整，容量报告与当轮实现的源码摘要匹配；该记录保留为历史证据。
- 局部测试曾因测试夹具存储根目录不符合 Publisher 归属、精确 IPC 数量更新遗漏失败，已修正；最终门禁仍单独计数，不把历史失败删除或改成通过。

原始失败日志保存在本 worktree 的 [第一轮门禁](../../../logs/low-memory/20260930-release-check-attempt-1.log) 与 [第二轮门禁](../../../logs/low-memory/20260930-release-check-attempt-2.log)。两项集成宿主修复后的记录为 [资源准入回归](../../../logs/low-memory/20260930-rows-admission-repaired.log) 和 [归档删除回归](../../../logs/low-memory/20260930-rows-archive-repaired.log)。`logs/` 按仓库规则被 Git 忽略，单独拷贝文档时需同时保留原始日志；最终证据摘要另记录日志 SHA-256。

## 交付与剩余项

代码、文档、探针均位于功能 worktree，未提交／推送／合并／发布。无新增第三方依赖，无版本号更改。[开发文件清单](development-manifest.json) 记录最终文件大小、SHA-256 与集合摘要。后续在取得 Windows 环境和代表样本后执行 [Windows 验收](windows-acceptance.md)，评审参数与支持矩阵，再冻结生产资格。
