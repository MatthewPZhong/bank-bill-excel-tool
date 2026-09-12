# v3.2.9 定时深色模式验证记录

日期：2026-09-12。分支：codex/v3.2.9-night-mode，基线 v3.2.8（2ba9ef14fe972363b604955636cff0c9ac53700f）。

## 结论

分支实现与独立 HTML 已完成。完整本地 release-check 通过；收尾交互、配色和小窗口修正后另跑专项回归与最终 GUI 矩阵。真实应用冷启动受既有公式计算出的后台预算阻塞；这不证明整机实际内存耗尽。Windows 和物理显示器验收未执行，不能把下面的设备模拟结果当作这些验收已通过。

## 自动化

| 范围 | 结果 | 证据 |
|---|---|---|
| npm run release-check | exit 0；lint、smoke、unit、integration 全部成功 | release-check-final.log |
| 完整单元测试 | 7308 通过 / 7311 总数，3 个 Windows 专项跳过，0 失败 | release-check-final.log |
| 完整集成测试 | 54 个脚本成功，含新 dark-mode-schedule-settings 6/6 | release-check-final.log |
| 收尾变更专项回归 | 74/74；共享规则、调度器、Renderer 竞态、设置/VCC 契约 | final-targeted.log |
| 收尾 lint / diff | lint exit 0，git diff --check 通过 | final-lint.log |
| GUI 设备与页面缩放矩阵 | 15 组、30 个主题场景、2580 项断言通过 | ui-verification*.json |

首轮门禁发现的设置导航、IPC 清单、canary 位置及旧固定颜色静态断言已修正；未修改业务保护条件来消除失败。集成 runner 按现有规则自动刷新 rules/integration-test-policy.md 的清单。

共享规则验证默认关闭、严格 HH:mm、同日起止、跨午夜、18:29/18:30/23:59/00:00/05:59/06:00，以及本地时区。调度器覆盖启动、分钟边界、聚焦、唤醒、时钟更改、事件 revision 和写入失败。SQLite 集成使用真实 AppDatabase、Main/Preload 处理代码，覆盖完整配置保存、重开、只读失败和背景记录/文件保全。

新增 Renderer 回归重现了两窗口并行编辑：另一窗口关闭并修改结束时间后，本窗口只编辑开始时间不会重新启用或覆盖结束时间。完整门禁运行期间的这项收尾修改由后续 74 项专项与最终 GUI 复测覆盖。

## 尺寸与可读性

所有测试均分别检查浅色、深色。2560×1440 已实际检查布局、控件宽度、溢出、字体、语义色和焦点轮廓。

| 内容窗口尺寸 | 网页 zoom | 实际 CSS viewport | 结果 |
|---|---:|---|---|
| 1080×760 | 100% | 1080×760 | PASS，另有 DPR 1 / 1.25 / 1.5 |
| 1240×860 | 100% | 1240×860 | PASS，另有 DPR 1 / 1.25 / 1.5 |
| 2560×1440 | 100% | 2560×1440 | PASS，另有 DPR 1 / 1.25 / 1.5 |
| 1080×760 | 125% | 864×608 | PASS |
| 1240×860 | 125% | 992×688 | PASS |
| 2560×1440 | 125% | 2048×1152 | PASS |
| 1080×760 | 150% | 720×506 | PASS |
| 1240×860 | 150% | 826×573 | PASS |
| 2560×1440 | 150% | 1706×960 | PASS |

前 9 组仅模拟设备 DPR，网页 zoom=1。后 6 组实际调用 setZoomFactor，设备缩放设为 1。JSON 分别记录 bounds、contentBounds、innerWidth/Height、devicePixelRatio、webZoom、截图尺寸和加载源文件 SHA-256。Mac Retina 上 2560×1440 内容窗口截图为 5120×2880，这不是物理显示器验收。

每个主题场景遍历 13 个已注册模块的真实主面板；完整打开并操作真实设置/外观组件，覆盖控件保存禁用、失败反馈、无效时段、开关以及背景草稿日夜切换和取消恢复。背景“完成”真实按钮使用 primary/on-primary，最低对比度 6.386:1；报告列出的语义文字色组合均至少 4.5:1。焦点检查使用真实 DOM.focus 与隐藏窗口的文档焦点模拟，没有强制 CSS 伪类。账户表和 VCC 标记的颜色探针是使用真实 CSS 类的测试节点，不等于完整业务弹窗流程。

最终三个 JSON 与 30 张截图均对应同一冻结源码，逐文件 SHA-256 核对无差异。截图可直接查看 ui-2560x1440-100-dark.png 与 ui-2560x1440-100-webzoom-150-dark.png。

## 独立 HTML

night-mode-3.2.9.html 无外部 src/href 依赖，4 个内嵌脚本语法检查通过。配色来自参考副本，未执行参考脚本。浏览器实际交互验证：开关、默认时段、18:30/06:00 边界、图片背景、等时拒绝、无效草稿下关闭、刷新保留配置、账户表和 2560×1440 无水平溢出。新增时间控件实际键盘 Tab 检查显示 2px 主色焦点轮廓。浏览器控制台无 error/warn。临时测试页、viewport 覆盖和 localhost 服务已清理。

后续按用户要求移除“定时深色模式 · 交互预览”整块及其演示控件，清除对应 DOM 读写和监听；HTML 改为直接使用本机时间，保留左下角设置及账户映射入口。生成器、fixture、全部 4 段内嵌脚本通过语法检查，独立审查确认不存在已删节点的残留引用。本地浏览器加载确认预览块已消失且初始化完成；随后浏览器标签失去访问，未重复完成设置点击验证。以上完整浏览器交互记录对应精简前版本，正式应用主题实现未变。

交付副本：/Users/pzhong/Downloads/v3.2.9-scheduled-dark-mode.html，与分支生成产物逐字节一致，247906 bytes，SHA-256 为 09d0ed73552706f796e27942cfee33fdeadb1c5103cda3053b43ee424d07ab0b。

## 实机缺口

scripts/verify-dark-mode-live.js 使用临时 userData/Documents、新数据库、真实单实例锁及真实 Main，没有设置 APP_CAPTURE_PATH。早先尝试曾分别报告 0 MiB、877 MiB；随后有一轮在资源准入后暴露验证脚本把 scripts 当 appPath 的错误，不能归为深色模式故障。脚本已恢复根目录、应用名称/版本，改为等待 renderer-init-complete，保留父进程 90 秒总时限及 SIGKILL 超时处理；主题观测命名为“加载完成后的主题快照”，不宣称全程无闪白。脚本专项验证见 live-script-checks.log。

2026-09-12 14:05 排查后再次运行修正的脚本，真实 Main 在创建业务窗口前报告可用/预算上限均为 **314 MiB**，仍被 BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE 拒绝。父进程采样 free 2476.40625 MiB 与 Main 不是同一瞬间，不能用它替代真实预算。最新结果见 live-runtime.json；本轮日志为 live-runtime-investigation-2026-09-12T06-05-09-351Z.log，原有结果另存带时间的快照。

当前 macOS/内置 libuv 的 os.freemem() 仅统计 free 页；后台预算扣除 2048 MiB reserve，1024 MiB 是固定 phase 预约量，不是本次实测 RSS。固定版本 Electron 的另外两个内存接口也不能直接提供包含 inactive 的可用量。预算公式文件与 v3.2.8 完全一致。本次未修改该公式、预置 ACTIVE 或关闭业务启动保护。完整来源、Unknowns Register 和有界资源观察见 [memory-investigation.md](memory-investigation.md)。

因此真实 Main 浅色、深色冷启动及 GUI 重启恢复仍为 BLOCKED，尚无两个场景均通过的结果；共享调度器、数据库和 Renderer 分层证据不能替代该结论。整条启动过程无闪白没有得到验证，即使脚本的加载完成快照通过，也不构成该项证明。

Windows 安装包、原生系统缩放、物理 2K 显示器、完整业务弹窗、全量 hover/disabled 状态、完整键盘 Tab 顺序及屏幕阅读器未验收。任意用户背景图片的逐像素文字对比也未作保证。
