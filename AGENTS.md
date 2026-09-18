# AGENTS.md

项目事实、通用边界和资料入口维护在本文件；Codex 的条件化工作流见 `CODEX.md`。同一规则只维护一份正文，其他文件引用。

## 工作边界
- 遵守环境的指令层级和权限。实现请求持续推进已授权工作，不在首版后例行停等确认；仅要求分析、讨论或方案时不修改文件。
- 修改前检查 `git status --short` 和相关差异，保护用户及其他 Agent 的改动；遵循模块边界和现有模式，不做无关重构、加无关依赖或撤销无关工作。抽象须消除真实重复或符合已有模式。
- 未经明确要求不提交、推送、开 PR 或升版；真实数据和不可逆操作不得超出授权。不记录秘密、凭据、token 或敏感业务数据。
- 不擅改计划、业务/数据契约、回退、依赖、迁移策略或公共接口；认证、资金/计费/订单、安全/加密、兼容、并发/幂等行为变更须有明确任务或契约依据。
- 迁移须幂等且启动安全；单次运行的对账批量数据不得进入主数据库。side-DB 的路径、生命周期和清理规则须从仓库规则、实现及测试核实，不用摘要推断。
- 完成与影响相称的必要验证，如实报告结果及未验证项；专项要求和正式交付门禁按下表读取。

## 按需读取
按任务补齐相关代码和资料，不预读整套文档或 Skill。已掌握且确认未变的内容复用；上下文缺失、更新、范围扩大或发现冲突时补读。

| 触发条件 | 读取位置 |
|---|---|
| 用户提供 spec、存在重要未知项（定义见对应章节），或涉及业务语义、契约、迁移、跨模块设计变化 | `CODEX.md`「决策与 spec」及相关 spec |
| 独立并行工作、独立审查或专项 Skill 需求 | `CODEX.md`「协作与 Skill」 |
| 代码或测试变化，或需专项风险验证 | `CODEX.md`「验证与风险审查」 |
| PR-ready、正式 GUI 交付、升版、发布、合并或每周发版 | `CODEX.md`「交付门禁与完成」及相关 Skill |

`CLAUDE.md` 不作为 Codex 的独立必读来源。同层级旧文档/Skill 与本版的读取、委派或触发安排冲突时，说明并以本版为准；专项业务约束不因此免除。

## 项目与架构摘要
网银账单生成小助手：导入 Excel/CSV 账单，按模板映射列，导出标准化明细与余额 Excel。技术栈：Electron 36、原生 JavaScript、SQLite（`node:sqlite` 的 `DatabaseSync`）、SheetJS/XLSX；依赖版本以 `package.json` 为准。

- Renderer（`index.html`、`src/renderer.js`、`src/renderer-dialogs.js`）经 `src/preload.js` 的 `window.desktopApi` 连接 `src/main.js` 的 IPC 与业务编排。修改跨模块大文件时读相关逻辑与调用方，不强制通读全文件。
- `src/backend/database.js` 是 `AppDatabase` 门面，`database/` 下为迁移、仓储和工具；`src/backend/file-service.js` 是文件 IO 门面，`file-service/` 下为 readers、writers、normalizers、common；`src/main-process/` 管理 statement-session、statement-generation；`src/backend/*-store.js` 管理余额种子、调整和账户顺序/模式。
- 账单流程：`readers.js` 读表头/行 → 模板映射 → `normalizers.js` 规范日期/金额/币种 → 内存会话；按 MerchantId+Currency 选择大账号并写入 `lastFileImportContext` → 拆分/合并 → `writers.js` 导出。
- 主进程的 `lastGeneratedExports`、`statementImportSessions`、`lastFileImportContext` 不跨重启持久化；渲染层使用 `state`、DOM 缓存 `elements`，弹窗由 JS 动态创建，无独立 HTML 模板。
- 模板、映射、设置存 SQLite；导出、错误报告、余额种子和日志存文件系统。这里不是所有对账模块的存储清单。

## 常用命令
以实际 `package.json.scripts` 为准；配置与文档不符时核实并说明。

| 用途 | 命令 |
|---|---|
| 开发 / lint | `npm start` / `npm run lint` |
| 单测 / 覆盖率 | `npm run test:unit` / `npm run test:unit:coverage` |
| 集成 / smoke | `npm run test:integration` / `npm run smoke`；smoke 属于集成级验证 |
| 完整本地门禁 | `npm run release-check` |
| 界面预览 / 启动性能 | `npm run preview`、`npm run preview:account` / `npm run startup:measure` |
| Windows 构建 | `npm run dist:win`（安装包＋便携版）、`npm run dist:win:portable`（便携版）、`npm run dist:win:setup`（NSIS 安装包） |

## 存储位置
除数据库外，以下相对路径均以 `Documents/网银账单生成小助手/` 为根目录。

| 数据 | 路径 |
|---|---|
| 主 SQLite | `{userData}/tool-data.sqlite` |
| 导出 / 错误报告 | `exports/{date}/` / `error-reports/{date}/` |
| 活动日志 | `app_activity_log.txt` |
| 余额种子 / 模板库 | `balance-seeds/` / `templates/template-library.json` |

## 约定与分支
- 界面、用户输出、文档、错误及注释使用中文；代码、注释、文档、提交、PR 和生成产物不加 AI 署名或标识。
- 自定义错误为 `src/backend/file-service/common.js` 的 `FileValidationError`（code、message、detail lines、context）；固定字段以 `__FIXED__:` 开头，如 `__FIXED__:MerchantId=NET001`。
- `src/backend/database/migrations.js` 在每次启动时执行迁移。
- `main` 始终可发布；本地 `main` 默认跟踪远端 `main`，不作为长期预发集成分支。线上维护修复仍可走 `v1.5.x`；常规每周版本使用 `release/<版本号>` 作为集成与冻结分支。
- 本轮 `release/<版本号>` 与独立模块分支以已确认的上一正式发布标签对应提交为基线，不直接沿用旧 release 分支的浮动末端；发布前核对并纳入最新 `origin/main` 的必要更新。模块分支先合入本轮 release，再通过 `release/<版本号> -> main` 的 PR 正式合并；已有集成成果直接核验复用，不重建或清空分支。
- 正式发布标签使用附注标签 `v<版本号>`，仅在 `release/<版本号>` 的 PR 合入远端 `main` 且最终检查通过后，创建到当前 `origin/main` 的提交并推送。
- 每次发布同步更新 `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。
