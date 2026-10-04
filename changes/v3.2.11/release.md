# v3.2.11 发布与集成记录

## 2026-10-04 正式发布准备

用户明确授权“合并进 main，然后执行正式发布动作，最后将本地 main 同步远端 main”。本轮复用已有 release 分支，授权涵盖版本与发布文档、必要修复和检查、提交／推送、PR 合并、附注标签、Windows 发布及安全同步本地主检出。

| 项目 | 冻结事实 |
| --- | --- |
| 正式基线 | `v3.2.10` → `18b82b4328cf5e00c1b2549d373a5b2f2677215c` |
| 接手 release | `release/v3.2.11@9a57d85755d6bddb15e7a23bbebe7db960e141aa` |
| 接手远端 main | `18b82b4328cf5e00c1b2549d373a5b2f2677215c`，已包含在 release 历史 |
| 目标版本／日期 | `3.2.11`／2026-10-04，Asia/Shanghai |
| 主检出保护 | 本地 main 无已跟踪文件改动，有未跟踪历史报告、版本文档及 outputs；同步前检查路径碰撞并保留原内容 |
| 发布要求 | PR 的 smoke-test 与 build 通过，合并后 main 检查通过，再于最终 main 创建附注标签并执行受保护发布环境 |

## 纳入范围

| 功能分支 | 已合入来源 SHA | 内容 |
| --- | --- | --- |
| `codex/v3.2.11-archive-center-delete-confirm-copy` | `1aeddac7fa8d14e9b4a75e9cdd1a8963f12404fe` | 删除确认说明精简，保留确认与删除保护 |
| `codex/v3.2.11-common-feedback-dialog-scroll` | `22e20b16c5e60ac60c4ffdf5d5882983c1baa48d` | 公共正文滚动、底部操作区保护 |
| `v3.2.11-settings-defaults` | `f0b9adcfa75131162dc3438a208f4f5d201fc5db` | 定时深色默认开启及 17:30–07:00，默认永久存档 |
| `codex/v3.2.11-vcc-fin-op-subject-sheets-export-ui` | `f9dc3414c04b86a6103a3c39231fc8064dd4d8d1` | 正式结果单工作簿按主体分 Sheet、导出页调整 |
| `v3.2.11-bizop-rows-low-memory` | `641c574db460c4b8afe0b6d7e2188aae2414f87e` | OP／按行拆分完整阶段低内存适配 |

五项来源已在接手 release 历史中；后续 `8cc9b2dd` 至 `9a57d857` 纳入公共扫描兼容、lock 随包、分组面板意图、清理补偿、CSV／BIFF8 档位适用性及准入诊断修复。当前范围不加入其他未合入功能分支。

## 检查与证据边界

- 接手前完整本地门禁：9,595 项单测 PASS、4 项 Windows SKIP；83/83 集成脚本 PASS。对应 [BIFF8 最终修复记录](release/v3.2.11/review-fixes/2026-10-03-r5-biff8-admission/repair-report.md)。这是升版前的历史结果。
- 本轮版本和三份发布文档更新后，须在冻结候选运行完整 `release-check`；最终 SHA、退出码、远端 CI 和发布产物证据记录在本轮 PR／Release 及独立 publication 记录，不预填通过。
- 生产内存档采用 2026-10-02 用户人工确认的 qualified 清单；详见 [人工确认记录](v3.2.11-bizop-rows-low-memory/windows-acceptance.md)。现有原始 Windows 压力文件和逐项明细未提供，不生成补造报告。
- 本轮 Windows CI 将执行全量自动门禁、实际进程语义、安装包检查、打包启动和 BizOP 工作流；Windows GUI 缩放、Excel/WPS 实际显示及用户大文件容量未在本轮独立人工重验，不扩大既有人工确认范围。
- 已声明的公共工厂范围外弹窗 OOS-01 继续按原 Spec 记录；不以本轮公共修复宣称所有自建弹窗均已覆盖。

## 执行进度的记录约定

准备时已确认五分支、基线与当前保护规则。PR、最终 main、附注标签、发布工作流、四项资产及本地同步只在取得实际结果后登记到 PR／Release 或独立结果文件。正式发布后不为更新本文件改写已发布提交、移动标签或覆盖资产。

## 2026-10-04 Windows 候选检查：测试连接关闭顺序修复

首个发布候选 `ec0bc211` 的本地完整门禁通过：9,595 单测 PASS、4 项 Windows SKIP，83/83 集成脚本与 3,116 项计数检查 PASS；5,554 个 tracked 输入核对一致。runner 只改写自动生成清单的日期和耗时，证据单独保存后恢复该文件，保持冻结候选。

[PR #241 的首轮 Windows 检查](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/37172499007)为 9,594 单测 PASS、1 FAIL、4 SKIP。唯一失败发生在 VCC 正式结果并发快照用例的 after 清理：公共 fixture 先关闭主连接并删除目录，稍后注册的第二连接关闭回调尚未执行，Windows 因打开的 SQLite 连接拒绝删除 `fixture.sqlite`（EBUSY）。导出与快照隔离断言已通过；集成和 build 未执行，不能把此 run 计为发布通过。

测试中第二连接改由 try/finally 在用例返回前关闭，再交给公共 fixture 清理；保留真实并发更新、结果单元格与第二连接数据断言，生产 Writer 和业务代码未改。基于真实失败用例注入 Windows 文件锁语义的本机探针修复前以同一 EBUSY 失败；修复后该探针 1/1 PASS，完整 VCC 工作簿测试文件 23/23 PASS。探针是在 macOS 注入文件锁语义的专项验证，最终本地／Windows 门禁须在新候选再次执行。原始日志与前后探针保存在独立 publication 证据中，后续结果写入 PR／Release。

## 2026-10-04 Windows 集成检查：ASAR 路径与键盘输入修复

候选 `5b179cd0` 的本地完整门禁通过：9,595 单测 PASS、4 项平台 SKIP，83/83 集成脚本与 3,116 项计数检查 PASS；全部 5,554 个 tracked 输入核对一致。

[第二轮 Windows 检查](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/37176003277)完成 9,595 单测 PASS、0 FAIL、4 SKIP，前一轮 SQLite 清理问题已通过。集成结果为 81/83 脚本通过，失败仅在以下测试装配：

- `packaged-memory-identity`：`@electron/asar` 按宿主 `path.sep` 遍历目录，测试固定 `/` 路径在 Windows 无法定位嵌套资格文件。使用实际已安装库并注入 `path.win32` 已复现失败与本机路径对照；改为 `path.join`，保留真实 builder 拷贝、ASAR 字节及 Electron 包内身份断言。本机专项 7/7 PASS。
- `renderer-lifecycle`：302/303 PASS，公共反馈键盘用例失败。隔离 Electron 探针确认旧输入驱动缺少 Space 的字符事件；补发该事件，显式聚焦测试窗口，并等待 PageDown 动画结束后再独立验证 Space，额外断言恰好一次可信空格 keypress。强化后的用例在旧驱动下 39/40、修复后 40/40；本机探针与 Windows 最终结果分别记录。输入语义参考 [Electron sendInputEvent 合同](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent)。

Windows 构建 workflow 将上述两个专项放到完整门禁前，使平台失败尽早返回；完整 `release-check`、进程语义、打包和正式发布检查均保留。Windows workflow 合同专项本机 5 PASS、2 项真实 Windows 条件 SKIP。修复不修改业务代码或资格清单，也不跳过失败断言。新候选完整本地／Windows 结果取得后写入 PR、Release 与独立 publication 记录。
