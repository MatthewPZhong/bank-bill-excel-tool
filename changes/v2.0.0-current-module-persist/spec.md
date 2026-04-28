# Spec — v2.0.0-current-module-persist

> status: apply
> owner: team-lead
> created: 2026-04-28
> updated: 2026-04-28

## 1. 背景

- 为什么要做：当前每次冷启动 app 都强制回到「网银账单生成」模块，对常驻使用「新开账户余额账单生成」「月度 Pending 数据核对」的用户不友好
- 用户 / 业务价值：减少切换 friction —— 上次用哪个，下次打开还是哪个
- 当前问题：`state.currentModule` 仅存在 renderer 内存中，无持久化路径

## 2. 代码现状（必须有出处）

- 相关文件：
  - `index.html:33-44` — module-switcher UI，`statementModulePanel`(`:47`) 默认无 `hidden`，另两个 panel(`:91`,`:157`) 默认 `hidden`
  - `src/renderer.js:96` — `state.currentModule = MODULES.statementGenerator.id`（写死默认）
  - `src/renderer.js:1134` — `setActiveModule(moduleId)` 内 `state.currentModule = moduleId`，唯一写入点
  - `src/renderer.js:3167` — 模块切换菜单点击事件
  - `src/backend/database/settings-repository.js:62-88` — uiStyle 三件套（参考模板）
  - `src/main.js:2657-2685` — `app:get-info` + `settings:set-ui-style` IPC（参考模板）
- 当前行为：每次启动 `currentModule` 重置为 `statement-generator`
- 已知限制：无持久化
- 事实依据：
  - `grep currentModule src/renderer.js` 仅 4 处（第 96/201/1134/1137 行），无 settings/restore 调用
  - app_settings 表已存在（`database.js:79`），同样的 key/value 模式

## 3. 目标

- 必做：
  1. 切换模块时立即将选择持久化到 `app_settings` 表
  2. 启动时从 `app_settings` 恢复并自动激活上次模块
- 可不做：
  - 加入"是否记忆模块"开关（默认 always-on，按需再加）
- 明确不做：
  - 模块内部的子状态/草稿持久化（不在本次范围）
  - settings UI 上暴露该字段

## 4. 功能点

### 功能点 1 — 启动时恢复
- 说明：app 冷启动时，从 `app_settings.current_module` 读取上次模块 ID 并激活
- 输入：`app:get-info` 返回的 `currentModule: 'statement-generator'|'new-account-generator'|'pending-reconciliation'`
- 输出：UI 直接呈现对应模块面板（其他面板 hidden）
- 边界：
  - 数据库无该 key → 返回默认 `statement-generator`
  - 值非合法枚举 → 回退默认，并把数据库值修正为默认
- 验收标准：
  - 手动验证：切到「月度 Pending 数据核对」→ 关闭 → 重启 → 直接进入 Pending 模块

### 功能点 2 — 切换时持久化
- 说明：用户从模块菜单选另一个模块时，立即写库
- 输入：`moduleId`（同上枚举）
- 输出：写入 `app_settings.current_module = moduleId`
- 边界：
  - 写库失败 → console.warn，不影响 UI 切换（不阻塞、不弹错）
  - 非法 moduleId → IPC handler 拒绝并返回 `{status:'failed'}`，不写库
- 验收标准：
  - 切换成功后立即查 SQLite，`current_module` 已更新

## 5. 影响范围

- 前端：`src/renderer.js`（启动恢复 + 切换时调用 IPC）、`src/preload.js`（暴露 API）
- 后端：`src/main.js`（新增 IPC + 改 get-info）、`src/backend/database.js`（facade）、`src/backend/database/settings-repository.js`（新增三件套）
- 脚本 / 配置 / 数据：无 schema 变更（沿用 app_settings key/value 表）
- 对外接口影响：
  - `app:get-info` 返回多一个字段 `currentModule`（向后兼容：旧字段不变）
  - 新增 `settings:set-current-module` IPC handler
- 兼容性影响：
  - 旧版本数据库无 `current_module` key → 自动回退默认值，不阻塞启动

## 6. 技术决策

- 方案：1:1 复用 uiStyle 持久化模式（settings 表 key/value + IPC + renderer apply on startup）
- 为什么不用其他方案：
  - 不开新表 —— uiStyle/enumConfig/backgroundConfig 都共用 `app_settings`
  - 不放 localStorage —— 项目无此模式且不跨 session 可靠
- 可能风险：
  - 用户如果手改 SQLite 写入非法值 → 回退默认 + 修正（不抛错）
  - renderer 启动时 apply currentModule 的时机要在 elements ready 之后

## 7. 数据 / 状态 / 安全影响

- 数据结构：复用 `app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT)`，新增一行 key=`current_module`
- 状态流转：
  - 启动：DB → main → IPC `app:get-info` → renderer state.currentModule → `setActiveModule`
  - 切换：renderer click → `setActiveModule(id)` → `desktopApi.setCurrentModule(id)` → main → DB
- 权限 / 安全：无（本地 SQLite，无外部接口）
- 回滚策略：
  - 代码层：revert commit
  - 数据层：用户在 SQLite 直接 `DELETE FROM app_settings WHERE setting_key='current_module'` 即恢复默认行为；无 schema 变更

## 8. 待澄清问题

- [x] 切换时是否阻塞 UI 等待写库完成？→ **否**，fire-and-forget，写库失败仅 warn
- [x] 是否需要在用户首次启动写入默认值？→ **否**，按需写（getter 找不到就 fallback 默认，避免无意义写库）
