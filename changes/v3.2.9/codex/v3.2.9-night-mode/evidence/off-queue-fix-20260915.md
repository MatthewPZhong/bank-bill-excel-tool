# v3.2.9 关闭后时间编辑修复验证（2026-09-15）

基于 `release/v3.2.9` 的 `e134cf4e4cfabaf4805e322d9b2f2a6e2afa844c` 及首次时间输入修复，处理第二轮 review 确认的 P2。改动仍未提交，未推送。

## 缺陷与修复

旧 UI（SHA-256 `ddc8408fee6b09bdfbe461c0b858c3f7df5718f7dc5bee74b92887cb88145117`）在结束时间 `07:00` 保存尚未完成时，依次点击关闭并输入开始时间 `20:30`，关闭请求会忽略新时间却将其当作已提交字段结算。macOS / Electron 36.9.5 原生回归确认最终存储仍为 `18:30 / 07:00 / false`，失焦后回退，两个关键断言失败；新增 Renderer 回归在修复前为 13 PASS / 4 FAIL。

当前以点击关闭时的开关编辑版本区分新旧草稿。关闭仍使用最新已保存时段，关闭之后的时间编辑不由该请求结算，而是保留并继续保存或校验。非法草稿不阻止关闭，旧草稿语义保持；后续有效修改最终落库且失焦不回退。内部续存保留先前失败反馈，关闭失败和新时间校验失败可同时显示，用户再次提交后清除旧提示。

生产修改仅涉及共享外观 UI，离线 HTML 由现有生成器同步重建。未调整 Main/IPC/存储接口、业务规则、存档期限队列、启动预算或保护。

## 当前专项验证

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| `npm run lint`；原生脚本语法及 no-undef | PASS | 当前源码及新增键盘用例 |
| 三份 dark-mode 单测 | 28/28 PASS | Renderer 17 个用例及共享规则、调度器；新增关闭成功/失败 × 新合法/非法时间四种交错 |
| `node scripts/integration/dark-mode-schedule-settings.js` | 6/6 PASS | 真实 AppDatabase / Main handler / Preload、失败、重开及背景保全 |
| `node scripts/verify-dark-mode-native-input.js <证据路径>` | 16/16 场景、90 个断言 PASS | 原有 13 场景；新增关闭排队后有效时间、关闭后非法草稿、关闭前非法草稿，关键输入均为真实键盘/鼠标 |
| 原生离线 HTML 输入及重载 | 1/1 场景、4 个断言 PASS | `19:30` 输入、独立 localStorage、焦点保持、重载回读 |
| `DARK_MODE_UI_FILTER=1080x760@1 node scripts/verify-dark-mode-ui.js` | 1/1 组、两色、172 个断言 PASS | 当前 Renderer/CSS、设置保存/失败与背景草稿 |
| `node scripts/verify-app-settings-layout.js` | 6/6 布局、4/4 组合场景、73 个组合断言 PASS | 主题/期限交错保存、切页、关闭、删除保护 |
| 独立受控交错复审 | 6/6 PASS；未发现新的可复现缺陷 | 外部快照、关闭前旧非法草稿、关闭后新编辑、失败原因保留、人工修正、destroy 与后续保存失败 |

单测命令：`node --test --test-reporter=tap tests/unit/dark-mode-renderer.test.js tests/unit/shared/dark-mode-schedule.test.js tests/unit/main-process/dark-mode-scheduler.test.js`。GUI 均使用隔离临时 profile 与内存业务 API；存储/IPC 集成不代表真实业务 Main 冷启动。

本轮日志、截图和 JSON 保存在本地忽略目录 `logs/verification/release-v3.2.9/night-mode-off-queue-fix-20260915/`。红灯 `native-input-before-fix.json` 和绿灯 `native-input.json` 绑定同一最终原生脚本。`candidate-sha256.json` 记录本轮 6 个代码、测试、验证脚本和 HTML 文件的摘要；验证完成后再次核对一致。

- 当前共享 UI SHA-256：`9cd66845f4045059da3a6c3059b7ce5773719ad5962210d91516cf318e6de4cf`
- 原生脚本 SHA-256：`c46e8c3d6479785131ae0116b12b4c617ead12ca733667f90fc3a4fdd7b0c8d5`
- 离线 HTML SHA-256：`6d6109c7c0abecfb47d72fdebaf70578166ae565c747eaeadaaa0e0b3b4aa02f`

## 保留的验证边界

本轮未重跑完整 `release-check`。此前完整门禁 RSS 失败与随后一次原门槛复跑通过仍为历史事实；真实 Main 冷启动、Windows、Excel/WPS、安装包与完整人工验收未闭环。未将本轮专项结果作为发布就绪证明。

首次修复的 `native-input-fix-20260915.md` 和 `night-mode-input-fix-20260915/` 日志继续保留；它们绑定旧 UI，不代表当前修复的全量验证。`integration-candidate-20260912.json` 仍绑定更早的集成候选。
