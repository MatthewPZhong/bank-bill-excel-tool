# PRD — v2.1.1 patch 迭代：PDF 整体移除 + C4 dialog 文案优化 + BillDate ±N 可配置 + tooltip + 按钮文案

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft，落盘即为已拍） |
| 目标版本 | `v2.1.1` |
| 起始版本 | `v2.1.0-beta.3`（PR #40 已 merge 到 main，2026-05-12，commit `363fee6`） |
| 起草日期 | 2026-05-12 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft（按 [[feedback_auto_proceed]] 起草即推进，不停下 review） |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | 文件导入（PDF）/ 对账单ReconID修复（C4 dialog + 引擎）/ 银行对账单处理（C3 提醒） |
| 工作分支 | `v2.1.1`（从 main 切出，PR 向 `v2.1.1 → main`） |
| 依赖 | v2.1.0-beta.3（含 C4 gateway 子模式 + 主面板账单类别筛选） |

---

## 一、需求概述

v2.1.1 是 patch 迭代，包含 4 项独立改动：

1. **T1 — PDF 整体移除（破坏性变更 / 依赖瘦身）**：移除 PDF 导入功能、对应解析器、依赖（`pdfjs-dist` + `tesseract.js`）、子进程（`pdf-worker.js`）、`electron-builder` 的 asar.unpack 配置、文档中 PDF 提及
2. **T2 — C4 dialog 优化**：
   - **T2-1**：文案改名（"匹配规则"→"匹配模式"、3 个勾选框 "主边单据 X v Y 从边单据"→"主边 X v Y 从边"，business 子模式；gateway 子模式不动）
   - **T2-2**：新增 BillDate 日期范围可配置（取代硬编码 ±1day 容错），含勾选框 + 数字输入 + tooltip
3. **T3 — "修复结果输出" / "订单修复ID取值" tooltip**（business + gateway 两处都加）
4. **T4 — "跳过 C3 直接运行" 按钮文案优化**：改为"直接运行"，不暴露内部代号 C3

---

## 二、背景与目标

### 2.1 业务背景

- **PDF**：早期为兼容部分网银 PDF 账单加入；用户群体已基本切到 Excel/CSV，PDF 路径长期未用、维护成本高（依赖 `pdfjs-dist` ~5 MB + `tesseract.js` OCR ~20 MB 训练数据 + 独立子进程）。借 v2.1.1 patch 清理
- **C4 dialog 文案**：v2.1.0-beta.3 引入 gateway 子模式后，business 子模式的"主边单据/从边单据"读着冗长；用户反馈简化
- **BillDate ±N**：现状 C4 算法 hardcode Step 2 `billDateMode='±1day'`（`src/main-process/scenario-engines/c4-recon-id-fix.js:7`），部分用户的对账场景需要更宽容窗口（如 ±5 / ±7 天）才能命中。提为配置项
- **C3 文案**：`renderer.js:3299` `'跳过 C3 直接运行'` 把开发代号写到用户界面，对最终用户不友好

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 安装包体积 | PDF 全清后估计减小 ~25 MB（pdfjs + tesseract + 训练数据 + asar.unpack 项） |
| 代码维护 | 移除 `pdf-worker.js` 子进程 + PDF reader 分支 → 减少未来 BUG 入口 |
| UI 清爽度 | 匹配模式区文案精简，符合 dialog 横向空间 |
| 对账容错 | BillDate ±N 可配置，业务有特殊容错需求时不再依赖代码改动 |
| 用户友好 | tooltip 解释复杂选项；按钮文案不暴露 C3 内部代号 |

### 2.3 目标（必做 / 不做对照）

| 必做 | 不做 |
|---|---|
| ✅ 删除 `pdfjs-dist` / `tesseract.js` 依赖 + lockfile 同步 | ❌ 保留 feature flag / 隐藏入口 |
| ✅ 删除 `src/backend/file-service/pdf-worker.js`（含子进程协议） | ❌ 改 Excel / CSV 解析器 |
| ✅ 移除 `readers.js` 中 PDF 分支 + IPC + UI filter | ❌ 改 readers.js 的对外签名（除 PDF 分支外其他不动） |
| ✅ 清 `electron-builder` 的 PDF/tesseract 相关 asar.unpack 配置 | ❌ 改其他打包配置 |
| ✅ C4 dialog "匹配规则" → "匹配模式" + 3 勾选框 "主边/从边" | ❌ 改 SubBizType 子项 / confirm 详情 / 错误文案中 "主边单据/从边单据" |
| ✅ T2-2 新增 BillDate 日期范围 UI + 算法接入 | ❌ 改 Step 1 strict 阶段（永远保留作为第一道） |
| ✅ T2-2 老 config 缺 `billDateRange` 字段 → enabled=false 缺省（零回归） | ❌ DB schema migration（config_json 是 BLOB，老字段缺失即用 default） |
| ✅ T3 两处 tooltip（business + gateway） | ❌ 加全局 tooltip 库 |
| ✅ T4 按钮文案"跳过 C3 直接运行" → "直接运行" | ❌ 改 dialog 主提示内容（"已启用..."） |
| ✅ smoke 全 14 子套 PASS + 新增 BillDate ±N 用例 | ❌ 改 v1.5.x / v2.0.0 / v3.0.0 分支 |
| ✅ preview 4 张 C4 dialog 截图重跑（含新增 BillDate 区） | ❌ 改 preview 脚本结构 |
| ✅ version bump 2.1.0-beta.3 → 2.1.1 + 三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE） | — |

### 2.4 明确不做

- **不保留 PDF 兼容路径**（用户已确认"全部清干净"）
- **不引入新的 DB 表 / 列**：T2-2 BillDate 范围作为 `scenario.config.billDateRange` 子对象存在 config JSON 内，老 config 无字段时按 `{enabled: false, days: 3}` 缺省
- **不改 Step 1 strict 阶段**：无论是否启用 BillDate ±N，Step 1 永远第一道（同 BillDate 严格匹配优先于宽容匹配）
- **不改 C3 dialog 主体提示文案**（"已启用「资金对账不平」类场景但未导入「资金对账不平结果表」"），仅改中间按钮文案

---

## 三、需求拆解

### 3.1 R1（T1）：PDF 整体移除

**现状**：

- 依赖：`package.json` 含 `pdfjs-dist` + `tesseract.js`（待 grep 精确版本）
- 解析器：`src/backend/file-service/pdf-worker.js`（独立子进程，PDF 文本 OCR）
- reader：`src/backend/file-service/readers.js` 中 PDF 分支（按扩展名分流）
- IPC：`src/preload.js` + `src/main.js` 暴露 PDF 相关 API（如果有）
- UI：`renderer.js` / `renderer-dialogs.js` 中文件选择 dialog 的 `filters: [{ extensions: ['.xlsx', '.csv', '.pdf', ...] }]`
- 打包：`package.json` `electron-builder` 配置中 asar.unpack 含 PDF worker 路径 + tesseract 训练数据路径
- 文档：`CHANGELOG.md` / `docs/USER_GUIDE.md` 提及 PDF 支持

**改动范围**（spec 细化到行号）：

| 文件 | 操作 |
|---|---|
| `package.json` | 删 `pdfjs-dist` / `tesseract.js` deps + 删 asar.unpack 中 PDF/tesseract 项 |
| `package-lock.json` | `npm install` 重生成 |
| `src/backend/file-service/pdf-worker.js` | 删除 |
| `src/backend/file-service/readers.js` | 删 PDF 分支（按扩展名 case） |
| `src/preload.js` | 删 PDF 相关 IPC API（如果有） |
| `src/main.js` | 删 PDF 相关 IPC handler |
| `src/renderer.js` + `src/renderer-dialogs.js` | 删 file dialog 中 `.pdf` filter |
| `CHANGELOG.md` | 显著说明（破坏性变更） |
| `docs/USER_GUIDE.md` | 删 PDF 相关章节 |

**风险**：⚠️ **破坏性变更** — 用户若仍在用 PDF 导入会被破坏。CHANGELOG 必须显著说明。

---

### 3.2 R2-1（T2-1）：C4 dialog "匹配模式" 区文案改名

**现状**：`src/renderer-dialogs.js:6824-6836` business 子模式：
```
匹配规则
  ☐ 主边单据 1 v 1 从边单据
  ☐ 主边单据 1 v 多 从边单据
  ☐ 主边单据 多 v 1 从边单据
```

**改动**：
```
匹配模式
  ☐ 主边 1 v 1 从边
  ☐ 主边 1 v 多 从边
  ☐ 主边 多 v 1 从边
```

gateway 子模式（"网关 1 v 1 渠道" 等）保持不动。

**范围限定**（用户拍：仅改"匹配模式"下面 3 个勾选框 + 标签）：
- `renderer-dialogs.js:6824` `<span class="scenario-config-label">匹配规则</span>` → "匹配模式"
- `renderer-dialogs.js:6828/6832/6836` business 模式三勾选框文案
- **不改**：SubBizType 区（5958-5962、7042-7047）/ confirm dialog（7393）/ error toast（5851）中的"主边单据/从边单据"

---

### 3.3 R2-2（T2-2）：BillDate 日期范围可配置（取代硬编码 ±1day）

#### 3.3.1 算法语义（选项 A，已拍）

| 配置 | Step 1（严格） | Step 2（容错） | Step 3.1/3'.1（1v多/多v1 严格） | Step 3.2/3'.2（1v多/多v1 容错） |
|---|---|---|---|---|
| 不勾选（缺省） | BillDate 必须相等 | BillDate ±**1** 天 | 同上 | 同上 |
| 勾选 N=3 | BillDate 必须相等 | BillDate ±**3** 天 | 同上 | BillDate ±**3** 天 |
| 勾选 N=5 | 同上 | BillDate ±**5** 天 | 同上 | BillDate ±**5** 天 |

**Step 1 strict 永远保留**（无论是否启用 BillDate ±N，先做严格匹配）。
**Step 2/3.2/3'.2 容错窗口**由 BillDate ±N 配置控制；不勾选 = 维持 ±1day 历史行为。

#### 3.3.2 UI 设计

C4 dialog "匹配模式" 同行右半块新增：

```
匹配模式                          BillDate 日期范围 ⓘ
  ☐ 主边 1 v 1 从边                 ☐ BillDate ± [   ] Days
  ☐ 主边 1 v 多 从边
  ☐ 主边 多 v 1 从边
```

- 勾选框右侧文本 "BillDate ±"
- 输入框宽度 **3 字符**（约 36px）
- 输入框右侧文本 "Days"
- "BillDate 日期范围" 标签右侧 tooltip ⓘ

#### 3.3.3 输入校验

- 输入框：仅勾选时启用；不勾选时 disabled + 灰显
- 合法值：**正整数 1-999**
- 默认值（勾选后初次显示）：**3**（理由：勾选 = 用户主动放宽，默认 ±3 是常见对账容错；若用户想要 1 可手动改）
- 非法值（0 / 负数 / 非整数 / 留空）：保存时校验失败 + error toast "BillDate 日期范围必须是 1-999 的正整数"

#### 3.3.4 Config schema

`scenario.config.billDateRange = { enabled: boolean, days: number }`

- 老 config 无此字段：路由层做 default `{ enabled: false, days: 3 }`（不写盘）
- 引擎接收 scenario 时，从 `scenario.config.billDateRange` 解出 `(enabled, days)` 传给 `tryOneToOne` / `tryOneToManyPool` 等函数（替换 hardcoded `billDateMode='±1day'`）

#### 3.3.5 tooltip 文案

> "默认 BillDate 范围 ±1 天。勾选后可调整容错窗口为 ±N 天（N=1-999），用于跨日扎单场景。Step 1 严格匹配阶段不受影响。"

#### 3.3.6 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | `billDateMatches(L, R, mode, days)` 加 `days` 参数；`tryOneToOne` / `tryOneToManyPool` 等加 `days` 形参；外层 `runC4Scenario` 从 `scenario.config.billDateRange` 解出传入 |
| `src/main-process/recon-id-fix-engine.js` | 同上传递链 |
| `src/renderer-dialogs.js` | C4 dialog 新增 BillDate 区 UI + validation + tooltip |
| `src/backend/database/scenarios-repository.js` | 序列化/反序列化时把 `billDateRange` 视为有效字段（已是 JSON.parse，应已无需改动；但要确认） |
| `scripts/smoke/recon-id-fix-engine.js` / `recon-id-fix-engine-gateway.js` | 新增 BillDate ±N 用例（含 N=1 / N=5 / 不勾选 三档） |

#### 3.3.7 ⚠️ 资金红线提醒

C4 引擎是**资金对账核心匹配算法**，必须人工复核：

- BillDate ±N 扩大容错 → 可能命中本不该匹配的单 → 数据失真
- 单测必须覆盖：N=0（如果允许，需校验阻止） / N=1（等同现状） / N=5（扩大） / 跨月（28→1 日）/ 跨年
- smoke 必须有 business + gateway 两个子模式的 BillDate ±N 覆盖

---

### 3.4 R3（T3）：tooltip 两处

#### 3.4.1 business 子模式 "修复结果输出"

位置：`src/renderer-dialogs.js:6855`（`<span>${isGatewayMode ? '订单修复ID取值' : '修复结果输出'}</span>`）

tooltip 草稿：

> "指定 ReconID 修复结果写到哪一侧的单据：仅写主边 / 仅写从边 / 主从都写。同时 Type 字段会自动标记（1 = 主边、2 = 从边、3 = 双向）。"

#### 3.4.2 gateway 子模式 "订单修复ID取值"

位置：同上行（同 span，根据 `isGatewayMode` 渲染不同文本）

tooltip 草稿：

> "指定网关账单与渠道账单两侧的修复 ID 取自哪一侧的 reconciliationId（可选追加 suffix）。'两侧都修复' 时会同时写入两侧。"

---

### 3.5 R4（T4）："跳过 C3 直接运行" 按钮文案

位置：`src/renderer.js:3299` `middleText: '跳过 C3 直接运行'`

改为：`middleText: '直接运行'`

dialog 主提示文案（`message: '已启用「资金对账不平」类场景但未导入「资金对账不平结果表」。<br>继续运行将跳过该类场景。'`）保持不变 — 已经把 C3 译成"资金对账不平"了，按钮文案只需简化。

---

## 四、风险与开放问题

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R-1 | T1 PDF 移除是破坏性变更，用户若仍用 PDF 导入会被破坏 | ⚠️ 高 | CHANGELOG 显著说明 + USER_GUIDE 删相关章节；用户已确认"全部清干净" |
| R-2 | T2-2 BillDate ±N 是资金对账核心算法改动 | ⚠️ 高 | 选项 A 语义保证不勾选 = 现状零回归；smoke 必须扩展 N=1/5/边界三档 + 跨月跨年 |
| R-3 | T2-2 老 config 无 `billDateRange` 字段 | 中 | 路由层 default `{enabled:false, days:3}`；smoke 验证老 config 行为不变 |
| R-4 | T1 移除 tesseract.js → 训练数据目录可能仍残留在 user data | 低 | 不主动清理用户数据（保守原则），用户重装后自然不再写入 |
| R-5 | T2-1 改名后 preview 截图需要全部重跑 | 低 | 列入 T6（smoke + preview） |
| R-6 | T1 改 electron-builder 配置可能影响打包产物（asar.unpack） | 中 | 本地 dist:win:portable 跑通后再发版 |

---

## 五、版本号策略

- `package.json.version`：`2.1.0-beta.3` → `2.1.1`
- 跳过 `2.1.1-beta.x`（patch 改动小，直接发 GA）；如 Dev 中发现复杂度高，可补 `2.1.1-beta.1`
- 三件套：CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE 一并 bump

---

## 六、测试与文档计划

### 6.1 smoke

- 全 14 子套必须 PASS
- 新增 BillDate ±N 用例（business + gateway 各 3 个：N=1 / N=5 / 不勾选）
- 老用例不动 → 验证 `billDateRange` 缺省回退 ±1day

### 6.2 preview

- 4 张 C4 dialog 截图重跑：`scenario-config-c4{,-gateway,-gateway-1vN,-both}.png`
- 因 T2-1 改名 + T2-2 新增 BillDate 区，截图必有变化
- ⚠️ 按 memory [[workflow_frontend_previews]] 强制要求

### 6.3 手动回归

- 必跑：导入 .xlsx（原 PDF 路径已断）→ 跑场景 → 验证 BillDate 不勾选默认 ±1day 行为
- 必跑：勾选 BillDate ±5，跑跨日扎单 → 验证命中扩大
- 必跑：tooltip 在 dialog 鼠标 hover 上正确显示

### 6.4 文档三件套

- CHANGELOG：
  - **破坏性**：移除 PDF 导入支持（"BREAKING"标记）
  - 新增：BillDate ±N 可配置 / "修复结果输出" tooltip / 文案优化
- VERSION_FEATURE_HISTORY：补 v2.1.1 一行
- USER_GUIDE：删 PDF 章节 + 加 BillDate ±N 使用说明

---

## 七、实施记录（占位）

> Dev 实施过程中本节会被反向同步更新（按 [[feedback_no_skip_spec]]）。Dev 完成后归档到 PR 中。
