# 实施记录

## Baseline

见 spec.md。主工作区存在大量既有改动，本次从正式标签另建 worktree。

## Decisions

- 采用最终用户确认的本地时间调度，默认关闭、18:30—06:00；旧三模式计划被替代。
- 用户参考的组件色值为依据，固定遮罩 .72；HTML 与正式应用复用代码，避免预览与实现漂移。
- 参考文件 SHA-256：7273783b161b870126574739659001b18feaa5cf47efd24689a5fcc1da984d90。原件只读，副本存 references/。
- 参考 file URL 无法在内置浏览器打开；通过静态源码提取色值。独立生成的 HTML 仅运行本分支审核过的代码。
- themeRevision 只作为进程内消息排序，不进入数据库。背景草稿不会被状态更新覆盖。
- 外观编辑按字段保留草稿；外部更新同步未编辑字段，避免更改开始时间时覆盖另一窗口刚关闭的开关。
- 真实页面缩放暴露两个共用面板的横向溢出；只在 CSS viewport ≤ 940px 时顺排操作区，正常窗口保留原对齐。
- 原生时间输入的分段焦点未必匹配 :focus-visible，外观页采用 :focus 轮廓，支持鼠标和键盘编辑。

## Evidence

完整 release-check 通过；收尾修改后专项回归 74/74、lint 通过；最终 GUI 15 组、30 个主题场景、2580 项断言通过。完整证据与平台边界见 evidence/verification.md。

## Remaining unknowns

- BLOCKED：真实 Main 冷启动被既有 BizOP 首次激活资源预算拦住。验证脚本 appPath/初始化等待已修正；2026-09-12 14:05 排查后重试的预算为 314 MiB，仍未创建业务窗口。macOS 的 free 页采样不等于整机实际可利用内存；完整诊断与 Unknowns Register 见 evidence/memory-investigation.md。未修改保护条件，尚未证明完整 GUI 冷启动。
- 未执行：Windows、2560×1440 实体显示器及原生系统显示缩放人工验收；设备模拟与页面 zoom 分别记录。
