# 审查修复记录｜v3.2.9 工具箱按行拆分

2026-09-18：已核实 [审查报告](review-2026-09-18.md) 的 R01–R04 均成立，并按用户授权直接修复。改动位于 `codex/v3.2.9-toolbox-split-by-rows` 的原隔离 worktree，仍未提交、推送或发布。原报告及其证据保留不改。

## 修复与复验

| 问题 | 修复 | 验证 |
|---|---|---|
| R01 / P1 覆盖确认竞态 | `prepareRows` 在确认前冻结源、全部目标的存在状态/身份及父目录身份；冲突列表从该快照生成，确认返回后复核。Main 直接传递同一 FilePlan，IPC 仅复用 Main 当前进程认证的冻结对象，普通对象仍按原方式规范化；TaskLifecycle 与 Publisher 继续验证同一快照。 | 新增 8 项真实 Main prepare / IPC / 生成器 / Publisher 回归，覆盖确认期间新增、替换目标，prepare 返回后新增、替换，取消覆盖，以及生成后正常发布、新增和替换三种结果。所有拒绝场景均核对用户文件保留。另增加 1 项 IPC 身份回归，验证复制的对象不能冒充 Main 冻结 authority。 |
| R02 / P2 结果及确认按钮被裁切 | 仅 rows 成功弹窗增加 `toolbox-split-rows-result` 类；内容区滚动、确认区不收缩，保留全部文件和现有警告。 | 真实 Electron 加正式入口 CSS，K=1/8/9/30/1000，均含长路径、格式警告和发布提示；确认完整列表、末尾可见、按钮命中，并以原生鼠标事件点击返回工具箱。 |
| R03 / P3 勾选未聚焦 | 刷新显示/禁用状态后，勾选时聚焦已启用的行数输入框。 | 原生鼠标勾选后聚焦、取消后不聚焦隐藏输入、键盘 Space 勾选后立即输入 `2`，共 3 项通过。 |
| R04 / P3 三类错误文案 | 空白提示“请输入每份文件的数据行数”；非正整数提示“请输入大于 0 的整数”；纯数字超出安全整数范围提示“行数过大，请输入有效范围内的整数”。 | 13 组非法输入逐项核对禁用状态与准确提示；另验证 `00010` 规范化为 `10`，指数、小数等仍被拒绝。 |

R01 的新回归也在原审查快照上运行：先验证 Main 和 rows service 的 SHA-256 与原快照清单一致，再用临时测试目录只读引用其源码。修复前 8 项中 4 项失败、4 项通过；四个失败分别对应确认期间和 prepare 返回后新增/替换目标。修复后 8 项全部通过。见 [修复前](evidence/review-fixes-2026-09-18/overwrite-before.log)、[修复后及 IPC 回归](evidence/review-fixes-2026-09-18/overwrite-after.log)。

Spec 和 TechDoc 同步补充确认快照、结果滚动和验收条件；TechDoc 流程图中遗留的“页面展示预计 K”已更正为内部计算。产品仍不显示预计数量提示行。

## 本轮验证

后端使用 Node 24.13.0。以下单测两组无重复计数，合计 **285/285 PASS**，包含新增的 9 项回归。

| 检查 | 结果 | 证据 |
|---|---|---|
| rows、覆盖竞态、IPC 合同、后台生成、分派、binding、manifest、renderer | 122/122 PASS | [focused.log](evidence/review-fixes-2026-09-18/focused.log) |
| FilePlan、TaskLifecycle、交互预检、归档、发布、writer、格式与目标身份 | 163/163 PASS | [related.log](evidence/review-fixes-2026-09-18/related.log) |
| `scripts/integration/toolbox-roundtrip.js` | 30/30 PASS | [roundtrip.log](evidence/review-fixes-2026-09-18/roundtrip.log) |
| `scripts/smoke-test.js` | PASS | [smoke.log](evidence/review-fixes-2026-09-18/smoke.log) |
| 隔离 Electron UI | 既有 21 项交互、4 项主题检查；新增 13 项错误文案、3 项原生焦点及 5 组结果布局/点击检查通过 | [UI JSON](evidence/review-fixes-2026-09-18/ui-result.jsonl)、[1000 份结果底部截图](evidence/review-fixes-2026-09-18/ui-result-1000.png)、[输入页面](evidence/review-fixes-2026-09-18/ui-rows.png) |
| 静态检查 | 本轮后端、Main、脚本及新增测试 eslint 通过；Main、renderer 和 UI 脚本语法通过；`git diff --check` 通过 | renderer 按仓库配置不进入 eslint，使用语法与真实 DOM 检查 |

UI 窗口为 1080×800，内容区 1080×772；K≥8 的长路径样本内容区高度 639px，确认按钮中心 y=703，在顶部和底部均可点击。完成按钮继续与主界面一致为 `#0b57d0`，取消按钮为白色，按钮/弹窗圆角沿用正式主题。UI 脚本等待按钮启用时的 160ms 颜色动画结束后再做样式比较。

复验命令示例：

```sh
node --test tests/unit/main-process/toolbox-row-split-overwrite.test.js tests/unit/main-process/archive-ipc-task-contract.test.js
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/verify-toolbox-row-split-ui.js /tmp/toolbox-rows-review-fixed-ui.png
node scripts/integration/toolbox-roundtrip.js
node scripts/smoke-test.js
```

## 关联功能 review 与未执行项

- 本轮 source 改动限于 rows 预检、Main 的 FilePlan 选择、IPC 冻结对象复用、renderer 和 rows 结果局部样式。对照 `rules/important-variables.md`，Main/renderer 定义文件关联 `dialog`、`app`、`state`；未改变原生对话框参数、应用启动/退出钩子或全局 renderer state。覆盖取消分支有回归。
- 公共 IPC 入口的普通 FilePlan 规范化继续保留；冻结对象复用不能由序列化对象伪造。旧字段拆分、受控任务、归档、发布恢复和公共 writer 已做上述关联回归。
- 本轮未重跑完整 `release-check`；[实施记录](implementation-notes.md) 中的整轮状态仍为 **FAIL**，原因是 Biz OP 恢复用例超时。其单独复跑通过与本轮局部检查通过均不能替代整轮门禁。
- UI 使用真实 renderer 和正式 CSS，但 API、导入数据和系统目录/覆盖对话框为测试替身；未启动完整业务 Main。1000 份 UI 检查不等于重新执行 1000 份实际生成容量测试。
- Windows、Excel/WPS 人工打开、网络卷及真实 Main 系统对话框全流程仍未验收；本轮没有扩大这些既有验收结论。
