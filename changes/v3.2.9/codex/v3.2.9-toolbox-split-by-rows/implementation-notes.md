# 按行拆分实施记录

## 范围与状态

用户于 2026-09-18 授权直接修订文档并按 v2 Spec/TechDoc 实施，D1–D8 按文档默认口径整体采用。

2026-09-18 审查修复：R01–R04 均核实成立并已修复；最新验证与边界见 [修复记录](review-fixes-2026-09-18.md)。原审查报告和原始证据保留，以下实施阶段门禁记录不因局部修复通过而改写为通过。

同日第二轮修复：R05 的父目录身份传递缺口已复现并修复，见 [第二轮修复记录](review-fixes-2026-09-18-r2.md)。本轮 221 项关联单测及 smoke 通过；完整发布门禁状态仍沿用下述记录。

- 分支：`codex/v3.2.9-toolbox-split-by-rows`。
- 实际基线：`main@2ba9ef14fe972363b604955636cff0c9ac53700f`；本地没有 `origin/v3.2.9`，不虚构该引用。
- 实现位于隔离 worktree；原工作区的 VCC 等未提交改动保持原状。
- 下载目录的 v2 Spec 和本分支 Spec 均已修正完成按钮条件：行数有效、本次导入计数可用且 R＞0、预计 K 未超限。
- 功能已实现，专项验收及 53 个集成脚本全部通过；完整 `release-check` 因一项既有 Biz OP 进程恢复用例超时返回失败，该用例单独复跑通过。未提交、未推送、未发布。

## 已实现行为

“值”下方新增 `按行拆分` 勾选框；勾选后禁用字段/值/旧多文件入口，显示输入框和“行”。默认不勾选、输入为空；仅同一弹窗内保留行数与字段选值草稿。严格十进制正安全整数校验，前导零规范化；按用户最新要求不展示预计份数行；空数据、导入计数缺失或预计超限均不可提交。

`split:read` 普通和大文件通道均增量返回相同 SPLIT 语义的 `dataRowCount`。主进程保存计数、token 和源快照；rows 不读取字段过滤条件。R/N 用整数运算得到 K，先拒绝 0 行及超过 1000 份，再选择一次目录及冻结 FilePlan。K=1 也使用目录选择；文件名为 `原名_按行拆分_0001.xlsx`。

公开 IPC 仍是 `toolbox:split:export`；内部只走 `toolbox:split-rows` managed Worker，没有 rows 主线程生成或旧路由掩码回退。一次任务关联原件和 K 个输出。私有 SQLite 缓存使用现有 typed codec，封存前回读校验全部行、样式实体及引用；读取器关闭后通过缓存独立恢复样式。单个 writer 完成 commit、校验和 stream close 后才创建下一个；N 超过 Sheet 容量时在同一个文件内续页。

全部输出通过计数、归属、文件大小及摘要验证后才调用一次现有 Publisher。发布中断沿用 durable journal 恢复，不声称跨文件系统原子提交。rows 没有中间缓存恢复；重试使用新的私有目录及 attempt。

2026-09-18 界面简化：按用户要求移除“预计生成 K 个文件（每份最多 N 行，不含表头）”整行及其 DOM/CSS；内部 K 计算、行数校验、超限提示与完成按钮保护保留。删除后复跑 21 项交互及 4 项主题检查全部通过，截图与 UI 结果证据已更新；renderer 语法检查通过。

## 实际文件职责

| 文件 | 职责 |
|---|---|
| `src/main-process/toolbox-row-split/contracts.js` | 参数、范围、命名、消息和磁盘预算 |
| `cache.js` | typed SQLite 缓存、全量样式、封存与回读 |
| `executor.js` | Worker 内缓存和逐个输出生命周期 |
| `service.js` | 主进程预检、冻结计划绑定、结果复核及调用 Publisher |
| `policy.js` / `worker-entry.js` | 独立 action、资源占用及执行入口 |
| `src/main.js` | 导入计数/token、模式分派、单任务 FilePlan、发布/归档接线 |
| `src/renderer-dialogs.js` / `src/styles-gemini-extra.css` | 正式页面控件、数量上限校验、状态切换和成功结果 |
| `src/main-process/toolbox-output-writer.js` | 增加仅对已提交 writer 使用的 `release()`，实际关闭文件流 |
| `src/main-process/toolbox-background/worker-host.js` | 提供受同一协议校验的同步取消轮询；旧执行器无需调用 |
| `src/main-process/background-execution/*` | action、binding、资源/验证器和冻结摘要注册 |
| `src/main-process/archive-center/file-plan.js` | 等价路径/硬链接判重改为线性身份采集，保留发布前 freshness |

`src/preload.js` 的现有参数/结果透传已核对，不需要新增 IPC。TaskPolicy 仍为既有 `toolbox:split:export`，134 项业务 TaskPolicy inventory 不变；内部 action 从 66 增加到 67，binding pair 从 73 增加到 74，更新绑定合同 SHA-256，没有数据库迁移。

## 资源边界

这些是失败保护预算，不能解释成任意形状数据均已通过容量验收。

| 资源 | 上限/策略 |
|---|---|
| 输出文件 | 1000；旧字段分组保持 8 |
| CSV/XLS 原始文件 | 64 MiB；现有 reader 会物化源表，超过时任务前提示转为 XLSX |
| 单条 typed 记录 / 样式实体总量 | 8 MiB / 64 MiB |
| 缓存 / 全部生成文件 | 8 GiB / 16 GiB |
| 临时占用总量 | 32 GiB；发布前计入缓存、生成、Publisher staging、旧目标备份及清单 |
| 磁盘余量 | 目标卷与元数据卷预检；至少保留 128 MiB，发布前再计入实际产物与备份 |
| Worker 内存 | heap+external 软保护 768 MiB；V8 old/young 硬限制 640/32 MiB；调度预留 1 GiB |
| 缓冲检查 | 缓存每 128 行或新增 4 MiB 检查；回放每 128 行或新增 1 MiB 让出事件循环并检查 |
| 计划 / 内部 manifest / 公共结果 | 各不超过 8 MiB；生成 Worker 只返回小于 4 KiB 的描述符 |
| 警告 | 沿用总数加最多 20 个样例，汇总预算 256 KiB；不截断 K 个文件列表 |

内存保护可拒绝高膨胀率 CSV/XLS 或极宽/高样式文件。公开成功结果完整返回全部文件，保留格式警告总数；Publisher 固定恢复/存档提示预留独立消息空间。

## 专项验收

`tests/unit/main-process/toolbox-row-split.test.js`：15 项通过。覆盖安全整数/1001 提前拒绝、R=0、源快照失效、低磁盘、CSV/XLS 物化预算、跨隐藏 Sheet、重复表头、顺序/文本编号/日期/布尔/错误值/样式、单文件续 Sheet、真实 Worker、单活动 writer 与延迟 commit、缓存损坏/缺失引用、数字串摘要隐私误判回归、生成中取消、发布中崩溃恢复。

新增归档联调验证了一个真实业务批次：1 个原件 + 9 个输出均为 `ready`，任务为 `succeeded`，之后才清理 receipt。大文件 scanFields 增量计数也有真实 Worker 回归。

`scripts/verify-toolbox-row-split-ui.js`：隔离 Electron DOM 自动化 21 项及正式主题一致性 4 项已通过；截图见 `evidence/ui-rows.png`，覆盖默认状态、字段/值禁用、浮层关闭、草稿恢复、非法输入、N 规范化、预估行移除、缺失计数/空数据/超限、旧空值字段切换、防重复提交、父层 rows 请求及结果展示。使用正式 `index.html` 的页面、字体与完整 CSS 链，仅去除业务启动脚本，注入真实 renderer 工厂及 mock API；系统文件对话框和业务 Main 没有在此 UI 脚本中启动。

2026-09-18 样式验收修正：首版截图脚本错误地组合旧 `styles.css` 与 `styles-gemini-extra.css`，导致棕色按钮和错误圆角，旧截图不作为正式外观依据。现已直接读取正式入口；实际计算样式确认完成按钮与主页面一致为 `rgb(11, 87, 208)`（`#0b57d0`），取消按钮为白色、按钮为胶囊圆角、弹窗圆角为 28px。重新运行 21 项交互与 4 项主题检查全部通过，以上证据文件已替换为修正后的结果；此次只改验收脚本，产品原有按钮主题无需改色。

`scripts/verify-toolbox-row-split-capacity.js`：真实 FilePlan → managed Worker → Publisher → 回读每个输出 → journal 清理。样本为两列 CSV，每份一行；所有 ID 按顺序守恒，文件列表完整，活动 writer 最大值 1。

环境：macOS Darwin 24.6.0、arm64、Apple M4 Pro、48 GiB 内存；容量脚本使用 Node 25.8.0。同期存在其他回归任务，时间只作本机观测，不能作为延迟承诺。最终 release-check 使用 Node 24.13.0。

| K | FilePlan 冻结 | 完整验收耗时 | rows Worker 内存采样峰值 | 公共结果 |
|---|---|---|---|---|
| 1 | 1 ms | 0.85 s | 40.7 MiB | 424 B |
| 8 | 1 ms | 1.20 s | 54.1 MiB | 2,069 B |
| 9 | 2 ms | 1.43 s | 54.1 MiB | 2,304 B |
| 999 | 129 ms | 86.76 s | 65.4 MiB | 238,846 B |
| 1000 | 146 ms | 55.44 s | 72.9 MiB | 240,088 B |

1000 份最终观测：缓存 425,984 B，输出合计约 6.05 MB，整个验收进程 RSS 峰值约 768 MiB；最大主事件循环延迟约 157 ms。原成对检查在同机测得 44,611 ms，线性采集后为 146 ms。该测试证明本样本的 1000 份能力；宽表、极端样式、Windows 网络卷等不据此宣称已验收。

## 回归与关联功能 review

- `check-vars` 对差异命中 `dialog`、`app`、`state`；前两者只用于目录/覆盖确认及受管目录，`state` 是 writer 局部生命周期状态，未改全局 renderer state。
- 定义文件同时关联工具箱合表、旧字段单拆/多拆、公共 writer/样式和 FilePlan。按对应 unit、large-file/multi-sheet/multi-split roundtrip 及完整 release-check 验证，保留旧 8 组上限、源文件保护与原发布/归档协议。
- 新跨文件合同候选：`ROWS_ACTION`、`ROWS_BUDGETS`、`rowsPerFile`、`dataRowCount`；本记录给出含义与边界，后续可纳入重要变量清单。
- 首轮完整检查暴露 binding 冻结摘要、扫描返回键集合、旧 runtime action 清单期望及同步源取消问题；均已修复或按新增合同更新回归，未忽略失败。
- `PATH=/Users/pzhong/.nvm/versions/node/v24.13.0/bin:$PATH UNIT_TEST_CONCURRENCY=2 npm run release-check`：lint、smoke 通过；单测共 7307 项，7303 通过、1 失败、3 平台跳过，约 20.5 分钟。原始日志为 `logs/unit-tests/unit-20260918-161357.log`，摘要为 `evidence/release-check-summary.txt`。
- 唯一失败是 `biz-op-v327.test.js` 的真实 Main 崩溃恢复用例，触发原有 30 秒子进程超时；同一代码与 Node 24.13.0 单独复跑在 1.29 秒通过，见 `evidence/bizop-timeout-recheck.txt`。没有放宽超时或修改该用例；保留原失败，整轮门禁状态仍为 FAIL。
- 最后一处长路径计划预算修订发生在全量检查期间；修订后对该源文件再次执行 eslint，并复跑 rows 专项 15 项全部通过，见 `evidence/focused-tests.txt`。
- 全量检查因单测失败未进入集成阶段；另行执行 `npm run test:integration`，53 个脚本全部通过，约 7 分钟，见 `evidence/integration-tests.txt`。其中旧工具箱大文件链路 50/50、跨 Sheet 拆分 31/31、多 Sheet 合表 16/16、多分组拆分 17/17、基础回读 30/30。
- 集成 runner 对公共清单只产生时间戳/耗时更新，已还原这部分无关差异；本次结果保存在上述版本证据目录。

## 未执行的验收

尚未完成 Windows 上 Excel/WPS 人工打开、真实业务 Main 的系统对话框全流程、Windows/网络卷锁文件及断电恢复验收；不将本机自动化通过等同发布许可。未做提交、推送、PR、合并或发版。


## 2026-09-19：按行拆分准入超时修复

- 依据：用户报告 `Admission request timed out after 5000ms`；实际错误日志缺少当时 Governor 快照，因此不将当前机器可用内存回推为历史唯一原因。
- 已复现：静态 rows 需 1 GiB，但 Governor 总配额仅 768 MiB 时，原 Supervisor 跳过总预算预检，空闲状态仍等满 5000 ms 后失败；此时生成 Worker 尚未启动。
- 修复：静态/动态 simple job 共用总预算预检；不可能满足时立即拒绝，真实临时占用继续有界等待。补充中文资源诊断、可选错误码和 Main 活动日志，不改变资源预约、系统预留、源件/正式目标保护或发布协议。
- 验证边界：真实 Supervisor/Governor 专项 133/133 PASS；错误传播 6/6 PASS；真实 Main/Runtime/rows Worker/Publisher Worker 集成 2/2 PASS，其中不足配额无 Worker 启动、无正式发布，旧目标和源件保持不变，足额生成三份并回读 2/2/1 数据行。完整门禁、独立复审和 UI 结果在本轮审查文档中按最终状态记录。
- 契约边界：Governor 总配额仍在 runtime 创建时冻结；关闭其他程序不会动态重算当前配额，提示在释放资源后重启。未操作用户正在运行的 Electron 或真实数据；没有补签 Windows PF 或 Excel/WPS 人工验收。
