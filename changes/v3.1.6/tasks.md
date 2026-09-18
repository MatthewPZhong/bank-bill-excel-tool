# v3.1.6 Tasks

## 实现与 Review

- [x] 五类原表严格模板导入、四类业务键幂等、冲突和逐行审计。
- [x] 主体九币种发生额、人工期初、跨月归档和双 Sheet 结果导出。
- [x] 数据管理查询、删除、当前有效原表/校验表导出及“已删除”生命周期。
- [x] 系统财务OP正式 16 列契约、CNY→CNH 和九币种血缘守恒。
- [x] 整合同事的平盘 pending owner-token 修复与管理页展示调整。
- [x] self-review 修复唯一 P3，复查后无未解决 P0-P3 Finding。
- [x] PR #118 以 merge commit `54acd9ea0dc5a8b9bfa9528a9d0d264018c7c3f1` 合入 `main`。

## 正式收尾

- [x] `main@54acd9e` Windows Build run `30755450625` 全部成功。
- [x] 干净 `npm ci` 后完整 `release-check`：unit 4,592/4,592、integration 2,051/2,051、lint 与 smoke 全绿。
- [x] 主页面两种尺寸、三档缩放 6/6 PASS。
- [x] `scan:vars` / `check:vars` 硬节点完成；release 分支无 `src` 差异。
- [x] 生产依赖审计记录 0 critical、7 high、2 moderate，不在发布收尾中混改依赖。
- [x] 建立 PR #118 归档、v3.1.6 PRD 与 release-prepared 规格/测试证据。
- [x] release-closeout PR #119 合入 `main@97324e56`，PR 与合并后 Windows checks 均成功。

## 发布收尾

- [x] 创建并推送指向最新 `main@97324e56` 的 annotated tag `v3.1.6`。
- [x] Windows Release workflow run `30756698074` 全部成功。
- [x] GitHub Release 为 latest、non-draft、non-prerelease。
- [x] 独立下载并核对 Setup、Setup blockmap、portable、`latest.yml` 的大小与 SHA-256。
- [x] 核对 `latest.yml` 的 version、path、size、SHA-512 与 Setup 实际字节一致。
- [x] 发布证据由 PR #120 回写正式日期、tag object/commit、workflow run 和资产摘要；该 PR 合入 `main` 即完成版本归档。
- 本地 `main` 同步与 tracked clean 复核在 PR #120 合并后执行，结果由最终交付说明记录。

## 发布后人工跟进

- [ ] 扫描业务提供的全部历史月份四类业务键，确认不存在合法跨期复用。
- [ ] 业务逐项复核主体、币种、方向、金额、账期、Pending J:K 和跨月期初衔接。
- [ ] 在真实数据库副本上执行未归档删除和不少于 400 万条通道数据导出。
- [ ] Windows Excel/WPS 打开大文件并核对分页、内存、临时磁盘和退出清理。
- [ ] 在 Electron 开发环境重试原平盘单文件并核对存档输入和侧库 checkpoint。
- [ ] 从上一 stable v3.1.5 执行 Setup 覆盖和 production/latest 在线升级 canary。
