# Spec — C3 网关对账提醒改向链接表（修过时提醒 + 堵漏对账风险）

> 状态：**已实施（v3.0.0 PR-3）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：v3.0.0
> 性质：🔴 资金风险（隐性漏对账）— 但改动本身以前端提醒/UX 为主，不碰 C3 对账计算
> 缘起：用户启用 C3、导入对账单后仍弹"导入资金对账不平结果表"提醒，质疑"导入的不平表能对账吗？"

---

## 一、问题

C3（`category='gateway-recon-join'`，`scenario-engines/index.js:27`）的网关行取数在 **v2.1.16-beta.2 T1** 已切到链接表：
```js
const workingGwRows = structuredClone(database.readLinkedTableRows('gateway-bill'));  // main.js:3602
```
但两处提醒**没同步改向**，仍引导用户导入"资金对账不平结果表"（落 `gatewayReconSession`）：
- `maybePromptGatewayReconImport`（`renderer.js:3583`，导入对账单后）
- `shouldPromptGatewayReconAtRun` + 运行点 dialog#2（`renderer.js:3683-3702 / 3710`，开始运行时）

两者 onConfirm 都调 `handleBankStatementImportGatewayRecon` → `gateway-recon:import`（`main.js:3521`）→ 只落 `gatewayReconSession`，**不写链接表**。

### 🔴 真实风险（不只是白导一个表）
若用户照提醒只导了资金不平表、而链接表 `gateway-bill` 实际为空 → C3 网关行 `=[]` → 所有网关 join **静默 no-op、不命中、不报错**（`main.js:3600` 注释"无数据返回 `[]`，下游 no-op"）→ **以为对了账，实际 C3 没做**。提醒把用户引向无效操作，掩盖了真正的"网关数据未就绪"。

---

## 二、B 调查结论（改提醒安全的依据）

`gatewayReconSession` 老路径已是**死路径**，改/废它不影响任何计算：

| 检查 | 事实 | 出处 |
|------|------|------|
| `gatewayReconSession.gwRows` 全项目访问 | 仅 `:3536` 写入 + `:3847` 读 `.length` 显示；**无引擎消费数据** | grep 实证 |
| 注释"资金对账不平校验模块的使用不动" | 过时/误导 —— 计算消费早切链接表，只剩导入+显示外壳 | `main.js:3601` |
| 前端 `state.gatewayReconSession` | 全是 UI 状态/提醒门控（`:3341/3367/3589/3712`），无计算 | grep 实证 |
| 真正活跃的"不平校验"组 | beta.5 接到网关 ReconID 修复（`reconIdFixSession`/`gateway-recon-id-fix`），**独立链路** | `renderer.js:4131` |

→ `gatewayReconSession` 是 C3 提醒专属、数据已废的僵尸 session。改提醒不误伤 C3 对账（链接表）、不误伤 ReconID 修复（reconIdFixSession）。

---

## 三、改造方案

把两处提醒的**「数据就绪判据」和「引导动作」从 `gatewayReconSession` 改向链接表 `gateway-bill`**：

### 1. 数据就绪判据（门控）
- 现状：`if (state.gatewayReconSession) return`（`:3589` / `:3712`）—— "导没导资金不平表"。
- 改为：**"链接表 `gateway-bill` 是否有数据"**。轻量查 `linked_table_meta` 的 rowCount（不读全表，避免 65 万行场景读盘），需新增 IPC（如 `linked-table:row-count` 或复用现有 meta 查询）。
- `c3CandidateCount`（`main.js:3856`，查银行侧候选行）**保留**——它判的是"本批银行数据有没有 C3 候选行"，与网关数据源无关，仍有效。

### 2. 引导动作 + 文案
- 文案：`资金对账不平结果表` → `网关对账单（链接表）`。
- onConfirm：从 `handleBankStatementImportGatewayRecon`（`gateway-recon:import` 死链）→ 引导到**链接表管理导入网关对账单**（见 O-1）。
- 提醒语义反转为正向价值：当链接表 `gateway-bill` 空且启用 C3 时提醒"C3 需要网关对账单，请在链接表管理导入"，堵住"静默漏对账"。

### 3. 触及代码点
- `renderer.js`：`maybePromptGatewayReconImport`（3583）、`shouldPromptGatewayReconAtRun`（3710）、`handleBankStatementRun` dialog#2（3685-3702）、可能 `updateBankStatementUi`（3364 状态框文案）。
- `main.js`：新增"链接表 gateway-bill 行数"IPC；（视 O-2）废弃 `gateway-recon:import` + `gatewayReconSession`。

---

## 四、待确认（OPEN）

| 编号 | 问题 | 候选 | 推荐 |
|------|------|------|------|
| O-1 | 提醒"导入文件"按钮的引导动作 | (a) 直接调起链接表导入对话框 `linked-table:import`（多选+识别落库）<br>(b) 文案引导 + 跳转「链接表管理」面板，用户自行导<br>(c) 新增专导网关对账单到 gateway-bill 的入口 | **(b)** 最小改动，复用既有链接表管理；避免再造入口 |
| O-2 | 是否顺手废弃死链 `gateway-recon:import` + `gatewayReconSession` | (a) A 阶段只改提醒方向，死链留待单独清理<br>(b) A 阶段一并废弃（消除困惑源） | 倾向 **(a)** 先改向（小步），废弃单列——避免一次动太多、Runtime-state 红线 |
| O-3 | 链接表 gateway-bill 行数查询接口 | 新增 IPC 查 `linked_table_meta` rowCount / 复用现有 | 用 meta（轻量，不读全表） |
| O-4 | dialog#2「直接运行」选项保留？ | 现在三选一（导入/直接运行/取消）；改向后语义仍成立 | 保留，文案同步改 |

---

## 五、影响面 / 风险 / 测试

- **资金红线**：本改动不碰 C3 对账计算（仍用链接表）；但 `gatewayReconSession` 属 Runtime-state（`main.js:11304` 标注）。实施前 **必跑 `/check-vars`**。
- **前端改造**：按约定提 PR 前重跑 `npm run preview` / `preview:account`（涉及 bank-statement 状态框 / 提醒）。
- **测试**：
  - 启用 C3 + 链接表 gateway-bill 空 + 本批有银行候选 → 弹"请导入网关对账单（链接表）"。
  - 启用 C3 + 链接表 gateway-bill 有数据 → **不弹**。
  - 未启用 C3 → 不弹。
  - 退款提醒与 C3 提醒互斥（`renderer.js:3574`）回归不变。
  - 运行点 dialog#2 三分支（导入/直接运行/取消）行为。

---

## 六、待办

1. [ ] 用户定 O-1 ~ O-4（尤其 O-1 引导方式、O-2 是否废死链）
2. [ ] 确认 `linked_table_meta` rowCount 查询接口（O-3）
3. [ ] 确认目标版本 / 是否并入某迭代
4. [ ] 实施 → 改提醒 + 新 IPC → `/check-vars` → 重跑 preview → 手测提醒矩阵 → PR
