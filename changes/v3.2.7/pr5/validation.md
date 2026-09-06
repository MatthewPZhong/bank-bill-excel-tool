# PR5 验证记录

2026-09-06 PR235 修复：在合入 PR1b—PR4 评论修复后，Electron IPC / 删除两个文件 18 PASS / 0 FAIL / 0 SKIP，20074 ms；原页面检查 11 PASS，新真实鼠标/键盘取消检查 10 PASS。两组 UI 使用实际 renderer / 样式 / Electron 模态，但 API 是可控夹具；后台组使用真实临时 Task、SQLite、worker、Publisher 和 Archive，不将两者写成完整生产人工操作。运行、双层删除及发布保护截图已检查。eslint 和 git diff --check 通过，check-vars 仅局部 dialog 同名命中。日志 `/tmp/bizop-pr235-backend-regression.log`、`/tmp/bizop-pr235-ui-regression.log`、`/tmp/bizop-pr235-ui-cancellation.log`。以下原 release-check 数字保留为历史基线，本轮完整汇总另记。

macOS arm64，真实合成 XLSX、临时主库/Archive/后台 worker/Publisher。应用版本保持 3.2.6，生产新业务禁用。

| 检查 | 当前实际结果 |
| --- | --- |
| 删除/恢复专项 | 12 PASS；两种模式、跨月影响、直接结果删除、过期/generation/保护变化、取消、共享导出、4 次真实进程退出、KEEP_RESULTS 说明丢失阻断 |
| 真实 IPC 专项 | 6 PASS；真实导入/计算/七类导出/删除、重复请求、主窗口/路径/action 约束、取消、完整缺失清单、401 条目录分页 |
| Electron 36.9.5 / Node 22.19 专项 | 18 PASS / 0 FAIL / 0 SKIP，47799 ms（删除与 IPC；随后响应异常边界另以 Node IPC 专项 6 PASS 覆盖） |
| 实际页面组件 | 11 PASS / 0 FAIL，独立 Electron 窗口、合成 API；4 张截图逐张检查；无真实用户数据 |
| 第一次完整 release-check | lint/smoke PASS；7076 PASS / 3 既有 SKIP / 3 FAIL，7082 项、454 文件，301599 ms；失败为原 IPC 清单固定数量/尚未暴露 V327 的旧断言，未进入集成层 |
| 清单修订专项 | 35 PASS / 0 FAIL；Main+preload+V327 注册器精确集合，71 file/63 no-file 不变，128 exclude；Toolbox 原 14 处装配检查保持 |
| 完整 release-check 重跑 | PASS，退出码 0；lint/smoke PASS；7079 PASS / 3 既有 SKIP / 0 FAIL，7082 项、454 文件，177412 ms；53 个集成脚本全部通过，2488/2488，466927 ms |
| check-vars | ipcRenderer、MODULES、dialog、elements、state；关联检查见 review.md |
| git diff --check | PASS |

```bash
npm run release-check
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-delete-main.test.js tests/unit/main-process/biz-op-v327-ipc.test.js
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/verify-ui.js
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/verify-ui-cancellation.js
node scripts/check-vars.js
```

页面验证加载真实 renderer 组件和样式，fixture API 验证交互。真实 IPC 使用另一组实际 native job/SQLite/Publisher/Archive 的临时宿主测试；两者不冒充完整生产应用人工点击。未执行 Windows 目录成功链、2200 万输入、用户真实样例、Excel/WPS 打开，也未启用清旧或发布版本。

[主页面截图](screenshots/main.png) · [删除影响截图](screenshots/delete-impact.png)。完整本机证据在 `outputs/pr5-validation/`。
