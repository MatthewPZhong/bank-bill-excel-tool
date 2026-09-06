# PR5 关联复核与盲区检查

结论：完成 Main IPC 到页面、两种删除与恢复闭环；可以作为堆叠草稿 PR 评审。E5 的条件通过不变，新业务仍禁用；Windows 成功路径、目标规模与人工资金/Excel 验收仍未通过。

| 边界 | 证据与结果 |
| --- | --- |
| 页面入口 / 旁路 | 20 个 V327 IPC 与 preload、policy 分类精确对应；主窗口及主 frame 校验，严格参数键，文件路径只来自 Main 原生选择；内部维护仍不暴露给 renderer |
| 重复 / 取消 | 同窗口 requestId + 请求摘要回读同一 Promise；换参拒绝，单次选择消耗；取消覆盖 native worker 和后续 Main 校验。Publisher 已开始后等待权威结果；排队期间的取消由 PR4 577e9adf 修复 |
| 运行草稿 | 主预检列出所有缺失输入；预检引用绑定 generation，确认前输入变更不创建新 Task；页面晚到预检不覆盖新日期，失败保留日期 |
| 删除闭包 | 原表选择按 dataset 去重；跨操作月份列出所有关联结果和原件引用，直接选结果不反删输入；mode 绑定不可变 intent/原 Task，receipt 优先且换模式拒绝 |
| KEEP_RESULTS 保护 | 删除前核验保留结果 manifest/分片/说明与原件引用；恢复及回收前再次核验。原件真实 hash 读取单独申请既有 Governor 容量，调用关闭后释放；缺说明的真实重启保持未决及待回收输入 |
| 原件 / 锁 | 只释放所选对象的 v327-input/result holds；统计用户锁与 shared blob 引用，不解锁，不 unlink Archive/外部文件 |
| 数据体积 | 元数据 keyset 每页至多 200 行、IPC 完整响应不超 256 KiB；401 条合成目录分成 200/200/1，未读取 payload；删除完整预览超过既有 64 KiB 控制预算明确拒绝，无截断级联 |
| UI | 精确列序、导出入口与三个删除按钮；用户来源名只作 textContent；双击、取消等待、错误、草稿及路由通过真实 Electron 页面组件测试。页面 API 为合成夹具，真实 IPC 测试另有独立临时数据库/worker/文件 |
| 恢复 / 平台 | 仍为同一 E5 Main driver、committed-only Provider 和原 2 次全量扫描；新增本模块 Provider/回收前保留结果检查，不修改共享 StartupRecoveryCoordinator 或 TaskLifecycle |

## Important variables

`check-vars` 命中 Important-skeleton `ipcRenderer` 与 Runtime-state `MODULES/dialog/elements/state`。Main/preload 新 namespace 逐项映射，旧命名空间保留；未改模块枚举、已启用模块或其他模块状态。模块切换以 Main mode 为准，异步回包不能重新显示已离开的面板。Task policy 仍为 71 file / 63 no-file；新增 8 个只读、选择、预览、取消排除入口，exclude 从 120 到 128。

主进程原有 runtime.get 的 14 处断言继续保留；新模块装配和新 IPC 装配分别明确核验 1 处。未放宽 worker context、生产 policy、资金解析/计算或 Publisher 证据。

## 剩余边界

元数据月份沿用目录 UTC 成功时间，界面明确 UTC，不因为本机时区改变既有结果的操作月份。大规模恢复预算、Windows 目录耐久屏障、用户真实数据及 Excel/WPS 人工检查仍属于后续启用门禁。截图只验证组件可读性和交互，不算用户人工验收或正式运行的应用验收。
