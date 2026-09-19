# v3.1.1 Tasks

## A. 平盘空旧侧库兼容

- [x] 建立受支持旧十表 schema 与空库证明 helper。
- [x] 仅在主库无 checkpoint、无 pending、存在合法 generation 0 bootstrap 时允许兼容。
- [x] 校验 SQLite `quick_check`、表/列、未知表/视图/触发器和十表行数。
- [x] 保留事务前预检，并在 `BEGIN IMMEDIATE` 后、`SCHEMA` 前完整复检，关闭并发写入竞态。
- [x] 全新建库候选在锁内证明无用户 schema，关闭“路径不存在检查后被外部抢先创建”的接管竞态。
- [x] 原地补齐现代 schema、运行完整性列和 generation 0 checkpoint history。
- [x] 补成功/阻断/重启/现代库回归测试。
- [x] 记录 `new / empty-legacy-upgrade / existing` 初始化模式；拒绝日志只写结构化 code/reason。
- [x] 用隔离异常旧库副本人工复核。

## B. 调拨方向与日期

- [x] 新增共享严格银行方向校验器和矩阵测试。
- [x] R3.5 Step1 改为方向+日期 eligible candidate，全局同日优先。
- [x] R3.5 Stage B 仅允许严格 Debit sibling 改为 `Charge`；Step2 保持不变。
- [x] R5s2 网关/调拨两来源校验真实方向和完整 directions 配置。
- [x] R4 复用共享校验器并锁定 warning/matchedPairs golden。
- [x] M2M 只读审计同步日期开关与 `±N`，保持宽方向。
- [x] 三个调拨写入引擎的日期失败告警按银行行/方向/原因去重，避免来源×银行 N×M 放大。

## C. 策略、生命周期与 UI

- [x] 新增 canonical owner predicate、policy resolver 和 stable signature。
- [x] owner 0/1/>1、伪内置保留签名冲突和非法日期值均有明确行为。
- [x] 幂等修复迁移恢复缺失 owner，不覆盖现有 owner 配置。
- [x] canonical seed 的功能说明准确反映来源/日期按配置；仅精确旧系统文案做幂等窄迁移。
- [x] create/update/delete/batch-delete/transfer/channel/bundle 旁路统一保护。
- [x] 管理页标题改为“调拨回填功能管理”，固定所有银行渠道。
- [x] 新增“调拨单匹配日期 ± [1] 天”，允许 1–999，关闭后保留输入值；与优先级同一行，日期在左、优先级在右。

## D. 主流程与审计

- [x] run 从含 disabled 的完整场景集合解析一次 policy。
- [x] policy 显式注入 R3.5、R5s2 两来源和 M2M。
- [x] 调拨 M2M 使用独立只读 audit context；R5 关闭但 R3.5 开启时不漏审计、不触发 R5 写入。
- [x] resolver warning 进入错误报告并计入 warning count。
- [x] enabled 场景快照与 policy raw/effective signature 组合。
- [x] export 重读并解析 policy；fatal 或 signature 变化拒绝旧结果。
- [x] canonical owner id 是唯一 R5s2 执行身份，冲突不落 R2。

## E. 发布收尾

- [x] 问题样本两笔逐笔人工复核。
- [x] `package.json` / lockfile 版本更新为 3.1.1。
- [x] 同步 `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。
- [x] `npm run scan:vars`。
- [x] `npm run check:vars -- --include-minor`。
- [x] `npm run release-check`。
- [x] 记录 Windows Excel/WPS 或其它必须人工完成的发布证据。

发布证据：两条真实资金问题样本及真实旧侧库隔离副本均已复核；本版没有修改
Excel writer、列顺序或单元格格式，Windows Excel/WPS 打开不属于 v3.1.1 的新增输出门禁，
格式保真专项留在 v3.1.2。

> v3.1.1 发布收尾完成前，不开始 v3.1.2 生产代码。
