# Implementation Notes — v3.0.18 Windows 在线升级

> status: v3.0.18 released / Windows manual validation and successor canary pending
> owner: Dev / 发布负责人
> updated: 2026-07-17

## Baseline

- 分支：`codex/v3.0.18-online-update`。
- 规格取证基线：`4375f29`，`package.json.version=3.0.17`。
- 范围：`changes/3.0.18/spec.md`；测试契约：`changes/3.0.18/test-spec.md`。
- v3.0.18 定位：用户手动安装的在线升级引导版本；在线路径首个真实目标是高于 `3.0.18` 的后继稳定 Release。
- 当前发布版本：`package.json.version=3.0.18`；tag 与 GitHub Release 已创建，线上资产回读结果见 Evidence；真实 Windows 安装链仍列在 Remaining Unknowns。

## Task Brief

- Goal：为 Windows NSIS 提供可选 GitHub Releases stable 在线升级，为 portable 提供仅提示下载路径。
- Context：Electron 36 + electron-builder，当前同时打 NSIS/portable；应用有分阶段启动和复杂业务/退出状态。
- Constraints：无签名；NSIS 默认关闭、`autoDownload=false`、关闭可取消 automatic 且 stale fail-closed；portable 纯外链且不加载 updater；发布直接 non-draft；启动一次且无 timer；手动检查不受开关限制；业务忙禁止重启；仅四份 PM/spec 文档可由本角色写入。
- Done when：本地实现、自动化、设置 preview、启动性能、重要变量和 Windows 构建资产契约完成；真实 Windows 升级链与 GitHub 保护配置作为发布前外部门禁保留。

## Confirmed Facts

| 事实 | 证据 | 结论 |
|---|---|---|
| 当前正式配置版本为 3.0.17，产物含 NSIS 与 portable | `package.json` | v3.0.18 必须先由用户手动覆盖安装，且包型必须分流 |
| 底部现有顺序为 `🎨 📕 🔄 🧰` | `index.html` | `⚙️` 插入 📕 与 🔄 之间 |
| 设置可存通用 key/value | `src/backend/database/settings-repository.js` | 复用 `app_settings`，无需 migration |
| 启动已有 deferred init | `src/main.js` | 更新检查必须 detached/non-blocking |
| 业务锁与 worker busy 分散 | `src/main.js` 及 backend worker/service | 需要统一注册器和原子 install transition |
| 退出已有清理链 | `src/main.js` 的 `before-quit` | updater 安装退出必须复用/兼容既有清理 |
| 目标 GitHub 仓库为 PUBLIC | `gh repo view`，2026-07-16；URL 见 Evidence | 客户端可匿名读取 Release，不得内置 token |
| 查询时 latest Release 为 v3.0.13 | `gh repo view ... --json latestRelease`，2026-07-16 | 当前远端 latest 低于 3.0.18 时必须判定无更新，不得降级 |
| electron-builder 将 feed 信息写入 `app-update.yml`，Windows 自动更新支持 NSIS | electron-builder 官方文档 | 使用 publish config，不在运行时 `setFeedURL` |
| `verifyUpdateCodeSignature` 是 `build.win` boolean，默认开启 | electron-builder schema / 本地 `app-builder-lib` typings | 按需求在构建配置显式设 false，不写成 updater runtime 函数 |
| portable 运行时提供 `PORTABLE_EXECUTABLE_FILE` | electron-builder NSIS 官方文档 | 将其作为 Windows 包型识别依据 |
| updater 默认 `autoInstallOnAppQuit=true` | electron-updater 官方 API / 本地 6.8.5 source | 必须显式设 false，才能保证“稍后”和业务忙门禁不被普通退出旁路 |
| `downloadUpdate(cancellationToken)` 是 `autoDownload=false` 时的官方手动下载入口 | 本地 `electron-updater/out/AppUpdater.d.ts` 与 6.8.5 source | 升级服务可持有每次操作 token 并显式开始/取消下载 |
| `CancellationToken.cancel()` 会让下载控制流以 CancellationError 结束 | 本地 `builder-util-runtime/out/CancellationToken.*` | 关闭开关可取消 automatic 下载；仍需 epoch 屏蔽迟到事件 |

## Unknowns Register

| 未知 | 分类 | 处理与证据 | 结果 / 复查触发 |
|---|---|---|---|
| GitHub 仓库是否公开，客户端是否需要 token | PROBE | `gh repo view` 查询 visibility | 已关闭：PUBLIC；若改 private，升级发布 BLOCK |
| stable feed 与 Release 类型 | PROBE | 查 electron-builder publish/auto-update 官方文档；用户最终指定发布计划 | 已关闭：构建期 GitHub publish config + `app-update.yml`，`releaseType=release`；workflow 先校验，后直接创建 non-draft Release；不运行时 setFeedURL |
| `verifyUpdateCodeSignature` 应放哪里 | PROBE | 查 build schema、WinOptions typings 与 updater source | 已关闭：`build.win.verifyUpdateCodeSignature=false`；runtime 同名能力不是 boolean |
| portable 如何可靠识别并隔离 updater | PROBE | 查 NSIS portable env 官方文档；用户最终指定 portable 不做 feed | 已关闭：先用 `PORTABLE_EXECUTABLE_FILE` 判型；portable 不 import/require updater，只打开固定 Releases 首页 |
| 自动开关放哪里 | PROBE | 检查现有 settings repository/schema | 已关闭：`app_settings.auto_update_enabled`，`'1'/'0'`，无 migration |
| “稍后”是否在普通退出时安装 | ASSUME | 以“不突然重启、业务忙门禁不可旁路”为保守语义 | 已固化：`autoInstallOnAppQuit=false`；如产品要改，必须先改 spec/test |
| 业务忙如何覆盖所有入口与竞态 | PROBE | 搜索现有 locks、worker busy 与退出链 | 已关闭设计：统一 registry + atomic install transition；全入口覆盖仍需 Dev 测试证明 |
| 启动检查何时执行 | PROBE | 检查 deferred startup 与性能门槛 | 已关闭：DB/窗口可用后 detached 触发，不阻塞 appInit/首屏 |
| 关闭开关如何取消 automatic | PROBE | 本地 API 证实 `downloadUpdate(cancellationToken)` 与 `CancellationToken.cancel()`；用户最终指定取消语义 | 已关闭：取消待执行 startup 与正在下载的 automatic，epoch 使 checking/available/progress/downloaded/error 迟到事件无法覆盖 disabled |
| 发现/下载完成时设置页关闭怎么办 | ASSUME | 已确认需提供立即/稍后动作，同时避免所有启动结果打扰用户 | 已固化：仅有可操作更新时弹一次应用内提示；状态页持续保留动作 |
| v3.0.18 发布前如何完成真实升级闭环 | PROBE | 引导版本没有更高生产 stable | 两阶段门禁：发布前用隔离公开测试 repo 的 non-draft Release 跑真实安装链；首个后继 stable 发布后、公告前立即跑生产 canary |

当前无 `BLOCK` 未知。Remaining Unknowns 均为实施/发布证据，不能用文档推断替代。

## Decisions

| ID | 决定 | 原因 | 影响 |
|---|---|---|---|
| D01 | `build.publish[0]` 固定公开 GitHub `MatthewPZhong/bank-bill-excel-tool`、`latest`、`publishAutoUpdate=true`、`releaseType=release`；workflow 校验后直接创建 non-draft Release | 用户最终明确不采用 draft+人工发布 | 普通构建禁止发布；创建 Release 前自动校验资产，创建后自动核验 |
| D02 | v3.0.18 为手动安装引导版本 | 旧版没有 updater | Release notes 必须显式告知；首个真实在线目标是后继版 |
| D03 | `auto_update_enabled` 默认 false，只存 `'1'/'0'` | 明确 opt-in 并兼容旧库 | 无 migration，非法值 fail closed |
| D04 | 开启时主实例每次启动检查一次，无周期 timer；startup 调度在执行前可取消 | 完全匹配需求并避免后台轮询 | second instance 不检查；关闭开关可取消尚未开始的 startup |
| D05 | false→true 当前会话立即检查；checkNow 与开关正交 | 区分用户偏好与主动操作 | 手动检查不改设置 |
| D06 | 同时只保留一个底层 NSIS 检查，operation source 创建后固定；stale automatic 收尾期间使用单槽排队，manual 优先，toggle 仅在开关仍开启且 epoch 未变化时执行；监听器只绑定一次 | 防止重复网络/下载、取消所有权漂移，又保证“立即检查”和快速重新开启都不漏请求 | coordinator 使用 in-flight Promise + automatic epoch + pending kind/generation |
| D07 | NSIS `autoDownload=false`、`autoInstallOnAppQuit=false`；available 后服务显式 `downloadUpdate(result.cancellationToken)` | 用户最终要求下载由升级服务受控，才能区分 automatic/manual 并取消 | automatic 开始下载前复核 epoch/开关；“稍后”不静默安装 |
| D08 | portable 不做元数据/feed/API 检查、不加载 updater，只打开固定 Releases 首页 | 用户最终明确 portable 仅手动下载 | `distribution=portable/supported=false/state=disabled`；开关禁用；updater 模块加载次数必须为 0 |
| D09 | 主进程是状态与权限唯一来源 | Renderer 不可信且生命周期短 | IPC 语义化、输入校验、事件可退订 |
| D10 | 业务 registry 覆盖全部长时/写操作，安装切换原子锁定 | 现有分散锁存在入口旁路和 TOCTOU 竞态 | 忙时不退出；安装开始后拒绝新业务 |
| D11 | 忙后不自动重启 | 防止业务刚结束时突然退出 | 用户需再次点击“立即重启” |
| D12 | 运行时状态不持久化，DB 只存 NSIS 开关 | 避免陈旧 downloaded/error/progress/epoch | 启动后重建 disabled/idle；portable 不写开关 |
| D13 | 移除 publisherName，`build.win.verifyUpdateCodeSignature=false` | 无签名是已确认约束 | 接受 SmartScreen/供应链风险，保留 HTTPS + hash 校验和发布前自动门禁 |
| D14 | 不调用 `setFeedURL`，不内置 token | 构建产物已有 app-update 配置，公开仓库无需 token | 减少配置漂移和凭据泄露 |
| D15 | NSIS 只有下载完成才主动提示；无更新/后台错误不抢焦点 | 启动检查应后台进行，available 会立即进入受控下载 | 手动检查仍在设置页给出明确结果 |
| D16 | 只有取得 single-instance lock 的主实例执行启动检查 | second instance 只负责唤醒窗口，不能重复网络请求 | 启动测试需覆盖第二实例 |
| D17 | 打包 NSIS 缺失 `app-update.yml` 记为发布错误 | 不支持状态会掩盖损坏产物；portable 本就不读取该文件 | 非 NSIS 通过 `distribution/supported=false/state=disabled` 解释，不加载 updater |
| D18 | true→false 先持久化，再 epoch 失效并取消 startup/automatic download；stale 事件 fail-closed | 用户关闭必须立即生效，单靠 token 无法防止竞态迟到事件 | CancellationError 不报错；manual source 不受自动开关取消 |
| D19 | portable 的共享“立即检查”和“前往下载”都打开固定 Releases 首页 | portable 不知道 latest，也不能接受 Renderer URL | 不拼 tag、不显示版本发现或 Release notes |

## Assumptions

- GitHub 仓库在该更新机制生命周期内保持 public，稳定 Release 可匿名访问。
- 正式 tag 使用 `v<semver>`，feed 中版本可规范化为纯 SemVer 比较。
- portable 的手动下载入口固定打开仓库 Releases 首页，由用户自行选择资产；不在应用内解析 latest、tag 或任意 asset。
- v3.0.18 的 NSIS 覆盖安装沿用同一 appId/userData，因此现有 SQLite 与模板可保留；必须由 Windows P0-24 证实。
- 无签名风险已由需求方接受，但 Windows 实际 SmartScreen 文案仍需发布负责人记录并写入用户说明。
- Stable 一经发布且客户端下载后不保证可远程撤回；错误版本通过停止公告并发布更高 SemVer 修复，不能覆盖同版本资产。

## Deviations

- 初稿曾采用 updater 隐式下载；最终计划改为 `autoDownload=false`，available 后由服务显式 `downloadUpdate(cancellationToken)`。
- 初稿曾写为关闭只影响未来触发；最终计划改为取消待执行 startup 与正在进行的 automatic download，并用 epoch 屏蔽 disabled 后的迟到事件。
- 初稿曾让 portable 检查 feed 元数据；最终计划改为完全不加载 updater/不访问 feed，只打开固定 Releases 首页。
- 初稿曾采用草稿暂存和人工发布；最终计划改为 workflow 前置校验后直接创建 published、non-draft、non-prerelease Release。
- 上述偏差均已同步到 `spec.md`、`test-spec.md` 和 `tasks.md`，不保留旧契约兼容路径。
- Windows 真实构建发现 electron-builder 的 `latest.yml` 使用 ASCII `safeArtifactName`，而磁盘只生成中文品牌 Setup；若直接发布会导致 updater 请求不存在的资产。新增 `stage-update-artifacts.js`，在发布前校验 SHA-512 并复制元数据实际引用的 Setup/blockmap，品牌 portable 和本地品牌产物保持不变。
- 实现将公开状态错误改为固定中文可行动文案，底层路径、URL、堆栈和原始错误只写 `app-update` 日志；启动后台检查失败回到 idle，不向 Renderer 广播 error。
- `electron-updater` 的检查结果 CancellationToken 优先用于后续显式下载；只有 adapter 未返回 token 时才创建后备 token。并发 manual 加入 startup/toggle 时，下载沿用真实检查来源，关闭开关仍可取消 automatic。
- 检查结果与下载完成只由各自 Promise 落定，升级器事件只承担当前下载进度；无活跃操作的迟到 available/downloaded/error 不得改状态。快速关闭再开启会排队新的 toggle，执行前再次关闭即失效，manual 请求可升级尚未创建的排队操作。
- 设置页补齐 `v` 前缀和最近检查时间；下载完成时若其它业务弹窗仍打开则延后提示，避免替换未保存输入。安装器同步启动失败时恢复已停止的统计/idle 定时器和退出准备状态，同时保留 downloaded 重试入口。
- 最终自审发现三个本地 Windows 构建脚本在新增 GitHub provider 后仍缺少显式发布禁令；已统一补 `--publish never`，并在静态契约测试中锁定，防止本地或普通构建绕过受控 Release workflow。
- PR #91 自审发现 install transition 清理期间仍可由用户窗口关闭触发普通退出链；已在窗口 `close` 事件阻止清理完成前的关闭，清理完成后的 `quitAndInstall` 正常放行，并补 P0-14B 契约。
- PR #91 UI 自审补齐 downloaded 设置页的显式“稍后”动作和自动更新开关无障碍名称；手动检查进入下载后失败时保留“下载失败”语义，不再降级成笼统的“检查失败”。
- PR #91 状态机自审补齐“自动更新关闭时手动下载、随后开启开关”的并发边界：保留 downloading 状态并复用当前操作，不重复检查或误报 busy。
- `src/main.js` 的源码抽取测试因新增 registry 依赖需注入 stub；已只调整测试 harness，不改变既有银行对账 operation lock 语义。
- 首次正式 `v3.0.18` tag workflow 在 Windows `release-check` 阶段暴露 12 组 SQLite 单测清理失败：测试已调用 `AppDatabase.close()`，但门面缺少该生命周期接口，macOS 允许删除已打开文件而掩盖问题，Windows 则以 `EBUSY` 阻断发布。新增幂等 `close()` 并清空已关闭句柄，不改变 schema 或业务读写契约；失败 workflow 未进入构建和 Release 创建阶段，不存在半发布资产。
- 修复后的 workflow 完成测试、构建、应用检查、staging、哈希校验和 Release 创建后，最终复核因 GitHub 自动把中文 portable 资产名规范化为 `-3.0.18-portable.exe` 而误报缺失。线上四个二进制/元数据资产实际完整，portable PE 头与 GitHub SHA-256 digest 一致，Setup SHA-512 与线上 `latest.yml` 一致。按不可变发布原则不修改 v3.0.18 已发布资产；后续发布预先 staging `bank-bill-excel-tool-portable-<version>.exe`，上传和复核统一使用该 ASCII 名称。
- Dev 若改变 provider、开关默认值、检查频率、稍后语义、portable 能力、业务忙范围、签名策略、发布资产或 IPC 行为，必须先更新 spec/test 并由 PM 复核，不能仅在代码中静默偏离。

## Evidence

| 日期 | 类型 | 证据 | 支持结论 |
|---|---|---|---|
| 2026-07-16 | 仓库 | `AGENTS.md`、`CODEX.md`、`rules/*`、`changes/templates/*`、`changes/3.0.17/*` | 项目约束、文档格式、分支与验证流程 |
| 2026-07-16 | 代码 | `package.json`、`index.html`、`src/main.js`、`src/preload.js`、`src/renderer*.js`、settings repository | 当前包型、入口、IPC、启动、设置、退出与业务状态基线 |
| 2026-07-16 | GitHub | `gh repo view MatthewPZhong/bank-bill-excel-tool --json visibility,isPrivate,url,latestRelease` 返回 PUBLIC、latest v3.0.13 | 匿名 stable 方案可行；低版本 latest 不得触发降级 |
| 2026-07-16 | 官方文档 | https://www.electron.build/auto-update.html | NSIS updater、`latest.yml`、事件与 app-update 配置 |
| 2026-07-16 | 官方文档 | https://www.electron.build/docs/publish/ | GitHub provider、owner/repo/channel 与 `releaseType=release` 配置能力；最终采用用户指定的直接 non-draft workflow |
| 2026-07-16 | 官方文档 | https://www.electron.build/nsis.html | portable 环境变量与 Windows target 行为 |
| 2026-07-16 | 官方 API | https://www.electron.build/electron-updater.Class.AppUpdater.html | `autoDownload`、`autoInstallOnAppQuit`、allowPrerelease/allowDowngrade、quitAndInstall |
| 2026-07-16 | 本地依赖 | `node_modules/app-builder-lib/.../winOptions.d.ts`、`node_modules/electron-updater/out/AppUpdater.{d.ts,js}`、`node_modules/builder-util-runtime/out/CancellationToken.*` | 签名配置层级、`autoDownload=false` 手动下载、CancellationToken、安装退出与事件实现 |
| 2026-07-16 | 用户最终计划 | 本 change 四条纠偏指令 | 显式可取消下载、disabled stale 隔离、portable 零 updater/feed、直接 non-draft 发布为最终优先契约 |

| 2026-07-17 | 自动化 | PR #91 全部自审修复后重新执行 `npm run release-check`：lint/smoke 全绿、unit 3673/3673、integration 41 个脚本及 1939/1939 断言全绿；unit 日志 `logs/unit-tests/unit-20260717-055507.log` | 升级专项与现有业务、资金和 Excel 契约均未回归 |
| 2026-07-16 | 升级专项 | 默认关闭、取消、stale 隔离、SemVer、错误脱敏、业务闸门和 metadata staging 均有自动化覆盖 | 更新状态机和发布资产脚本受回归测试保护 |
| 2026-07-16 | 启动性能 | `npm run startup:measure`：平均 total 774.268ms、ready-to-show 176.721ms、window visible 103.157ms | 后台启动检查未回退首屏门槛 |
| 2026-07-16 | UI | `docs/previews/app-update-settings.png` 人工检查 | 设置弹窗、按钮顺序、状态/进度和布局无重叠 |
| 2026-07-16 | 重要变量 | `npm run scan:vars` 完成；`npm run check:vars -- --include-minor` 按约定以退出码 2 提醒命中 | 4 个 Important-skeleton、4 个 Runtime-state、2 个 Minor 已逐项复核；无 Critical/Risk-sensitive 命中 |
| 2026-07-16 | Windows 构建 | Windows x64 交叉构建产出 NSIS、portable、latest.yml、blockmap；`stage:update-artifacts` 后 metadata path/SHA-512 与发布 Setup 完全匹配，`app-update.yml` 为 GitHub latest | 构建与匿名 updater 资产契约成立 |
| 2026-07-16 | 发布交接 | `docs/WINDOWS_RELEASE_RUNBOOK.md` | 远端 environment/branch/tag 保护、不可变资产与 Windows canary 门禁有明确执行清单 |
| 2026-07-17 | Windows CI | 首次 `v3.0.18` Release workflow run `29622101428` 在 unit teardown 阶段失败：115 个失败均源于 12 个测试文件删除未关闭 SQLite 时的 `EBUSY`；build/release steps 均未执行 | 失败属于跨平台测试资源生命周期缺口，不是业务断言失败；必须先修复并重新走 PR、tag 和发布门禁 |
| 2026-07-17 | 发布修复回归 | 受影响的 12 组测试加生命周期测试共 137/137 通过；`npm run release-check` 为 unit 3674/3674、integration 41 个脚本及 1939/1939 断言全绿；`scan:vars` 完成且 `check:vars -- --include-minor` 未命中重要变量 | `AppDatabase.close()` 修复在本地无业务回归，待 PR Windows CI 证明 `EBUSY` 已消除 |
| 2026-07-17 | v3.0.18 正式发布 | workflow run `29622809519` 的 Windows `release-check`、构建、应用检查、staging、更新资产校验和 Release 创建均成功；Release `https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.0.18` 为 published/non-draft/non-prerelease，四个资产均可匿名读取 | Windows 文件锁修复生效；在线更新所需 Setup、blockmap、latest.yml 完整，portable 仅发生 GitHub 官方文件名规范化 |
| 2026-07-17 | 线上资产回读 | 无认证请求 `latest.yml` 返回 HTTP 200；下载线上 metadata 与 Setup 后计算 SHA-512 完全一致；portable 下载后为 99,221,741 bytes、`MZ` PE 头、SHA-256 `ad24c753cc47248bad5c946d53a43646de65c78e37eebcf172a974a99dbb41a5`，与 GitHub asset digest 一致；GitHub [Release assets 官方文档](https://docs.github.com/en/rest/releases/assets)说明会重命名含特殊/非字母数字字符的资产名 | v3.0.18 Release 可由公开客户端匿名读取且二进制内容无缺失；最终 workflow 红灯是名称复核假阴性，后续改用 ASCII staging 名 |
| 2026-07-17 | 发布命名修复回归 | `npm run release-check`：unit 3675/3675、integration 41 个脚本及 1939/1939 断言全绿；`scan:vars` 完成，`check:vars -- --include-minor` 因无 `src/` 改动跳过 | ASCII portable staging、上传和发布后复核契约不影响应用运行时或既有资金/Excel 行为 |

以上为本地和交叉构建证据。真实 Windows 安装/重启与远端 GitHub 保护仍见 Remaining Unknowns。

## Remaining Unknowns

- Windows 10/11 无签名 NSIS 的真实下载、SmartScreen、v3.0.17 覆盖安装、`quitAndInstall` 重启和用户数据保留尚未执行；v3.0.18 已发布，公告或推广前仍须补证；Owner：发布负责人。
- Windows 实包中 `CancellationToken.cancel()` 对 full/differential automatic 下载的中断、缓存处置和迟到事件顺序仍需实机复核；Owner：发布负责人；截止：首个后继 stable 公告前。
- `production-release` environment 已允许本次受控 tag workflow 执行；`main` 与 `v*` 的服务端保护规则细节仍未独立核验；Owner：仓库管理员；截止：下一个发布 tag 前。
- 隔离公开测试仓库的真实 `3.0.18 → 3.0.19` 链和生产 `3.0.18 → 后继 stable` canary 尚未执行；Owner：首个后继版本发布负责人；截止：对应 Release 公告前。

## Handoff

- v3.0.18 Release 和线上资产已完成自动与回读校验，不得替换同版本资产。
- 发布负责人补齐 Remaining Unknowns 中的 Windows 安装、取消下载和数据保留证据。
- 首个后继 stable 创建后、公告前，必须由 v3.0.18 NSIS 从生产 `latest` 完成 canary；失败则停止公告并发布更高补丁版本。
