# Test Spec — v3.0.18 Windows 在线升级

> status: apply
> created: 2026-07-16
> updated: 2026-07-16
> source: `changes/3.0.18/spec.md` AC-01～AC-20

## 1. 测试目标

- 核心业务逻辑：验证开关与三类触发、NSIS `autoDownload=false` + 显式 `downloadUpdate`、关闭取消与 stale fail-closed、portable 纯外链隔离、下载后动作及原子业务忙门禁。
- 边界条件：缺失/非法设置、待执行 startup 取消、自动下载 cancellation token、重复监听、并发检查、迟到事件、manual/automatic 所有权、相同/低版本、非 Windows/开发态、普通退出与缓存重发现。
- 错误路径：离线/超时/限流、feed/资产缺失、哈希校验失败、外链非法、退出清理失败和 updater 异常。
- 回归范围：底部四个既有按钮、应用启动性能、现有 `before-quit` 清理、所有业务 IPC、SQLite 数据、NSIS 覆盖安装和完整 `release-check`。
- 发布目标：v3.0.18 验证“手动引导安装 + 更新能力就绪”；首个后继稳定版本验证真实公开 GitHub `3.0.18 → 后继版` 闭环。

## 2. 测试分层

- 单元测试：
  - 设置键缺失/非法/boolean 持久化；
  - packageType 识别、SemVer/stable 过滤、状态机、并发去重、operation source、automatic epoch 与迟到事件；
  - NSIS `autoDownload=false`、显式下载及 `CancellationToken`；portable 在模块加载层面隔离 updater；
  - 业务操作注册器 begin/end、原子 install transition、新业务拒绝和失败释放；
  - 状态快照脱敏、固定 Release URL 构造。
- 集成测试：
  - 主进程启动触发、IPC/preload 参数校验与事件退订；
  - updater 事件序列、startup 调度取消、显式下载/取消、下载完成动作、现有 `before-quit` 协作；
  - 各业务入口被统一注册器覆盖，异常分支在 `finally` 释放；
  - package 配置与打包资产静态契约。
- E2E / 手工验证：
  - Windows 10/11 打包态设置弹窗、NSIS 与 portable；
  - 真实安装覆盖、SmartScreen 文案、更新下载/重启、业务忙阻断；
  - GitHub Release 资产、自动 non-draft 发布与匿名访问；
  - v3.0.18 到首个后继稳定版的真实升级回放。

测试 adapter 必须允许注入当前版本、包类型、事件和失败，不得让普通单元/集成测试访问生产 GitHub。

## 3. P0 必测场景

| ID / 场景 | 输入 | 前置条件 | 预期 |
|---|---|---|---|
| P0-01 默认关闭 | NSIS 新库、缺失键、`0`、`true` 等非法值 | 分别启动应用 | 开关均为关闭、状态 disabled、没有 feed 请求；对应 AC-03、AC-17 |
| P0-02 开关持久化与写失败 | false→true→重启→false→重启；再注入 DB 写失败 | SQLite 可写/故障 adapter | 只存 `'1'/'0'`；跨重启准确恢复；非 boolean 被拒；写 false 失败时不取消自动操作，UI 保持 true；写成功后的网络失败不回滚 true |
| P0-03 开启即查 | 设置弹窗将 false 切为 true | 当前会话无检查 | 立即产生恰好一个检查并持久化 true；对应 AC-05 |
| P0-04 主实例启动一次 | 开关预置 true | 启动主实例、保持运行，再启动 second instance | 主实例初始化后后台检查恰好一次，second instance 只唤醒窗口且不检查，长时间无第二次；不阻塞首屏；对应 AC-04、AC-07 |
| P0-05 手动不受开关限制 | 开关 false，点击“立即检查”，feed 返回 `3.0.19` | NSIS adapter 可计数 | 执行一次 manual check，服务显式调用一次 downloadUpdate，开关仍 false；对应 AC-06、AC-09 |
| P0-06 并发与来源固定 | startup 检查未完成时点击立即检查 | adapter 延迟返回 | 底层请求只有一个、事件监听一套；operation source 仍为 automatic，不因 manual join 改类；对应 AC-07 |
| P0-07A 取消待执行 startup | 开关 true 启动，在调度执行前切 false | 可控 scheduler | startup handle 被取消，`checkForUpdates` 为 0 次，状态立即 disabled；对应 AC-05 |
| P0-07B 取消自动下载 | startup/toggle 已显式调用 downloadUpdate 后切 false | 可观测 CancellationToken | 先持久化 false，再调用该 token.cancel；CancellationError 不记 error；无 downloaded/restart 动作；对应 AC-05、AC-15 |
| P0-07C 自动迟到事件隔离 | true→false 后依次注入旧 request 的 available/progress/downloaded/error | automatic epoch 已失效 | 所有事件被忽略，enabled=false/status=disabled 不变；对应 AC-05、AC-17 |
| P0-07D manual 不被取消 | 由“立即检查”启动下载时 true→false | operation source=manual | 开关写为 false，但 manual 检查/下载继续并可进入 downloaded；对应 AC-06 |
| P0-07E disabled 后立即手动 | 取消仍在收尾的 automatic 后连续点击“立即检查” | 旧 updater check Promise 未 settle | 不加入 stale Promise；只排队一个 manual，旧 Promise settle 后新建 manual check 并可显式下载；对应 AC-06、AC-07 |
| P0-07F 快速重新开启 | automatic 检查失效收尾期间 false→true；再覆盖执行前再次 false | 旧 updater check Promise 未 settle | 第一次重开排队一个 toggle 并在旧 Promise settle 后真正检查；再次关闭使排队 toggle 失效；期间 manual 请求仍被保留；对应 AC-05～AC-07 |
| P0-07G manual 运行中开启 | 开关 false 时手动检查进入 checking/downloading，再切 true | manual operation 尚未完成 | 持久化 true，保留原状态和进度，底层 check/download 均不重复，也不返回 busy；对应 AC-05～AC-07 |
| P0-08 稳定版本筛选 | draft、prerelease、当前版、低版本、高版本 stable | 当前 `3.0.18` | 仅高版本 stable 进入 available/download；对应 AC-08 |
| P0-09 NSIS 显式下载成功 | stable `3.0.19` + 匹配 feed/Setup/blockmap | 打包 NSIS `3.0.18`，`autoDownload=false` | check 只返回 available 且无隐式 downloadPromise；服务以返回的 cancellationToken 显式调用 downloadUpdate 恰好一次，进度 0～100，校验后 downloaded，提示仅一次；对应 AC-09、AC-12 |
| P0-10 NSIS 稍后 | downloaded 后点“稍后”，再普通退出 | `autoInstallOnAppQuit=false` | 当前会话不重启，普通退出不安装；状态在本会话保持 downloaded；对应 AC-14 |
| P0-11 空闲立即重启 | downloaded 后点“立即重启” | 注册器无业务操作 | 原子取得 install transition，新业务入口被拒绝，既有退出清理完成一次，安装后重新启动；对应 AC-14 |
| P0-12 业务忙阻断 | 分别在导入、解析、对账/匹配/计算、生成/导出、拆分合并、worker、定时/后台清理运行时点击立即重启 | downloaded | 每类都返回 blocked-busy；不退出、不安装、业务结果不丢、状态仍 downloaded；对应 AC-13 |
| P0-13 忙结束不偷重启 | P0-12 后让业务结束 | 不再点击重启 | 不自动安装或重启；再次点击才进入 install transition |
| P0-14 原子竞态 | 无业务时点击立即重启，同时尝试启动业务 | 精确控制两个调用交错 | 只能有一方获准：install transition 成功后新业务返回 busy，不存在安装与新业务同时开始 |
| P0-14B 关闭窗口竞态 | install transition 已取得、退出清理 Promise 未完成时点击窗口关闭；随后分别让清理成功/失败 | 精确控制 close 与 cleanup 交错 | 清理未完成时阻止窗口关闭和普通退出抢占；成功后只由安装器退出，失败后释放 transition 且原窗口继续可用 |
| P0-15 安装启动失败 | `quitAndInstall` 前置/同步失败 | downloaded、无业务 | 释放 install transition，应用可继续使用，状态仍 downloaded，错误可重试 |
| P0-16 portable 纯手动模式 | 启动 portable 并打开设置 | `PORTABLE_EXECUTABLE_FILE` 存在；监控模块加载和网络 | `distribution=portable/supported=false/state=disabled`，开关禁用；`electron-updater` 从未 import/require/初始化，feed/API 请求为 0，所有 updater API 为 0；对应 AC-10、AC-19 |
| P0-17 portable 外链 | 分别点击共享“立即检查”和“前往下载” | P0-16 | 两者都只由主进程打开固定 `https://github.com/MatthewPZhong/bank-bill-excel-tool/releases`；Renderer 不能注入 URL；不显示 latest 版本；对应 AC-10、AC-18 |
| P0-18 包类型隔离 | NSIS、portable、macOS/Linux、未打包 dev 四种环境 | 在加载 updater 前注入环境 | 只有 NSIS 为 `supported=true` 并允许加载 updater/访问 feed；其余以 `distribution` 区分、`supported=false/state=disabled`；对应 AC-19 |
| P0-19 下载校验失败 | 篡改 Setup 或 feed hash | NSIS 下载 | 不进入 downloaded、不调用安装，状态 error，可再次检查；对应 AC-15 |
| P0-20 NSIS 网络/feed/资产错误 | 离线、超时、403/限流、404、坏 YAML、缺 Setup/blockmap；打包 NSIS 缺 `app-update.yml` | 各执行一次启动检查和手动检查 | 业务可继续；启动失败回到 idle 且只写日志，手动显示脱敏中文错误；配置缺失为 release-blocking error；CancellationError 不走本场景；无 token/本地路径泄露；对应 AC-15、AC-18 |
| P0-21 UI 契约 | 打开主界面和设置弹窗 | 各 update state | 按钮顺序 `🎨 📕 ⚙️ 🔄 🧰`；版本、包型、开关、状态、检查按钮和动作正确；重复开关弹窗无监听泄漏；对应 AC-01、AC-02 |
| P0-22 构建配置 | 检查最终 `package.json` 与 unpacked resources | Windows build | 无 publisherName，`verifyUpdateCodeSignature=false`，provider/latest/release 正确，无 token；electron-updater 为 runtime dependency；普通构建不发布；对应 AC-11、AC-18 |
| P0-23 直接 non-draft 发布 | 运行 release workflow；分别注入前置校验失败和成功 | 尚无同 tag Release | build 阶段固定 `--publish never`；失败时 Release 创建为 0；成功时独立 release step 自动创建一次 published/non-draft/non-prerelease Release 并上传已校验资产；不存在草稿或人工发布步骤；对应 AC-18 |
| P0-24 引导版本 | 在仅装 v3.0.17 的 Windows VM 安装 v3.0.18 | 用户手动下载安装 | 覆盖安装成功，原 SQLite/模板/导出数据可用；不宣称 v3.0.17 可在线升级；对应 AC-16 |
| P0-25 两阶段真实闭环 | 测试仓库 `3.0.18→3.0.19`；随后生产仓库 v3.0.18→首个后继 stable | 隔离公开测试 repo 已发布；生产后继 stable 已发布但未公告 | 发布前测试仓库证明匿名检查/下载/安装链；生产发布后立即 canary 证明相同闭环、版本更新和用户数据保留，失败则停止公告/放量；对应 AC-16 |
| P0-26 退出回归 | 普通退出、业务退出、更新退出各一次 | worker/pending cleanup 可观测 | usage flush/worker shutdown/pending cleanup 每次至多一次，无递归退出、挂死或遗留锁；对应 AC-20 |
| P0-27 全量回归 | `npm run release-check`、`npm run startup:measure` | 最终候选构建 | 全部通过，启动门槛不回退，账单/金额/币种/Excel 输出不变；对应 AC-20 |

## 4. P1 应测场景

| ID / 场景 | 输入 | 前置条件 | 预期 |
|---|---|---|---|
| P1-01 进度事件风暴 | 每 1% 或更高频进度 | NSIS 下载 | UI 更新平滑，IPC/日志经过节流，无明显卡顿 |
| P1-02 迟到事件 | 旧 automatic error/success 迟于 disable 或新 manual request 到达 | 可控 adapter | 旧 request 既不能覆盖 disabled，也不能覆盖较新的 manual 状态 |
| P1-03 弹窗关闭与开关关闭区分 | 下载中仅关闭弹窗；再重开并切关闭开关 | automatic download | 关弹窗不取消且重开见最新进度；关开关才 cancel token 并进入 disabled |
| P1-04 已下载后关闭开关 | automatic 已 downloaded 时切 false，再手动检查 | NSIS | UI 立即 disabled 且不展示重启动作；缓存不自动安装；后续 manual 重新确认后才可恢复 downloaded |
| P1-05 重复点击动作 | 快速连点检查/重启/下载页 | 对应状态 | 检查去重、重启只触发一次、外链受节流/按钮禁用保护 |
| P1-06 Release notes 异常 | 超长、HTML、空说明 | NSIS available | UI 使用安全文本/受控渲染，不执行脚本、不撑破弹窗；portable 不读取/显示 Release notes |
| P1-07 GitHub latest 落后 | latest 为 `3.0.13`，当前 `3.0.18` | 公开 feed | 显示已是最新，不尝试降级 |
| P1-08 SmartScreen | 无签名 v3.0.18/后继安装器 | 干净 Windows VM | 记录实际系统提示，用户仍可按发布说明完成安装；不误报为签名版本 |
| P1-09 多窗口/窗口已关闭 | 下载完成前主窗口关闭或重建 | 主进程仍存活 | 不向已销毁 webContents 发送事件；退出策略与 `autoInstallOnAppQuit=false` 一致 |
| P1-10 辅助功能与窄窗口 | 键盘操作、125%/150% 缩放 | 设置弹窗 | 焦点顺序、标签和按钮可用，内容可滚动且不遮挡 |

## 5. 不测项与原因

- macOS/Linux 自动安装：明确不在本迭代范围，只测 `supported=false/state=disabled` 防误触发。
- Authenticode 证书链和 publisher 匹配：本版本明确无签名并关闭代码签名校验；只验证配置和风险提示。
- 在线降级/回滚安装：`allowDowngrade=false`；生产修复通过更高 SemVer。
- beta/prerelease/灰度通道：明确不做，只验证其被稳定通道排除。
- portable 版本发现、feed/API、Release notes 与下载进度：产品明确不做；测试目标是证明这些调用为 0，而不是模拟结果。
- v3.0.17 在线升级到 v3.0.18：旧版无 updater，技术上不存在该路径，只验证手动覆盖安装。
- 真实 GitHub 全闭环在 v3.0.18 发布前若无更高 stable 资产则无法在生产仓库完成；发布前必须用隔离公开测试 repo 验证。首个后继 stable 发布后立即执行生产 canary，未通过不得公告或继续放量。
- 大规模网络地域/代理兼容矩阵：无测试资源；至少覆盖正常公网、断网和一个受限/代理环境，并记录剩余风险。

## 6. 执行顺序

1. 先让设置、packageType、状态机、并发去重和业务注册器单测 Red。
2. 再让 IPC、启动触发、updater 事件、退出协作和 package 静态契约集成测试 Red。
3. 实现最小主进程纵切后逐层 Green；先判包型，只有 NSIS 构造 updater adapter，portable 只构造固定外链能力。
4. 扩展业务操作注册器到全部相关 IPC，用 P0-12/P0-14 逐类证明没有旁路。
5. 运行专项单元/集成测试、`npm run release-check`、`npm run startup:measure`、`npm run scan:vars` 和硬节点 `/check-vars`。
6. 生成 Windows NSIS + portable，静态核对 `app-update.yml`、`latest.yml`、Setup、blockmap 和 portable 资产；普通构建显式不发布；release workflow 在前置校验后直接创建 non-draft Release。
7. Windows VM 执行 P0-21、P0-24、P1-08，并用隔离公开测试 repo 跑 P0-25 第一阶段；后继 stable 发布后、公告前跑生产 canary。
8. 保存日志、截图、Release asset 清单、版本前后截图和数据保留证明，交由发布负责人签字。

## 7. 通过门槛与证据

- P0：全部通过；任何 P0 失败均阻止对应 Release 发布。
- P1：失败必须记录影响、规避和负责人；涉及任意下载/安装旁路、数据丢失或静默重启时提升为 P0。
- 自动化证据：测试命令、PASS 计数、日志路径、startup 指标、vars 扫描结果。
- 打包证据：构建命令、Windows/架构、安装器与 feed 的 SHA-256、Release URL 与资产列表。
- 行为证据：设置页截图、portable 提示、NSIS 下载完成、业务忙阻断、升级前后版本与用户数据截图。
- 发布证据：前置校验日志早于 Release 创建；Release 为 published/non-draft/non-prerelease，流程无人工发布步骤，仓库匿名可访问，客户端内无 token。
