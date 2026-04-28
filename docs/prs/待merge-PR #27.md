# PR #27（待 merge）

- **URL**：（待 `gh pr create` 后补）
- **分支**：`v2.0.0` → `main`
- **版本**：`2.0.0-beta.2`（本次不 bump）
- **状态**：待 merge
- **integrated**：false

---

## Summary

启动模块持久化：app 冷启动时自动恢复上次使用的模块（「网银账单生成」/「新开账户余额账单生成」/「月度 Pending 数据核对」三选其一）。

之前每次冷启动都强制回到「网银账单生成」，对常驻使用其他两个模块的用户造成无谓切换。本次复用 `uiStyle` 持久化模板（settings 表 key/value + IPC + renderer apply on startup），不开新表，不改 schema。

5 文件 +60/-3。

---

## ⚠️ 关联功能 review（check-vars 自动生成）

本次改动触及以下重要变量，已自查通过：

- **Important-skeleton**: `settingsRepository`, `ipcRenderer`
  - settingsRepository review：新加的 setting key `current_module` 在 main / preload / renderer 三层一致；非法值在 main + renderer 都做了校验
  - ipcRenderer review：新增 channel `settings:set-current-module` 已在 main 端 `src/main.js:2688` 注册 `ipcMain.handle`，preload 已暴露 `desktopApi.settings.setCurrentModule`

- **Runtime-state**: `state`, `MODULES` / `setCurrentModule`
  - state review：未新增 state 字段；UI 重渲染逻辑未变；模板列表 / 导出可用性联动未受影响
  - MODULES / setCurrentModule review：本次未增加模块枚举；`setCurrentModule` 加 `{ persist=true }` 参数，启动恢复处显式 `{ persist: false }` 避免回写自身

- **Minor 知会**: `getSetting`, `setSetting`（复用既有 setting 工具，无新增 schema）

**已跑**：
- [x] `npm run smoke`（passed）
- [x] `npm run preview` + `npm run preview:account`
- [x] 后端单元验证（in-memory SQLite）：空库 → null；写入 → 读到；非法值 → 抛错；外部篡改非法值 → 读取 null（main 端 `|| 'statement-generator'` 兜底）
- [x] 用户手动验证：切模块 → 重启 → 自动恢复

---

## 关键决策

- **D1**：复用 `uiStyle` 持久化模板（settings-repository.js:62-88 + main.js:2657-2685），不引入新表 / 不改 schema / 不加用户开关
- **D2**：切换时 fire-and-forget 写库，写库失败仅 `console.warn`，不阻塞 UI 切换
- **D3**：启动恢复 fallback 链 — DB null/非法值 → main 兜底 `'statement-generator'` → renderer 二次校验合法值 → 最终走默认（三道兜底）
- **D4**：`setCurrentModule` 加 `{ persist=true }` 第二参数；启动恢复处显式 `{ persist: false }` 避免对自身值再写一遍库

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/backend/database/settings-repository.js` | +27 — 新增 `current_module` key + 合法值枚举 + `getCurrentModule` / `setCurrentModule` |
| `src/backend/database.js` | +8 — facade 暴露 `getCurrentModule` / `setCurrentModule` |
| `src/main.js` | +10 — `app:get-info` 返回多 `currentModule` 字段；新增 `settings:set-current-module` IPC handler |
| `src/preload.js` | +2/-1 — 暴露 `desktopApi.settings.setCurrentModule` |
| `src/renderer.js` | +13/-2 — `setCurrentModule` 加 `{ persist }` 参数；`initialize()` 启动从 `info.currentModule` 恢复 |

附带 preview 截图：
- `docs/previews/main-page.png`
- `docs/previews/account-mapping.png`

变更目录：
- `changes/v2.0.0-current-module-persist/spec.md / tasks.md / log.md`

---

## 文档同步

按 memory `workflow_docs_update`：发版前才更新文档三件套，中间 fix / 小功能不更新。本次**不**更新 CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE，留到 v2.0.0 系列发版前统一收口。

---

## Test plan

- [x] `npm run smoke`
- [x] `npm run preview` + `npm run preview:account`
- [x] 后端单元验证（settings-repository in-memory SQLite）
- [x] 启动恢复手动验证：切到模块 B → 关闭 → 重启 → 直接进入模块 B
- [x] 切换持久化：切换后立即查 SQLite `app_settings.current_module` 已更新
- [ ] 等 reviewer 在自己机器上同样跑一遍冷启动验证
