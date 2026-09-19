# v3.2.9 TechDoc — 模块存档保留期限

| 项目 | 内容 |
| --- | --- |
| 目标版本 | `v3.2.9` |
| 功能分支 | `codex/v3.2.9-archive-retention-by-module` |
| 基线 | `v3.2.8` / `2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 产品依据 | [spec.md](spec.md) |

## 1. 配置与解析

新增 `src/main-process/archive-center/retention-policy.js`，统一存取和解析：

- 保留 `app_settings.archive_center_retention_days` 及旧 scalar API。
- 新增 `archive_center_retention_days_by_module`，JSON 对象以 canonical module ID 为 key，值为允许的天数或 `null`（永久）。
- 没有 key 表示继承；`inherit` 是更新动作，持久化时删除 key，不存入 map。
- 读取只接受注册表 canonical key 及合法值；非法 JSON、数组、未知 key 或非法值不产生覆盖。
- 更新按模块合并，模块 id/code/alias 通过 `getArchiveScope` 归一化，未知模块拒绝。数据库 schema 无变更，启动不迁移、不改历史批次。

## 2. 调用链

`Renderer → preload.setModuleRetentionDays(payload) → archive-center:set-module-retention-days → Controller → retention-policy → app_settings`。新 IPC 使用既有 `archiveCenterMutationIpcHandle` 退出闸门；payload 为 `{ moduleId, retentionDays }`。

`getSettings` 额外返回 `retentionDaysByModule`、`retentionModules`。默认期限继续调用 `setRetentionDays(number|null)`，兼容已有调用者。

新 IPC 在 `task-policy-registry.js` 的 `archive-center-maintenance` 类别显式登记，和默认期限设置相同，不新建用户存档任务；注册集合与 IPC 总数的闭合检查同步增加一项。

Main 的存档 `createService(rootDir)` 工厂注入同步动态 resolver，因此初始实例及存档位置迁移后实例都读取最新配置。Service 的 `createBatch`、`_taskBatchInput`、`reserveFileTaskBatch` 使用同一 resolver 补齐未显式指定的期限；文件任务使用已持久 TaskRun 的模块身份。Controller 旧路径创建 outbox payload 时记录当时所属模块期限。

优先级为已有批次/显式期限快照 → 模块覆盖 → 全局默认。Repository 继续负责日历天计算和写入 `retention_until`；不修改清理条件及生命周期保护。

## 3. 界面与并发

新增“适用模块”下拉框，首项为默认，模块列表来自后端注册表；模块可选择“跟随默认”。已保存状态使用 `retentionDaysByModule`，显示永久时使用明确的 null 判断。

保留原单队列 latest-intent 保存机制，intent 携带模块 ID。保存期间模块选择器及关闭按钮禁用，同模块期限仍可连续修改；新 intent 替换尚未执行的旧 intent。成功只更新对应配置，失败恢复已保存值；最终结束后刷新说明及继承显示。

保存期间返回列表再重开设置时，先开启 loading 并等待保存队列完成，再读取配置和统计；请求编号失效或弹窗销毁后不再读取。这样慢统计响应不会让旧设置快照覆盖新值。同值 change 在入队前跳过，避免空保存留下已完成的队列引用。

存档设置加载中或保留期限仍有正在执行／待执行的保存时，删除入口只显示稍后重试的提示，不打开删除确认。删除确认会临时替换设置弹窗，因此必须在创建确认框之前检查这三个状态，避免弹窗离开 DOM 导致保存队列停在中途。保存成功或失败收口后，删除确认恢复原有行为；返回列表和重新打开设置仍然可用。返回列表会取消当前设置加载，已失效的读取请求不继续阻塞删除，也不在返回时恢复 loading。

## 4. 验证与整合

- 单测覆盖 policy、Controller 设置、Service 默认入口和现有存档链路。
- `scripts/integration/archive-center-module-retention.js` 使用真实 SQLite 与临时文件测试持久化、新建/复用/清理及保护。
- `scripts/verify-app-settings-layout.js` 使用隔离 Electron profile 和 API stub 测试实际 DOM 保存行为与 6 个窗口/缩放组合。
- 删除交叉回归覆盖全局／模块期限的连续保存、最终成功／失败、取消设置加载后的旧响应，以及保存结束后正常打开和取消删除确认。
- 最终运行 `npm run release-check`，区分本次失败、基线失败和平台验收；结果见 [verification.md](verification.md)。

本 worktree 位于主目录的 `tmp/worktrees/v329-archive-retention-by-module`，未承接主目录未提交改动。与永久删除分支的潜在合并交集是 Controller / Main / preload / renderer；与模板管理分支的交集是设置弹窗和布局测试。集成时应保留各自功能并重新验证，不整文件覆盖。

回退本功能代码会恢复旧版全局期限行为；新增 JSON key 可留存，旧版本不读取它。已生成批次的到期日继续保留，回退不重新计算历史期限。

文档结构参考本轮模板管理 TechDoc，按本项配置与生命周期范围精简。
