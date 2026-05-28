# Spec — rpa-statement-fetch

> status: propose
> owner: 待指派
> created: 2026-05-26
> updated: 2026-05-26
> 目标分支：v3.0.0
> 关联版本：v3.0.0-beta（feature 内嵌，暂不单独 bump）

---

## 1. 背景

### 为什么要做

当前用户使用本工具的完整链路是：

```
登录企业网银 → 查询交易明细 → 手工导出 Excel → 打开本工具 → 选择文件 → 完成导入/导出
```

链路里最耗时、最容易出错的是「**手工导出**」这一步：

- 每个银行的导出入口、参数选择都不同，新员工容易选错日期/账号
- 多账号场景下要重复 N 次相同操作
- 日终对账场景每天都要做一次

如果工具能"自己去网银把账单拉回来"，用户体验会有质的提升。

### 用户/业务价值

| 维度 | 当前 | 引入 RPA 后 |
|------|------|-------------|
| 单账号取单耗时 | 2–5 分钟（含登录） | 30–60 秒（登录仍需用户） |
| 多账号取单 | 线性增长，N×手工 | 程序内循环 |
| 操作错误率 | 中（账号选错/日期选错） | 低（参数由程序控制） |
| 学习成本 | 中（不同银行 UI 差异大） | 低（统一界面） |

### 当前问题

- 工具完全依赖用户已拿到 Excel 文件，"取数"环节是黑盒
- 无法批量化，无法定时化（虽然 MVP 不做定时）

---

## 2. 代码现状（必须有出处）

### 相关文件

| 路径 | 当前职责 | 与本变更的关系 |
|------|---------|---------------|
| `src/main.js`（~7500 行） | 全部 `ipcMain.handle` 集中点；全局 session 状态 | 新增 RPA 系列 IPC，新增 `rpaSessions` 全局态 |
| `src/main-process/statement-session.js` | 导入会话状态管理 | 参考结构，新建 `rpa-session.js` |
| `src/backend/file-service/readers.js` | Excel/CSV 解析入口 | RPA 抓回的 Excel **直接复用**，不另起一套 |
| `src/backend/file-service/normalizers.js` | 列映射、日期/金额清洗 | 同上，零改动 |
| `src/preload.js` | 暴露 `window.desktopApi` 给 renderer | 追加 `rpa.*` 命名空间 |
| `src/renderer-dialogs.js`（~5000 行） | 模态对话框工厂 | 新增"网银抓取"对话框 |
| `src/renderer.js`（~3500 行） | DOM 状态绑定 | 新增入口按钮 + 状态机 |
| `assets/币种映射表.xlsx` | 币种归一化 | 无关 |

### 当前行为

- `src/main.js:102` 全局变量 `lastFileImportContext`：记录最近一次导入的"大账号"与币种上下文
- `src/main.js:106` 全局变量 `statementImportSessions`（Map）：当前正在处理的导入会话
- IPC 命名规律：`<domain>:<action>`，如 `template:list`、`account-mapping:save`
- 文件导入入口（renderer 触发）：`background:select-file`（main.js:2760）→ 走文件对话框选盘上文件

### 已知限制

- 工具内**没有任何浏览器/网络抓取能力**——全部从本地 Excel 读取
- v2.1.1 起已移除 PDF/OCR 子进程，没有现成的"子进程 + 工作流"基础设施可复用（RPA 不走子进程，走 Electron 内置 BrowserView）
- 没有凭证存储机制（无 keytar/safeStorage 集成）
- 没有 Playwright/Puppeteer 依赖

### 事实依据

```bash
$ grep "ipcMain.handle" src/main.js | wc -l    # 集中式 IPC 注册
$ ls src/main-process/                          # statement-session.js / statement-generation.js / monthly-balance.js
$ ls src/backend/file-service/                  # common.js / normalizers.js / readers.js / writers.js / pdf-worker.js
$ grep "statementImportSessions" src/main.js    # 共 7 处引用，证实全局 Map 模式
```

---

## 3. 目标

### 必做（MVP 验收门）

1. 用户能在主界面点击"从网银抓取"，弹出渠道选择对话框
2. 选择"工商银行企业网银"后，应用打开内嵌 BrowserView 加载工行企业网银登录页
3. 用户**手动完成**登录（账号、密码、Ukey、短信验证码）
4. 用户点击"开始抓取"后，程序自动跳转到"账户明细"页、自动选择"昨日"作为日期范围、自动点击"导出 Excel"
5. 程序拦截下载的 Excel 文件到应用临时目录
6. 抓取完成后，**自动调用现有导入管线**，进入现有的大账号选择 → 导出流程
7. 全程在主窗口内完成，不弹出独立浏览器窗口

### 可不做（明确推迟到下一轮）

- 多家银行支持（仅工行）
- 多账号循环抓取（单账号即可）
- 凭证存储与"自动登录"
- 余额表、回单、月度对账单（仅交易明细）
- 用户自定义日期范围（仅"昨日"硬编码 + 可手改 UI）
- 录制器、可视化流程编辑器
- 定时任务、批量任务队列

### 明确不做（永不在本变更内做）

- 短信验证码自动转发/拦截
- 账号密码持久化存储
- 桌面客户端版网银的 UIA 自动化
- 真实 Java applet / IE 插件交互
- 任何绕过银行风控/验证码的尝试

---

## 4. 功能点

### 功能点 1：渠道选择对话框

- **说明**：用户在主界面点击"从网银抓取"按钮，弹出对话框，列出已支持的渠道
- **输入**：用户点击
- **输出**：选定渠道 ID（MVP 仅 `icbc-enterprise`）+ 进入步骤 2
- **边界**：MVP 只有 1 项可选；列表数据从 `src/backend/rpa/scripts/<channel>/meta.json` 加载
- **验收**：对话框正确显示 1 个渠道项；选择后能进入下一步；取消能正确关闭

### 功能点 2：内嵌 BrowserView 登录页

- **说明**：在主窗口内嵌入 BrowserView，加载工行企业网银登录 URL，让用户手动登录
- **输入**：渠道脚本 `meta.json` 中的 `loginUrl`
- **输出**：用户登录成功后（由用户点击"我已登录，开始抓取"按钮确认），进入步骤 3
- **边界**：
  - BrowserView 大小与主窗口工作区一致，覆盖原 UI（保留顶部一条"渠道控制栏"用于显示状态、取消、确认）
  - 用户可随时点"取消"关闭 BrowserView，回到主界面
  - 不持久化 cookie（默认 partition='in-memory:rpa-session-<id>'，关闭后丢弃；MVP 阶段就这样，降低凭证泄露面）
- **验收**：能加载工行企业网银登录页；用户能正常登录；登录后页面状态由用户确认而非程序检测

### 功能点 3：自动化执行（step runner）

- **说明**：用户点"开始抓取"后，程序按渠道脚本（`export-detail.steps.json`）顺序执行操作
- **输入**：渠道 ID + 日期范围（MVP 硬编码"昨日"，UI 可调）
- **输出**：拦截到的 Excel 文件路径
- **支持的 step 类型（MVP 最小集）**：
  - `goto`：跳转 URL
  - `wait-for-selector`：等待元素可见
  - `click`：点击元素
  - `type`：输入文本
  - `select`：下拉选择
  - `wait-ms`：固定等待（防风控）
  - `extract-text`：提取文本（可选，用于断言）
  - `wait-for-download`：等待下载触发
- **边界**：
  - 单 step 默认超时 15 秒，超时整体流程失败
  - 失败时保留 BrowserView 截图到 `Documents/网银账单生成小助手/rpa-debug/<timestamp>/`
- **验收**：脚本能成功执行到导出按钮、能拦截到下载文件、失败时有可定位的截图+日志

### 功能点 4：下载拦截

- **说明**：监听 `webContents.session.on('will-download')`，把网银下载的 Excel 重定向到应用临时目录
- **输入**：下载事件
- **输出**：临时文件路径 `{userData}/rpa-downloads/<sessionId>/<filename>`
- **边界**：
  - 只允许下载白名单后缀：`.xls`、`.xlsx`、`.csv`
  - 文件大小上限 50 MB（防止误下载大文件）
  - 单次会话只接受一次下载，多次下载只保留最后一次
- **验收**：下载文件落到指定路径；非白名单后缀被拒；超大文件被拒

### 功能点 5：抓取结果对接现有导入管线

- **说明**：抓取成功后，把下载到的 Excel 路径喂给现有导入流程
- **输入**：临时文件路径 + 渠道关联的"模板 ID"（可选，MVP 阶段让用户选）
- **输出**：进入现有的大账号选择对话框 → 导出流程
- **边界**：
  - 调用现有 `readers.js` 解析逻辑，不重写
  - 用户仍可在导入对话框里改列映射（与本地导入一致）
- **验收**：能像本地选文件一样走完后续流程；不绕过任何现有校验

### 功能点 6：取消与失败处理

- **说明**：用户随时可中止；自动化失败时给出可读错误
- **输入**：用户点取消 / step 抛错 / 超时
- **输出**：BrowserView 关闭；状态回到主界面；失败时弹出错误对话框
- **边界**：
  - 取消是"立即生效"，正在执行的 step 中断
  - 失败错误信息分两层：用户层（"工行账户明细页加载失败，请检查网络"）+ 调试层（截图、step 索引、selector 实际状态写入 log）
- **验收**：任何阶段点取消都能正确清场；失败有可读提示与可定位日志

---

## 5. 影响范围

| 层 | 影响 | 说明 |
|----|------|------|
| 前端（renderer） | 新增 | 1 个入口按钮 + 1 个对话框；状态机扩展 |
| 主进程（main） | 新增 | 1 个 `rpa-session.js` + 一组 IPC handler |
| 后端模块 | 新增目录 | `src/backend/rpa/` 全新目录 |
| 数据库 | 不影响 | MVP 不持久化任何 RPA 数据 |
| 文件系统 | 新增目录 | `{userData}/rpa-downloads/` + `Documents/网银账单生成小助手/rpa-debug/` |
| 现有 IPC | **不修改** | 仅追加新 IPC，零破坏 |
| 现有导入流程 | **不修改** | 通过同样的 `file-service` 入口对接，复用所有逻辑 |
| 依赖 | **不新增** | 不引入 Playwright、Puppeteer、nut-js、robotjs；只用 Electron 自带 BrowserView + DevTools Protocol |
| 打包体积 | 不变 | 零新依赖 |

### 对外接口影响

- preload 新增 `window.desktopApi.rpa.*` 命名空间，不动现有 API
- 无对外公网 API

### 兼容性影响

- 不影响现有用户工作流（旧的"选文件 → 导入"路径继续可用）
- 不影响 SQLite 模式（无 migration）

---

## 6. 技术决策

### 总体方案

**Electron 原生 BrowserView + 注入式自动化**（方案 A，已在前期讨论中选定）。

```
┌──────────────────────────────────────────────────────────┐
│                  Main Window (BrowserWindow)             │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Renderer (index.html + renderer.js)               │  │
│  │  - 主界面入口按钮                                   │  │
│  │  - 渠道控制栏（顶部 56px）                          │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  BrowserView (动态挂载，覆盖主区)                  │  │
│  │  - 加载工行企业网银 URL                            │  │
│  │  - webContents 受程序控制                          │  │
│  │  - executeJavaScript 注入抓取逻辑                  │  │
│  │  - will-download 拦截 Excel                        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
              │
              ▼
       Main Process
              │
              ├── src/main-process/rpa-session.js   (会话状态)
              ├── src/backend/rpa/
              │   ├── engine/
              │   │   ├── browser-view-engine.js    (生命周期)
              │   │   ├── action-runner.js          (step 执行)
              │   │   └── download-interceptor.js   (下载拦截)
              │   ├── scripts/
              │   │   └── icbc-enterprise/
              │   │       ├── meta.json
              │   │       ├── export-detail.steps.json
              │   │       └── selectors.js          (selector 兜底)
              │   └── bridge-to-import.js           (对接导入管线)
              └── (复用现有) src/backend/file-service/readers.js
```

### 为什么不用其他方案

| 备选 | 拒绝原因 |
|------|---------|
| Playwright | 增加 ~200MB 依赖；与主窗口分离 UX 割裂；MVP 用不上录制 codegen |
| Puppeteer | 同上 |
| nut-js / robotjs | 桌面客户端网银不在 MVP 范围；引入跨平台编译麻烦 |
| 直接调银行 API | 合规雷区，工行无公开个人/企业账单 API |
| 完整 RPA 平台 | 工作量爆炸；本工具定位是垂直对账工具，不是通用 RPA |

### 渠道脚本格式（JSON DSL）

```jsonc
// src/backend/rpa/scripts/icbc-enterprise/meta.json
{
  "channelId": "icbc-enterprise",
  "displayName": "工商银行企业网银",
  "loginUrl": "https://corporbank.icbc.com.cn/...",  // 实际 URL 落地阶段确认
  "scriptVersion": 1,
  "supports": ["export-detail"],
  "userAgentOverride": null,
  "session": {
    "partition": "in-memory:rpa-icbc",
    "persistCookies": false
  }
}
```

```jsonc
// src/backend/rpa/scripts/icbc-enterprise/export-detail.steps.json
{
  "name": "export-detail",
  "version": 1,
  "params": {
    "dateRange": {
      "type": "enum",
      "values": ["yesterday", "today", "custom"],
      "default": "yesterday"
    }
  },
  "steps": [
    { "op": "goto", "url": "<meta.loginUrl>", "comment": "等待用户登录" },
    { "op": "wait-user-confirm", "prompt": "请完成登录后点击「开始抓取」" },
    { "op": "click", "selector": "#menu-account-detail", "timeout": 10000 },
    { "op": "wait-for-selector", "selector": "#date-range", "timeout": 15000 },
    { "op": "select", "selector": "#date-range", "value": "yesterday" },
    { "op": "click", "selector": "#btn-query" },
    { "op": "wait-for-selector", "selector": ".result-table", "timeout": 30000 },
    { "op": "click", "selector": "#btn-export-excel" },
    { "op": "wait-for-download", "timeout": 30000, "expectedExt": ["xls", "xlsx"] }
  ]
}
```

**关键设计**：
- selector 字符串保留可读，**复杂 selector 用 `selectors.js` 集中管理**，JSON 里写引用 `"selector": "@detail.dateRange"`
- 所有动作都是声明式，便于未来加图形化编辑（远期）
- `wait-user-confirm` 是必须的 step 类型，承担"半自动"的核心交互

### IPC 契约

| Channel | 方向 | Payload | 返回 |
|---------|------|---------|------|
| `rpa:list-channels` | R→M | – | `[{ channelId, displayName, supports[] }]` |
| `rpa:start-session` | R→M | `{ channelId, action, params }` | `{ sessionId }` |
| `rpa:user-confirm` | R→M | `{ sessionId }` | `{ ok }` |
| `rpa:cancel` | R→M | `{ sessionId }` | `{ ok }` |
| `rpa:status` (event) | M→R | `{ sessionId, phase, stepIdx, message }` | – |
| `rpa:result` (event) | M→R | `{ sessionId, success, downloadPath?, error? }` | – |

`phase` 枚举：`init → loading → awaiting-user → running → downloading → done | error | cancelled`

### 可能风险（按 CLAUDE.md 第 7 条高亮）

| 风险 | 等级 | 缓解 |
|------|------|------|
| 银行用户协议禁止自动化 | **Critical** | 产品文案明示"仅辅助用户操作"；不存储凭证；保留用户中止权 |
| 工行网银改版导致 selector 失效 | **Important** | 脚本版本化；失败截图；每月手测一次 |
| 触发风控被冻结账户 | **Important** | 加随机 200–800ms 延迟；单日同账户限抓 N 次；MVP 阶段建议测试环境验证 |
| 下载文件路径泄露用户敏感数据 | **Important** | 下载目录设权限；用户关闭软件后定期清理（>7 天） |
| BrowserView session 复用导致跨账户串数据 | **Important** | partition 强制 `in-memory`，每次新 sessionId 一个独立 partition |
| 异常崩溃导致 BrowserView 残留 | Minor | 主进程 cleanup hook；窗口关闭时强制 detach |

---

## 7. 数据 / 状态 / 安全影响

### 数据结构

**主进程新增全局态**：

```js
// src/main.js（追加）
const rpaSessions = new Map();  // sessionId → RpaSession 实例
```

**RpaSession 内存结构**（不持久化）：

```js
{
  sessionId: "rpa-1714032000000-abc",
  channelId: "icbc-enterprise",
  action: "export-detail",
  params: { dateRange: "yesterday" },
  phase: "running",          // init/loading/awaiting-user/running/downloading/done/error/cancelled
  currentStepIdx: 4,
  startedAt: 1714032000000,
  browserView: <BrowserView>,
  partition: "in-memory:rpa-icbc-...",
  downloadPath: null,
  errors: []
}
```

### 状态流转

```
[idle]
   │ rpa:start-session
   ▼
[init] ──→ [loading]
              │
              ▼ goto 完成
          [awaiting-user]
              │ rpa:user-confirm
              ▼
          [running]  ←──┐
              │         │ step 间循环
              ▼         │
          [downloading]─┘ (最后一步)
              │
              ▼
          [done] ──→ 交给 import 管线
              
任意状态：rpa:cancel → [cancelled]
任意状态：step 抛错/超时 → [error]
```

### 权限 / 安全（⚠️ 资金/认证场景，必须人工复核）

**安全约束清单**：

1. **凭证零存储**：MVP 不存账号密码；BrowserView session partition 强制 `in-memory:`
2. **下载白名单**：仅允许 `.xls/.xlsx/.csv`，其他后缀直接拒绝
3. **大小限制**：单文件 ≤ 50 MB
4. **路径隔离**：下载落到 `{userData}/rpa-downloads/<sessionId>/`，sessionId 用 timestamp+random，避免猜测
5. **日志脱敏**：不记录 cookie、不记录 URL query string 中的 token；step 日志只记 selector 和动作类型
6. **截图脱敏**：失败截图保留**整个 BrowserView 区域**会包含账户敏感信息——MVP 阶段截图存到本地，**不上传任何远程**，并在用户启用调试模式时才保存
7. **DevTools 屏蔽**：BrowserView 默认禁用 DevTools，避免误开放调试通道
8. **CSP / IPC 校验**：所有 `rpa:*` IPC 需要 sessionId 匹配，避免跨会话误操作

### 回滚策略

- **代码级回滚**：MVP 全部代码在 `src/backend/rpa/` + `src/main-process/rpa-session.js` 独立目录；删除整个目录 + 在 `src/main.js` 移除 RPA IPC 注册块 + 在 `src/preload.js` 移除 `rpa.*` 即可完全回滚
- **不需要数据回滚**：MVP 无 SQLite 写入
- **用户文件清理**：可保留 `{userData}/rpa-downloads/` 历史下载文件（用户可自行删除）

---

## 8. 待澄清问题

- [ ] **工行企业网银的真实登录 URL**：需要用户/团队提供测试环境账号，或先用一份脱敏页面录制 URL & selector
- [ ] **selector 来源**：是参考线上真实页面（需要测试账号）还是先做"占位脚本 + 后续补真值"？
- [ ] **首次发布前合规审查**：是否需要法务同事 review 用户文案与免责声明？
- [ ] **错误截图调试模式开关位置**：放在"设置"里还是命令行 flag？
- [ ] **导入对接的"模板 ID"**：抓取成功后是让用户**手动选模板**，还是由渠道脚本指定"工行企业网银默认模板"？倾向后者，但需要先有该模板存在
- [ ] **多窗口安全**：用户同时开两个 RPA 会话怎么办？MVP 阶段是否限制"同时只允许一个 RPA 会话"？
- [ ] **首次启动检测**：是否需要在主菜单显眼位置加入 RPA 入口，还是只放在"工具"二级菜单？
