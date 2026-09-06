# PR5 验证记录

macOS arm64，真实合成 XLSX、临时主库/Archive/后台 worker/Publisher。应用版本保持 3.2.6，生产新业务禁用。

| 检查 | 当前实际结果 |
| --- | --- |
| 删除/恢复专项 | 12 PASS；两种模式、跨月影响、直接结果删除、过期/generation/保护变化、取消、共享导出、4 次真实进程退出、KEEP_RESULTS 说明丢失阻断 |
| 真实 IPC 专项 | 6 PASS；真实导入/计算/七类导出/删除、重复请求、主窗口/路径/action 约束、取消、完整缺失清单、401 条目录分页 |
| Electron 36.9.5 / Node 22.19 专项 | 18 PASS / 0 FAIL / 0 SKIP，47799 ms（删除与 IPC；随后响应异常边界另以 Node IPC 专项 6 PASS 覆盖） |
| 实际页面组件 | 11 PASS / 0 FAIL，独立 Electron 窗口、合成 API；4 张截图逐张检查；无真实用户数据 |
| 第一次完整 release-check | lint/smoke PASS；7076 PASS / 3 既有 SKIP / 3 FAIL，7082 项、454 文件，301599 ms；失败为原 IPC 清单固定数量/尚未暴露 V327 的旧断言，未进入集成层 |
| 清单修订专项 | 35 PASS / 0 FAIL；Main+preload+V327 注册器精确集合，71 file/63 no-file 不变，128 exclude；Toolbox 原 14 处装配检查保持 |
| 完整 release-check 重跑 | RUNNING，结果补充到本记录；不能把第一次或专项成绩写成全量 PASS |
| check-vars | ipcRenderer、MODULES、dialog、elements、state；关联检查见 review.md |
| git diff --check | PASS |

```bash
npm run release-check
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-delete-main.test.js tests/unit/main-process/biz-op-v327-ipc.test.js
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/verify-ui.js
node scripts/check-vars.js
```

页面验证加载真实 renderer 组件和样式，fixture API 验证交互。真实 IPC 使用另一组实际 native job/SQLite/Publisher/Archive 的临时宿主测试；两者不冒充完整生产应用人工点击。未执行 Windows 目录成功链、2200 万输入、用户真实样例、Excel/WPS 打开，也未启用清旧或发布版本。

[主页面截图](screenshots/main.png) · [删除影响截图](screenshots/delete-impact.png)。完整本机证据在 `outputs/pr5-validation/`。
