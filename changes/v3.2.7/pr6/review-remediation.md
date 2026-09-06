# PR230—235 评论修复与串行回归

本文件为第一轮历史记录。第二轮 R1 的范围及最终证据见 [terminal-recovery-remediation.md](terminal-recovery-remediation.md)。

2026-09-06。用户授权修复，并沿用本地提交后直接更新远端 PR 的授权。E5 与已批准 E01—E03 不变；版本保持 3.2.6，生产发布门禁保持关闭。修复在原 PR 所属分支提交，通过普通 merge 向下游传播，没有重写远端历史或合并 main。

## 修复对应关系

| PR | 问题与最终行为 | 修复提交 |
| --- | --- | --- |
| #230 / PR1a | 本轮没有待修复评论，保持原共享关闭观察实现 | 98976f6e 不变 |
| #231 / PR1b | Inspector 暂不可用按平台精确 Task 计划处理；真实 anchor / Hold 中断继续原 Task 和批次 | cb5e74dd |
| #231 / PR1b | 已提交 receipt 与失败/取消 Task、错误批次终态保持冲突阻断；旧 COMPLETE 不隐藏来源，不重写业务事实 | cb5e74dd |
| #232 / PR2 | Main 独立拒绝 cancelled 文档，worker 最后封存及 Main 最后 await 之后检查取消；提交前不发布，提交后保留成功 | d128ca82 |
| #233 / PR3 | Main 最终计算提交前重新采样 signal，由 PR3 自身提供，无需等 PR5 | 402c4543 |
| #234 / PR4 | 每次 RAW / actual 读取独占 SST 子目录，缓存关闭不删除候选、spool 或输出 | 6a965714 |
| #235 / PR5 | 唯一取消按钮进入顶层弹窗；等待/保护提示同弹窗可见，正确 requestId、去重、等待原操作收敛和忽略旧响应 | d39ab6f2 |

PR6 合入上述代码后的验证基线为 `b5f8a9d5`。与原 PR6 `cedd713b` 比较，共享 `StartupRecoveryCoordinator`、发布证据配置与 package.json 内容完全一致；本轮未扩大平台改造范围。

## 本轮实际验证

所有数据均来自隔离临时数据库及合成 XLSX，没有改写用户业务数据。

| 范围 | 结果与边界 |
| --- | --- |
| PR1b 恢复 | Electron 34 PASS / 0 FAIL / 0 SKIP；新增 6 项真实 anchor / Hold / Task / Batch 故障回归 |
| PR2 导入 | Electron 两文件 21 PASS，之后新增文档独立防线 1 PASS，共 22 个独立测试；不是重复计数 |
| PR3 计算 | Electron 两文件 32 PASS / 0 FAIL / 0 SKIP，包含两个新的最终提交边界 |
| PR4 导出 | 原两个文件 20 PASS；大 SST 文件 7 PASS；共 27 个独立测试，0 FAIL / 0 SKIP |
| PR5 后台 | Electron 真实 IPC / 删除恢复 18 PASS / 0 FAIL / 0 SKIP |
| PR5 页面 | 原脚本 11 PASS，新真实鼠标/键盘脚本 10 PASS；三张新截图逐张检查。API 是可控夹具，未写成完整生产人工点击 |
| PR6 合并后升级 | Electron 30 PASS / 0 FAIL / 0 SKIP，11460 ms；验证新恢复对齐逻辑与升级阶段、原 Task 和实际关闭的兼容性 |
| 汇总完整 release-check | 完整退出码 0，lint / smoke PASS；单元 7131 PASS / 3 既有 SKIP / 0 FAIL，共 7134 项、456 文件、260087 ms；53/53 集成脚本通过，2488/2488，279562 ms |

大 SST 夹具每份 600 个 30006 UTF-16 字符字符串，超过真实 32 MiB 缓存预算。OP_RAW / FLOW_RAW 各两份原件经实际导入、native worker、Main、Publisher、Archive 连续完成导出；直接读取测试观察 `sst.bin` 被正确清理，并验证取消/失败后父目录、打开的 spool 和输出仍归原 owner 管理。actual 回读夹具给临时输出加入合法共享字符串表和引用；内容不匹配仍由既有摘要检查拒绝。

取消 UI 探针使用 `sendInputEvent` 的鼠标与完整键盘事件，没有用 DOM `.click()` 证明模态可访问性。覆盖导入对照、运行鼠标/键盘、结果/原表/管理导出、双层删除、保留结果删除、发布保护、晚到取消响应。初次探针的 Enter 事件不完整及不可克隆函数返回值已在验证脚本修正；未改变产品键盘逻辑规避失败。

## 检查与保留边界

- 各修复源码 eslint / diff check 通过。check-vars：PR1b 的辅助状态局部 `state`、PR5 的 renderer 局部 `dialog` 属于通用同名；原全局 renderer 状态和 Main 原生 dialog 没有因本轮修复改变。PR2 / PR3 / PR4 无重要变量命中。
- 保留原 Task 终态、收据、版本与取消后的用户选择。终态矛盾只保留证据和保护，不能自动将失败改成功。
- 远端 PR231—235 已追加各自修复及本轮专项证据；PR236 汇总包含全部变更。当前 CI 必须按最新 head 查询，原绿色历史运行不代表修复后的 CI。
- PR236 代码基线 `b5f8a9d5` 的 Ubuntu BizOP 持久性合同检查已通过。PR232 的 Windows run `34027214509` 出现 1 项既有 `bank-bu-supervisor-e08-a.test.js:465` 事件序列失败，缺少 `receipt:mirror=1`。该用例及 Bank BU / Supervisor 实现在本轮未修改，夹具的执行期限为 5000 ms，远端此项耗时 11256 ms；这符合期限竞争的表现，但单凭日志不能确认根因。相同 PR2 head 下 Electron 单项 1 PASS，本地完整回归也通过。已重跑失败的远端 job，未改生产实现或放宽断言；Windows CI 尚不能记录为通过。
- Windows 目录耐久成功链、2200 万输入及最大结果并集、真实资金和 Excel/WPS 人工验收仍未完成。Windows unsupported 成功路径的 SKIP 不算验收通过；不开放生产或执行清旧。
- 原始本机记录保存在 `outputs/pr230-235-fixes-20260906/`；完整回归日志从 `/tmp/bizop-pr230-235-release-check.log` 归档。大型日志和生成文件不提交远端。

## 复跑入口

```bash
npm run release-check
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-export-sst.test.js
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/verify-ui-cancellation.js
```
