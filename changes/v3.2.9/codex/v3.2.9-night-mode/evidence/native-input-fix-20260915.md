# v3.2.9 原生时间输入修复验证（2026-09-15）

本记录保留首次修复的代码与验证边界。第二轮 review 发现的关闭后编辑遗漏已另行修复，最新结果见 [关闭队列修复记录](off-queue-fix-20260915.md)。

基于 `release/v3.2.9` 的 `e134cf4e4cfabaf4805e322d9b2f2a6e2afa844c` 修复 review P2；本轮代码及记录尚未提交。目标为 Spec 的可编辑时段、有效编辑自动保存和完整时段保存。

## 缺陷与修复

旧实现将每个原生 `change` 立即保存，并在保存期间禁用 fieldset。macOS / Electron 36.9.5 下，将开始时间 `18:30` 的小时连续输入 `1`、`9`，保存延迟 15ms、键间隔 100ms 时，控件失焦后重置分段状态，最终控件及保存值成为 `09:30`。冻结旧 UI 的原生键盘回归明确失败，保留了 `01:30 → 09:30` 请求轨迹；旧实现对应的定向 Renderer 测试为 8 PASS / 5 FAIL。

修复后保存期间保持控件可编辑，不主动重设焦点或重写活动时间框；面板串行保存并合并等待期间的最新修改。每个字段记录编辑版本，旧回包只结算未再编辑的字段。失败继续显示原因、保留已保存配置和主题，离开输入框后回读保存值。关闭开关沿用执行时最新已保存的时段，非法草稿不阻止关闭；弹窗的保存中关闭保护和存档期限队列保持原行为。

离线 HTML 由现有生成器重新构建，内嵌本次共享 UI，并同步包含 release 中已经合并的保留期限/Biz OP 样式。没有修改这两个模块的源样式或业务实现。

## 当前专项结果

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| `npm run lint` | PASS | 当前 src 静态检查 |
| `node --test --test-reporter=tap tests/unit/dark-mode-renderer.test.js tests/unit/shared/dark-mode-schedule.test.js tests/unit/main-process/dark-mode-scheduler.test.js` | 24/24 PASS | 时间规则、调度器、修订顺序、失败、连续编辑队列、草稿、关闭与销毁 |
| `node scripts/integration/dark-mode-schedule-settings.js` | 6/6 PASS | 真实 AppDatabase / Main handler / Preload，存储失败、重开、主题与背景保全 |
| `node scripts/verify-dark-mode-native-input.js <证据路径>` | 13/13 场景、65 个断言 PASS | 原生控件对照；开始/结束的小时/分钟，15ms/100ms 和 200ms/30ms；已启用时逐位输入触发 dark → light → dark，慢保存跨字段、保存中关闭、失败焦点；请求最大并发数为 1 |
| `DARK_MODE_UI_FILTER=1080x760@1 node scripts/verify-dark-mode-ui.js` | 1/1 组、两色、172 个断言 PASS | 当前 Renderer/CSS、13 模块代表界面、外观保存/失败、背景草稿与主题遮罩 |
| `node scripts/verify-app-settings-layout.js` | 6/6 布局、4/4 主题/期限交错场景、73 个组合断言 PASS | 切页、保存成功/失败、关闭与删除保护、期限结果保持 |
| 真实离线 HTML 原生键盘及重载 | 1/1 场景、4 个断言 PASS | 连续输入 `19` 后控件及独立 localStorage 为 `19:30`，焦点保持；重新加载并打开设置仍为 `19:30` |
| 差异检查与独立只读复审 | PASS / 无新增可确认问题 | 修复边界、保存串行、回包版本、删除确认临时移走弹窗的生命周期 |

GUI 使用独立临时 userData 和内存 API；原生回归通过 CDP 键盘/鼠标操作，关键时间输入未用赋值或合成 change 代替。新增脚本支持 `DARK_MODE_NATIVE_BASELINE_DIR` 加载冻结源码复现旧问题。其输出绑定当前脚本、共享规则、UI 和两份样式的 SHA-256，完成后已再次核对一致。

本次日志/JSON/截图位于本地忽略目录 `logs/verification/release-v3.2.9/night-mode-input-fix-20260915/`；`native-input-before-fix.json` 保留旧实现反例，`native-input.json` 为修复后全部原生用例。旧 UI 的 SHA-256 为 `e094a1a32e89a498f50e7904c292e8a21577da4044e32f97df0c932f676486ff`。

离线产物最初的一次独立 helper 在 40 秒内未返回阶段结果，`offline-preview.json` 保留此次未完成尝试，不能据此判断产品失败。随后使用已验证的先加载页面、再启用 CDP 焦点仿真的入口完成独立回归，结果见 `offline-preview-native-input.json`；未重跑原超时 helper。HTML 内嵌 UI 与当前源码逐字节相同，产物 SHA-256 为 `77670fe10a897d5778e3c87986ec78d0a9d25d14f002660796d68390116c992d`。

## 验证边界

本轮未运行完整 `release-check`。2026-09-12 的完整门禁 RSS 失败及随后一次原门槛独立复跑通过均保留在 release.md，不能用本次 UI 专项覆盖其未决状态。未修改启动预算或保护，未重试真实业务 Main 冷启动；此前的 `BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE` 仍为未闭环验收。Windows、Excel/WPS、安装包和实际显示器/完整业务人工验收未执行。

旧 `integration-candidate-20260912.json` 继续绑定修复前的集成候选，不代表本次未提交修复的全量验证。
