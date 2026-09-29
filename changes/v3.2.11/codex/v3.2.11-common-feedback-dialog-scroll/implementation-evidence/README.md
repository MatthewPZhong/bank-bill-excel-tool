# 最终实现验证证据

本目录属于 2026-09-29 的公共反馈弹窗**实际实现**验证，使用功能分支工作区；不复用 `../review-2026-09-29-evidence/` 中的方案实验结果充当本次测试。

基线：`main@18b82b4328cf5e00c1b2549d373a5b2f2677215c`，分支 `codex/v3.2.11-common-feedback-dialog-scroll`，未提交工作区。来源和文件哈希见 [manifest.json](./manifest.json)。所有文件名、路径、token、API 返回值均为虚构夹具；隔离 runner 将 userData／Documents 指向临时目录，不加载生产 Main。

## 命令和结果

工作目录：`/Users/pzhong/.codex/worktrees/feedback-dialog-scroll/bank-bill-excel-tool`。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/test-renderer-lifecycle.js common-feedback-dialog-scroll` | 40/40 PASS，退出码 0 | [focused-output.txt](./focused-output.txt) |
| `npm run release-check` | PASS，退出码 0；全部 68 个集成脚本通过 | [release-check-output.txt](./release-check-output.txt) |
| `git diff --check` | PASS | 覆盖本次差异 |

完整门禁按项目现有脚本串行运行 lint、架构、smoke、unit、integration。最终结果：架构扫描 765/765 文件通过；smoke 通过；unit 9,435 通过／0 失败／4 项 Windows 专用跳过（共 9,439）；完整 Renderer 生命周期 273/273 通过，全部 68 个集成脚本通过（runner 可解析汇总 2,941 项）。新增 fixture 由 `scripts/renderer-lifecycle/electron-main.cjs` 自动发现，经既有 `scripts/integration/renderer-lifecycle.js` 进入门禁；没有另外复制业务 reader／writer 集成链。门禁结束自动同步 `rules/integration-test-policy.md` 的现行测试清单。

重建截图和测量数据可在上面的功能工作区运行：

```bash
RENDERER_LIFECYCLE_EVIDENCE_DIR="$PWD/changes/v3.2.11/codex/v3.2.11-common-feedback-dialog-scroll/implementation-evidence" \
  node scripts/test-renderer-lifecycle.js common-feedback-dialog-scroll
```

## 真实环境和尺寸

本机 `darwin`，Electron 36.9.5，Chromium 136.0.7103.177，显示器 `scaleFactor=2`。下表全部来自实测 JSON；显示器缩放、页面 zoom、CSS 视口和截图像素分开记录。布局模式使用 `frame:false`，正式尺寸场景设置与生产一致的 `minWidth=1080/minHeight=760` 并缩至最小；压力模式解除的仅是隔离测试窗口限制。

| 场景 | 实际窗口／内容区 DIP | CSS 视口 | 页面 zoom | DPR | 截图像素 | 结果 |
| --- | --- | --- | ---: | ---: | --- | --- |
| 最小窗口，浅色 | 1080×760／1080×760 | 1080×760 | 1 | 2 | 2160×1520 | [顶部](./public-three-top.json)、[底部](./public-three-bottom.json)布局通过 |
| 最小窗口，深色 | 1080×760／1080×760 | 1080×760 | 1 | 2 | 2160×1520 | [几何、滚轮和鼠标](./minimum-dark.json)通过 |
| 最小窗口，额外页面 zoom | 1080×760／1080×760 | 720×506 | 1.5 | 3 | 2160×1520 | [几何、滚轮和鼠标](./minimum-zoom-150.json)通过；不等同 Windows 150% |
| 独立压力 P1-a | 1280×720／1280×720 | 1280×720 | 1 | 2 | 2560×1440 | [记录](./pressure-1280-720.json)通过 |
| 独立压力 P1-b | 1024×640／1024×640 | 1024×640 | 1 | 2 | 2048×1280 | [记录](./pressure-1024-640.json)通过 |
| 独立压力 P1-c | 800×480／800×480 | 800×480 | 1 | 2 | 1600×960 | [记录](./pressure-800-480.json)通过 |
| Windows W1，系统 100% | 未测 | 未测 | 要求 1 | 未测 | 未测 | 待 Windows 验收 |
| Windows W2，系统 125% | 未测 | 未测 | 要求 1 | 未测 | 未测 | 待 Windows 验收 |
| Windows W3，系统 150% | 未测 | 未测 | 要求 1 | 未测 | 未测 | 待 Windows 验收 |

CSS 通过 `index.html` 实际 `<link>` 顺序加载全部生产样式，文件 URL 可解析字体路径；断言每个样式表已加载且含规则，等待 `document.fonts.ready` 后再测量。只用 Chromium `sendInputEvent` 完成鼠标点击、wheel、键盘 Tab／Shift+Tab／PageDown／Space／Enter；按钮完整矩形、`elementFromPoint`、原回调计数同时核对。没有用 DOM `.click()` 代替“按钮未遮挡”的证据。管理页／选择器部分逻辑准备和 OOS-01 的原关闭回调用 DOM 事件，并明确不据此宣称独立框真实点击验收通过。

实体触控板和系统滚动条拖动没有设备手测。系统自动隐藏滚动条策略未改变；本机截图可见原生滚动条。Windows 安装包／真机数据亦未验收。

## AC 对照

| AC | 实际覆盖 | 状态／边界 |
| --- | --- | --- |
| AC01 | 前置资金 100 混合结果首次三个按钮可见、真实输入 | 本机通过 |
| AC02 | 正文顶／中／底、末项矩形、footer 稳定、卡片不二次溢出 | 本机通过 |
| AC03 | 1／10／50／100 项，单／双／三按钮，短框自然高度、原初始按钮 | 本机通过 |
| AC04 | 连续长文件名／路径、长标签、压力窗口下完整按钮矩形及命中 | 本机通过 |
| AC05 | 生产最小配置、窗口放大再缩回、页面 zoom | macOS 通过；Windows W1–W3 待执行 |
| AC06 | 无可修复项单按钮；混合项仅失败且 canRepair+token 进入请求 | 受控 API 通过，不操作真实资金文件 |
| AC07 | 导出取消／成功／失败，修复失败／部分失败，再反馈和 retry-token | 受控 API 通过 |
| AC08 | 滚动／resize／关闭不额外修复导出；busy 拒关及日志合并 | 新增 fixture 通过；重复点击／owner 等由现有生命周期套件共同覆盖 |
| AC09 | 原输入／按钮初始焦点、正文命名、焦点轮廓、Tab 环、键盘滚动、根返回焦点、深浅主题 | 本机通过；实体设备和 Windows 输入仍待手测 |
| AC10 | 平盘真实控制器独立报错、VCC 真实消息、自建同名类、日期删除表单 | 不误命中通过；OOS-01 不计作修复 |
| AC11 | 两个公共工厂默认路径，无新滚动参数 | 通过 |
| AC12 | 链接表长汇总 → ADM → BOC → 银行派生链；“现在导入／稍后” | 受控 API 通过 |
| AC13 | merge/read/split 失败、多文件成功、按行成功 | 真实工具箱＋公共工厂通过 |
| AC14 | 两个旧 class 的真实 CSS 共存、三处布局包装核对；存档正文追加错误节点 | 通过；逐包装静态清单见 [call-inventory](../call-inventory.md) |
| AC15 | 全部文件正文、转义、ADM 50 条／工具箱 20 条上限、日志一次／skip、原回调 | 通过 |
| AC16 | 静态清单、40 项受控回归、实测环境、截图、最终输入哈希 | 本机证据齐备；完整门禁通过，Windows 缺口单列 |

## 代表性截图

- [公共三按钮顶部](./public-three-top.png)／[底部](./public-three-bottom.png)。
- [前置资金 100 条混合结果](./prefund-mixed.png)。
- [工具箱普通多文件成功](./toolbox-multiple.png)／[合并失败](./toolbox-merge-failed.png)。
- [深色主题](./minimum-dark.png)／[页面 zoom 150%](./minimum-zoom-150.png)。
- [VCC 独立消息](./vcc-independent.png)／[平盘 OOS-01 记录](./position-oos-01.json)。

截图是辅助证据；相应 JSON 记录的是本次执行的测量，自动断言和退出码决定测试结果。当前未提交、未合并、未发布，不能将本机门禁结果写成 Windows 或全模块独立弹框全部修复。
