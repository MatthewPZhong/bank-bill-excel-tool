# Tasks - v3.0.22 设置页内存档中心

> updated: 2026-07-21

## 状态

| 任务 | 状态 | 产物/证据 |
|---|---|---|
| 1. 冻结范围与 11 模块矩阵 | done | `spec.md` §2-5 |
| 2. 建立 SQLite 轻量目录 | done | `archive-repository.js` + repository tests |
| 3. 实现 SHA-256 Blob store | done | `archive-service.js` + service tests |
| 4. 实现保留、锁定、删除、重试和启动修复 | done | service/controller tests |
| 5. 实现设置页双导航和存档浏览 | done | renderer/preload/CSS + UI contract test |
| 6. 接入 11 个模块与独立链接表批次 | done | `operation-tracker.js` + 25 项策略测试 |
| 7. 修复共享入口与临时批次错绑 | done | origin module、模块+归档类型活动域反例测试 |
| 8. 同步版本号和三份版本文档 | done | package/changelog/history/user guide |
| 9. 完整发布检查和预览 | done | release-check、变量检查、启动性能和设置页预览均通过 |
| 10. 真实文件人工血缘抽查 | pending | 由资金负责人完成 |
| 11. PR、自审与合并 | done | PR #97 已由 merge commit `116eee1` 合入 `main` |
| 12. 发布归档与在线发布 | done | tag `v3.0.22` 指向 `9e40a29`；workflow `29816044492` 通过，latest Release 与四个公开资产已验证 |

## 实施检查清单

### 数据层

- [x] 主库只保存批次、逻辑文件和 Blob 轻量元数据。
- [x] 文件字节位于 Documents 固定目录。
- [x] 流式 SHA-256，不整文件加载内存。
- [x] 全局去重、共享引用安全删除。
- [x] 启动一致性修复和临时目录清理。

### 业务接入

- [x] 业务成功先返回，归档复制后台串行执行。
- [x] 导入未运行不建运行批次。
- [x] 首次成功结果冻结，后续输出不追加。
- [x] 聚合、区间、错误、配置、工具箱出口旁路。
- [x] 归档后台队列只保留轻量结果快照，不持有大体量业务行。
- [x] 资金对账网关修复携带发起模块。
- [x] 临时 MPT 与正式前置资金对账活动域隔离。
- [x] 没有当前周期文件时不创建空批次。
- [x] 显式历史 run key 不回退到最新批次。
- [x] 临时 MPT 同名文件按原始下标绑定结果。
- [x] 业务成功时记录文件身份，排队期间变化则拒绝错存。
- [x] 整批文件在首个复制动作前全部登记；正常退出等待队列排空。

### UI 与安全

- [x] 自动更新为默认页且现有功能不变。
- [x] 存档中心不加入主模块。
- [x] Renderer 不接收源路径或 Blob 路径。
- [x] 删除二次确认，锁定批次禁删。
- [x] 打开使用只读副本；另存为使用系统保存框。
- [x] 另存目标经目录链接指向存档根时仍被拒绝。
- [x] 模板排除和保留期持久化。

### 收尾

- [x] 版本更新为 3.0.22。
- [x] 更新 `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。
- [x] `npm run release-check`。
- [x] `npm run scan:vars`。
- [x] `npm run check:vars -- --include-minor` 并完成人工关联功能自查。
- [x] `npm run startup:measure`。
- [x] 复核 `docs/previews/archive-center-settings.png`。
- [ ] Windows 最小窗口和缩放人工检查。
- [ ] 真实资金文件 SHA-256 人工抽查。

## 非本轮任务

- 跨重启 receipt、旧数据回填和历史 run 绑定。
- 失败运行批次、业务恢复和一键重跑。
- 文件名/全文搜索、Excel 内容预览和云同步。
- 云同步、旧批次回填和存档内容恢复仍不进入发布范围。
