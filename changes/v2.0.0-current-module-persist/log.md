# Log — v2.0.0-current-module-persist

## 2026-04-28 初始

- 动作：落 spec/tasks/log 三件套，状态=apply
- 证据：用户问"重新打开软件显示哪个页面"→ 回答默认 statement-generator → 用户要求加持久化
- 风险：
  - currentModule 命中"渲染端模块状态"，需评估是否登记入 rules/important-variables.md
  - 持久化失败时 UI 切换仍要正常 → 采用 fire-and-forget + warn 模式
- 决策：
  - 复用 uiStyle 持久化模板（settings-repository.js:62-88 + main.js:2657-2685）
  - 不引入新表、不改 schema、不加用户开关
  - 切换时立即写库，启动时 get-info 返回带 currentModule

## 2026-04-28 实施完成

- 动作：5 个文件改动（database.js / settings-repository.js / main.js / preload.js / renderer.js）
- 证据：
  - smoke：`npm run smoke` → "smoke test passed"
  - 后端单元验证（in-memory SQLite）：空库返回 null、写入读取正常、非法值抛错、外部篡改非法值时读取返回 null
- 风险：
  - 命中 Important-skeleton 的 `MODULES / setCurrentModule`（rules/important-variables.md:193）
  - setCurrentModule 加了第二参数 `{ persist = true }`；调用方默认行为不变，唯独启动恢复处显式 `{ persist: false }`，避免启动写库
- 决策：
  - 启动恢复 fallback 链：DB null/非法值 → main 兜底 'statement-generator' → renderer 二次校验合法值 → 最终走默认
  - 切换 fire-and-forget，写库失败仅 console.warn

## 待用户验证

- [ ] `npm start` → 切到「月度 Pending 数据核对」→ 关闭 → 重启 → 应直接进入 Pending 模块
- [ ] 同上，切到「新开账户余额账单生成」验证
- [ ] 切回「网银账单生成」→ 重启 → 应回到「网银账单生成」

## 可沉淀知识
- [x] `app_settings` 表的 key/value 持久化套路：repository 三件套（get/set/[ensureDefault]）+ database.js facade + main.js IPC（get-info 返回 + 单独 set handler）+ preload api + renderer apply on init —— 是项目的标准 setting 持久化范式
