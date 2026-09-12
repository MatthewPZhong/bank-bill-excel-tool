# v3.2.9 定时深色模式 TechDoc

适用分支：codex/v3.2.9-night-mode。需求见 spec.md。

## 状态与持久化

共享模块 src/shared/dark-mode-schedule.js 提供严格校验、默认化和本地时段判断，Node 与 HTML 共用。app_settings.dark_mode_schedule 一次保存 { enabled, startTime, endTime }；缺失或坏历史值只读回退为默认关闭，无表迁移，不复用 ui_style。有效主题不持久化。

Main 的独立 dark-mode-scheduler 在 createWindow 前启动，按分钟边界安排一次性计时器，每次取新 Date；powerMonitor resume 与 browser-window-focus 重判，will-quit 清理。nativeTheme 明确指定 light/dark，页面和原生窗口统一底色。仅配置或有效主题变化时递增进程内 themeRevision。

## 接口与前端

app:get-info 扩展 darkModeSchedule/effectiveTheme/themeRevision；settings:set-dark-mode-schedule 返回 status:ok 与同一快照，失败返回 status:failed/message。settings:dark-mode-schedule-changed 同步快照；Preload setDarkModeSchedule 与 onDarkModeScheduleChanged（返回 unsubscribe）暴露受控接口。

head 在样式前同步加载共享规则和 renderer-dark-mode.js，从 Main 控制的 matchMedia 结果设 data-theme 和 color-scheme；不放宽生产 CSP。Renderer 先订阅后读取初始化快照，以 revision 丢弃旧回包。设置保存序列化并校验完整回包，卸载取消订阅。

外观面板复用设置外壳。样式变量来自用户参考，组件固定颜色替换为语义变量并保留回退。特殊行、状态色、色谱本身和禁用态分别处理。buildBackgroundStyle 保留浅色构造，深色 prepend 遮罩时同步尺寸/位置/repeat列表，图片保留 cover。

外观草稿按字段跟踪。订阅事件更新未编辑字段，保存基于最新快照合入当前编辑，关闭时直接使用已保存时段，避免非法时间草稿阻止恢复浅色。新外观输入在 :focus 时显示轮廓，覆盖原生分段时间控件。

CSS viewport ≤ 940px 时，两块共用 recon-id-fix-board 的固定操作区改成上下排列，取消该小屏范围内的水平偏移；1080px 及以上的正常主界面对齐不变。

## HTML 与验证

scripts/render-dark-mode-preview.js 将本分支 index/CSS、共享时间规则、设置控制器和背景纯函数打包，预览适配器仅包含示例数据与浏览器存储。没有加载参考文件的行为脚本。修改主题后重新运行该命令使产物一致。

离线 HTML 在 CSS 之前同步读取独立 localStorage 配置并按系统时间绘制首屏，不依赖操作系统的外观偏好；演示时间选择仅影响本次页面预览。

单元测试验证规则/scheduler/renderer乱序与失败；集成测试真实 AppDatabase + Main/Preload 链与背景文件保全；GUI 脚本验证真实 Renderer/CSS 与合成业务 API；真实应用另用隔离 userData/Documents 启动。详见 evidence/verification.md，模拟结果不替代 Windows 或 2K 实机验收。
