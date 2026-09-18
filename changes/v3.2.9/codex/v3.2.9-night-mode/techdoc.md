# v3.2.9 定时深色模式 TechDoc

功能分支：codex/v3.2.9-night-mode；当前界面调整落在 release/v3.2.9。需求见 spec.md。

## 状态与持久化

共享模块 src/shared/dark-mode-schedule.js 提供严格校验、默认化和本地时段判断，Node 与 HTML 共用。app_settings.dark_mode_schedule 一次保存 { enabled, startTime, endTime }；缺失或坏历史值只读回退为默认关闭，无表迁移，不复用 ui_style。有效主题不持久化。

Main 的独立 dark-mode-scheduler 在 createWindow 前启动，按分钟边界安排一次性计时器，每次取新 Date；powerMonitor resume 与 browser-window-focus 重判，will-quit 清理。nativeTheme 明确指定 light/dark，页面和原生窗口统一底色。仅配置或有效主题变化时递增进程内 themeRevision。

## 接口与前端

app:get-info 扩展 darkModeSchedule/effectiveTheme/themeRevision；settings:set-dark-mode-schedule 返回 status:ok 与同一快照，失败返回 status:failed/message。settings:dark-mode-schedule-changed 同步快照；Preload setDarkModeSchedule 与 onDarkModeScheduleChanged（返回 unsubscribe）暴露受控接口。

head 在样式前同步加载共享规则和 renderer-dark-mode.js，从 Main 控制的 matchMedia 结果设 data-theme 和 color-scheme；不放宽生产 CSP。Renderer 先订阅后读取初始化快照，以 revision 丢弃旧回包。设置保存序列化并校验完整回包，卸载取消订阅。

外观面板复用设置外壳。样式变量来自用户参考，组件固定颜色替换为语义变量并保留回退。特殊行、状态色、色谱本身和禁用态分别处理。buildBackgroundStyle 在深色主题且没有自定义图片时直接使用 #111419 底色并清除浅色渐变；返回浅色时恢复已保存颜色。自定义图片继续使用原背景构造并保留 cover，不增加深色遮罩；配置、图片和草稿不被主题切换改写。

外观草稿按字段跟踪。订阅事件更新未编辑字段，保存基于最新快照合入当前编辑，关闭时直接使用已保存时段，避免非法时间草稿阻止恢复浅色。新外观输入在 :focus 时显示轮廓，覆盖原生分段时间控件。

原生时间控件逐位输入也可能触发 change，因此保存期间保持字段可编辑，不禁用或重新聚焦。面板串行执行保存，期间的连续修改合并为下一次请求；回包只结算本次捕获且未再编辑的字段。活动时间框不被快照重写，离开后将已结算字段与保存值对齐；保存失败保留原配置与主题，并显示错误。弹窗销毁后不继续发送排队编辑，删除确认临时移走再恢复弹窗不视为销毁。

关闭操作以开关的编辑版本划分草稿：只结算点击关闭之前的旧草稿，关闭之后的新时间编辑保留到下一次请求。新时间合法则在关闭结算后继续保存；非法则反馈并保留草稿，不阻止关闭本身。内部续存不能清除先前的失败原因，关闭失败和后续校验失败可同时展示；用户新提交时清除旧提示。

CSS viewport ≤ 940px 时，两块共用 recon-id-fix-board 的固定操作区改成上下排列，取消该小屏范围内的水平偏移；1080px 及以上的正常主界面对齐不变。

## HTML 与验证

scripts/render-dark-mode-preview.js 将本分支 index/CSS、共享时间规则、设置控制器和背景纯函数打包，预览适配器仅包含示例数据与浏览器存储。没有加载参考文件的行为脚本。修改主题后重新运行该命令使产物一致。

离线 HTML 在 CSS 之前同步读取独立 localStorage 配置并按系统时间绘制首屏，不依赖操作系统的外观偏好；按后续确认移除演示时间选择，外观页始终按本机当前时间判断主题。

单元测试验证规则/scheduler/renderer乱序与失败；集成测试真实 AppDatabase + Main/Preload 链与背景文件保全；GUI 脚本验证真实 Renderer/CSS 与合成业务 API；真实应用另用隔离 userData/Documents 启动。详见 evidence/verification.md，模拟结果不替代 Windows 或 2K 实机验收。

scripts/verify-dark-mode-native-input.js 使用隔离 Electron 原生 time 控件及 CDP 键盘/鼠标事件，验证连续数字输入、慢保存排队、关闭和失败焦点；关键输入不通过直接赋值模拟。2026-09-15 修复及验证见 [原生时间输入修复记录](evidence/native-input-fix-20260915.md)。

第二轮 review 的关闭后编辑修复及当前专项结果见 [关闭队列修复记录](evidence/off-queue-fix-20260915.md)，覆盖关闭前/后的合法与非法草稿、失败反馈和继续保存。

2026-09-15 界面精简：导航改为“外观设置”并置于末项；移除顶部说明、开关说明、当前状态栏、组件预览及底部说明。时间框在后续反馈中从约 80px 加宽为 104px、两侧内边距各 8px，保留时分文本和时钟按钮的空间；开关框保持原宽度的四分之一，窄窗口保留 200px 最小宽度。保存错误继续单独反馈，原生输入及串行保存逻辑保留。
