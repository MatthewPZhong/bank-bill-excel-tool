# 真实 Main 截图复核 — v3.2.9

日期：2026-09-19。工作树：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool-worktrees/release-v3.2.9`。只修改 `scripts/verify-dark-mode-live.js`，没有修改产品源码；源码与验证脚本哈希记录见 `source-hashes.json`。

## 诊断

原脚本在 `did-finish-load` 后检查 DOM，设置点击后只等待两次 `requestAnimationFrame`，随后直接调用 `capturePage()`。DOM/rAF 已完成不代表 compositor 已呈现新画面。旧 JSON 中设置可见，但 PNG 仍是主页面，属于截图没有核验对应画面的证据缺陷。

本次实测 Main 在 `did-finish-load` 时 `window.visible=false`，Renderer 初始化完成后为 `true`，与正常 Main 的 `show:false → ready-to-show → show` 顺序相符。没有复现窗口持续不显示或设置弹窗未打开。旧运行日志未记录窗口状态，不能倒推旧截图时窗口必然未显示。

## 脚本修正

- 新增可选 `DARK_MODE_LIVE_EVIDENCE_DIR`，父/子进程统一绝对路径；本轮写入新的临时证据目录，没有覆盖旧图或旧 JSON。
- 等待真实 Main 自行显示窗口，不调用验证用 `show()` 绕过正常启动。
- 订阅实际 presentation frame，主动请求重绘，以当前 DOM 几何位置和背景色校验实际帧像素后保存。设置截图取 3 个弹窗内部采样点，旧主页面帧不能满足该条件。
- 两个冷启动场景分别保存启动稳定画面、重载后的深色画面、真实外观设置画面，并记录应用版本、窗口状态、DOM、像素检查与隔离路径。
- JSON 明确标注：`did-finish-load` 仅验证加载完成状态，未连续采样整个启动过程，不证明首帧或无闪白。

## 本轮执行

```sh
DARK_MODE_LIVE_EVIDENCE_DIR=/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented node scripts/verify-dark-mode-live.js
```

结果：退出码 0；light/dark 两场景 2/2 PASS，每场景 11 个断言，0 failures、0 Renderer errors。两场景均为真实 Main + Preload + Renderer、应用版本 `3.2.9`、正常单实例锁。userData/Documents 使用同一临时夹具下的独立目录，实际 app paths 已断言，结束后已删除。截图 CSS viewport 为 1240×860，DPR 2，PNG 为 2480×1720。

| 场景 | 启动加载完成主题 | IPC 切换 | 重载 | 设置 DOM/截图 |
| --- | --- | --- | --- | --- |
| light | light / 白色 body | 开启 dark、关闭 light | dark | visible=true、checked=true、dark；实际 PNG 显示外观设置 |
| dark | dark / 深色 body | 开启 dark、关闭 light | dark | visible=true、checked=true、dark；实际 PNG 显示外观设置 |

人工查看本轮两张 settings PNG，均清楚显示设置导航、外观标题、已开启开关、时间字段和返回按钮。另将旧 PNG 与新 PNG 按同一采样坐标解码核对：两张旧图均拒绝，两张新图均通过，结果见 `screenshot-regression.json`。

首次新增验证器曾将浅色主页面底部渐变当成纯白背景，导致该验证器自身失败；已选用确认无渐变的主页面边缘背景点。该失败记录保留于相邻 `night-live-final/` 和 `night-live-final-run.log`，不作为产品缺陷。设置弹窗的 3 点校验未放宽。

`node --check scripts/verify-dark-mode-live.js` 与 `git diff --check -- scripts/verify-dark-mode-live.js` 均通过。未重复运行全量门禁；当前产品核心冻结门禁由主任务执行。

## 证据文件

- [运行结果](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-runtime.json)
- [旧/新截图回归](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/screenshot-regression.json)
- [浅色冷启动](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-light-startup.png)、[浅色启动后重载](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-light-reload-dark.png)、[对应外观设置](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-light-startup-dark-settings.png)
- [深色冷启动](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-dark-startup.png)、[深色启动后重载](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-dark-reload-dark.png)、[对应外观设置](/private/tmp/v329-release-20260919-3_bafjvz/night-live-presented/live-dark-startup-dark-settings.png)

边界：本次为 macOS 源码运行的稳定状态/真实 IPC/重载/设置证据，不是 Windows 安装包验收，也不是启动全程录像或无闪白证明。
