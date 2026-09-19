# 时间框与夜间底色调整（2026-09-15）

分支：release/v3.2.9，HEAD：`e134cf4e4cfabaf4805e322d9b2f2a6e2afa844c`。基于上轮外观精简继续调整；保持原生时间输入、串行保存和此前分支改动。

- 时间框从约 80px 加宽到 104px，两侧内边距由 4px 增至 8px，为时分文本与时钟按钮留白；开关框保持原尺寸。
- 上轮去遮罩后，无图片背景仍使用浅色渐变，导致夜间界面过亮。现在无自定义图片时，深色主题直接使用 `#111419` 底色且清除浅色渐变；切回浅色恢复保存的配色。
- 自定义图片继续保留原展示方式，不叠加深色遮罩。主题切换不保存、删除或改写背景配置、图片及草稿。
- 同步 Spec、TechDoc 和离线 HTML；历史验收记录不覆盖。

验证：真实 Electron 原生时间控件／CDP 输入 16/16 PASS；真实 Renderer/CSS 的 15 组／30 个主题场景／2760 项断言全部通过，覆盖 1080×760、1240×860、2560×1440 及 100%／125%／150% 设备模拟和网页缩放。新增断言覆盖夜间底色、无浅色渐变、切回浅色恢复原配色，以及主题切换不写背景设置。JS 语法与 git diff --check 通过。已查看 2560×1440 深色截图，背景与输入框间距符合本次调整。

界面验证使用真实 index、Renderer、CSS，业务 API 为内存夹具；未运行真实业务 Main、Windows 实机或完整 release-check。当前通过结果不替代完整发布门禁。

证据：`/private/tmp/appearance-dark-background-lgnik1ak`，含 `ui/`、`native-input.json`、`final-verification.json`。修改前备份：`/private/tmp/appearance-dark-background-lgnik1ak/before`。原有 10 个未涉及的未提交文件已按 SHA-256 验证不变。未提交或推送。
