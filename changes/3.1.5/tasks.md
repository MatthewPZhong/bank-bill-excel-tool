# v3.1.5 Tasks

- [x] 固化 v3.1.4 失败 run、无 Release/资产和 tag 不改写边界。
- [x] 修复两处测试 cleanup：先关闭 SQLite store，再删除临时目录。
- [x] Windows PR workflow 增加受影响测试文件的定向回归。
- [x] `package.json` / `package-lock.json` 升级为 3.1.5。
- [x] 将 CHANGELOG、VERSION_FEATURE_HISTORY、USER_GUIDE 的实际交付版本同步为 v3.1.5。
- [x] 执行定向测试、lint、完整 `release-check`、布局和发布契约检查。
- [x] 执行 `scan:vars` / `check:vars` 并完成关联 review。
- [ ] 提交 PR，等待 Windows checks 与 Codex Review，修复至无 P3 或更高 Finding。
- [ ] 合并 PR，同步最新 `main`。
- [ ] 创建并推送 annotated tag `v3.1.5`。
- [ ] 等待 Release workflow 成功并核对四项公开资产。
- [ ] 提交并合并发布证据 PR，回写发布日期、run、资产大小和 SHA-256。
- [ ] 同步本地 `main`，确认 tracked worktree 干净。

## 发布后人工跟进

- [ ] Windows 10/11 正式 Setup/portable 启动与 SmartScreen。
- [ ] `v3.1.3 → v3.1.5` Setup 离线覆盖及用户数据保留。
- [ ] Windows 打包环境大报告恢复、进程硬退出、文件锁与存档重试。
- [ ] production/latest 在线升级 canary。
