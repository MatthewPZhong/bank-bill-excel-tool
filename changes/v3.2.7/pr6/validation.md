# PR6 验证记录

2026-09-06 PR230—235 评论修复汇总：代码基线 `b5f8a9d5`，完整 `npm run release-check` 退出码 0，lint / smoke PASS；7131 PASS / 3 既有 SKIP / 0 FAIL（7134 项、456 文件），53 个集成脚本全部通过、2488/2488。Electron 合并后升级另跑 30 PASS / 0 FAIL / 0 SKIP。各修复专项、真实 UI 输入与原始证据位置见 [本轮修复记录](review-remediation.md)。以下为初始 PR6 历史验证，本轮没有重开生产门禁或改动共享恢复核心。

宿主：macOS arm64。仅操作隔离 temp 主库/Archive、合成旧月库及新 XLSX；生产配置 disabled，package.version 保持 3.2.6。

| 检查 | 实际结果 |
| --- | --- |
| 升级专项 | 30 PASS，已在完整单测重跑中复核；含 7 个真实 process.exit 位置、原旧 run/month-end provider、未知来源保护、关闭失败晚到收口、ACTIVE 反馈丢失、持久旧写 guard、实际激活后新链 |
| Electron 36.9.5 / Node 22.19 | 30 PASS / 0 FAIL / 0 SKIP，21436 ms；真实 native worker、临时 SQLite/Archive 和 Publisher |
| 启动与旧 lineage 专项 | 42 PASS / 0 FAIL，3585 ms；Main 首语句顺序修复后，原 Pending/Archive/窗口边界仍成立 |
| 最终启动/Toolbox 专项 | 44 PASS / 0 FAIL，1404 ms；原 14 个 runtime.get 入口数量不变，新模块、IPC、activation 装配各自单列 1 个 |
| 发布 policy schema/语义 | 1 PASS；合成证据全部通过时，新策略仍使用原登记键与现有 commit 枚举，其余 action 策略不动 |
| 首次 release-check | lint/smoke PASS；7104 PASS / 3 既有 SKIP / 5 FAIL，7112 项、455 文件，195813 ms；5 项均来自 Main 首 require 位置及 runtime.get 装配计数，未进入 integration；保留失败记录 |
| 完整 release-check 重跑 | PASS，退出码 0；lint/smoke PASS；7109 PASS / 3 既有 SKIP / 0 FAIL，7112 项、455 文件，187533 ms；53 个 integration 脚本全部通过，2488/2488，280677 ms |
| check-vars | Runtime-state app；完成启动/退出与未保存业务边界复核，见 review.md |
| git diff --check | PASS |

```bash
npm run release-check
node --test tests/unit/main-process/biz-op-v327-upgrade.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-upgrade.test.js
node scripts/check-vars.js
```

Linux CI 已有真实目录屏障专项，将自动包含本 PR 的升级测试。Windows 不能提供真实目录 fsync 时，相关成功用例通过既有 helper 明确 SKIP，负向门禁及 policy 检查继续执行；不能把 SKIP 算成 Windows 清旧成功。

未执行：真实用户清旧、2200 万输入/最大结果并集、Windows 目录耐久成功链、真实资金样本、Excel/WPS 人工打开、生产启用、版本发布或合并。上述门禁继续保留。
