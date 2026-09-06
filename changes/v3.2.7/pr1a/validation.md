# PR1a 验证记录

范围为共享 native/thread-single/job 关闭观察与资源所有权。E5 关闭合同指纹已从 E5 原 ZIP 重新读取核对；不修改设计包或生产开关。

| 检查 | 状态与证据 |
|---|---|
| 新增关闭专项 | 13 PASS / 0 FAIL；真实 worker + Main 故障注入 |
| 旧平台、适配器及宿主回归 | 系统 Node 与 Electron 各 438 PASS / 0 FAIL；之后新增 1 个宿主 case |
| 当前 Electron 关闭专项与实际宿主 | 24 PASS / 0 FAIL；新增共 14 个 case，其余为既有宿主回归 |
| lint、smoke | 完整 release-check 中通过 |
| 系统 Node 全部单元 | 6961 PASS / 3 SKIP / 0 FAIL；Windows 专用测试本地跳过 |
| 全部集成 | 53 个脚本、2488/2488 PASS；默认大文件规模未下调 |
| 完整 release-check | 退出码 0；lint → smoke → unit → integration 全部通过 |
| Windows Node / Electron | 本地未运行；验收以本 PR 的 CI 结论为准，不以 macOS 结果替代 |
| check-vars、diff whitespace | 无重要变量命中；git diff --check 通过 |

本地环境：macOS arm64；系统 Node v25.8.0；Electron 36.9.5 / Node v22.19.0。Windows CI 使用 Node 22，并显式执行 Electron 内置 Node 的关闭专项及宿主文件生成测试。

复验命令（仓库根目录）：

```bash
npm run release-check
node --test tests/unit/main-process/background-execution/*.test.js tests/unit/main-process/toolbox-background-generation.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/background-execution/carrier-observation.test.js tests/unit/main-process/toolbox-background-generation.test.js
```

Windows Electron 命令见 `.github/workflows/build-windows.yml` 的 `Verify carrier closure in Windows Electron` 步骤。

测试边界：未对实际用户业务文件、数据库或运行中的 Electron 应用执行操作。专项中的业务失败、终止拒绝和挂起为故障注入；线程退出为 native Worker 的真实事件。新宿主 case 使用真实工具箱 runtime 和文件生成器，仅写测试临时目录。PR1b 的持久 dispatch/read pin、目录提交、真实 Task/receipt/Hold 恢复、应用进程重启与后续业务/规模/人工验收仍独立落实。
