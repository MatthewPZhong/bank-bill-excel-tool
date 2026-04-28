# Tasks — v2.0.0-current-module-persist

## Task 1 — 数据库层加 current_module setting
- 目标：复用 uiStyle 模板，新增 key + 三件套
- 涉及文件：
  - `src/backend/database/settings-repository.js`
  - `src/backend/database.js`
- 操作：
  1. settings-repository.js 新增常量 `CURRENT_MODULE_KEY='current_module'`、`CURRENT_MODULE_VALID=['statement-generator','new-account-generator','pending-reconciliation']`、`CURRENT_MODULE_DEFAULT='statement-generator'`
  2. 新增 `getCurrentModule / setCurrentModule`（非法值 → setCurrentModule 抛错；getCurrentModule 非法值返回 null）
  3. exports 加上
  4. database.js facade 加 `getCurrentModule / setCurrentModule`
- 验证：手写一个 node 一行式 require 调用看 get/set/get 三步行为正确
- 状态：done

## Task 2 — main.js IPC 接入
- 目标：暴露给 renderer
- 涉及文件：`src/main.js`
- 操作：
  1. `app:get-info` 返回里加 `currentModule: database.getCurrentModule() || 'statement-generator'`
  2. 新增 `ipcMain.handle('settings:set-current-module', (_event, moduleId) => {...})`，try/catch 抛错时返回 `{status:'failed', message}`
- 验证：grep 确认两处出现
- 状态：done

## Task 3 — preload 暴露 + renderer 接入
- 目标：renderer 启动恢复 + 切换持久化
- 涉及文件：
  - `src/preload.js`
  - `src/renderer.js`
- 操作：
  1. preload `desktopApi` 加 `setCurrentModule: (moduleId) => ipcRenderer.invoke('settings:set-current-module', moduleId)`
  2. renderer 在 `app:get-info` 返回处理处（约 3070-3090 行附近 `initialize()` 内），如果 `info.currentModule` 是合法值，**在 setActiveModule 第一次被调用前**用它替代默认 `statement-generator`
  3. 在 `setActiveModule(moduleId)` 内（renderer.js:1134 附近）当模块**实际改变**时，触发持久化：`window.desktopApi.setCurrentModule?.(moduleId).catch(err => console.warn('persist currentModule failed:', err))`
- 验证：
  - 启动 app（`npm start`）→ 切到「月度 Pending」→ 关闭 → 重启 → 应直接显示 Pending 模块
- 状态：done

## Task 4 — smoke 测试
- 目标：不破坏现有自动化
- 涉及文件：无
- 操作：`npm run smoke`
- 验证：全部通过
- 状态：done

## Task 5 — important-variables 入表评估
- 目标：state.currentModule 是否需要纳入 rules/important-variables.md
- 操作：评估 → 如需要，加一条 Important-skeleton 层条目
- 验证：决策记录在 log.md
- 评估结论：**不新增条目**。`MODULES` / `setCurrentModule` 已在 Important-skeleton 层（rules/important-variables.md:193），本次未增加模块枚举，仅给 `setCurrentModule` 加 `{ persist }` 参数；后端新增的 `getCurrentModule` / `setCurrentModule`（settings-repository 中的 db facade method）属性同 Minor 层既有 `getSetting` / `setSetting`，被 Important-skeleton 的 `settingsRepository` 整体覆盖，不单独升格
- 状态：done
