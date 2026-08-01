# v3.1.4 Tasks

- [x] 白名单行分类与稳定错误码
- [x] ledger 过滤记录、原因统计、行数守恒与碰撞重建
- [x] 流式异常报告生成、哈希和 sealed manifest
- [x] 过滤墓碑与运行过滤快照 schema
- [x] source writer 同事务写正常行、墓碑、解除记录与 revision
- [x] 存档 output 角色、锁定和报告解析
- [x] 导入结果异常报告导出 IPC/UI
- [x] 全量过滤运行阻断
- [x] 结果确认页“过滤数据导出”常驻按钮
- [x] 过滤报告完整性确认门禁
- [x] 单元、集成、故障注入和六份真实文件回放
- [x] CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE / 版本号
- [x] `scan:vars` / `check:vars` 与关联变量 review
- [x] `release-check`
- [x] 资金业务人工复核（2026-08-01，业务负责人确认 Spec 13.3 五项判断）

## 正式收尾

- [x] PR #114 以 merge commit `1e5dfc697f043a83ef4881843fd6a284ff31e6d2` 合入 `main`。
- [x] PR #114 最终实现 commit `836dc5d1db975c0bee69d83ea1f22a79e91b0639` 经 Codex Review 无 P3 或更高 Finding，全部 review 线程关闭。
- [x] 建立 `docs/prs/PR114-v3.1.4.md` 和 `docs/iterations/v3.1.4/PRD-v3.1.4.md`。
- [x] 业务负责人确认 Spec 13.3 五项资金判断，并授权技术发布。
- [x] 重新执行发布门禁、布局校验、变量扫描与 check-vars。
- [ ] 提交并合并 v3.1.4 发布准备 PR。

## 发布收尾

- [x] Windows 10/11 候选 Setup/portable 与 SmartScreen 门禁已由发布负责人单独豁免；证据见 [PR #115 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/115#issuecomment-5151827405)，不记为实测通过。
- [x] 候选 Setup `v3.1.3 → v3.1.4` 离线覆盖 canary 门禁已由发布负责人单独豁免；证据同上，不记为实测通过。
- [ ] 创建并推送 annotated tag `v3.1.4`，且 tag 必须指向当时最新 `main`。
- [ ] 等待 Windows Release workflow 全部通过。
- [ ] 验证 GitHub Release 为 stable/latest、non-draft、non-prerelease，并包含 Setup、Setup blockmap、portable、`latest.yml` 四项资产。
- [ ] 回读公开资产元数据与摘要，核对版本、文件名、大小及 `latest.yml` 引用。
- [ ] 回写发布 run、资产摘要和最终状态，提交并合并发布证据 PR。
- [ ] 同步本地 `main` 并确认 tracked worktree 干净；既有无关未跟踪文件不纳入清理。

## 发布后人工跟进

- [ ] Windows 打包环境验证大异常报告流式 writer 峰值与存档恢复。
- [ ] Windows 安装版演练进程硬退出、系统文件锁和存档持久重试提示。
- [ ] 在 Windows 10/11 补做候选/正式 Setup 与 portable 启动及 SmartScreen 实际提示验证。
- [ ] 使用 Setup 补做 `v3.1.3 → v3.1.4` 覆盖安装并核对主库、平盘 side DB、设置、存档与导出文件保留。
- [ ] Release 公开后使用上一 stable 完成 production/latest 在线升级 canary，核对检查、下载、稍后、业务忙阻断、重启安装和用户数据保留。
