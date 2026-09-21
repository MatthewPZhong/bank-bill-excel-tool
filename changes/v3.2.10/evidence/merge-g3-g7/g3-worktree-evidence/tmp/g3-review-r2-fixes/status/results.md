# RR02 状态读取恢复反馈整改证据

本轮只修改两个领域控制器与其既有行为测试；代码位于 `codex/v3.2.10-renderer-boundaries`，HEAD 为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，全部改动未提交。

实现状态：已实现并冻结本目录 after-snapshot.json 列出的三个文件。验证状态：专项通过。集成状态：未提交、未合入 release；主 Agent 负责最终组合验证及实施记录。

## 修前与修后

| 执行 | 修前 | 修后 | 证据 |
| --- | --- | --- | --- |
| 用户独立 7 项审查探针 | 5 PASS / 2 FAIL，exit 1 | 7 PASS / 0 FAIL，exit 0 | before-probes.log / after-probes.log |
| 控制器反馈矩阵 | 61 项：41 PASS / 20 FAIL，exit 1 | 61 PASS / 0 FAIL，exit 0 | before-regression.log / after-regression.log |
| 相称组合：本矩阵 + 真实 Main 路由 + service + 银行进度 + 状态展示 | 本轮未跑修前组合 | 164 PASS / 0 FAIL / 0 skipped，exit 0 | focused-regression.log |
| 三个变更文件 ESLint | — | exit 0，无警告 | lint.log |
| git diff --check | — | exit 0 | diff-check.log |

每个日志的同名 `*-command.json` 记录精确命令、cwd、退出码和耗时。组合测试包含本矩阵，不相加为独立用例总数。原用户 review、独立探针及历史 tmp/g3-review-fixes 未修改。

## 五项实施事实

1. **职责与边界**：`src/renderer/controllers/bank-statement.js` 和 `recon-id-fix.js` 私有持有最后业务反馈与仍占据状态框的 session 读取错误恢复快照。sessionStatus 失败仅临时覆盖展示；有效成功后撤回该覆盖，数据/按钮资格仍由 Main 状态决定。`updateStatusBox` 的正常业务、进度、其他读取反馈写入会使旧恢复资格失效；raw DOM 写仍受本控制器 active/generation 保护。未增加导航壳、另一领域的状态读写权限。
2. **调用方与兼容**：公开构造、`enter/leave/invalidate/dispose/refreshStatus`、commands、scoped API 和 sharedReconSession 接口不变。生产调用仍由 `src/renderer.js:492/498` 装配、`:544` 路由场景通知、`:545` 重读 Recon 列表，模块 router 执行 enter。预览现有 facade 不变。没有新增兼容转发或待迁调用方；既有进度/状态测试验证相同入口。
3. **业务行为**：按 G3 Spec §4 的进入同步及保留已有成功/欢迎反馈合同修复 RR02；按 §5 保留 scope 失效范围。确定失效或 Main 已无结果时仍重新生成事实反馈，不能从错误快照恢复已失效导出。R9 不确定重同步中 Main 仍保留的另一域结果/导出继续保留。读取失败/迟到不能伪造业务成功、不能清其他域、不增加 IPC 写入。
4. **验证证据**：新增 26 项 RR02 行为回归，其中 20 项修前失败、修后通过；原 35 项 R03/R05 完整保留。真实 controller + 当前 Main AST handler + 真实 Preload 场景/渠道映射 + 内存 SQLite 仓储验证失效；sessionStatus 故障通过 scoped API 受控注入。进度、导出响应和 UI 记录为测试替身，不读写真实业务文件。当前相称组合 164/164。独立探针 7/7 单列，不冒充全部平台验收。
5. **当前规则入口**：`src/renderer/README.md` 应用壳/领域控制器及场景共享会话章节、G3 Spec §4/§5、现有 TechDoc 仍为入口。本次没有调整公开职责、生命周期接口、数据/金额/输出合同或 G8 激活配置；仅实现已有恢复约定，无需修改这些规则正文。主 Agent 负责在总实施记录关联本证据，按任务约束本 Agent 不改 README/notes/TechDoc。G8 仍未集成，未增加例外。

## 新增 26 项矩阵

| 场景 | 数量 | 保证 |
| --- | ---: | --- |
| 两域可见确定失效后 failed / reject，离开重入成功 | 4 | 清当前读取错误且不恢复已失效导出；未命中域保留 |
| 两域 welcome / export 前置反馈后静默恢复及再导航 | 4 | 恢复原有效反馈，后续无错误导航不重复写状态框 |
| 两域连续两次读取失败后恢复 | 2 | 保存原业务成功，替换最新读取错误 |
| 两域在途导出在错误后成功 | 2 | 新成功取代旧错误标记，恢复不回放旧导出 |
| Bank gateway / Recon 场景列表错误占据状态框 | 2 | session 成功不得误清另一读取的错误 |
| R9 重同步的实际未命中结果域遇到读取故障 | 2 | Main 有效结果与导出反馈保留 |
| 两域快进出旧 ok / failed / reject 晚到 | 6 | 旧代次不覆盖已恢复的新页面 |
| 两域并行刷新较新失败、较旧成功后到 | 2 | 旧成功不撤回较新错误，后续有效成功才恢复 |
| Bank 较新导入进度 / Recon 列表主动业务展示更新 | 2 | 正常更新使旧错误恢复资格失效，不覆盖新内容 |

已有 35 项继续覆盖 Recon import/run/export 成功、失败、取消、异常后 disabled；无合法场景仍禁用；隐藏域的批删、导入、单类新增、双向 R9 resync、仅关闭、失败、渠道变化；隐藏确定失效遇到第一次读取失败后重试仍清旧导出。

## 限制与回退

本轮未运行 full unit、integration runner、release-check、Electron GUI、真实产品 Main 启动、Windows/Excel/WPS/安装包；没有重试历史资源拒绝。RR02 专项通过不等于 release-ready。回退只需按 rr02.patch 与 before-snapshot.json 恢复本轮三个文件对应差异，不能覆盖其他 Agent 后续改动。

## 冻结 SHA-256

- `src/renderer/controllers/bank-statement.js`: `9514f9f522c3147d875e912620b22171ad56caac255ce98a20d13ddce7e6e2aa`
- `src/renderer/controllers/recon-id-fix.js`: `932c3c417722d25461c235f96907bc536301a1a3e5f19701ac54f7e65e1280a9`
- `tests/unit/renderer/scenario-controller-feedback.test.js`: `cb5c20c26ea4257cafaf256978a55220dbe260879f0b22b776d3d3f5b12c7403`
