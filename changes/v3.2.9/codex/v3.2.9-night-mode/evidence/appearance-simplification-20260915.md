# 外观设置精简（2026-09-15）

用户确认修改 `release/v3.2.9`，HEAD `e134cf4e4cfabaf4805e322d9b2f2a6e2afa844c`；保留此前的原生时间输入与关闭队列修复，不提交、不推送。

- 设置导航中的“外观”改为“外观设置”，排在版本管理、存档中心之后；面板标题同步。
- 移除顶部说明、开关说明、界面预览、当前主题／时段状态栏和底部自动保存说明；错误反馈继续保留。
- 时间框由原两等分列缩至五分之一：常规 2560×1440 下从约 408px 缩至约 81.6px；开关框由 862px 缩至 215.5px，即四分之一。小窗口分别保留 80px / 200px 最小宽度，保证原生控件完整可用。
- 深浅主题共用原背景构造，取消额外深色遮罩；色彩、图片、裁切方式及未保存草稿不因主题切换被改写。原生输入与串行保存实现保留。
- 同步 Spec、TechDoc、离线 HTML 及验证脚本，旧历史验收记录保持原样。

## 验证

- 主题规则／scheduler／renderer 单测：28/28 PASS。
- 真实 Electron 原生 time 控件 + CDP 键盘／鼠标：16/16 PASS，包含连续输入、慢保存、开关关闭和失败焦点。
- 真实数据库设置集成：6/6 PASS，验证配置恢复及背景文件不被主题操作改写。
- 设置布局：6/6 PASS，覆盖保留天数设置等共用外壳交互。
- 外观 GUI 矩阵完成 15 组／30 个主题场景／2700 项断言，覆盖 1080×760、1240×860、2560×1440 及 100%／125%／150% 设备模拟和网页缩放；导航顺序、删减区域、控件宽度、背景无额外遮罩均有实际 DOM／样式断言。
- 首次设备矩阵为 8/9：2560×1440@1.25 的进程退出 0，但在 inspect-dark 后没有返回最终结果，未报告断言失败。未改源码独立复跑该组 1/1 PASS；保留首次失败与复跑日志，不将首次运行记为 9/9 PASS。
- JS 语法及 git diff --check 通过；renderer.js 按项目 ESLint 配置被忽略，实际 Renderer 已由 Electron 脚本加载执行。

GUI 使用真实 index／Renderer／CSS，业务 API 为隔离内存夹具；未启动真实业务 Main，未执行 Windows 实机或完整 release-check。本轮自动验证不替代发布门禁。

证据：`/private/tmp/appearance-settings-edit-h8b0r0ci`，包括 `final-verification.json`、`focused-tests.log`、`native-input.json`、`settings-integration.log`、`layout-final/`、`ui-final/`、`ui-retry/`。完整修改前备份位于 `/private/tmp/appearance-settings-edit-h8b0r0ci/before`。本轮未覆盖的 6 个原有未提交文件已逐项按 SHA-256 核对不变。
