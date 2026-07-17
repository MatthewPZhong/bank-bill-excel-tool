# Tasks — v3.0.18 Windows 在线升级

> 每个 task 按风险优先、可验证、可独立 review 拆分。除 Task 1 外均由 Dev 执行；PM/spec 不直接修改业务代码、package 或版本文档。

## Task 1：冻结产品契约与测试映射

- 目标：固化 NSIS 显式可取消下载、关闭 stale fail-closed、portable 纯外链、直接 non-draft 发布、稍后语义、业务忙门禁和引导版本边界。
- 涉及文件：`changes/3.0.18/spec.md`、`changes/3.0.18/test-spec.md`、`changes/3.0.18/tasks.md`、`changes/3.0.18/implementation-notes.md`。
- 操作：确认 AC-01～AC-20 与 P0/P1 一一可追踪；任何行为变更先反向同步 spec。
- 验证：四份文档互相引用一致；无阻塞未知；写入范围仅上述四份文件。
- 依赖：无。
- 状态：done

## Task 2：先建可注入更新状态机与失败测试

- 目标：在接真实 updater 前证明状态迁移、operation source、automatic epoch、取消、并发去重、迟到事件和包类型门禁。
- 涉及文件：建议新增 `src/main-process/update-coordinator.js` 及对应 `tests/unit/main-process/` 测试；最终路径由 Dev 遵循仓库结构确定。
- 操作：定义固定状态快照、distribution/support 门禁、operation source、单调 automatic epoch、单 in-flight check、可取消 startup scheduler、stale automatic 收尾后的单槽排队（manual 优先，toggle 受 epoch/开关门禁）、一次性事件绑定；注入 app/updater/distribution/log adapter。
- 验证：P0-04～P0-09、P0-16～P0-20、P1-01～P1-05 单测先 Red 后 Green；证明 stale automatic 事件无法复活 disabled，测试不访问生产 GitHub。
- 依赖：Task 1。
- 状态：done（状态机与专项单测已完成）

## Task 3：配置依赖、稳定发布与无签名策略

- 目标：生成可消费 GitHub stable feed 的 Windows NSIS/portable 产物。
- 涉及文件：`package.json`、`package-lock.json`、`.github/workflows/release-windows.yml` 及必要的打包测试/检查脚本。
- 操作：
  - 将 `electron-updater` 加为 runtime dependency；
  - 在 `build.publish[0]` 配置 GitHub `provider/owner/repo/channel=latest/publishAutoUpdate=true/releaseType=release`；
  - 移除 `build.win.signtoolOptions.publisherName`，若对象为空则移除空对象；
  - 设置 `build.win.verifyUpdateCodeSignature=false`；
  - 保持现有 NSIS/portable artifactName 兼容；包括 release workflow 在内的 build 步骤全部 `--publish never`；Release 不存在时先完成测试、构建、版本/文件名/hash 校验，再由独立 step 自动创建 published、non-draft、non-prerelease Release 并上传同一批资产；不设置人工发布 gate。
- 验证：P0-22、P0-23；unpacked `app-update.yml`/资源配置正确且包内无 token；不调用运行时 `setFeedURL`；前置校验失败时 Release 创建调用为 0，成功流程无 draft/人工发布步骤。
- 依赖：Task 1。
- 状态：done（代码、workflow、真实 Windows x64 交叉构建和资产校验已完成）

## Task 4：持久化默认关闭的自动检查开关

- 目标：复用现有 SQLite settings，保证旧库安全默认关闭。
- 涉及文件：`src/backend/database/settings-repository.js`、`src/backend/database.js`、对应 unit tests。
- 操作：实现 `auto_update_enabled` 的 boolean 读写；缺失/非法值返回 false；拒绝非 boolean 写入；不新增 migration；portable UI 禁用开关且不写该键。
- 验证：P0-01、P0-02，现有 settings 全量测试通过。
- 依赖：Task 1。
- 状态：done

## Task 5：接入 NSIS 显式下载与 portable 外链隔离

- 目标：NSIS 受控显式下载并可取消 automatic；portable 只打开固定 Releases 首页且不加载 updater。
- 涉及文件：Task 2 的更新协调器、可能的 updater adapter 模块、日志模块。
- 操作：
  - 依据 `PORTABLE_EXECUTABLE_FILE` 与 `app.isPackaged/platform` 先判包型，只有 NSIS 分支才懒加载 `electron-updater`；
  - NSIS：固定 `autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=false`、`allowDowngrade=false`；check 返回 available 后按 source/epoch 再校验，并显式 `downloadUpdate(result.cancellationToken)`；
  - 为 startup/toggle automatic 保存 cancellation token；关闭开关时 cancel，`CancellationError` 归类为正常取消，所有事件先过 request/epoch；stale check 收尾期间的 manual 请求只排一个并在 settle 后执行；
  - portable：固定 `distribution=portable/supported=false/state=disabled`，不加载 updater、不读 feed/API、不比较版本；“立即检查/前往下载”只调用主进程固定 Releases URL。
- 验证：P0-05～P0-10、P0-16～P0-20、P1-02～P1-04；模块加载 spy 证明 portable 的 updater require 为 0。
- 依赖：Task 2、Task 3。
- 状态：done（真实 Windows 下载/安装链仍归 Task 11）

## Task 6：建立无旁路的业务操作注册器与原子安装门禁

- 目标：业务运行时绝不重启，并消除“刚检查空闲就有新业务开始”的竞态。
- 涉及文件：`src/main-process/business-operation-registry.js`、`src/main.js`、所有相关业务 IPC 注册点及测试。
- 操作：
  - 所有导入、解析、运行/匹配/对账/计算、生成/导出/拆分合并、清理/恢复和 worker 任务用 begin/`finally` end 包裹，既包括 IPC，也包括 idle timer/后台任务的共同编排边界；
  - install transition 原子检查 active operations 并在成功后拒绝新业务；
  - 旧 locks、`fileImportInProgress`、worker busy 作为补充防线；
  - 忙时返回脱敏操作名称，不排队自动重启；install transition 后用户任务返回 busy，后台任务安全跳过；失败时释放 transition。
- 验证：P0-12～P0-15；以 IPC 清单扫描证明全部入口已覆盖，异常/取消路径无 token 泄漏。
- 依赖：Task 2。
- 状态：done（统一 tracked/business wrapper、两把既有锁、worker 与 idle cleanup 已接入；真实运行竞态仍归 Task 11）

## Task 7：接入启动、IPC 与退出安装链

- 目标：实现一次性且可在执行前取消的后台启动检查、开关无关的 manual 检查和安全 `quitAndInstall`。
- 涉及文件：`src/main.js`、`src/preload.js`、更新协调器及 integration tests。
- 操作：
  - 在 DB/窗口可用后调度可取消 startup check，不阻塞 `ready-to-show`/`appInitDone`；false 写入成功时先 epoch 失效、再取消待执行 startup/automatic download；
  - 注册 `getStatus/setEnabled/checkNow/restartAndInstall/onStatusChanged` 能力，严格校验输入；NSIS checkNow 创建 manual source，portable checkNow 直接打开 Releases；
  - portable 外链由主进程固定为仓库 Releases 首页，不接收 Renderer URL；
  - install intent 与现有 `before-quit` 清理幂等协作，安装后重新启动；
  - Renderer 销毁后不再发送事件。
- 验证：P0-03～P0-07、P0-11、P0-15、P0-17、P0-26、P1-09。
- 依赖：Task 4～Task 6。
- 状态：done（Windows `quitAndInstall` 实机时序仍归 Task 11）

## Task 8：实现设置弹窗和底部入口

- 目标：提供完整、可访问且不打断后台启动的设置体验。
- 涉及文件：`index.html`、`src/styles-gemini.css`、`src/styles-gemini-extra.css`、`src/renderer.js`、preview/DOM tests。
- 操作：
  - 底部顺序调整为 `🎨 📕 ⚙️ 🔄 🧰`；
  - NSIS 展示当前版本、可用开关、状态/时间、进度和“立即检查”，根据 downloaded 提供“立即重启/稍后”；
  - portable 展示当前版本、禁用开关、手动下载提示和“前往下载”；共享“立即检查”入口在 portable 也只打开 Releases；
  - 应用初始化时取快照并只注册一份状态订阅，设置弹窗重复打开复用该状态源；关闭弹窗不取消下载，提示去重，状态不只依赖颜色。
- 验证：P0-21、P1-03、P1-05、P1-06、P1-10；桌面与窄窗口 preview 人工检查。
- 依赖：Task 7。
- 状态：done（设置弹窗 preview 已人工检查）

## Task 9：自动化回归与重要变量复核

- 目标：证明更新模块不破坏既有业务和启动/退出行为。
- 涉及文件：`tests/unit/`、`scripts/integration/`、必要的 preview/packaging checks；不改变业务契约。
- 操作：补齐 `test-spec.md` P0/P1 自动化；覆盖显式 downloadUpdate、startup/automatic 取消、stale event、portable 模块不加载、直接 non-draft 发布、updater 错误、退出清理、业务入口注册与静态构建配置。
- 验证：`npm run release-check`、`npm run startup:measure`、`npm run scan:vars`、`npm run check:vars -- --include-minor`；输出 PASS 计数和证据路径。
- 依赖：Task 2～Task 8。
- 状态：done（完整本地验证结果见 implementation notes）

## Task 10：候选版本与发布文档交接

- 目标：由 Dev/发布负责人在实现和验证完成后更新正式版本材料并通知 PM 复核。
- 涉及文件：`package.json`/lock 的 version、`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 及 Release notes。
- 操作：明确写入“v3.0.18 需手动安装的引导版本”、默认关闭、NSIS/portable 差异、无签名 SmartScreen 风险和首个后继版门禁。
- 验证：三份版本文档同步、version 一致、硬节点 `/check-vars` 通过；发布说明不宣称 v3.0.17 可在线升级。
- 依赖：Task 9。
- 状态：done

## Task 11：Windows 打包、直接发布与首个后继版本门禁

- 目标：完成真实 Windows 分发闭环并保留用户数据。
- 涉及文件：打包/Release 资产、release workflow 与验证记录；代码文件无额外假定。
- 操作：
  - v3.0.18：Windows 10/11 手动覆盖安装 v3.0.17，核对 NSIS 默认关闭与取消、portable 纯外链/不加载 updater、资产匿名访问和 SmartScreen；
  - 发布前：用隔离公开 GitHub 测试仓库和测试构建完成一次真实 `3.0.18→3.0.19` 安装链；
  - 生产 workflow：全部前置校验通过后直接创建 non-draft/non-prerelease Release，不等待人工发布；
  - 首个后继 stable：生产 Release 创建后、公告前，用 v3.0.18 NSIS 从生产 GitHub latest canary 下载、重启、安装并验证版本/数据。
- 验证：P0-23～P0-27；确认无 draft/人工发布阶段；任何真实升级、业务忙保护或数据保留失败均阻止公告/继续放量。
- 依赖：Task 10，且首个后继 stable 资产已构建并通过前置校验。
- 已完成交接：`docs/WINDOWS_RELEASE_RUNBOOK.md` 已记录远端保护、发布前后门禁与不可替换资产规则。
- 状态：todo
