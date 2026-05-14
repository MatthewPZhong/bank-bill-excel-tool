# Tasks — v2.1.4 任务拆分

> 关联 `PRD-v2.1.4.md` / `spec.md`（同目录）
> 文档版本：v0.1（2026-05-14 起草），v0.2 修订标注（2026-05-15 round 2 self-review I-new-5）
>
> ⚠️ **v0.2 修订（Fix1）**：以下 Verify 清单中部分项为 v0.1 设计快照，已被 Fix1 撤回 / 修订：
> - **T6 Verify**「左侧按 name.length 重排」→ Fix1.5 改视觉宽度（CJK×2 + 其他×1）
> - **T6 Verify**「关闭弹窗即时反映新列表/顺序」→ Fix1.2 改两阶段提交（点「完成」后一次性落库 + 关弹窗）
> - 完整 Verify 清单以 `PRD-v2.1.4.md §七 验收测试` + `USER_GUIDE.md §1.8` 为最终基准
>
> 工作分支：`v2.1.4`（基于 `origin/main e4c3abe`）
> PR 计划：单 PR — `v2.1.4 → main`（4 块改动总规模小，无需拆分多 PR）

---

## 任务执行顺序

```
T0 (PM/spec) ──→ T1 ──→ T4 ──┐
                              ├──→ T5 ──→ T6 ──→ T7 ──→ T8 ──→ T9 ──→ T10 ──→ T11
              ──→ T2 ──→ T3 ──┘
                  (backend)
```

- T1 (使用手册按钮换皮) + T4 (ReconID 账单类别默认) 可并行（独立 HTML/CSS 改动）
- T2 (settings repo + IPC) → T3 (preload API) 是后端先行
- T5 (HTML 弹窗 DOM + 🔄 按钮) 起步前需 T1/T4 完成（同一 HTML 文件，避免冲突）
- T6 (renderer JS 弹窗逻辑) → T7 (启动初始化 + currentModule fallback) → T8 (顶部切换按钮渲染改造)
- T9 (preview) → T10 (smoke 拓展) → T11 (文档三件套 + check-vars)

---

## T0 — PM/spec 拍板（本任务）

**Owner**：team-lead（PM）

**Input**：用户需求文本（v2.1.4 4 点需求）

**Output**：
- `docs/iterations/v2.1.4/PRD-v2.1.4.md`（本目录）
- `docs/iterations/v2.1.4/spec.md`（本目录）
- `docs/iterations/v2.1.4/tasks.md`（本文）
- `package.json` bump 2.1.3 → 2.1.4（直接正式版，patch 级别）

**Verify**：
- [ ] 三件套已生成
- [ ] 用户对 PRD §五 OPEN ISSUES（O1-O7）确认拍板
- [ ] 分支已切到 `v2.1.4`，基于 `origin/main`

**当前状态**：✅ PRD/spec/tasks 已起草 + 用户已拍板全部 OPEN ISSUES + V1（版本号），进入 Dev 阶段

---

## T1 — 使用手册按钮换皮 📕

**Owner**：dev

**Input**：spec §二

**Output**：
- `index.html:340` — `#saveUserGuideBtn` 改为圆形 emoji 📕（类 `palette-trigger`）
- CSS 验证：`.background-guide-btn` 类若无其他引用可清理

**Verify**：
- [ ] `npm start` 后右下角看到圆形 📕 按钮（视觉与 🎨 一致）
- [ ] 点击 📕 仍触发 USER_GUIDE.md 导出（功能不变）
- [ ] `npm run preview` 截图通过对照

**估时**：15 min

---

## T2 — settings repo 新增 enabled_modules 函数

**Owner**：dev

**Input**：spec §3.2

**Output**：
- `src/backend/database/settings-repository.js` 新增 `getEnabledModules` / `setEnabledModules` / `DEFAULT_ENABLED_MODULES`
- 处理：空值 seed 默认 / JSON 解析失败回退 / 写入去重 + 防空数组

**Verify**：
- [ ] 新建 DB 调 `getEnabledModules(db)` 返回 `['statement-generator','bank-statement-process','recon-id-fix']` 且 DB 已 seed
- [ ] 重新调返回相同值（幂等）
- [ ] 写入空数组抛 `enabled_modules must not be empty`
- [ ] 写入 `['a','a','b']` 落库为 `'["a","b"]'`

**估时**：30 min

---

## T3 — preload + main IPC handler

**Owner**：dev

**Input**：spec §3.3 + §3.4

**Output**：
- `src/preload.js` 暴露 `getEnabledModules` / `setEnabledModules`
- `src/main.js` 注册 `settings:getEnabledModules` / `settings:setEnabledModules` handler

**Verify**：
- [ ] Renderer 调 `window.desktopApi.getEnabledModules()` 返回 `{success:true, data:[...]}`
- [ ] Renderer 调 `window.desktopApi.setEnabledModules(['recon-id-fix'])` 返回 `{success:true}` 后 DB 内容更新

**关联功能 review 命中预判（spec §五）**：
- ⚠️ IPC 接口新增 → tracked IPC vs plain IPC 口径（与 v2.1.3 round 3 拍板的 "15 IPC = 5 tracked + 10 plain" 对齐）

**估时**：20 min

---

## T4 — ReconID 账单类别默认 gateway

**Owner**：dev

**Input**：spec §四

**Output**：
- `index.html:286` 删占位 `<option value="">请选择账单类别</option>` + gateway 加 `selected`
- `src/renderer.js:4417` 段初始化逻辑：DB 空值时默认 'gateway' + 写回

**Verify**：
- [ ] 新 DB 启动 → 进入对账单ReconID修复模块 → 主面板「账单类别」显示「网关对账单」+ DB `recon_id_fix_bill_category='gateway'`
- [ ] 旧 DB `recon_id_fix_bill_category=''` 启动 → 写回 'gateway'，UI 默认 gateway
- [ ] 旧 DB `recon_id_fix_bill_category='business'` 启动 → 保持 'business'（不强制覆盖）
- [ ] 切换到 business 再切回 gateway 工作正常

**关联功能 review 命中预判**：
- ⚠️ `state.reconIdFixBillCategory` (Runtime-state) — 初始化逻辑改造
- ⚠️ `app_settings.recon_id_fix_bill_category` key (Persistence) — 启动写回

**估时**：30 min

---

## T5 — HTML 弹窗 DOM + 🔄 按钮

**Owner**：dev

**Input**：spec §3.5

**Output**：
- `index.html` — `#saveUserGuideBtn` 后插入 `#moduleCabinetBtn` 圆形 emoji 🔄
- `index.html` — `#moduleCabinetOverlay` 弹窗 DOM（标题 + 双区域 + 中间控制按钮）
- `src/styles.css`（或 `Clear/`/`General/` 分别）— 弹窗 CSS（spec §3.7）

**Verify**：
- [ ] `npm start` 后右下角 🎨 / 📕 / 🔄 三个圆形按钮并排
- [ ] 点 🔄 弹窗显示，结构与 spec §3.3.2 ASCII mockup 一致
- [ ] 点 × 或 overlay 外部关闭弹窗

**估时**：1h

---

## T6 — renderer 弹窗逻辑

**Owner**：dev

**Input**：spec §3.6

**Output**：
- `src/renderer.js` 新增弹窗 state + DOM 缓存 + 关键函数（openModuleCabinet / closeModuleCabinet / renderModuleCabinetLists / 选中 / ➡️/⬅️ 移动 / HTML5 拖拽）
- 事件绑定（在 `bindEvents` 等启动初始化里）

**Verify**：
- [ ] 点击左侧某行 → 高亮（右侧若有选中则清空）
- [ ] 选中左侧 + 点 ➡️ → 该项移到右侧末尾，左侧按 name.length 重排
- [ ] 选中右侧 + 点 ⬅️（启用区 ≥ 2 时）→ 该项移到左侧，按长度重排
- [ ] 右侧只剩 1 个 → ⬅️ disabled
- [ ] 右侧拖拽某行到另一行 → 顺序变更，落库
- [ ] 关闭弹窗 → 左上角切换按钮即时反映新列表/顺序

**关联功能 review 命中预判**：
- ⚠️ `MODULES` (Important-skeleton)
- ⚠️ `state.enabledModules` (新增 Runtime-state)

**估时**：2h

---

## T7 — 启动初始化 + currentModule fallback

**Owner**：dev

**Input**：spec §3.6.6

**Output**：
- `src/renderer.js` 启动序（`initializeApp` 或等价位置）— 拉取 enabled_modules → 注入 state
- 若 `state.currentModule` 不在启用列表，切到第一个 + 写回 `setCurrentModule`

**Verify**：
- [ ] 新 DB 启动 → `state.enabledModules = ['statement-generator','bank-statement-process','recon-id-fix']`
- [ ] 旧 DB `current_module='biz-op-recon'` 但 enabled_modules 未含该 ID → 启动后 currentModule = 'statement-generator' 且 DB 已写回
- [ ] 旧 DB 无 `enabled_modules` key → 启动后 key 已 seed

**关联功能 review 命中预判**：
- ⚠️ `state.currentModule` (Runtime-state) — 启动 fallback 改造
- ⚠️ `app_settings.current_module` key (Persistence) — 启动 fallback 写回

**估时**：30 min

---

## T8 — 顶部切换按钮渲染改造

**Owner**：dev

**Input**：spec §3.6.5

**Output**：
- `src/renderer.js` 定位左上角模块切换的渲染函数（grep `MODULES` 在 renderer 渲染处），按 `state.enabledModules` 过滤+排序

**Verify**：
- [ ] 默认 → 左上角只显示 3 个启用模块，顺序与 `enabledModules` 数组一致
- [ ] 用 🔄 弹窗把「业务OP数据核对」移到启用 → 左上角立即多一项
- [ ] 拖拽改序 → 左上角顺序立即跟随

**估时**：1h

---

## T9 — Preview

**Owner**：dev

**Input**：spec §3.8

**Output**：
- `src/renderer-previews.js` 新增 `previewModuleCabinet`
- `package.json` scripts 加 `preview:module-cabinet`
- `scripts/render-preview.js`（或对应 driver）支持新 preview 名

**Verify**：
- [ ] `npm run preview:module-cabinet` 生成 PNG，弹窗结构清晰
- [ ] `npm run preview` 主页 screenshot 包含新的 🔄 按钮
- [ ] 改前端文件后必须重跑（CLAUDE.md memory：`workflow_frontend_previews`）

**估时**：1h

---

## T10 — Smoke 拓展

**Owner**：dev

**Input**：spec §六

**Output**：
- `scripts/smoke-test.js` 增加 7 个 Case（ENABLED-MODULES-1..5 + RECON-ID-FIX-DEFAULT-1..2）

**Verify**：
- [ ] `npm run smoke` 全部通过
- [ ] 失败 case 必须 fix 而不是 skip

**估时**：1.5h

---

## T11 — 文档三件套 + check-vars + 自查

**Owner**：team-lead

**Input**：T1-T10 完成

**Output**：
- `CHANGELOG.md` — 新增 v2.1.4 段
- `docs/VERSION_FEATURE_HISTORY.md` — 新增 v2.1.4 条目
- `docs/USER_GUIDE.md` — 顶部版本号 v2.1.1 → v2.1.4；§1.5 末追加 "v2.1.4 起账单类别默认网关对账单"；§1.7 后新增 §1.8「主界面工具栏与模块收纳（v2.1.4 新增）」
- `package.json` 已是 2.1.4（T0 已 bump，无需再改）
- `/check-vars` 跑通，输出 PR body 「⚠️ 关联功能 review」段落
- `npm run scan:vars` 重生成自动统计报告
- Codex 自动 review 通过（如适用）

**Verify**：
- [ ] `git diff main..v2.1.4` 文件清单覆盖 PRD §4.1 表中所有条目
- [ ] check-vars 命中变量与 spec §五预判一致
- [ ] CHANGELOG/VFH 内容自洽（不要写 USER_GUIDE 更新）

**估时**：1h

---

## 总估时

| 阶段 | 估时 |
|---|---|
| 后端（T2 + T3） | 50 min |
| HTML/CSS（T1 + T4 + T5） | ~1h45m |
| 弹窗逻辑（T6） | 2h |
| 启动联动（T7 + T8） | 1.5h |
| Preview/Smoke/文档（T9 + T10 + T11） | 3.5h |
| **总计** | **~9.5h**（含 self-review 与 Codex round） |

---

## 退出标准（Definition of Done）

- ✅ 所有 T1-T11 完成 + 单元 Verify 通过
- ✅ `npm run smoke` 全绿
- ✅ `npm run preview` 三组 preview 截图通过对照
- ✅ Codex 自动 review 0 Critical + 0 Important（如有 Important 必须修复）
- ✅ `/check-vars` 输出已贴入 PR body
- ✅ PR 自评轮次 ≥ 1 轮（参照 v2.1.3 多轮 review 节奏）
- ✅ 用户手动测试反馈：4 块改动行为符合预期
- ✅ 等用户明确说"提 PR"后 team-lead 才走 PR（CLAUDE.md memory `workflow_no_tester_no_auto_pr`）

---

## OPEN ISSUES（已全部拍板 — 同 PRD §五）

| # | 议题 | 拍板 | 状态 |
|---|---|---|---|
| ~~O1~~ | 闲置区从启用区收回时排序方式 | ~~A=按 name.length 重排~~ → **Fix1.5 修订为按视觉宽度** | ✅ |
| O2 | DB 持久化空值时启动写回 'gateway' | A=写回 | ✅ |
| O3 | 启用区至少保留 1 | A=禁止减到 0 | ✅ |
| O4 | 当前激活模块被移到闲置时 | A=自动切到启用区第 1 个 | ✅ |
| O5 | 拖拽手柄视觉 | A=⋮⋮ | ✅ |
| ~~O6~~ | 弹窗"取消/确认"按钮 | ~~A=不需要（即时落库）~~ → **Fix1.2 撤回，改为完成/取消 两阶段提交** | ✅ |
| O7 | 🔄 按钮 tooltip 文案 | A="小助手功能收纳" | ✅ |
| V1 | v2.1.4 版本号格式 | 直接 2.1.4（无 beta） | ✅ |

---

## 实施记录

> Dev 阶段每完成一个 task 后在下方追加 commit 哈希 + 简述。
