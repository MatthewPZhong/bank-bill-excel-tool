# tasks — v2.1.7 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.8（2026-05-21 — T14 收口启动：spec 反向同步 3 处 + knowledge 沉淀 + PRD v0.11 实施记录 + check-vars 10 升格 + PR body 草稿）；v0.7 = round 5 2 task；v0.6 = round 4 3 task；v0.5 = round 3 7 task；v0.1-0.4 略 |
| 关联 PRD | `PRD-v2.1.7.md` v0.11 |
| 关联 spec | `spec.md` v0.9 |
| 工作分支 | `v2.1.7` |
| 起草人 | PM |
| 状态 | 定稿 — 6 项需求 + round 2 8 项 + round 3 6 项 + F8 + round 4 3 项 + round 5 2 项拆 37 task（T0 + T1-T13 + T13.1-T13.11 + T13.12-T13.18 + T13.19-T13.21 + T13.22-T13.23 + T14）；F5 延期 v2.1.8 不在本表；B2 跟随 T13.23 用户实测，如失败 round 6 走路径 B |

---

## 依赖图

```
[T0 PRD/spec/tasks 三件套] (✅ 本任务)
        │
        ├──── F1 独立 ────────────────┐
        │  [T1 C1 引擎] ──→ [T2 C1 dialog + radio] ──→ [T3 C1 smoke + preview]
        │                                                       │
        ├──── F2 独立 ⚠️ 资金红线 ──┐                          │
        │  [T4 C3 引擎 1v1 方案 A]   ──→ [T5 C3 smoke + 真实数据回测]
        │                                                       │
        ├──── F3 独立 ────────────────┐                         │
        │  [T6 CSS flex min-width:0 + preview]                  │
        │                                                       │
        ├──── F4 独立（含重命名扇出）─┐                         │
        │  [T7 C2 引擎放宽] ──→ [T8 C2 dialog 默认值+校验] ──→ [T9 C2 重命名全量替换 + smoke + preview]
        │                                                       │
        ├──── F6 独立 ────────────────┐                         │
        │  [T10 session.runCheck onProgress] ──→ [T11 main.js handler IPC 桥接 + 节流]
        │  [T12 preload + renderer 订阅 + 文案] ──→ [T13 F6 smoke]
        │                                                       │
        ├──── F7 独立（3 子任务并行）─┐                         │
        │  [T13.1 F7-A1 PRAGMA + 19 suite 回归] 🚨 全局影响     │
        │  [T13.2 F7-A2 source_file 索引 + ANALYZE]             │
        │  [T13.3 F7-B1 Notification + smoke]                    │
        │  (F7 三子任务共享 main.js / database.js，需注意合并顺序)
        │                                                       │
        ├──── round 2 5 项小修（部分依赖 round 1）─┐            │
        │  [T13.4 R1 F4 删按钮门槛] (依赖 T9 F4 重命名完成)     │
        │  [T13.5 R2 F6 fileCount 注入] (依赖 T10 session 改完) │
        │  [T13.6 R3 状态框「：」换行] 🚨 全局 + 19 suite 回归  │
        │  [T13.7 R4 acquiring inflight flag] (依赖 T11/T12)    │
        │  [T13.8 R5 F1 默认 AND + 三层护栏] 🔴 资金红线 (依赖 T2)│
        │                                                       │
        ├──── R6 三 task（F3 二次诊断）─┐                       │
        │  [T13.9 R6a multi 文件名 grid 3 列] ⏸ 等用户拍板方案 │
        │  [T13.10 R6b 滚动条回归验证] (依赖 T13.9)             │
        │  [T13.11 R6c extract-order-list 加 max-height + overflow-y]│
        │  (R6a 改 styles-gemini-extra.css 与 R3 同文件 → 必须 R3 commit 后跑)│
        │                                                       │
        ▼                                                       ▼
[收口] ────────────────────────────────────────────────────[T14 文档三件套 + version bump + check-vars + PR 草稿]
```

**关键并行机会**：F1 / F2 / F3 / F4 / F6 / F7 六个功能独立，可由多人/多 session 并行；T14 必须最后做。F7 内 T13.1 / T13.2 / T13.3 也可并行（但 T13.1 + T13.2 共享 `database.js`，T13.2 + T13.3 / F6 T11 共享 `main.js`，建议串行 commit 或同一人接力）。round 2 task 部分依赖 round 1 task（详串行约束）。R6 三 task 也部分有依赖。

**关键串行约束**：
- T2（C1 dialog）依赖 T1（引擎），因为 dialog 默认 config 与引擎 fallback 行为对齐
- T9（C2 重命名扇出）依赖 T7+T8，避免改名先于校验/引擎放宽落地
- T11（main.js handler）依赖 T10（runCheck onProgress 入参）
- T12（preload/renderer）依赖 T11（IPC channel 命名 + payload schema 定型）
- T13（F6 smoke）依赖 T10/T11/T12 全部完成
- **round 2 串行约束**：
  - T13.4（R1）依赖 T9（F4 重命名完成；T13.4 是 1 字符 diff 排最后避冲突）
  - T13.5（R2）依赖 T10（session.js runCheck 已加 onProgress；T13.5 改同文件 wrapper）
  - T13.6（R3）独立但建议在 T12 / T13.3 之后跑（F6/F7 也涉及 setStatus 调用方文案）
  - T13.7（R4）依赖 T11+T12（renderer acquiring 入口已动）
  - T13.8（R5）依赖 T2（C1 dialog 已加 radio；T13.8 在其基础上改默认 + 重排 + helper）
- **R6 串行约束**：
  - **T13.9（R6a）⏸ 等用户拍板方案 A/B/C/(C+B)** 后才能入 Dev；R6a 改 styles-gemini-extra.css，**与 T13.6（R3）改同文件 → 必须 R3 commit 后再做**（合并冲突防御）
  - T13.10（R6b）依赖 T13.9 完成（R6b 是 R6a 副作用回归验证，无独立 commit）
  - T13.11（R6c）独立 — 改 `.extract-order-list` 不与 R3/R6a 冲突
- T14（收口）依赖所有功能 task + T13.1-T13.11 完成

---

## T0：起 PRD / spec / tasks 三件套

- **状态**：✅ 已完成（2026-05-20）
- **产物**：
  - `docs/iterations/v2.1.7/PRD-v2.1.7.md` v0.4（含 F5 延期专章）
  - `docs/iterations/v2.1.7/spec.md` v0.2（5 项需求）
  - `docs/iterations/v2.1.7/tasks.md` v0.1（本文件）
- **依赖**：5 项需求已用户拍板；F5 延期 v2.1.8（决策已锁定）
- **下一步**：Dev 启动 T1 / T4 / T6 / T7 / T10（5 个并行入口）

---

## F1 — C1 提取ReconId-From Self 加 AND/OR 开关

### T1：F1 引擎 — rowMatchesAnyCondition → rowMatchesConditions

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/main-process/scenario-engines/c1-extract-recon-id.js`（spec §2.2 改动点 1+2）
- **关联 spec**：§二 / 2.2
- **改动量**：~15 行 diff（函数重命名 + 入口取 config.conditionsLogic）
- **验收标准**：
  - `rowMatchesConditions(row, conditions, 'OR')` 行为与原 `rowMatchesAnyCondition` 一致
  - `rowMatchesConditions(row, conditions, 'AND')` 用 `every` 判定
  - `runC1Scenario` 取 `config.conditionsLogic === 'AND' ? 'AND' : 'OR'` fallback OR
  - 旧 scenario（无 conditionsLogic）跑通 → 行为与 v2.1.6 一致
  - module.exports 不保留 `rowMatchesAnyCondition` alias（spec 推荐直接重命名）
- **commit message**：`[v2.1.7] feat(F1): C1 引擎 conditionsLogic AND/OR 切换`
- **风险**：🟡 中（改场景引擎匹配语义）
- **预估**：1h

### T2：F1 Dialog — C1 配置弹窗加 AND/OR radio + confirm 预览切换

- **状态**：⏳ 待启动
- **依赖**：T1
- **改动文件**：
  - `src/renderer-dialogs.js`（spec §2.3 改动点 1-5：默认 config / dialog innerHTML / 事件绑定 / tooltip / confirm 预览）
- **关联 spec**：§二 / 2.3
- **改动量**：~40 行 diff（默认 config 加字段 + dialog 加 radio 块 + 事件 + tooltip + 预览切换）
- **验收标准**：
  - 新增 C1 场景 → dialog 显示 AND/OR radio，默认 OR 选中
  - 切换 AND 保存 → DB 持久化 `conditionsLogic: 'AND'`
  - confirm 预览文案随 logic 切换为 "条件（AND）：" / "条件（OR）："
  - tooltip 文案改为"按下方选择的逻辑聚合条件"
  - 修改老 v2.1.6 scenario（无 logic 字段）→ dialog 显示 OR radio 选中（fallback）
  - 只读模式（view）下 radio 禁用
- **commit message**：`[v2.1.7] feat(F1): C1 dialog 加 AND/OR radio + confirm 预览按 logic 切换`
- **风险**：🟢 低
- **预估**：1.5h

### T3：F1 smoke + preview

- **状态**：⏳ 待启动
- **依赖**：T1 + T2
- **改动/新建文件**：
  - `scripts/smoke/scenario-engines-c1.js`（新建或追加 spec §2.4 Case F1-A/B/C/D）
  - preview 截图入口：找到 C1 dialog preview 入口（spec §2.5），追加 AND/OR radio 渲染（OR 默认 + AND 选中 共 2 张）
- **关联 spec**：§2.4 / §2.5
- **验收标准**：
  - smoke F1-A/B/C/D 全过
  - preview C1 dialog 截图含新 radio 行
- **commit message**：`[v2.1.7] test(F1): C1 AND/OR smoke + preview`
- **风险**：🟢 低
- **预估**：1h

---

## F2 — C3 提取ReconId-From 网关 多笔等额改 1v1 🚨 资金红线（方案 A）

### T4：F2 引擎 — usedGwRowIdx Set 标记已用网关行

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/main-process/scenario-engines/c3-gateway-recon-join.js`（spec §3.1 改动）
- **关联 spec**：§三 / 3.1 / 3.2（边界场景说明）
- **改动量**：~20 行 diff（主循环加 `usedGwRowIdx` Set + map+filter + add 已用）
- **验收标准**：
  - smoke F2-A：3 笔等额 bank + 3 笔等额 gw → B1←G1, B2←G2, B3←G3
  - smoke F2-B/C/D/E：覆盖部分等额 / 单边多余 / 旧 baseline
  - smoke F2-F：旧 C3 smoke 全套通过（first-match-wins regression）
  - 真实数据（用户提供 v2.1.6 反例样本）跑通，gwField 值 distinct count > 1
  - conditions / reconFields / virtual amount 路径不变
- **commit message**：`[v2.1.7] feat(F2)!: C3 引擎 1v1 方案 A — 网关候选池 usedGwRowIdx Set`
- **风险**：🔴 **HIGH（资金红线）**
- **预估**：3h

### T5：F2 smoke + 真实数据回测

- **状态**：⏳ 待启动
- **依赖**：T4
- **改动/新建文件**：
  - `scripts/smoke/scenario-engines-c3.js`（新建或追加 spec §3.3 Case F2-A 至 F2-F）
- **关联 spec**：§3.3 / §3.4
- **验收标准**：
  - smoke 6 个 Case 全过（含真实数据回测的关键断言）
  - 真实数据手测：用户 v2.1.6 反例样本，命中数 ≠ 全部 ←G1
  - 旧 C3 smoke 套件 0 回归
- **commit message**：`[v2.1.7] test(F2): C3 1v1 smoke + 真实数据回测`
- **风险**：🟡 中
- **预估**：2h

---

## F3 — 大账号确认页 multiMode "PP..." CSS 修复

### T6：F3 CSS + preview

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/styles.css`（spec §4.1 改动点 1：`.big-account-file-meta` 加 `min-width:0 + flex:1 1 auto`）
  - `src/styles-gemini-extra.css`（改动点 2：`.ba-file-name` 同步）
  - **检查并同步** `Clear/styles-gemini-extra.css` / `Clear/styles-gemini.css` 副本（spec §4.1 改动点 3）
  - preview 截图入口：覆盖大账号 dialog multiMode 启 / 关 / grouped 闭合 3 张
- **关联 spec**：§四 / 4.1 / 4.4
- **改动量**：CSS ≤ 5 行 + 2-3 张 preview 截图
- **验收标准**：
  - 手测：勾"单个账号匹多个文件" + grouped 闭合 → 文件名 + "→ 大账号" 完整显示，不显示 "PP..."
  - 不勾 multiMode → 文件名显示与 v2.1.6 一致（regression baseline）
  - hover 文件名行 → tooltip 显示完整文件名（沿用 `meta.title`）
  - preview 截图 multiMode 启 / 关都正常
- **commit message**：`[v2.1.7] fix(F3): 大账号 multiMode 文件名 CSS flex min-width:0 修复`
- **风险**：🟢 低
- **预估**：1.5h

---

## F4 — 账单打标 → 银行对账单字段赋值（重命名 + 校验放宽 + 引擎放宽）

### T7：F4 引擎放宽 — billTypes ≥ 1 + reconFields = 0 无条件赋值

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/main-process/scenario-engines/c2-offset-bill-mark.js`（spec §5.7 改动点 1+2）
- **关联 spec**：§五 / 5.7
- **改动量**：~30 行 diff（`< 2` 改 `< 1` + 删 `length === 0` 卡 + 加无条件赋值分支）
- **验收标准**：
  - billTypes.length < 1 → warning + return（与旧"< 2"行为类似）
  - billTypes.length === 1 + reconFields = 0 + markValue 完整 → 凡命中 billType 的行写 markValue（衍生方案 A）
  - billTypes.length ≥ 2 + reconFields ≥ 1 → 走原配对逻辑（旧 baseline 不变）
  - smoke F4-A（旧 baseline）/ F4-B（新无条件赋值）全过
- **commit message**：`[v2.1.7] feat(F4): C2 引擎放宽 billTypes ≥ 1 + reconFields 0 无条件赋值`
- **风险**：🟡 中（资金红线相关 — C2 引擎入口；衍生方案 A 待用户拍板，按推荐先实现）
- **预估**：2h

### T8：F4 Dialog 默认值清空 + 校验放宽 + 强补逻辑删除

- **状态**：⏳ 待启动
- **依赖**：T7
- **改动文件**：
  - `src/renderer-dialogs.js`（spec §5.1 默认 config / §5.2 校验 / §5.3 dialog 入口强补删除）
- **关联 spec**：§5.1 / §5.2 / §5.3
- **改动量**：~25 行 diff（默认空 + 校验 < 2 改 < 1 + 删 reconFields 必填 + 删 dialog 入口强补）
- **验收标准**：
  - 新增 C2 场景 → dialog 打开 billTypes 0 行 / reconFields 0 行
  - 保存校验：billTypes 0 行报错"账单类型至少需要 1 行"；billTypes 1 行通过
  - 保存校验：reconFields 0 行通过；reconFields 有行但 leftField/rightField 空 → 报错（沿用旧行为）
  - 修改老 v2.1.6 scenario（billTypes 2 行）→ dialog 加载正常
  - **暂保留旧文案"打标值"**（重命名 in T9）
- **commit message**：`[v2.1.7] feat(F4): C2 dialog 默认空 + 校验放宽 billTypes ≥ 1 + reconFields 允许 0 行`
- **风险**：🟢 低
- **预估**：1.5h

### T9：F4 重命名全量替换（账单打标 → 银行对账单字段赋值，打标值 → 赋值）+ smoke + preview

- **状态**：⏳ 待启动
- **依赖**：T8
- **改动文件**（高扇出 grep 替换）：
  - `src/renderer-dialogs.js`（L5392 / L5641 类别 label；L5840-5842 校验文案 3 处；L6629 dialog label；L7544 confirm 预览）
  - `src/main-process/scenario-engines/c2-offset-bill-mark.js`（顶部 PRD 引用注释，spec §5 备注）
  - `docs/USER_GUIDE.md:553`（仅当前章节改名，保留历史段）
  - `scripts/smoke/scenario-engines-c2.js`（新建或追加 spec §5.9 Case F4-A/B/C/D）
  - preview 截图入口：C2 dialog 新展示名 + 默认空状态
  - **不动**：`docs/VERSION_FEATURE_HISTORY.md` 历史段 / `CHANGELOG.md` 历史段 / migration 内置场景 category 字符串 / DB schema
- **关联 spec**：§5.4 / §5.5 / §5.6 / §5.7（注释）/ §5.9 / §5.10
- **改动量**：~10 处文案替换 + smoke 用例 ~50 行 + 1 张 preview
- **验收标准**：
  - 全文 grep `账单打标\|打标值\|打标：` 命中点全部替换（保留历史发版日志段）
  - 引擎入口 category 字符串仍为 `'offset-bill-mark'`
  - 老 v2.1.6 scenario（DB 中 category='offset-bill-mark'）能正常加载、显示新 label
  - smoke F4-A/B/C/D 全过
  - C2 dialog preview 截图含新展示名
- **commit message**：`[v2.1.7] refactor(F4)!: 账单打标 → 银行对账单字段赋值 全量替换 + smoke + preview`
- **风险**：🟡 中（漏改一处文案会让用户找不到入口）
- **预估**：2.5h

---

## F6 — 收单单据币种校验模块：状态框运行进度显示

### T10：F6 session.runCheck 加 onProgress 入参 + 5 阶段埋点

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/main-process/acquiring-bill-currency-session.js`（spec §6.2 改动：`runCheck` 签名加 onProgress + 6 处守护式埋点）
- **关联 spec**：§六 / 6.2
- **改动量**：~15 行 diff（函数签名 + 6 个 `if (onProgress) onProgress(...)`）
- **验收标准**：
  - 新签名 `runCheck({ db, monthKey, storageRoot, onProgress })`
  - 6 个埋点按顺序触发：`clearing-old-runs` / `computing-stats` / `inserting-run` / `sql-joining` / `writing-xlsx` / `updating-paths`
  - 旧 caller（无 onProgress）行为不变（守护语句跳过）
  - smoke F6-B / F6-C 通过
- **commit message**：`[v2.1.7] feat(F6): session.runCheck 加 onProgress 5 阶段埋点`
- **风险**：🟢 低（守护式埋点不改业务逻辑）
- **预估**：1h

### T11：F6 main.js handler IPC 桥接 + 100ms 节流

- **状态**：⏳ 待启动
- **依赖**：T10
- **改动文件**：
  - `src/main.js`（spec §6.3 改动点 1+2：3 处 handler 桥接 + 2 个 helper）
- **关联 spec**：§6.3
- **改动量**：~50 行 diff（trackedIpcHandle 签名加 event / sessionImport/sessionOverwrite/runCheck 加 onProgress 参数 / createImportProgressForwarder 100ms 节流 / createRunProgressForwarder 无节流）
- **验收标准**：
  - import handler 调用 sessionImport/sessionOverwrite 时传 onProgress
  - run handler 调用 runCheck 时传 onProgress
  - 高频 `inserting` 事件触发（间隔 < 100ms）时 main.js 节流，但 `reading` stage 切换必发
  - `webContents.send` try/catch swallow（参考 main.js:9520 范式）
  - 现有 import/run/export/clearMonth handler 业务逻辑不变
- **commit message**：`[v2.1.7] feat(F6): main.js import/run handler 桥接 onProgress IPC + 100ms 节流`
- **风险**：🟢 低
- **预估**：1.5h

### T12：F6 preload 暴露订阅 API + renderer 订阅 + 文案 helper

- **状态**：⏳ 待启动
- **依赖**：T11
- **改动文件**：
  - `src/preload.js`（spec §6.4：acquiringBillCurrency 命名空间新增 `onImportProgress` / `onRunProgress` 订阅 API）
  - `src/renderer.js`（spec §6.5：`formatAcquiringBillCurrencyProgress` helper + 2 个 handler 函数 try/finally 内订阅 + unsubscribe）
- **关联 spec**：§6.4 / §6.5
- **改动量**：preload ~15 行 + renderer ~35 行 diff
- **验收标准**：
  - preload `desktopApi.acquiringBillCurrency.onImportProgress(listener)` 返回 unsubscribe 函数
  - preload `desktopApi.acquiringBillCurrency.onRunProgress(listener)` 同上
  - renderer `runAcquiringBillCurrencyImport` / `handleAcquiringBillCurrencyRun` 进入后订阅 → 收到事件 setStatus → finally `unsubscribe()`
  - 文案格式严格符合用户原话：`正在导入 xxxxx.xlsx 文件 (11/16 个文件)` / `正在写入 xxx：已读取 N 行 (i/n 个文件)` / 6 个运行 stage 文案见 spec §6.5
  - 完成/失败最终文案不变（与 v2.1.6 一致）
  - 切到其它模块再回来不报错（listener 在 finally 已取消）
- **commit message**：`[v2.1.7] feat(F6): preload 订阅 API + renderer 文案刷新`
- **风险**：🟡 中（listener 内存泄漏 → finally 显式取消必须验证）
- **预估**：2h

### T13：F6 smoke

- **状态**：⏳ 待启动
- **依赖**：T10 + T11 + T12
- **改动/新建文件**：
  - `scripts/smoke/acquiring-bill-currency-progress.js`（新建，spec §6.7 Case F6-A/B/C/D）
- **关联 spec**：§6.7
- **验收标准**：
  - F6-A（importFlowFiles onProgress collector）通过
  - F6-B（runCheck 6 阶段事件序列断言）通过
  - F6-C（runCheck 无 onProgress regression baseline）通过
  - F6-D（main.js handler 节流测试）通过
  - 性能：v2.1.6 500w 行测试样本 totalElapsedMs 增长 < 5%
- **commit message**：`[v2.1.7] test(F6): 收单币种校验进度 smoke 4 用例`
- **风险**：🟡 中
- **预估**：2h

---

## F7 — 收单单据币种校验 SQL 调优 + 完成系统通知

### T13.1：F7-A1 全局 PRAGMA + 19 个 smoke suite 回归 🚨 全局影响

- **状态**：⏳ 待启动
- **依赖**：T0（与 T13 平行；不要求 T13 先做）
- **改动文件**：
  - `src/backend/database.js`（spec §7.3：紧贴 L42 现有 foreign_keys 之后追加 4 条 PRAGMA）
- **关联 spec**：§7.2 / §7.3 / §7.7
- **改动量**：~6 行 diff（4 条 PRAGMA + 1 行注释）
- **关键不变量**：
  - PRAGMA 顺序固定：foreign_keys → journal_mode(WAL) → synchronous(NORMAL) → cache_size → mmap_size（synchronous=NORMAL 必须在 WAL 之后，否则 FULL 模式下不安全）
  - 全部用 `this.db.exec('PRAGMA ...;')`，幂等
- **验收标准**：
  - AC-F7-A1-1：启动后 `sqlite3 tool-data.sqlite "PRAGMA journal_mode; PRAGMA synchronous; PRAGMA cache_size; PRAGMA mmap_size;"` 返回 wal / 1 / -65536 / 268435456
  - AC-F7-A1-2：DB 目录出现 `tool-data.sqlite-wal` + `tool-data.sqlite-shm` 旁文件
  - **AC-F7-A1-3：全 19 个 smoke suite 全套通过**（PRAGMA 影响所有业务引擎共享同一 DB instance；spec §7.7 含完整矩阵）
- **commit message**：`[v2.1.7] perf(F7-A1)!: 全局 PRAGMA WAL+NORMAL+64MB cache+256MB mmap`
- **风险**：🟡 中（PRAGMA 全局回归，必须 19 suite 全过；WAL 旁文件用户备份行为变更）
- **预估**：3h（含全 suite 跑通 + 调试任何 WAL 模式回归）

### T13.2：F7-A2 source_file 索引 + 启动 ANALYZE

- **状态**：⏳ 待启动
- **依赖**：T0（与 T13、T13.1 平行；与 T13.1 共享 database.js 文件 → 同时改 init() 时建议两人 1 commit 内合并）
- **改动文件**：
  - `src/backend/database/migrations.js`（spec §7.4.1：在 `ensureAcquiringBillCurrencyTablesSupport` 内 bill_imports 块尾追加 source_file 索引）
  - `src/backend/database.js`（spec §7.4.2：init() 末尾在所有 migration 跑完后追加 `this.db.exec('ANALYZE;')`）
- **关联 spec**：§7.4
- **改动量**：~10 行 diff（新增 1 个 CREATE INDEX + 1 个 ANALYZE 调用）
- **验收标准**：
  - AC-F7-A2-1：启动后 `.schema acquiring_bill_currency_bill_imports` 输出含 `idx_acquiring_bill_currency_bill_source_file`
  - AC-F7-A2-2：`SELECT COUNT(*) FROM sqlite_stat1` ≥ 1
  - AC-F7-A2-3：手测 EXPLAIN QUERY PLAN 显示 `listDiffRowsBySourceFile` 用新索引
  - smoke acquiring-bill-currency-pragma.js 索引存在断言通过
- **commit message**：`[v2.1.7] perf(F7-A2): source_file 索引 + 启动 ANALYZE`
- **风险**：🟢 低（CREATE INDEX IF NOT EXISTS 幂等；ANALYZE 无副作用）
- **预估**：1.5h

### T13.3：F7-B1 Electron Notification + smoke

- **状态**：⏳ 待启动
- **依赖**：T0（与 T13.1 / T13.2 平行；与 F6 T11/T12 同改 main.js → 注意合并）
- **改动文件**：
  - `src/main.js:6`（destructure 加 `Notification`）
  - `src/main.js:10240附近`（runCheck handler 2 处 return 前调用 notifier helper；spec §7.5.2）
  - `scripts/smoke/acquiring-bill-currency-pragma.js`（合并 T13.1 / T13.2 smoke + 加 F7-B1 mock 桩测试 spec §7.6.3）
- **关联 spec**：§7.5 / §7.6
- **改动量**：~20 行 diff + smoke ~50 行
- **验收标准**：
  - AC-F7-B1-1：手测 macOS 通知中心 / Windows 任务栏出现"「收单单据币种校验」YYYY-MM 对账完成（共 N 行差异）"
  - AC-F7-B1-2：失败路径手测出现"对账失败：{message}"通知，body ≤ 200 字符
  - AC-F7-B1-3：smoke `Notification.isSupported() = false` mock 不抛错
  - smoke F7-A1 / F7-A2 / F7-B1 三个断言全过
- **commit message**：`[v2.1.7] feat(F7-B1): runCheck 完成系统通知 + F7 smoke 3 用例`
- **风险**：🟢 低（try/catch swallow 兜底；不影响业务 return）
- **预估**：2h

---

## round 2 — 用户手测反馈修复（R1-R5，R6⏸ 不在本表）

### T13.4：R1 F4 billTypes 删按钮门槛改 `=== 1`

- **状态**：⏳ 待启动
- **依赖**：T0（与 F4 T7-T9 串行：必须在 T9 之后；T9 已动 dialog 大量文案，T13.4 这 1 字符 diff 排在最后避免合并冲突）
- **改动文件**：
  - `src/renderer-dialogs.js:6676`（`<= 2` → `=== 1`，与 :6700 reconFields 对齐）
- **关联 spec**：§8.2
- **改动量**：1 字符 diff
- **关键不变量**：与 reconFields `=== 1` 门槛对齐
- **验收标准**：
  - billTypes 长度 = 1 时该行无删除按钮
  - billTypes 长度 ≥ 2 时所有行都有删除按钮
  - smoke（可选）：构造 billTypes = [bt1, bt2] 调 renderBillTypes，DOM 检查 2 行均有 remove 按钮
- **commit message**：`[v2.1.7] fix(R1): F4 dialog billTypes 删按钮门槛与 reconFields 对齐`
- **风险**：🟢 极低（1 字符 diff，零回归概率）
- **预估**：15min

### T13.5：R2 F6 inserting payload 显式注入 fileCount

- **状态**：⏳ 待启动
- **依赖**：T0（与 F6 T10-T13 串行：必须在 T10 之后；T10 已动 session.js runCheck，T13.5 改 session.js wrapper 顺序敏感）
- **改动文件**：
  - `src/main-process/acquiring-bill-currency-session.js:62-64`（importFilesInTransaction wrapper）
  - `src/main-process/acquiring-bill-currency-session.js:113-115`（importFilesWithOverwrite wrapper）
- **关联 spec**：§8.3
- **改动量**：2 行（2 处 wrapper 各加 `, fileCount: filePaths.length`）
- **关键不变量**：
  - `fileCount` **必须**在 `...p` 之后（对象 spread 后置 = 覆盖前置）
  - reader 内部不需要任何改动
- **验收标准**：
  - F6 smoke F6-B 增强断言：inserting 事件 payload 含 `fileCount === filePaths.length`
  - 手测：导入 16 个文件，状态框显示 `(i/16 个文件)` 而非 `(i/? 个文件)`
- **commit message**：`[v2.1.7] fix(R2): F6 session.js inserting payload 显式注入 fileCount`
- **风险**：🟢 低（payload 加字段不破坏消费方）
- **预估**：30min

### T13.6：R3 状态框「：」换行（全局规则）+ 19 suite 回归 🚨 全局影响

- **状态**：⏳ 待启动
- **依赖**：T0（与其它 task 平行；但**最好在 F6 T12 / F7 T13.3 之后跑**，因 F6/F7 也涉及 setStatus 调用方文案）
- **改动文件**：
  - `src/renderer.js:519-538`（updateStatusBox 入口加 `replace(/：/g, '：\n')` + null 兜底）
  - `src/renderer.js:4131-4143`（删 setBizOpReconStatus 的 innerHTML hack，仅保留 updateStatusBox 调用；删 `formatBizOpReconStatusHtml` 引用如已无消费方）
  - `src/styles.css`（line 358 附近加 `.status-box-text { white-space: pre-wrap; }`）
  - `scripts/smoke/render-status-box.js`（新建，spec §8.4.4 Case 4 个）
- **关联 spec**：§8.4 / §7.7（19 suite 矩阵）
- **改动量**：renderer ~5 行 + CSS ~3 行 + smoke ~30 行
- **关键不变量**：
  - 只 replace 中文「：」（U+FF1A），不动半角 `:`（U+003A）
  - null/undefined 必须兜底空串
  - textContent 仍是赋值入口（不切 innerHTML 防 XSS）
- **验收标准**：
  - smoke updateStatusBox 单测 4 case 全过（含「：」换行、null 兜底、半角不换行、多个「：」全换）
  - **19 个 smoke suite 全套通过**（updateStatusBox 全局影响，spec §7.7 矩阵）
  - 手测：bizOpRecon / acquiring / bankBuRecon / pending / new-account 5 个模块状态框各跑一遍含「：」文案，肉眼确认换行
  - bizOpRecon hack 删除后行为不变（手测 biz-op-recon 模块状态框换行场景）
  - **R3 文案审计完成**：spec §8.4.4 PM 建议 grep 一遍所有 setStatus 调用方含半角 `:` 文案，产出"候选改文案"清单（dev 阶段决定改不改，非阻塞）
- **commit message**：`[v2.1.7] fix(R3)!: updateStatusBox 全局「：」换行 + 清理 bizOpRecon hack`
- **风险**：🟡 中（全局 setStatus 影响 19 suite；需 manual smoke 5 模块）
- **预估**：3h（含 19 suite 跑 + 5 模块手测 + 文案审计 + 调试任何回归）

### T13.7：R4 acquiring 模块 inflightOperation flag

- **状态**：⏳ 待启动
- **依赖**：T0（与 F6 T11/T12 串行：必须在 T11/T12 之后；T11/T12 已动 renderer acquiring 入口，T13.7 在其基础上加 inflightOperation flag）
- **改动文件**：
  - `src/renderer.js:4233 acquiringBillCurrencyState`（加 inflightOperation 字段）
  - `src/renderer.js:4285 restoreAcquiringBillCurrencyPanelState`（按 flag 决定 disable）
  - `src/renderer.js:4317-4396 runAcquiringBillCurrencyImport`（set 'import' → finally null）
  - `src/renderer.js:4400-4458 handleAcquiringBillCurrencyRun`（set 'run' → finally null）
  - `src/renderer.js:4460-4476 handleAcquiringBillCurrencyExport`（set 'export' → finally null）
- **关联 spec**：§8.5
- **改动量**：~10 行（1 行 state + 1 行 restore + 3 个 handler 各 try-finally 2 行）
- **关键不变量**：
  - inflightOperation **必须** finally 清除（异常路径也要清）
  - flag 仅设在按钮 disable 之前那一刻（用户主动 cancel 月份弹窗时不设）
  - 与 main.js `acquiringBillCurrencyOperationLock` 互补（main 全局 lock / renderer state flag）
  - **不扩散到其它模块**（spec §8.5.1 PM 已 grep 验证 bankBuRecon/bizOpRecon/pending 用 apply*ButtonState 范式无此问题）
- **验收标准**：
  - 手测 1：开始 import 大数据 → 切走 → 切回 → 4 按钮仍 disabled
  - 手测 2：完成 import → 切走 → 切回 → 4 按钮 enabled
  - 手测 3：失败 import → 切走 → 切回 → 4 按钮 enabled（错误已显示）
  - 手测 4：开始 run（5 阶段进度中）→ 切走 → 切回 → 4 按钮仍 disabled
  - smoke 不强制（纯 UI 状态切换难模拟）
- **commit message**：`[v2.1.7] fix(R4): F6 acquiring 切模块按钮误启 + inflightOperation flag`
- **风险**：🟢 低（仅 acquiring 模块；其它模块 PM 已验证无此问题）
- **预估**：1.5h

### T13.8：R5 F1 默认 AND（仅新建）+ dialog 纵向 + 资金红线三层护栏

- **状态**：⏳ 待启动
- **依赖**：T0（与 F1 T1-T3 串行：必须在 T2 之后；T2 已动 dialog HTML 大量改动，T13.8 在其基础上改默认值 + dialog 重排 + 加 pickConditionsLogicChecked helper）
- **改动文件**：
  - `src/renderer-dialogs.js:5707`（`'OR' → 'AND'`）
  - `src/renderer-dialogs.js` C1 dialog 工厂 fn 顶部（新增 `pickConditionsLogicChecked(draft)` helper）
  - `src/renderer-dialogs.js:6294-6306`（dialog HTML：删 logic-row + 新增独立 row + 纵向 + AND 在上 + checkedLogic 渲染）
  - `scripts/smoke/scenario-engines-c1.js`（增强：R5-A 至 R5-E 5 case）
  - F1 preview 截图重跑（dialog 视觉变化）
- **关联 spec**：§8.6（含资金红线三层护栏 §8.6.5）
- **改动量**：~30 行 diff（默认值 1 字符 + helper ~10 行 + HTML 重写 ~15 行 + smoke 5 case）
- **关键不变量**（资金红线三层护栏）：
  - **第 1 层 默认 config**：`createDefaultScenarioConfig('extract-recon-id')` 返回 `conditionsLogic: 'AND'`（仅 mode=create 走此）
  - **第 2 层 dialog helper**：`pickConditionsLogicChecked(draft)` 按 mode 分支 — `mode==='create' → AND`；`mode==='edit' && !draft.config.conditionsLogic → OR`（老 scenario 护栏）；其它 → 本值
  - **第 3 层 引擎 fallback**（spec §2.2 已实现，**不动**）：`runC1Scenario` 内 `config.conditionsLogic === 'AND' ? 'AND' : 'OR'` 默认 OR
  - **三层缺一不可**；缺第 2 层用户编辑老 scenario 静默从 OR 翻 AND = 资金事故
- **验收标准**：
  - smoke R5-A：createDefaultScenarioConfig 返回 conditionsLogic === 'AND'
  - smoke R5-B：pickConditionsLogicChecked(create + AND) === 'AND'
  - smoke R5-C：**pickConditionsLogicChecked(edit + 老 scenario undefined) === 'OR'**（资金红线关键 case）
  - smoke R5-D：pickConditionsLogicChecked(edit + 新 scenario AND) === 'AND'
  - smoke R5-E：runC1Scenario 无 logic 字段 fallback OR（spec §2.2 回归保护）
  - 手测：新建 C1 场景 → dialog 显示独立行 + AND 选中 + OR 在下
  - 手测：编辑 v2.1.6/v2.1.7-round1 老 scenario → dialog 显示 OR 选中（资金红线护栏）+ 保存不变语义
  - 手测：编辑 v2.1.7-round2 新 scenario（DB 写过 'AND'）→ dialog 显示 AND 选中
  - F1 preview 重跑（dialog 视觉变化）
- **commit message**：`[v2.1.7] feat(R5)!: F1 默认 AND（仅新建）+ dialog 纵向 + 资金红线三层护栏`
- **风险**：🔴 资金红线（默认值变更影响新建 + 三层护栏防老 scenario 语义翻转）
- **预估**：2.5h

### T13.9：R6a F3 multi 模式文件名 grid 3 列治本 ⏸ 等用户拍板方案

- **状态**：⏸ **等用户拍板方案 A/B/C/(C+B)**（spec §8.7.9 PM 推荐方案 C MVP）；用户拍板后入 Dev
- **依赖**：T0（独立 CSS 改动，与其它 task 平行；**与 Dev 当前跑的 R1-R5 文件冲突**：R6a 改 styles-gemini-extra.css，Dev R3 也改同文件 → 必须等 R3 commit 后再 commit R6a）
- **改动文件**（按方案 C）：
  - `src/styles-gemini-extra.css:391-401`（`.ba-file-row` grid-template-columns: `28px 1fr` → `auto auto 1fr`）
  - `src/styles-gemini-extra.css:411-419`（`.ba-file-name` 删 `flex: 1 1 auto`；保留 `min-width: 0`）
  - `src/styles-gemini-extra.css:190`（`.big-account-selection-card` width: `min(100%, 1080px)` → `min(100%, 1200px)`）
  - **方案 C+B（可选追加）**：`src/renderer-dialogs.js:999`（multi 分支 truncateFileName 阈值 `20` → `multiMode ? 14 : 20`）
  - **方案 C 兜底（可选追加）**：`src/styles-gemini-extra.css` 加 `.ba-file-row:not(.ba-multi-editing):not(.ba-multi-grouped) .ba-file-name { grid-column: 2 / -1 }` 防普通模式视觉破版
- **关联 spec**：§8.7（含完整 CSS sketch + 方案 4 选）
- **改动量**：~5 行 diff（方案 C 单独）；+ ~3 行 if 加 C+B；+ ~3 行 if 加 :not() 兜底
- **关键不变量**：
  - 不动 `.ba-file-row` 子项 append 顺序
  - 不动 multi 各分支 renderer 逻辑
  - 不动普通模式（非 multi）渲染分支
  - 弹窗加宽 `min(100%, 1200px)` 保留 small-screen 自适应
- **验收标准**：
  - 手测：multi 编辑态文件名 `PPchaxun1.csv 第9行` 完整显示（不再 "PP..."）
  - 手测：multi grouped 闭合态文件名 + "→ MERCHANT USD" 完整显示
  - 手测：multi uncovered 未入组态文件名完整显示
  - 手测：非 multi 模式文件名显示与 round 1 baseline 一致（regression；如视觉破版加 `:not()` 兜底）
  - **preview 必跑 4 张**：multi 关 / multi 编辑 / multi grouped / multi uncovered（详 PRD §14.3）
- **commit message**：`[v2.1.7] fix(R6a): F3 multi 文件名 grid 3 列治本 + 弹窗加宽`
- **风险**：🟡 中（grid 改动影响非 multi 模式视觉；preview 4 张必查）
- **预估**：1.5h（含 preview 重跑 + 视觉验证 + 可选 :not() 兜底）

### T13.10：R6b 大账号 multi-mode 列表滚动条丢失回归验证（合并到 R6a 后）

- **状态**：⏳ 待启动（依赖 T13.9）
- **依赖**：**T13.9 R6a 完成后必跑**（R6b 实质是 R6a 副作用）
- **改动文件**：**无**（PM 已实测高度链已通；spec §8.8 仅作回归验证）
- **关联 spec**：§8.8
- **改动量**：0 行 diff
- **验收标准**：
  - 手测 1：导入 5 个文件 + multi 模式 → 列表无滚动条（内容总高 < 52vh，预期）
  - 手测 2：导入 ≥ 20 个文件 + multi 模式 → 列表自动出现垂直滚动条
  - 手测 3：弹窗不超屏（modal-card max-height: calc(100vh - 56px) 兜底生效）
  - 手测 4：小屏（如 720px 高）测试 `.big-account-selection-split { min-height: 600px }` 是否与 modal-card max-height 冲突；如冲突 dev 阶段微调（非阻塞）
- **commit message**：（无独立 commit；合并到 T13.9 commit 验证段）
- **风险**：🟢 低（R6a 修复后预期自动恢复；如仍异常 spec 阶段深挖）
- **预估**：0.5h（纯手测验证）

### T13.11：R6c "确认大账号顺序" dialog 列表加 max-height + overflow-y

- **状态**：⏳ 待启动
- **依赖**：T0（独立 CSS 改动；与 R6a/R6b 不冲突 — 改不同 class .extract-order-list）
- **改动文件**：
  - `src/styles-gemini-extra.css:1294-1296`（`.extract-order-list` 加 2 行：`max-height: calc(100vh - 280px)` + `overflow-y: auto`）
- **关联 spec**：§8.9
- **改动量**：2 行 CSS diff
- **关键不变量**：
  - 不动 `.extract-order-card` 宽度
  - 不动 `.extract-order-body` grid 列宽
  - 不动 `.extract-order-row` 内部结构（grid 3 子项 vs 3 列已对齐）
  - 不动 `truncateFileName` 调用阈值（保留 20）
  - 280px 余量推导基于 modal header (~56) + body padding (~26) + dialog-actions (~64) + col-header (~32) + 安全余量（spec §8.9.3）
- **验收标准**：
  - 手测 1：导入 ≥ 30 个文件 + 点"提取大账号顺序" → 弹窗内列表自动出现垂直滚动条，能滚到底部
  - 手测 2：导入 5 个文件 → 弹窗内列表无滚动条（内容少，预期）
  - 手测 3：弹窗不超屏（modal-card 兜底）
  - 手测 4：在弹窗内点"编辑"按钮展开 input，行高变化 → overflow-y:auto 自动适应
- **commit message**：`[v2.1.7] fix(R6c): extract-order-list 加 max-height + overflow-y 恢复滚动`
- **风险**：🟢 低（2 行 CSS，纯增量；calc 极端边界 fallback auto）
- **预估**：0.5h

---

## round 3 — 用户手测反馈修复（B1-B5 + F4 删空）+ F8 新需求

### T13.12：B1 F1 radio 移回"条件"row 内部

- **状态**：⏳ 待启动
- **依赖**：T2 / T13.8（C1 dialog 已加 radio + R5 资金红线护栏已就绪；T13.12 仅 DOM 重组）
- **改动文件**：
  - `src/renderer-dialogs.js:6325-6346`（radio 移到 .scenario-config-multi-wrap 末尾，删除独立 row）
- **关联 spec**：§9.2
- **改动量**：~15 行 HTML 重组
- **关键不变量**：
  - 资金红线护栏 R5 三层全部不动（默认 config / pickConditionsLogicChecked / 引擎 fallback）
  - 仅 DOM 重组，JS 逻辑不动
- **验收标准**：
  - 手测 C1 dialog 新建场景 → radio 显示在"条件" row 内（紧贴"+ 新增条件"按钮下方）
  - 手测编辑老 scenario → fallback OR 仍生效
  - **F1 preview 必跑**（dialog 视觉变化）
- **commit message**：`[v2.1.7] fix(B1): F1 radio 移回"条件"row 内部`
- **风险**：🟢 低（DOM 重组，无 JS 逻辑变化）
- **预估**：30min

### T13.13：B2 multi 完成态字母列 min-width 兜底

- **状态**：⏳ 待启动
- **依赖**：T13.9（R6a 完成后 grid 治本，B2 才能验证修复效果）
- **改动文件**：
  - `src/styles-gemini-extra.css:1887`（`.big-account-order-index--alpha` 加 `min-width: 24px + text-align: center`）
- **关联 spec**：§9.3
- **改动量**：2 行 CSS
- **关键不变量**：
  - R6a grid `auto auto 1fr` 不动
  - 仅给 letter 列加最小宽度兜底
- **验收标准**：
  - 手测 multi 完成态：字母 "a./b./c." 列显示正常
  - 手测 multi 编辑态：checkbox + letter + meta 3 列布局不破
  - 手测非 multi 模式：idx + meta 2 子项布局不破（regression）
  - **R6a preview 4 张回归（含 grouped 闭合态）**
- **commit message**：`[v2.1.7] fix(B2): multi 完成态字母列 min-width 兜底`
- **风险**：🟢 低（1 行 CSS）
- **预估**：30min

### T13.14：B3 extract-order-card 单 grid + 单滚动条（用户拍板方案 A）

- **状态**：⏳ 待启动
- **依赖**：T13.11（R6c 已加 `.extract-order-list max-height + overflow-y`；T13.14 要把 overflow 从 .extract-order-list 迁到 .extract-order-body，必须在 R6c 之后避免合并冲突）
- **改动文件**：
  - `src/renderer-dialogs.js:1683-1779`（dialog HTML 结构 + JS 渲染逻辑重构为单 grid 表格 + 每行横跨左右 cell）
  - `src/styles-gemini-extra.css:1286-1296`（`.extract-order-body` 加 max-height + overflow + grid 调整；删 `.extract-order-list` 段）
- **关联 spec**：§9.4（含完整 HTML + CSS sketch）
- **改动量**：HTML ~20 行 + JS 渲染 ~30 行 + CSS ~20 行
- **关键不变量**：
  - grid auto row 自动对齐（左右行边界横线对齐）
  - 单 overflow（左右一起滚）
  - 编辑按钮逻辑保留不动（textSpan / editBtn / editContainer click handler）
  - R6c max-height 余量逻辑从 `.extract-order-list` 迁到 `.extract-order-body`
- **验收标准**：
  - 手测 ≥ 10 文件 → 左右两栏行高对齐
  - 手测 单滚动条 → 左右一起滚
  - 手测 编辑按钮展开 → 该 row 高度变化 → 对齐 row 跟随
  - 手测 ≥ 30 文件 → 单滚动条出现，能滚到底
  - **extract-order-card preview 必跑**（视觉完全重组）
- **commit message**：`[v2.1.7] fix(B3): extract-order-card 单 grid + 单滚动条（用户拍板方案 A）`
- **风险**：🟡 中（DOM 重组影响编辑按钮 click handler 闭包；preview 必跑）
- **预估**：2h

### T13.15：B4 ≥20 文件场景滚动调试 ⏸ 待 dev 实测

- **状态**：⏳ 待启动（**先建 fixture 调试** — spec 阶段无法预判真根因）
- **依赖**：T0（独立）
- **改动文件**：
  - `src/renderer-previews.js`（新增 `applyBigAccountSelectionMultiLargePreviewState` fixture，≥20 文件）
  - `src/renderer.js:5266 附近` preview 路由注册
  - `src/styles-gemini-extra.css`（按 dev 实测调试结果决定改哪几行；可能涉及 `.big-account-selection-split min-height` 或 `.ba-scroll-container max-height`）
- **关联 spec**：§9.5
- **改动量**：fixture ~15 行 + CSS 1-3 行（按实测）
- **关键不变量**：
  - 不动 R6a grid 治本 CSS
  - 不动 R6b 高度链验证已确认通的部分
- **验收标准**：
  - 手测打开新 fixture → 观察滚动条具体表现（不出现 / 不可拖 / 不可滚 / 卡半 → 选对应修复）
  - 手测 ≥ 20 文件 + multi 模式 → 垂直滚动条出现 + 鼠标 / 滚轮可滚到底部
  - 手测 5 文件 → 滚动条不出现（regression）
  - **新 fixture preview 加入回归矩阵**
- **commit message**：`[v2.1.7] fix(B4): 大账号 multi ≥20 文件场景滚动调试 + 新 preview fixture`
- **风险**：🟡 中（真根因 ⏸ 待实测；可能需多轮 CSS 调试）
- **预估**：2h（含 fixture + 实测 + 调试）

### T13.16：B5 🚨 R3 wiring 漏接审计（3 处直写 + smoke 加固）

- **状态**：⏳ 待启动（**spec 优先级最高，与用户体感最直接**）
- **依赖**：T13.6（R3 updateStatusBox 入口 replace 已就绪）
- **改动文件**：
  - `src/renderer.js:3298-3331 updateBankStatementUi`（textContent 直写 → updateStatusBox）
  - `src/renderer.js:3647-3686 updateReconIdFixUi`（同上）
  - `src/renderer.js:4245-4252 setAcquiringBillCurrencyStatus`（同上）
  - `scripts/smoke/render-status-box.js`（R3 已建；追加 wiring 审计断言）
- **关联 spec**：§9.6
- **改动量**：renderer ~15 行（3 处简化为 updateStatusBox 调用）+ smoke wiring 审计 ~30 行
- **关键不变量**：
  - 3 处全部走 updateStatusBox 入口（自动获得 R3 `replace(/：/g, '：\n')` + null 兜底）
  - 按钮 disabled 控制 / dataset.tone 等其它逻辑保留
- **⚠️ dataset.tone vs is-* class 风格差异**：
  - updateStatusBox 用 `dataset.tone`；setAcquiringBillCurrencyStatus 当前用 `classList.add('is-' + tone)`
  - dev 阶段先按 spec §9.6.2 改造跑 preview / 手测 5 模块
  - 如视觉破版按 §9.6.3 选项 1（CSS 加 `[data-tone]` 兼容）或选项 2（updateStatusBox 双写）处理
- **验收标准**：
  - 手测 5 模块状态框（statementGenerator / bankBuRecon / bizOpRecon / acquiringBillCurrency / reconIdFix / newAccount）含「：」文案，肉眼确认换行
  - 手测 acquiringBillCurrency 进度文案"正在写入 xxx.xlsx：已读取 N 行 (i/n 个文件)"冒号后换行
  - 手测 bankStatement / reconIdFix 状态文案含「：」也换行
  - **smoke wiring 审计断言通过**（grep `.status-box-text.*textContent =` 应只在 updateStatusBox 函数内）
  - **19 个 smoke suite 全套回归通过**（与 R3 同等级全局影响）
- **commit message**：`[v2.1.7] fix(B5)!: R3 wiring 漏接审计（3 处 statusBox 直写改走 updateStatusBox）+ smoke 加固`
- **风险**：🟡 中（3 处改造 + dataset.tone vs class 风格差异；smoke 必跑 19 suite）
- **预估**：2h（含 5 模块手测 + 19 suite + 视觉调试）

### T13.17：F4 删空（R1 display + handler 同步 `>= 1`）

- **状态**：⏳ 待启动
- **依赖**：T13.4（R1 已改 display）— T13.17 是 R1 二次修复，必须在 R1 之后
- **改动文件**：
  - `src/renderer-dialogs.js:6716`（display 条件改 `isReadonly ? ''`，永远显示按钮）
  - `src/renderer-dialogs.js:6794`（handler 条件改 `length >= 1`，允许删到 0 行）
- **关联 spec**：§9.7
- **改动量**：2 行（1 个删条件 + 1 个改 `>` 为 `>=`）
- **关键不变量**：
  - 保存校验 L5832 `< 1` 兜底（已就绪）
  - reconFields / markValue 引用重排逻辑 L6797-6803 保留不变
- **验收标准**：
  - 手测 billTypes=2 → 删除成功（length=1）
  - 手测 billTypes=1 → 删除成功（length=0）
  - 手测 billTypes=0 → 保存校验报"账单类型至少需要 1 行"
  - 手测 添加（"+ 新增账单类型"）→ length 恢复
- **commit message**：`[v2.1.7] fix(F4-empty): 账单类型支持删空 + 保存校验兜底`
- **风险**：🟢 低（2 字符 diff）
- **预估**：15min

### T13.18：F8 🚨 dispatcher 反向 filter unmatchedRows + writer 第 2 sheet（资金红线）

- **状态**：⏳ 待启动（**最后做 — F8 涉及主功能写盘 + 资金红线，要确保前面 task 都稳定**）
- **依赖**：T0（独立；建议放在所有 round 2/3 之后避免冲突）
- **改动文件**：
  - `src/main-process/scenario-dispatcher.js:122-151`（modifiedRows 不动；新增 `const unmatchedRows = bankRows.filter((r) => !rowLockSet.has(r._rowId))`；return 加 `unmatchedRows` + `stats.unmatchedRowCount`）
  - `src/backend/file-service/writers.js:223-260 writeWorkbookRows`（加可选 `unmatchedRows` 入参 + 第 2 sheet 写入 + stripInternalFields helper）
  - `src/main.js:5948-5957`（writeWorkbookRows 调用加 `unmatchedRows: preparedBatch.unmatchedRows || []`）
  - **dev 阶段必查**：`preparedBatch` 组装链路是否传递 dispatcher 返回的 unmatchedRows；如未传递需补 main.js 中间层
  - `scripts/smoke/scenario-dispatcher.js` + `scripts/smoke/scenario-engines.js`（追加 F8 case + 资金红线断言）
- **关联 spec**：§9.8（含完整 diff + smoke + 关键不变量）
- **改动量**：dispatcher ~5 行 + writers ~25 行 + main ~3 行 + smoke ~50 行
- **关键不变量**（资金红线）：
  - `modifiedRows` filter 条件 `rowLockSet.has(r._rowId)` **完全不动**
  - `unmatchedRows = bankRows - modifiedRows`（反向 filter）
  - `modifiedRows.length + unmatchedRows.length === bankRows.length`（无遗漏）
  - `modifiedRows ∩ unmatchedRows = ∅`（无重复）
  - C4 走独立流水线，不进 dispatcher
  - `_` 前缀字段必须 strip
- **验收标准**：
  - smoke F8-1 至 F8-6 全过（详 spec §9.8.7）
  - 🚨 **smoke 强制 "scenario-dispatcher.js 全套 + scenario-engines.js 全套通过"**（modifiedRows 行为不动 = 资金红线 baseline 一致）
  - 手测：导入测试样本 → 处理结果 xlsx 含 2 个 sheet：主明细 + 未命中场景行
  - 手测：未命中场景行 sheet 列 = 原始银行对账单行所有列（不映射，不加诊断列）
  - 手测：内部 `_rowId` / `_hitScenarioId` 等字段不出现在 sheet
  - 手测：混币种场景 — 每个 currency 明细文件都含第 2 sheet
- **commit message**：`[v2.1.7] feat(F8)!: dispatcher 反向 filter unmatchedRows + writer 第 2 sheet 未命中场景行`
- **风险**：🔴 资金红线（dispatcher 返回 schema 变化；强制 smoke baseline 一致）
- **预估**：3h（含 dev 阶段 grep preparedBatch 链路 + 6 case smoke + 19 suite 回归 + 手测混币种）

---

## round 4 — 用户手测 round 3 后反馈未通过修复（B1 + B2 + B4）

### T13.19：B1（round 4）F1 radio Layout-1 — 左列纵向 + 字体一致

- **状态**：⏳ 待启动（**Dev 优先级最高 — 用户已拍板**）
- **依赖**：T13.12（B1 round 3 已落地）— round 4 在其基础上 DOM 重组
- **改动文件**：
  - `src/renderer-dialogs.js:6325-6346`（dialog HTML：新增 `.scenario-config-label-stack` 容器，radio 从 .scenario-config-multi-wrap 内部移到左列纵向）
  - `src/styles-gemini-extra.css`（约 L2287 后追加 `.scenario-config-label-stack` + `.scenario-config-logic-inline` + `.scenario-config-logic-option` 字体 13px font-weight:normal 类）
  - `Clear/styles-gemini-extra.css`（双写，与 R6a/R6c/B4 一致）
  - 可选清理：grep `scenario-config-logic-stack` 全文，若 round 2/3 留下的旧 class 无引用则删除
- **关联 spec**：§10.2
- **改动量**：HTML ~15 行重组 + CSS ~25 行新增（双写 × 2）
- **关键不变量**：
  - 资金红线护栏 R5 三层全部不动（默认 config / pickConditionsLogicChecked / 引擎 fallback OR）
  - 仅 DOM 重组 + CSS 新规则；JS 逻辑（checkedLogic / 事件绑定）不动
  - label-stack 外宽 120px 与原 .scenario-config-label 一致 → 右列 .scenario-config-multi-wrap 位置不变
  - radio label 显式 `font-size: 13px` 与 .scenario-config-feature-grid label 对齐
- **验收标准**：
  - 手测新建 C1 场景 → dialog 左列纵向显示"条件 ⓘ\nAND（同时满足）\nOR（满足任一）"+ 右列 conditions
  - 手测编辑老 scenario（无 conditionsLogic）→ OR radio 选中（fallback OR）
  - 手测编辑新 scenario（写过 'AND'）→ AND radio 选中
  - 手测 radio label 字号肉眼接近"筛选字段" label（13px）
  - F1 preview 必跑（视觉变化）
- **commit message**：`[v2.1.7] fix(B1-round4)!: F1 radio Layout-1 左列纵向 + 字体 13px 与"筛选字段"对齐`
- **风险**：🟢 低（DOM 重组 + CSS；资金红线护栏不动）
- **预估**：1h（含 preview 验证）

### T13.20：B4（round 4）真根因 fix — `.big-account-split-left/right` 加 `min-height: 0`

- **状态**：⏳ 待启动（**Dev 优先级 #2 — 先修 B4 让 B2 可手测**）
- **依赖**：T0 独立（与 round 3 各 task 不冲突）；**B2 T13.21 依赖本 task 完成后才能完整手测**
- **改动文件**：
  - `src/styles-gemini-extra.css:369-376`（`.big-account-split-left/right` 加 1 行 `min-height: 0`）
  - `Clear/styles-gemini-extra.css`（双写）
- **关联 spec**：§10.3（含完整高度链 grep 验证 + 真根因解释）
- **改动量**：1 行 CSS × 2 文件 = 2 行 diff
- **关键不变量**：
  - dev round 3 加的 scrollbar-width:thin + ::-webkit-scrollbar CSS 保留（双覆盖：触发滚动 + 持续可见）
  - `.ba-scroll-container min-height: 360px` floor 兜底
  - 双侧对称（split-left + split-right）
- **验收标准**：
  - 手测打开 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 列表自动出现垂直滚动条
  - 手测滚动到底 → 能看到最后一行
  - 手测 5 文件 → 列表无滚动条（regression）
  - DevTools：`.big-account-split-left clientHeight < scrollHeight`（实际高度被 max-height cap 在 52vh）
- **commit message**：`[v2.1.7] fix(B4-round4): .big-account-split-left/right 加 min-height:0 防 grid item 穿透 max-height`
- **风险**：🟢 低（1 行 CSS，纯增量）
- **预估**：30min（含 DevTools 验证）

### T13.21：B2（round 4）multi 完成态字母没显示 — dev 实测后选路径 A 或 B

- **状态**：⏳ 待启动（**依赖 T13.20 B4 完成**）
- **依赖**：**T13.20 完成后**（用户原话 B2 测试被 B4 阻塞）
- **改动文件**（dev 实测后二选一）：
  - **路径 A**：`src/renderer-dialogs.js:1030-1037`（修 letterSpan.textContent 显式判 `source === 'closed'`）
  - **路径 B**：`src/styles-gemini-extra.css:398-400`（改 `.ba-file-row grid-template-columns: auto minmax(24px, auto) 1fr`）+ `Clear/styles-gemini-extra.css` 双写
- **关联 spec**：§10.4（含双路径 sketch + dev 实施步骤）
- **改动量**：路径 A ~10 行 JS / 路径 B 1 行 CSS × 2 文件
- **关键不变量**：
  - 路径 A 完成态分支只接受 `source='closed'` group，pendingGroup 边界 case 走 fallback（'?.' 占位 + console.warn）
  - 路径 B 改 grid track minmax 不影响非 multi 模式 2 子项（idx span 自身宽度已 ≥ 24px）
- **dev 实施步骤**：
  1. 启动 round 3 fixture（B4 修复后才能用）→ 进入 multi 完成态
  2. Chrome DevTools 选 grouped 行 letterSpan：
     - textContent 为空 → 真根因 = 候选 1 → 路径 A
     - textContent 有值但视觉看不见（看 Computed width = 0）→ 真根因 = 候选 2 → 路径 B
  3. 提交对应路径修复
  4. 用户回归如仍不行 → round 5
- **验收标准**：
  - 手测 multi 完成态：字母 "a./b./c." 显示正常
  - 手测 multi 编辑态：checkbox + letter + meta 3 列布局不破
  - 手测非 multi 模式：idx + meta 2 子项布局不破（regression）
  - R6a 4 张 preview 回归（含 grouped 闭合态）
- **commit message**：（按实施路径）`[v2.1.7] fix(B2-round4): {letterSpan 渲染显式判 source / grid track minmax(24px,auto)}`
- **风险**：🟢 低（dev 实测选路径，两路径都低风险）
- **预估**：1.5h（含 DevTools 诊断 + 路径选择 + 实施 + 验证）

---

## round 5 — 用户手测 round 4 后反馈修复（B1 微调 + B4 真根因第 2 层）

### T13.22：B1（round 5）去掉 radio 文本 + tooltip 整合（用户拍板）

- **状态**：⏳ 待启动
- **依赖**：T13.19 round 4 已落地（B1 Layout-1 + 字体 13px）— T13.22 仅文案微调
- **改动文件**：
  - `src/renderer-dialogs.js:6358`（"条件" label tooltip 文案扩展为多行：含 AND + OR 各自语义；用 `&#10;` HTML 实体换行）
  - `src/renderer-dialogs.js:6360-6367`（radio label 文案去掉"（同时满足）/（满足任一）"，仅保留 "AND" / "OR"）
- **关联 spec**：§11.2
- **改动量**：3 处文案微调（1 tooltip + 2 radio label）
- **关键不变量**：
  - 资金红线护栏 R5 三层全部不动
  - B1 round 4 字体 13px font-weight:normal + Layout-1 + .scenario-config-label-stack 容器全部不动
  - HTML `&#10;` 实体浏览器原生支持多行 tooltip（macOS / Windows / Linux 兼容）
- **验收标准**：
  - 手测 hover "条件" ⓘ → 显示多行 tooltip：`按下方选择的聚合逻辑：` + 两行 AND / OR 说明
  - 手测 radio label 只显示 "AND" / "OR"（无括号文本）
  - 手测新建 C1 → 默认 AND checked（资金红线护栏不动）
  - 手测编辑老 scenario → fallback OR checked
  - F1 preview 必跑
- **commit message**：`[v2.1.7] fix(B1-round5): F1 radio 去括号文本 + tooltip 整合到"条件" label`
- **风险**：🟢 低（3 处文案微调，无逻辑变化）
- **预估**：20min

### T13.23：B4（round 5）真根因第 2 层 🚨 — 第 3 层 flex item 也加 min-height: 0

- **状态**：⏳ 待启动（**Dev 优先级最高 — 解除 B2 阻塞 + 用户已 round 4 测试失败**）
- **依赖**：T13.20 round 4 已落地（第 2 层 split-left/right 加 min-height: 0）— T13.23 在其基础上修第 3 层 + 防御性第 1 层
- **改动文件**：
  - `src/styles-gemini-extra.css:390-400`（`.big-account-file-list/.big-account-order-list` 加 `min-height: 0` — 主修第 3 层）
  - `src/styles-gemini-extra.css:357-360`（`.big-account-split-body` 加 `min-height: 0` — 防御性第 1 层兜底）
  - `Clear/styles-gemini-extra.css`（双写）
- **关联 spec**：§11.3
- **改动量**：2 行 CSS × 2 文件 = 4 行 diff
- **关键不变量**：
  - dev round 3 加的 scrollbar-width:thin + ::-webkit-scrollbar CSS **保留不动**（双覆盖：min-height:0 触发滚动 + scrollbar 持续可见）
  - dev round 4 加的 `.big-account-split-left/right min-height: 0` **保留不动**（第 2 层）
  - `.ba-scroll-container min-height: 360px` floor 兜底
  - 主修第 3 层 file-list/order-list（用户报告主路径）+ 防御性第 1 层 split-body（极小屏 < 700px 高 edge case）
  - 双写 src + Clear 与历史 Dev 范式一致
- **验收标准**：
  - 手测打开 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 列表自动出现垂直滚动条
  - 手测**鼠标滚轮 + trackpad** 在列表区域滚动到底（用户 round 4 原话验证点）
  - 手测 5 文件 → 列表无滚动条（regression）
  - 手测大账号顺序列表（右列）同步出现滚动条
  - DevTools：`.big-account-file-list clientHeight < scrollHeight`（触发 overflow）+ `.big-account-split-left clientHeight ≈ 52vh = ~562px`（被父 max-height cap）
  - **B4 修好后 B2 解除阻塞 → 用户实测字母 a/b/c 是否显示 → 若失败 round 6 走 B2 路径 B**
- **commit message**：`[v2.1.7] fix(B4-round5): 第 3 层 file-list/order-list + 防御性第 1 层 split-body 加 min-height: 0（完整高度链修齐）`
- **风险**：🟢 低（2 行 CSS 纯增量；与 round 4 / round 3 CSS 形成完整高度链 + scrollbar 可见双覆盖）
- **预估**：30min（含 DevTools 验证 + 双写）

---

## T14：收口 — 文档三件套 + version bump + check-vars + PR 草稿

- **状态**：🔄 进行中（2026-05-21 用户全部测试通过 + B4 round 6 真根因彻底锁定 + 显式"提 PR"指令 → 启动）
- **依赖**：T1-T13 + **T13.1 / T13.2 / T13.3 + T13.4 / T13.5 / T13.6 / T13.7 / T13.8 + T13.9 / T13.10 / T13.11 + T13.12 / T13.13 / T13.14 / T13.15 / T13.16 / T13.17 / T13.18 + T13.19 / T13.20 / T13.21 + T13.22 / T13.23 + B4 round 6 真根因（commit a9cb2ad）** 全部完成

### T14 收口子项清单（PM ↔ team-lead 分工）

**PM 工作（spec 反向同步 + 知识沉淀 + 升格评估）**：
- ☑ **T14-A spec 反向同步 3 处**：
  - §8.4.2 R3 状态框换行 — `styles.css → styles-gemini-extra.css` 修正（active CSS 路径，cssGeneral disabled / cssClearExtra enabled）
  - §9.8.4 F8 writer sheet — SheetJS PM sketch（启发用）+ ExcelJS dev 实际落地（commit d289779 `src/main-process/exceljs-writer.js`）双版本
  - §11.3.8 B4 round 6 真根因补章 — `.ba-scroll-container` 加 `grid-template-rows: 1fr`（commit a9cb2ad），含 DevTools 实测数据 + 双线必修说明
- ☑ **T14-B knowledge 沉淀**：
  - 新建 `knowledge/css-flex-grid-overflow-pitfalls.md` — v2.1.7 B4 round 3-6 完整经验 + 两条必修线 + 排查 SOP + 双写范式
  - 更新 `knowledge/index.md` 入索引
- ☑ **T14-C PRD v0.11 实施记录**：
  - §二十三 加 YAML front matter `integrated: true`（防 archive PR 草稿重复，按 memory `workflow_pr_integrate_prd`）
  - §23.1 38 commit 全列表（按时间逆序 + commit hash + 类型 + 内容 + 对应 PRD §引用）
  - §23.2 6 round 历程总结表
  - §23.3 F5 延期 v2.1.8 状态说明
  - §23.4 关联 PR（PR 号留待回填）
  - PRD 头部 v0.10 → v0.11 + §二十二变更记录追加 v0.11 行
- ☑ **T14-D tasks v0.8**：标 T14 进行中 + 列收口子项清单（本节）
- ☑ **T14-E check-vars 升格评估**：10 个候选评估 + 修订 `rules/important-variables.md` v8 → v9
  - 升格 Critical：`unmatchedRows` 字段 / `runScenarioDispatcher` / `conditionsLogic` 字段
  - 升格 Risk-sensitive：`pickConditionsLogicChecked` helper / `runC1Scenario` / `runC2Scenario` / `runC3Scenario` / `writeBankStatementOutput`
  - 升格 Important-skeleton：`AppDatabase.init` / `updateStatusBox`
- ☑ **T14-F PR body 完整草稿**：粘贴给用户用 gh pr create

**team-lead 工作（已全部完成；commit 见 PR #51）**：
- ☑ **T14-G version bump**：`package.json` 2.1.6 → 2.1.7（commit 10116f1）+ `package-lock.json` 同步到 2.1.7（commit 2fe0b77 round 10 补，npm install --package-lock-only）
- ☑ **T14-H 三件套文档更新**（commit 10116f1）：
  - `CHANGELOG.md` — 新增 v2.1.7 段（6 项需求 + round 2/3/4/5/6 + 资金红线 F2/F4/F7-A1/F8/R5 + 全局 PRAGMA + R3 状态框换行 + F4 重命名扇出；不提 F5）；round 10 (commit 2fe0b77) 删 F2/F8 已修边界 case + 新增「已在本 PR round 8/9 闭环」段
  - `docs/VERSION_FEATURE_HISTORY.md` — 同上
  - `docs/USER_GUIDE.md` — §五 v2.1.7 新增能力（§5.1 WAL 旁文件备份 + §5.2-5.7 F6/F7/F8/R3/F1/F2/F4/B4）
- ☑ **T14-I rules/important-variables.md 落盘**（commit d337068 PM 同步起草 + team-lead 一并 commit 10 升格条目）
- ☑ **T14-J commit + push + PR**：
  - PM docs commit d337068 + team-lead release commit 10116f1（按 PM 建议拆 2 个 commit）
  - 用户显式说"提 PR" 后 push origin v2.1.7 + gh pr create
  - PR #51 created: https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/51
- ☑ **T14-K PR 草稿归档**（commit e7604b0 mv + 070c0b9 YAML 回填）：
  - `docs/prs/待merge-PR #51.md` → `docs/prs/PR51-v2.1.7.md`
  - YAML 回填 `pr_url` + `status: open` + `integrated: true` + `opened_at` + `opened_by` + `total_commits: 42`

**T14 后 PR review 反馈循环（round 7-11，44-48 commit）**：
- ☑ **round 7**（commit 2781d7c）：F2 gw 误消费 + F8 sheet 不落盘 + PRD trailing whitespace（Codex review + reviewer Finding 1/2）
- ☑ **round 8**（commit c142e45）：F8 saveDialog 触发条件 follow-up（reviewer round 2 Finding 1，对齐 AC-F8-5）
- ☑ **round 9**（commit e1264ae）：F2 空 gw / 已等值 gw 卡池双方向（reviewer round 3 Finding 1，方案 A filter + B lock）
- ☑ **round 10**（commit 2fe0b77）：package-lock 同步 + CHANGELOG 已知 case 闭环（reviewer round 4 P2/P3）
- ☑ **round 11**（本 commit）：tasks T14 收口标 ☑ + PR draft Test plan 勾选 + smoke 数 19→22（reviewer round 5 Finding 1/2）

### 原 T14 字段（保留作 reference）
- **改动文件**：
  - `package.json`（version 2.1.6 → 2.1.7，**用户拍板后再 bump**）
  - `package-lock.json`（同步）
  - `CHANGELOG.md`（新增 v2.1.7 段：6 项需求 + round 2 5 项小修 + 资金红线声明 F2/R5 + 全局 PRAGMA 性能调优 F7-A1 + 状态框「：」全局换行 R3；**不提 F5**）
  - `docs/VERSION_FEATURE_HISTORY.md`（同上）
  - `docs/USER_GUIDE.md`（F4 改名当前章节 + F6 进度反馈说明 + **F7 WAL 旁文件备份提示**（spec §7.10）+ **R3 状态框「：」自动换行提示**（可选，简短一句）；**F4 历史段不动 / F5 不提**）
  - `rules/important-variables.md`（按 `/check-vars` 输出评估升格 `runC2Scenario` / `runC3Scenario` / **`AppDatabase`** / **`conditionsLogic`**（R5 资金红线，候选 Critical）候选；用户审批后落盘）
  - `docs/prs/待merge-PR #NN.md`（按 memory `workflow_archive_pr_draft`，PR 号留待提 PR 时回填）
- **关联**：PRD §14 / §15 / §16 / §17 / §13 round 2
- **流程**：
  1. 跑 `npm run scan:vars` 重新生成自动统计
  2. 跑 `npm run check:vars` 拿到「⚠️ 关联功能 review」段
  3. **跑 `npm run smoke` 全 19 个 suite 确认全套通过**（F7-A1 全局 PRAGMA + R3 全局 updateStatusBox 双层回归保护）
  4. 跑相关 preview（F1 / F3 / F4 / **R5 F1 dialog 新布局**）确认截图最新
  5. 起 PR 草稿（**不主动 push、不主动 gh pr create**；等用户明确说"提 PR"）
- **验收标准**：
  - 三件套版本号与 package.json 一致（或维持 2.1.6 待用户决策）
  - USER_GUIDE 含完整 F4 改名说明 + F6 进度反馈示意文案 + F7 WAL 旁文件备份提示
  - important-variables 增量评估完成（无需升格也要在 PR body 写"评估后不升格"理由）
  - PR 草稿含 ⚠️ 资金红线声明（F2/F4 引擎放宽 + R5 三层护栏）+ ⚠️ 全局影响声明（F7-A1 WAL 模式 + R3 updateStatusBox 全局换行 + 旁文件）+ 关联功能 review 段 + smoke 结果（19 suite 全过截图）+ preview 链接 + **F5 延期声明（用户已知决策）** + **v2.1.8 立项预告（F5 + A3 联合主题）** + **round 2 R6 F3 二次诊断⏸ 待用户截图说明**
  - 等用户手动测试 + 显式"提 PR"指令后 team-lead 才能 push + gh pr create
- **commit message**：`[v2.1.7] docs: CHANGELOG + VFH + USER_GUIDE + important-variables 同步`
- **风险**：🟢 低
- **预估**：4h（多 0.5h 写 round 2 段 + R6 ⏸ 说明）

---

## 工时合计

| 阶段 | 工时 |
|---|---|
| F1（T1-T3） | 3.5h |
| F2（T4-T5）🚨 资金红线 | 5h |
| F3（T6） | 1.5h |
| F4（T7-T9） | 6h |
| F6（T10-T13） | 6.5h |
| F7（T13.1-T13.3）🚨 T13.1 全局回归 | 6.5h |
| **round 2**（T13.4-T13.8）🚨 T13.6 全局 + T13.8 资金红线 | **7.75h** |
| **R6**（T13.9-T13.11） | **2.5h** |
| **round 3**（T13.12-T13.17）🚨 T13.16 全局 wiring | **7.25h**（B1 30min / B2 30min / B3 2h / B4 2h / B5 2h / F4 删空 15min）|
| **F8**（T13.18）🚨 资金红线 | **3h** |
| **round 4**（T13.19-T13.21）| **3h**（B1 1h / B4 30min / B2 1.5h）|
| **round 5**（T13.22-T13.23）| **50min**（B1 微调 20min / B4 真根因第 2 层 30min）|
| T14（收口） | 4h |
| **合计** | **~60.3h（约 7-8 工作日）**（round 5 加 +50min；并行可压缩）|

---

## OPEN ISSUE

### v2.1.7 范围内（不阻塞 Dev，spec 阶段先按推荐实现）

- F4 单 billType + 0 reconFields 引擎语义：spec §5.7 按方案 A（无条件赋值）实现；若用户后续回复方案 B（warning 不跑），删 spec §5.7 改动点 2 的新增分支即可（~5 行）
- F7 PRAGMA 设置点 PM 已定为 `src/backend/database.js:42`（紧贴现有 `foreign_keys = ON`）；不需要拆到 main.js init 阶段，因 database.js init() 已是项目唯一 DB 入口（见 spec §7.2 现状定位）
- **R3 文案审计**（spec §8.4.4）：spec 阶段 grep 一遍所有 setStatus 调用方含半角 `:` 文案，产出"候选改文案"清单；dev 阶段决定改不改（非阻塞）；本次 R3 只加规则不强制改文案

### ⏸ 等用户拍板（阻塞对应 task）

- **T13.9 R6a 方案 A/B/C/(C+B)**：PM 推荐方案 C MVP（grid 3 列治本，spec §8.7.3 已给精确 CSS sketch）；用户拍板后 dev 直接照 spec 实施
  - 方案 A：文件名换行（牺牲 ellipsis 一致性）
  - 方案 B：仅 JS truncateFileName 阈值 20→14
  - 方案 C：仅 CSS grid `auto auto 1fr` 治本（**PM 推荐 MVP**）
  - 方案 C+B：grid 3 列 + JS 阈值 14（**PM 推荐 robust**）

### v2.1.8 范围（不在本表）

- F5 BillDate 数字日期解析 + 算法重设（详 PRD §十；TEST2.xlsx 期望基线 57 行；差距根因 = maxSize=8 + manyToOne 遍历顺序）
- A3 把 acquiring-bill-currency-session.runCheck 整体搬到 worker_threads / utilityProcess（详 PRD §10.6 v2.1.8 立项预告，与 F5 联合主题）

---

## 文档变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-20 | 起草；14 task；F5 延期不在表内；T7-T9 拆 F4 引擎/dialog/重命名 3 步；T9 重命名扇出含 ~10 处替换 + smoke + preview |
| v0.2 | 2026-05-21 | **追加 F7 三 task（T13.1 / T13.2 / T13.3）**：T13.1 PRAGMA + 19 suite 全局回归🚨；T13.2 source_file 索引 + ANALYZE；T13.3 Notification + 3 个 smoke；T14 依赖更新（含 T13.x）；T14 验收新增 ⚠️ 全局影响声明 + v2.1.8 立项预告；依赖图加 F7 块 + 跨任务文件合并提示（T13.1/T13.2 共享 database.js，T13.3/F6 T11 共享 main.js）；工时合计 25.5h → 32.5h；OPEN ISSUE 加 F7 PRAGMA 设置点定为 database.js:42 备注 |
| v0.3 | 2026-05-21 | **追加 round 2 五 task（T13.4-T13.8）**：T13.4 R1 删按钮 1 字符 diff（依赖 T9）；T13.5 R2 fileCount 注入（依赖 T10）；**T13.6 R3 状态框「：」换行 🚨 全局 19 suite 回归 + 文案审计**（独立但建议在 T12/T13.3 后跑）；T13.7 R4 acquiring inflightOperation flag（依赖 T11/T12，不扩散）；**T13.8 R5 F1 默认 AND + 资金红线三层护栏 🔴**（依赖 T2）；T14 依赖更新（含 T13.4-T13.8）+ 验收加 R5/R3 资金红线/全局影响声明 + R6 ⏸ 待截图说明；依赖图加 round 2 块 + 5 串行约束；工时合计 32.5h → 40.75h；OPEN ISSUE 加 R3 文案审计 + R6 ⏸ 等截图；本迭代 6 项需求 + round 2 5 项小修共 22 task |
| v0.4 | 2026-05-21 | **用户发来 F3 三件套 2 张截图，追加 R6 三 task（T13.9 / T13.10 / T13.11）**：T13.9 R6a F3 multi 文件名 grid 3 列治本 ⏸ 等用户拍板方案 A/B/C/(C+B)（spec §8.7 给精确 sketch；与 T13.6 R3 同改 styles-gemini-extra.css 须串行 commit）；T13.10 R6b 滚动条回归验证（依赖 T13.9 完成；无独立 commit；R6a 副作用）；T13.11 R6c `.extract-order-list` 加 max-height + overflow-y 2 行 CSS（独立）；T14 依赖更新（含 T13.9-T13.11）+ 验收去 R6 ⏸ 说明改为已完成；依赖图加 R6 块 + 3 串行约束（R6a 等用户拍板 + 与 R3 同文件冲突防御）；工时合计 40.75h → 43.25h；OPEN ISSUE 加 T13.9 R6a 4 方案待用户拍板说明；本迭代 6 项需求 + round 2 8 项小修共 25 task；**PM 关键发现**：用户描述"flex 对 grid 无效"正确但只是表层；真根因是 `.ba-file-row grid-template-columns: 28px 1fr` 硬编码 2 列 vs multi 各分支 append 3 子项不匹配；spec §8.7 4 方案对比 + 推荐方案 C MVP |
| v0.5 | 2026-05-21 | **用户手测 round 3 通过 F1/R4/R6 主功能；追加 7 task T13.12-T13.18**：T13.12 B1 F1 radio 移回"条件"row 内部（依赖 T2/T13.8）；T13.13 B2 multi 完成态字母列 min-width 兜底（依赖 T13.9）；**T13.14 B3 extract-order-card 单 grid + 单滚动条**（用户拍板方案 A，依赖 T13.11 R6c）；T13.15 B4 ≥20 文件场景滚动调试 + 新 fixture（独立，⏸ 待 dev 实测真根因）；**T13.16 B5 R3 wiring 漏接审计 + smoke 加固 🚨**（依赖 T13.6 R3；3 处直写 statusBox 全部改走 updateStatusBox + 19 suite 回归）；T13.17 F4 删空（依赖 T13.4 R1，2 字符 diff 同步 display + handler）；**T13.18 F8 dispatcher 反向 filter unmatchedRows + writer 第 2 sheet 🚨 资金红线**（独立；scenario-dispatcher.js 加 unmatchedRows 字段 + writeWorkbookRows 加可选入参 + stripInternalFields helper；强制 smoke baseline modifiedRows 不动）；T14 依赖更新（含 T13.12-T13.18）；工时合计 43.25h → 56.5h；本迭代 6 项需求 + round 2 8 项小修 + round 3 6 项小修 + F8 共 32 task；**PM 关键发现**：① B5 用户发现 1 处漏接 + PM grep 再发现 2 处（updateBankStatementUi:3330 + updateReconIdFixUi:3684，影响 acquiring + bankStatement + reconIdFix 3 模块状态框）；② F4 R1 commit 漏改 handler（L6716 改了 L6794 没改 → 按钮显示但点击无效）；③ F8 dispatcher rowLockSet 已就绪，反向 filter 一行即可，改动极轻量且不动 modifiedRows 资金红线；④ F8 wiring 链路 preparedBatch ↔ dispatcher unmatchedRows 传递需 dev 阶段 grep 验证 |
| v0.6 | 2026-05-21 | **用户手测 round 3 后反馈 3 项未通过；追加 3 task T13.19/T13.20/T13.21**：**T13.19 B1 round 4 Layout-1**（用户拍板：左列纵向 label + AND + OR radio；PM grep 字体差异 14px vs 13px → 显式设 radio label 13px；新增 `.scenario-config-label-stack` + `.scenario-config-logic-option` 类；依赖 T13.12）；**T13.20 B4 round 4 真根因 fix**（PM grep 锁定 = grid 子项缺 `min-height: 0` 穿透 max-height；1 行 CSS 双写 src + Clear；dev round 3 scrollbar CSS 保留；独立可立即入 Dev）；**T13.21 B2 round 4 双路径**（dev 实测后选：路径 A 修 letterSpan 渲染 / 路径 B 改 grid minmax(24px,auto)；**依赖 T13.20 B4 完成**，用户原话 B2 测试被 B4 阻塞手测）；T14 依赖更新（含 T13.19-T13.21）；工时合计 56.5h → 59.5h；本迭代 6 项需求 + round 2 8 项 + round 3 6 项 + F8 + round 4 3 项 = 35 task；**PM 关键发现**：① B4 真根因 PM grep 即可锁定（不需等截图）= 经典 CSS grid item `min-height: auto` 穿透父 max-height 陷阱；② B2 被 B4 阻塞（用户原话），先修 B4 才能验证；③ B1 字体一致性需 `.scenario-config-logic-option` 显式 13px font-weight:normal 区别于 `.scenario-config-label` 14px+500 |
| v0.7 | 2026-05-21 | **用户手测 round 4 反馈 B1 微调 + B4 仍不能滚动；追加 2 task T13.22/T13.23**：**T13.22 B1 round 5 微调**（用户拍板去掉 radio "（同时满足）/（满足任一）"括号文本，提示合到"条件" label tooltip — PM 推荐方案 B 单 tooltip 整合到 6358 行现有 ⓘ tooltip 文案 + 用 `&#10;` HTML 实体多行；3 处文案微调；依赖 T13.19）；**T13.23 B4 round 5 真根因第 2 层 🚨**（PM 二次 grep 完整 3 层 flex/grid 嵌套高度链锁定 round 4 修对第 2 层 grid item 但漏修第 3 层 flex item file-list/order-list；round 5 一次性修齐第 3 层 file-list/order-list 主修 + 防御性第 1 层 split-body 兜底；2 行 CSS × 2 文件双写 src + Clear；dev round 3 scrollbar CSS 保留；依赖 T13.20）；B2 round 5 跟随 — 不主动改，B4 修好后用户实测路径 A 是否成功（失败 → round 6 走路径 B）；T14 依赖更新（含 T13.22/T13.23）；工时合计 59.5h → 60.3h；本迭代 6 项需求 + round 2 8 项 + round 3 6 项 + F8 + round 4 3 项 + round 5 2 项 = 37 task；**PM 关键发现**：① B4 真根因是经典 flex 嵌套坑 — 每层 flex/grid item 都需显式 min-height: 0，round 4 只修第 2 层不够，round 5 修齐第 3 层（主修）+ 第 1 层（防御性）避免 round 6 再发现遗漏；② B1 多行 tooltip 用 `&#10;` HTML 实体（原生支持，无需新 CSS）；③ round 5 严守 1-2 行 CSS 单次 commit 原则，dev 一次完成 |
| v0.8 | 2026-05-21 | **用户全部测试通过 + round 6 B4 真根因彻底锁定（commit a9cb2ad）+ 显式"提 PR"指令；T14 收口启动**：① T14 状态从 ⏳ 待启动 → 🔄 进行中；② T14 新增**收口子项清单**（PM 6 项 ☑：spec 反向同步 3 处 / knowledge 沉淀 / PRD v0.11 实施记录 / tasks v0.8 / check-vars 10 升格 / PR body 草稿；team-lead 5 项 ☐：version bump / 三件套文档 / important-variables 落盘 / commit+push+PR / PR 草稿归档）；③ B4 round 6 真根因 = `.ba-scroll-container` 缺 `grid-template-rows: 1fr`（不是 min-height:0 不够，而是 grid 父容器条线）— PM round 5 推断"修齐 3 层 min-height:0 就够"虽然 computed 值都生效但 splitLeft_h 仍 5952px（远超父 447px），DevTools 实测才锁定 grid-template-rows 才是 grid 容器关键；④ 不增 task（B4 round 6 是反向同步范畴，不是新需求）；⑤ tasks 头部 v0.7 → v0.8 / 关联 PRD v0.10 → v0.11 / 关联 spec v0.8 → v0.9 同步；**PM 关键经验沉淀到 knowledge/css-flex-grid-overflow-pitfalls.md**：① flex/grid 嵌套穿透 max-height 必修两条线（每层 flex/grid item min-height:0 + grid 父 grid-template-rows:1fr），缺一不可；② round 5 推断为什么不完整 — flex 链路 min-height:0 思路对，但 grid 父容器还要管 grid-template-rows，spec 阶段如果父是 display:grid 必须显式检查 grid-template-rows 不能只看 min-height:0 链；③ 排查 SOP：用 DevTools 取 4 个值（client/scroll/parent_h/parent_maxH）+ 一路向上每层看 computed min-height + 父 grid 看 grid-template-rows；T14 收口经验沉淀完成 |
