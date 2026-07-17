# Spec — v3.0.18 Windows 在线升级

> status: apply
> owner: PM
> created: 2026-07-16
> updated: 2026-07-16
> implementation branch: `codex/v3.0.18-online-update`

## 0. 任务摘要

- Goal：让 Windows NSIS 安装版从后续稳定版本开始可通过 GitHub Releases 在线升级；portable 保持手动下载，并提供统一、可解释的设置与状态入口。
- Context：v3.0.18 是在线升级能力的引导版本，v3.0.17 及更早版本没有更新客户端，因此必须由用户手动安装 v3.0.18。
- Constraints：无代码签名；自动更新默认关闭；不设周期定时器；业务运行时禁止进入升级重启；本 change 不改变账单、金额、币种、对账和 Excel 输出契约。
- Done when：本文件 AC-01～AC-20 全部通过，Windows 打包产物和稳定通道资产完整；隔离的公开测试仓库先证明真实安装链，首个后继稳定版发布后、正式公告前再完成生产仓库 canary `3.0.18 → 后继版本` 验证。

## 1. 背景

- 为什么要做：当前版本升级依赖用户自行发现、下载和安装，新版本触达与升级路径不统一。
- 用户 / 业务价值：安装版用户可自主选择是否自动检查；发现新稳定版后由升级服务受控下载，并在安全时机重启安装。portable 用户仍保持免安装特性，在设置页获得明确的手动下载入口。
- 当前问题：应用没有更新设置入口、NSIS 更新状态机、GitHub Releases feed 配置或升级重启保护；现有业务忙状态分散在多个主进程锁和 worker 中。
- 引导版本边界：v3.0.18 本身不能被旧版在线推送。用户必须手动安装一次 v3.0.18；在线升级能力从 v3.0.18 升到下一个高版本稳定 Release 时首次生效。

## 2. 代码现状（必须有出处）

| 事实 | 出处 | 对本迭代的约束 |
|---|---|---|
| 当前基线版本为 `3.0.17`，Windows 同时生成 NSIS 与 portable | `package.json` 的 `version`、`build.win.target` | 两种包必须显式分流，不能把 portable 当作可安装更新包 |
| Windows 构建存在 `signtoolOptions.publisherName: "pzhong"`，没有 `verifyUpdateCodeSignature` 与 `publish` | `package.json` 的 `build.win`、`build` | 无签名方案必须移除 publisherName、关闭更新签名校验并补稳定发布配置 |
| 底部入口当前为 `🎨 📕 🔄 🧰` | `index.html` 的底部圆形按钮区域 | 新增 `⚙️` 后顺序必须为 `🎨 📕 ⚙️ 🔄 🧰` |
| Renderer 通过 `window.desktopApi` 调用主进程，弹窗由 JS 动态创建 | `src/preload.js`、`src/renderer.js` | 更新能力只通过最小 IPC 暴露，不向 Renderer 暴露 updater 实例或任意外链 |
| 通用设置已存于 SQLite `app_settings`，已有 `getSetting` / `setSetting` | `src/backend/database/settings-repository.js`、`src/backend/database.js` | 开关复用现有设置表，不新增 migration |
| 启动采用分阶段、非阻塞初始化 | `src/main.js` 的 `DEFERRED_WINDOW_STARTUP`、`appInitDone`、`app:get-info` | 启动检查不得阻塞窗口创建、`ready-to-show` 或 Renderer 初始化完成 |
| 导入、对账、导出、worker 等业务忙状态分散 | `src/main.js` 的 operation locks、`fileImportInProgress`，`src/backend/run-check-worker-pool.js` 等 | 更新重启需要统一、原子的业务操作注册器，不能只检查某一个按钮或布尔值 |
| 退出时已有 usage flush、worker shutdown、pending run cleanup | `src/main.js` 的 `before-quit` 处理 | `quitAndInstall` 必须复用并兼容现有退出清理，不得绕过或重复破坏清理链 |

基线为 `4375f29`。本 change 编写期间 Dev 已在同一工作树开始依赖、设置和业务操作注册器改动；这些未提交改动不是本规格的事实来源，也不由 PM 文档回滚或代改。

## 3. 目标

### 3.1 必做

- Windows NSIS 安装版通过公开仓库 `MatthewPZhong/bank-bill-excel-tool` 的 GitHub Releases `latest` 稳定通道检查和下载更新。
- portable 不检查 feed、不判断最新版本，只提示用户并打开 GitHub Releases；任何 portable 路径都不加载 `electron-updater`。
- NSIS 自动更新默认关闭；开启后主实例每次启动只后台检查一次，不设任何周期定时器。
- NSIS 当前会话从关闭切换为开启时立即发起一次检查；“立即检查”始终可由用户触发，不受开关限制。
- NSIS 固定 `autoDownload=false`；检查到更新后，由升级服务在确认请求仍有效后显式调用 `downloadUpdate(cancellationToken)`。
- NSIS 从开启切为关闭时，立即取消尚未开始的启动检查和正在进行的自动下载；已失效自动请求的迟到事件不得覆盖 `disabled`。
- 设置弹窗展示当前版本、自动检查开关、状态/进度、“立即检查”及与状态匹配的后续动作；portable 显示静态手动下载提示。
- NSIS 下载完成后提供“立即重启”和“稍后”；业务运行时拒绝立即重启且保留已下载状态。
- 无签名构建显式移除 `publisherName` 并设置 `build.win.verifyUpdateCodeSignature=false`。
- 更新检查、下载、错误、重启阻断均可观察、可测试，且不影响账单处理与启动性能门槛。

### 3.2 可不做

- 状态文案和进度可在不改变状态枚举、操作语义与验收口径的前提下微调。
- 下载完成提示可复用仓库现有动态弹窗样式；不要求使用操作系统原生通知。

### 3.3 明确不做

- 不支持 macOS、Linux 自动更新。
- 不支持 beta、alpha、prerelease、draft、多通道切换、灰度百分比或降级安装。
- 不做强制更新、静默强制重启、周期轮询、后台常驻检查。
- portable 不做 feed/API 元数据检查，不加载 `electron-updater`，不做应用内更新包下载、差分更新、自动安装或自重启。
- v3.0.17 及更早版本不具备在线升级到 v3.0.18 的能力。
- 本迭代不购买或接入代码签名证书，不承诺消除 Windows SmartScreen“未知发布者”提示。
- 不修改银行账单处理、金额/币种语义、数据库业务 schema 或 Excel 输出。

## 4. 功能点

### 4.1 设置入口与弹窗

- 说明：在底部圆形按钮区新增设置按钮 `⚙️`，顺序固定为 `🎨 📕 ⚙️ 🔄 🧰`。
- 输入：用户点击 `⚙️`。
- 输出：打开单实例设置弹窗，至少包含：
  - 标题“设置”和关闭入口；
  - 当前版本，取主进程 `app.getVersion()`，显示为 `v3.0.18`；
  - “自动检查更新”开关；NSIS 可操作，portable 固定关闭且禁用，并说明便携版仅支持手动下载；
  - 当前包类型：安装版 / 便携版；
  - NSIS 更新状态和最近检查时间；下载时展示 0～100% 进度；
  - NSIS 显示“立即检查”；portable 主动作显示“前往下载”，若复用“立即检查”入口，其 portable 行为也只能打开 Releases；
  - NSIS 已下载时展示“立即重启”“稍后”；portable 不展示版本发现、下载进度或安装动作。
- 边界：弹窗重复打开不得重复注册 updater 监听器或自动触发检查；关闭弹窗本身不取消操作，只有 NSIS 开关从开启切为关闭才执行本规格定义的自动操作取消。
- 验收标准：见 AC-01、AC-02。

### 4.2 NSIS 开关、启动检查、取消与手动检查

- 设置键：`auto_update_enabled`，复用 `app_settings`；仅 `'1'` 解释为开启，缺失、`'0'` 或非法值均解释为关闭。
- 开关写入只接受 boolean。关闭到开启的每一次有效状态切换都先持久化，再在当前会话发起来源为 `toggle` 的自动检查。
- 应用启动时，在数据库与主窗口可用后调度一次可取消的启动任务：
  - 关闭：不访问 feed，状态为 `disabled`；
  - 开启：取得 single-instance lock 的主应用实例后台检查一次；只负责唤醒已有窗口的 second instance 不检查；
  - 不使用 `setInterval`、递归 `setTimeout` 或任何周期任务。
- 开关变更必须先持久化再触发：写入失败时 UI 回退到主进程真实值且不检查；写入 true 成功后即使检查失败也保持开启，不因网络错误回滚用户偏好。
- 从开启切为关闭时，主进程按以下顺序执行：
  1. 先持久化 false；失败则保持原开启状态且不取消；
  2. 成功后递增自动操作 epoch，立即发布 `enabled=false/status=disabled`；
  3. 取消尚未真正调用 `checkForUpdates()` 的 startup 调度句柄；
  4. 若来源为 `startup` 或 `toggle` 的自动下载正在进行，调用其专属 `CancellationToken.cancel()`；
  5. 已开始但无法物理取消的自动检查只允许结束底层请求，结果被 epoch 判旧，禁止调用 `downloadUpdate`，也禁止其 `update-available`、progress、downloaded、error 等迟到事件覆盖 `disabled`。
- 取消属于正常控制流，不展示“检查失败”。取消后的临时下载由 updater 清理/复用，但不得暴露“立即重启”；以后重新开启或手动检查必须重新确认当前 stable 元数据。
- “立即检查”是 `manual` 请求，无论开关开/关都真正检查 NSIS stable feed，且不隐式改变开关。由 manual 请求启动的下载不受自动开关取消；即使 `enabled=false`，其手动 checking/downloading/downloaded 状态仍可显示。
- 自动更新关闭期间若 manual 检查或下载仍在进行，随后开启开关只持久化 true 并复用当前操作；必须保留 checking/downloading 状态和进度，不重复检查、不误报 busy。当前 manual 操作结束后，新的开关值用于后续启动检查。
- 同一时刻只允许一个底层 NSIS 检查。操作来源在创建时固定；手动点击若加入已有自动请求，不把它改成 manual，随后关闭开关仍会取消该自动请求，用户可在 disabled 后再次点击“立即检查”。
- disabled 后若旧 automatic 检查仍在底层收尾，新的“立即检查”不得加入该 stale Promise；协调器至多排队一个 manual 请求，在旧 Promise settle 后立即创建新的 manual operation。该排队是用户主动请求，不受自动开关限制。
- disabled 后若旧 automatic 仍在收尾而用户快速重新开启，协调器排队一个 `toggle` 检查；旧操作 settle 且开关仍开启、automatic epoch 未再次变化时才真正执行。执行前再次关闭则丢弃该排队自动检查；期间若用户主动点击“立即检查”，尚未创建的排队请求升级为 manual 并在旧操作 settle 后执行。
- 后台启动检查不得抢焦点：无更新和网络错误只更新状态并记录日志；下载完成才弹一次应用内提示。手动检查结果在设置弹窗中明确反馈。
- 验收标准：见 AC-03～AC-07、AC-09、AC-15、AC-17、AC-20。

NSIS 触发矩阵：

| 触发 | 开关关闭 | 开关开启 | 下载所有权 | 是否改变开关 |
|---|---|---|---|---|
| 主实例启动 | 不检查，`disabled` | 后台检查一次 | automatic，可取消 | 否 |
| 关闭 → 开启 | 不适用 | 立即检查一次 | automatic，可取消 | 是，写为开启 |
| 开启 → 关闭 | 取消待执行 startup；取消自动下载；使自动迟到事件失效 | 不适用 | 不影响独立 manual 操作 | 是，写为关闭 |
| 点击“立即检查” | 检查并在发现更新后显式下载 | 同左 | manual，不受开关取消 | 否 |
| 周期定时器 | 无 | 无 | 无 | 否 |

### 4.3 稳定通道与版本判定

- Provider 固定写在 `build.publish[0]`：`provider=github`、`owner=MatthewPZhong`、`repo=bank-bill-excel-tool`、`channel=latest`、`publishAutoUpdate=true`、`releaseType=release`。
- `allowPrerelease=false`、`allowDowngrade=false`；只有已发布、非 draft、非 prerelease 且 SemVer 严格高于当前版本的 Release 才是更新。
- 不在运行时调用 `setFeedURL`，不在应用中打包 `GH_TOKEN`、PAT 或其他发布凭据；Feed 由 electron-builder 生成的 `app-update.yml` 提供。
- 目标仓库必须保持公开。若改为 private，客户端匿名更新契约失效，必须停止发布并重新评审分发与凭据方案。
- 稳定 Release 必须包含并相互匹配：`latest.yml`、NSIS Setup `.exe`、对应 `.blockmap`；portable `.exe` 作为手动下载资产同时上传。构建目录保留中文品牌产物；发布前按 `latest.yml.path` 复制一份 ASCII 安全名的 Setup 及 blockmap，Release 只上传该元数据实际引用的 Setup，避免 GitHub 资产名与 updater URL 不一致。
- 所有构建步骤（包括 release workflow 的构建）都显式使用 `--publish never`。受控 workflow 先在尚未创建 Release 的阶段完成测试、构建、资产文件名/版本/hash 清单校验；全部通过后，再由独立 release step 自动创建 published、non-draft、non-prerelease Release 并上传同一批已校验资产。流程不采用草稿暂存，也没有人工发布步骤。
- Tag 采用 `v<semver>`，Release title 可同名；不可覆盖同版本资产来“热修”，修复必须发布更高 SemVer。
- 验收标准：见 AC-08、AC-16、AC-18。

### 4.4 NSIS 安装版更新流程

- 只有包类型为 NSIS 时才加载并使用 `electron-updater`；初始化即固定 `autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=false`、`allowDowngrade=false`。
- `checkForUpdates()` 返回可用更新后，升级服务必须再次校验 packageType、operation source、request id/epoch 和开关约束，再显式调用 `downloadUpdate(updateCheckResult.cancellationToken)`。不得依赖 updater 隐式自动下载。
- automatic 请求只有在 epoch 仍有效且开关仍开启时可开始/继续下载；manual 请求不读取开关作为下载门禁。
- 显式设置 `autoInstallOnAppQuit=false`。“稍后”表示本次会话不重启、不排队、不在普通退出时静默安装；已下载状态保留到当前进程结束。
- 下一次启动是否重新检查仍由开关决定；开关关闭时用户可通过“立即检查”重新发现并使用缓存/重新下载。
- automatic 状态流转：`disabled → checking → available → downloading → downloaded`，关闭时可从 checking/available/downloading 立即回到 `disabled`；manual 可从 `disabled` 进入 checking/available/downloading/downloaded。无更新进入 `up-to-date`，非取消错误进入 `error`。
- 下载完成只提示一次，并在设置弹窗持续提供“立即重启”“稍后”。点击“稍后”仅关闭本次提示，不清理下载缓存；若用户正在编辑其它弹窗，更新提示等待该弹窗关闭后再显示，不得替换并丢失用户输入。
- 下载完整性由 updater 对 `latest.yml` 中的校验信息执行；校验失败不得进入 `downloaded`，不得安装。
- 验收标准：见 AC-09、AC-12～AC-15。

### 4.5 portable 提示流程

- Windows 打包态通过 `PORTABLE_EXECUTABLE_FILE` 是否存在识别 portable；不存在且为已打包 Windows 应用时视为 NSIS。未打包环境标记为 `development`，其它已打包平台保留平台名；这些环境均为 `supported=false`。
- 必须先判定 packageType，再决定是否加载 updater。portable 进程和 portable 测试路径禁止 import/require/初始化 `electron-updater`，不读取 `app-update.yml`，不访问 GitHub feed/API，也不做版本比较。
- portable 设置页使用 `distribution=portable`、`supported=false`、`state=disabled`，提示“便携版不支持应用内检查和升级，请前往 GitHub Releases 手动下载”。自动更新开关固定关闭且禁用，不写 `auto_update_enabled`。
- portable 点击共享“立即检查”入口或“前往下载”均只让主进程打开固定 `https://github.com/MatthewPZhong/bank-bill-excel-tool/releases`；不拼版本 tag，Renderer 不能传 URL。
- portable 启动永不产生更新网络请求；任何分支都不得调用 `checkForUpdates`、`downloadUpdate` 或 `quitAndInstall`。
- 验收标准：见 AC-10、AC-15、AC-18、AC-19。

### 4.6 下载完成、业务忙与重启安装

- “业务运行中”指任一会修改业务状态、占用业务文件、等待 worker 或产生导入/处理/导出结果的操作尚未结束，包括所有模块的导入、读取/解析、运行/匹配/对账/计算、生成/导出/拆分合并、清理/恢复及相关 worker 任务。
- 只读设置、查看帮助、更新检查和更新下载本身不计为业务运行。
- 主进程维护统一业务操作注册器：所有上述用户触发 IPC 和后台/定时清理、worker 任务都要在共同编排边界真正开始前原子注册，在 `finally` 中释放；已有 operation lock、`fileImportInProgress` 和 worker busy 作为防御性补充检查，不得只依赖 Renderer 按钮禁用态。install transition 已开始时，用户任务返回明确 busy，后台任务安全跳过并留待下次，不得与安装退出并发。
- 用户点击“立即重启”时，主进程必须原子执行 install transition：
  1. 再次确认包类型为 NSIS 且状态为 `downloaded`；
  2. 若已有业务操作，返回 `blocked-busy` 和脱敏后的操作名称，不退出、不安装、不丢失下载状态；
  3. 若无业务操作，锁定 install transition，拒绝新业务开始；
  4. 标记 update install intent，调用 `quitAndInstall` 并允许安装完成后重新启动；
  5. 与现有 `before-quit` 清理链协作，确保 usage flush、worker shutdown、pending cleanup 只执行一次且不会递归阻断安装。
- 忙时不自动排队、不在业务结束后突然重启。用户结束业务后必须再次点击“立即重启”。若启动安装前同步失败，释放 install transition，保留 `downloaded` 并显示错误。
- install transition 已取得但退出清理尚未完成时，窗口关闭请求必须被阻止，避免普通退出链与安装退出链同时接管；清理完成后由 `quitAndInstall` 发起的窗口关闭正常放行。清理或安装启动失败时释放 transition，原窗口继续可用。
- 验收标准：见 AC-12～AC-14、AC-20。

### 4.7 状态模型与 IPC 契约

主进程是唯一状态源，Renderer 只读取快照和订阅变化。只持久化开关，其他运行态在进程重启后重建。

```text
UpdateState = {
  enabled: boolean,
  supported: boolean,
  distribution: string,
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' |
         'downloaded' | 'up-to-date' | 'error',
  currentVersion: string,
  targetVersion: string | null,
  percent: number,
  lastCheckedAt: string | null,
  canRestart: boolean,
  busyOperations: string[],
  error: { code: string | null, message: string } | null
}
```

Preload 固定暴露 `window.desktopApi.appUpdate` 的以下能力：

| 能力 | 输入 | 主进程结果 |
|---|---|---|
| `getStatus()` | 无 | 返回完整、可序列化的 `UpdateState` |
| `setEnabled(enabled)` | boolean | 仅 NSIS 可用；false→true 触发自动检查，true→false 执行取消与 epoch 失效 |
| `checkNow()` | 无 | NSIS 发起 manual 检查并显式下载；portable 直接打开固定 Releases 页面 |
| `restartAndInstall()` | 无 | 成功、业务繁忙、不支持或尚未下载 |
| `onStatusChanged(listener)` | callback | 注册状态监听并返回退订函数；弹窗重开不叠加监听器 |

错误对象不得把本地用户路径、Release 凭据、请求 header 或堆栈直接暴露给 Renderer。NSIS 请求使用单调 request id/automatic epoch；所有 updater 事件都先校验当前 operation，已取消 automatic 的迟到事件不得覆盖 `disabled`。

### 4.8 错误处理与可观测性

- NSIS 网络离线、超时、404、损坏/缺失 `latest.yml`、资产缺失、校验失败和 GitHub 限流均不影响业务功能。启动检查失败回到 `idle` 且只写日志；手动检查或显式下载失败进入可重试 `error`；安装启动失败保留 `downloaded/canRestart` 并附带脱敏错误，允许用户再次重试。`CancellationError` 映射为受控取消，不进入 error。
- 启动后台检查错误不向 Renderer 暴露，也不弹阻塞框；手动检查错误显示脱敏中文可行动文案“检查失败，请稍后重试”，详细原因仅进入现有活动日志。
- 日志至少记录触发源（startup/toggle/manual）、包类型、当前/目标版本、状态迁移、下载进度关键点、错误类别、重启阻断与 install intent；不得记录 token。
- portable、非 Windows 和未打包开发态不访问生产 feed，均通过 `distribution + supported=false + state=disabled` 解释原因。已打包 NSIS 若缺失/损坏 `app-update.yml` 属于发布缺陷，必须进入 `error` 并阻止发布，不能伪装为不支持。
- 未签名风险需在发布检查记录中明确：`verifyUpdateCodeSignature=false` 仅关闭 Authenticode 发布者校验；HTTPS 与 updater 哈希校验不能等价替代代码签名，用户仍可能看到 SmartScreen 警告。

## 5. 验收标准

| ID | 验收口径 |
|---|---|
| AC-01 | 底部按钮顺序和可访问名称严格为 `🎨 📕 ⚙️ 🔄 🧰`，原四个按钮行为不变。 |
| AC-02 | NSIS 设置弹窗完整展示当前版本、开关、状态/进度、“立即检查”和状态动作；portable 显示禁用开关、静态手动提示和“前往下载”；重开无重复监听/检查。 |
| AC-03 | 新库、缺失键、`0` 或非法值均默认关闭，首次启动没有更新网络请求。 |
| AC-04 | 开关已开启时，取得 single-instance lock 的主实例每次启动后台检查恰好一次；second instance 只唤醒窗口不检查，首屏与 Renderer 初始化不等待检查结果。 |
| AC-05 | NSIS false→true 立即检查；true→false 取消待执行 startup 和自动下载，立刻进入 disabled；已失效 automatic 的任何迟到事件都不能改写 disabled。 |
| AC-06 | NSIS 开关关闭时点击“立即检查”仍执行 manual 检查并显式下载，且不改开关；manual 不被自动开关取消，旧 stale automatic 未结束时至多排队一次并随后执行。 |
| AC-07 | 无更新周期定时器；同一时刻只有一个底层 NSIS 检查；操作来源固定，updater 事件只绑定一次并按 request/epoch 过滤。 |
| AC-08 | NSIS 只接受公开 GitHub `latest` 中严格更高的 published、non-draft、non-prerelease SemVer；相同和更低版本均不升级。 |
| AC-09 | NSIS 始终 `autoDownload=false`；有效请求发现更新后升级服务显式调用一次 `downloadUpdate(cancellationToken)`，进度可见且校验通过后才 downloaded。 |
| AC-10 | portable 不加载 electron-updater、不读 feed/API、不判断版本；“立即检查/前往下载”只打开固定 GitHub Releases 首页，不下载、不安装。 |
| AC-11 | Windows 构建移除 `publisherName`，设置 `build.win.verifyUpdateCodeSignature=false`；打包应用不含发布 token。 |
| AC-12 | NSIS 下载完成后可选择“立即重启”或“稍后”；提示最多一次，动作在设置页持续可用。 |
| AC-13 | 任一业务操作活跃时“立即重启”返回 `blocked-busy`，应用不退出、数据不丢失、下载状态仍为 `downloaded`。 |
| AC-14 | 空闲时 install transition 原子阻止新业务开始，并完成既有退出清理后安装和重启；“稍后”及普通退出不静默安装。 |
| AC-15 | NSIS 无网、feed/资产/校验错误可重试且不阻塞业务；自动取消不报错，启动错误只写日志，手动错误以脱敏中文文案清晰展示。 |
| AC-16 | v3.0.18 发布说明明确要求旧用户手动安装；隔离公开测试仓库先完成真实安装链，首个后继 stable 发布后、公告前完成生产仓库 canary `3.0.18 NSIS → 后继版`。 |
| AC-17 | NSIS 开关跨重启持久化；取消 epoch、进度、错误和运行态不持久化；disabled 后 stale automatic 事件不可复活状态。 |
| AC-18 | Release workflow 先校验完整资产，再自动直接创建 published、non-draft、non-prerelease Release；无 draft/人工发布步骤，日志与客户端无敏感信息。 |
| AC-19 | portable、非 Windows 和未打包环境均不加载 updater、不访问 feed，并通过 `distribution/supported/state` 正确说明；NSIS 状态机通过注入 adapter 测试。 |
| AC-20 | 完整 `release-check`、启动性能检查和现有退出清理回归通过；更新功能不改变账单/金额/币种/Excel 行为。 |

## 6. 影响范围

- 前端：`index.html`、`src/styles-gemini.css`、`src/styles-gemini-extra.css`、`src/renderer.js`，新增设置入口和更新状态 UI。
- 主进程：`src/main.js`、`src/preload.js`、新的更新协调器/业务操作注册器，接入启动、IPC、事件和退出安装。
- 后端：现有 settings repository/facade 增加 boolean 开关读写，不新增表或 migration。
- 配置 / 依赖：`package.json`、`package-lock.json` 增加运行时 `electron-updater`，配置 GitHub publish 与无签名校验策略。
- 测试 / 脚本：增加状态机、设置、IPC、业务忙原子门禁、打包资产与 Windows 安装升级验证。
- 对外接口影响：新增 Renderer→Main IPC，仅限应用内部；无已有 IPC 破坏性变更。
- 兼容性影响：旧数据库缺键自动关闭；NSIS 覆盖安装继续使用同一 Electron `userData`；portable 数据目录行为不变。
- 资金影响：无。本 change 不参与资金计算、匹配、回填或 Excel 生成，无需改变资金人工复核口径。

## 7. 技术决策

| 决策 | 选择 | 不选其他方案的原因 | 风险 / 缓解 |
|---|---|---|---|
| 更新实现 | NSIS 懒加载 `electron-updater` + GitHub provider；portable 只用 `shell.openExternal` | portable 元数据检查会引入无价值 feed/updater 依赖 | 包型判定必须早于 updater require，并用模块加载测试锁定 |
| 稳定通道 | 校验完成后由 workflow 直接创建公开 non-draft Release | draft+人工发布不符合最终发布计划，私有仓库需要客户端凭据 | workflow 在创建 Release 前完成资产校验，创建后再做自动核验 |
| NSIS 下载 | `autoDownload=false`，服务显式 `downloadUpdate(cancellationToken)` | updater 隐式下载无法可靠归属触发源和执行关闭取消 | 每次操作独立 token、source、request id/epoch |
| 关闭取消 | 取消待执行 startup 与 automatic download，stale event fail-closed | 仅改开关不取消会违背用户控制并让 disabled 被迟到事件复活 | CancellationToken + epoch 双层门禁，取消不是 error |
| 稍后语义 | `autoInstallOnAppQuit=false`，不自动排队 | 普通退出时安装可能绕过业务忙门禁，也违背“稍后”的直觉 | 下次启动重新发现，设置页保留手动入口 |
| portable | 不做 feed/版本检查，固定打开 Releases 首页 | portable 不是受支持的自动安装目标，也无需得知 latest | 永不加载 updater；固定 URL 由主进程持有 |
| 重启保护 | 主进程统一操作注册器 + 原子 install transition | Renderer disabled 或单个全局锁存在旁路和竞态 | 所有业务 IPC try/finally 注册，旧锁作补充 |
| 签名 | 本版本不签名，关闭 updater 代码签名校验 | 当前没有证书且需求已确认 | 发布资产人工核验、哈希校验、SmartScreen 风险告知 |
| 状态 | 主进程内存状态机，DB 只存开关 | 持久化进度/错误会产生陈旧状态和恢复歧义 | 进程启动后从 idle 重建 |

## 8. 数据 / 状态 / 安全影响

- 数据结构：只新增 `app_settings.auto_update_enabled` 逻辑键，值为 `'1'` / `'0'`；无 schema migration。
- 状态流转：由主进程更新协调器管理；NSIS 检查并发合并、事件只注册一次，automatic epoch 失效后迟到事件不可覆盖 `disabled`；manual source 与开关正交。
- 幂等：重复打开弹窗、重复订阅、重复点击检查和重叠启动触发都不能创建多个下载或多个安装尝试。
- 权限 / 安全：不打包 GitHub token；仅访问固定公开 GitHub HTTPS 域名；Renderer 不可提供下载 URL；更新错误输出脱敏。
- 无签名风险：关闭签名校验是显式产品风险接受，不代表更新包可信度等同签名版本。发布人员必须核对 tag、版本、`latest.yml` 和资产哈希/文件名的一致性。
- 撤回限制：已下载到客户端缓存的无签名更新无法保证被远程撤销；一旦发布 stable 应视为不可撤销，问题修复发布更高 SemVer。Release 创建前自动校验、仓库 2FA/最小发布权限和 canary 是主要缓解措施。
- 回滚策略：代码回滚可移除入口/协调器并保留未知设置键；已发布客户端不允许在线降级。生产修复通过发布更高 SemVer 完成，不覆盖旧 Release 同版本资产。
- 兼容：若 future 版本重新启用签名，需重新加入证书、publisher 校验并在已安装 v3.0.18 上验证迁移。

## 9. 非功能要求

- 启动检查完全异步，不改变仓库既有启动性能门槛。
- 更新失败不降低账单业务可用性；更新模块异常不得导致应用启动失败。
- 进度事件节流到 UI 可承受频率，避免写日志/IPC 风暴。
- 所有用户可见文案为中文，状态不只依赖颜色表达。
- Windows 10/11 至少各验证一个受支持环境；NSIS 覆盖安装后 SQLite、模板和导出目录仍可用。

## 10. 待澄清问题

- 无阻塞问题。用户已确认核心产品契约。
- 发布前待验证而非需求待定：v3.0.18 发布前用 adapter 加隔离公开 GitHub 测试仓库验证状态机与真实安装链；生产 feed 只有发布后才对匿名 stable 客户端可见，因此首个后继版本须在发布后立即 canary，未通过不得公告或继续放量。
- 仓库若从 public 改为 private、Release tag 规范变化或启用代码签名，属于契约变化，必须先回到 spec 评审。

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-07-16 | 固化 GitHub stable、NSIS/portable 分流、默认关闭、启动/开关/手动触发、无签名、业务忙重启门禁和 v3.0.18 引导版本契约。 |
| 2026-07-16 | 按最终计划改为 NSIS `autoDownload=false` + 显式可取消下载、关闭后 stale fail-closed；portable 纯 Releases 外链且不加载 updater；发布 workflow 直接创建 non-draft Release。 |
