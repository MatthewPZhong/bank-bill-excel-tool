# v3.1.7 Tasks

## 实现与 Review

- [x] Payment 与 R5s2-recon 共享调拨派生工作副本并固定 Payment 先运行。
- [x] 付款账户核对、连续 ISO 周窗口、三轮匹配和跨引擎双侧消费保护。
- [x] 三个 Payment 核对 sheet、回填前银行快照和运行态使用标记。
- [x] 固定样本生产回放和结构化回归基线。
- [x] self-review 后无未解决 P3 及以上 Finding。
- [x] PR #121 以 squash merge `6fe118b8c4d665e1ce877fb792e6a4bbcda64cdf` 合入 `main`。

## 正式收尾

- [x] `main@6fe118b` Windows Build run `30794912210` 全部成功。
- [x] 干净 `npm ci` 后完整 `release-check`：unit 4,575/4,575、integration 2,051/2,051、lint 与 smoke 全绿。
- [x] 主页面两种尺寸、三档缩放 6/6 PASS。
- [x] `scan:vars` / `check:vars` 完成并逐项 review 三个 Runtime-state 词法命中。
- [x] 固定样本重跑保持 Payment 220、R5 2、命中 192、未命中 1,639，付款账户 220/220 相等。
- [x] 生产依赖审计记录 0 critical、7 high、2 moderate，本次不混改依赖。
- [x] 建立 PR #121 归档、v3.1.7 PRD、preflight、test spec 和 release-prepared 证据。
- [x] release-closeout PR #122 合入 `main@1117c8b7`；PR run `30796827775` 与 main run `30797197015` 均成功。

## 发布收尾

- [x] tag 前确认同名远端 tag 不存在；workflow 在发布前再次确认同名 GitHub Release 不存在。
- [x] 创建并推送指向最新 `main@1117c8b7` 的 annotated tag `v3.1.7`。
- [x] Windows Release workflow run `30797428933` 全部成功。
- [x] GitHub Release 为 latest、non-draft、non-prerelease。
- [x] 独立下载并核对 Setup、Setup blockmap、portable、`latest.yml` 的大小与 SHA-256。
- [x] 核对 `latest.yml` 的 version、path、`files[0].size`、SHA-512 与 Setup 实际字节一致。
- [ ] 发布证据 PR 回写正式日期、tag object/commit、workflow run 和资产摘要并合入 `main`。
- [ ] 同步本地 `main`，确认无本次任务遗留的 tracked 改动。

## 发布后人工跟进

- [ ] 业务逐笔复核固定样本中的 220 条 Payment 配对及 2 条 R5 后续回填；完成前不启用或公告该资金功能。
- [ ] Windows 10/11 正式 Setup 与 portable 启动，并记录 SmartScreen 表现。
- [ ] 从上一 stable v3.1.6 执行 Setup 覆盖和 production/latest 在线升级 canary，核对 SQLite、设置、存档和导出文件。
