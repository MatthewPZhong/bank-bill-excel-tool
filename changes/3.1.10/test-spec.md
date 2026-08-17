# Test Spec — v3.1.10 VCC storage compaction

> status: apply
> created: 2026-08-16

## 1. 测试目标

- 保证计数、幂等、金额、九币种、结果/调整/归档事实不因瘦身改变。
- 保证原始文件血缘可验证、业务hold不可绕过、历史缺口显式可见。
- 保证copy-on-write迁移任一失败不破坏旧库，成功后物理缩小。

## 2. P0 必测场景

| 场景 | 输入/故障 | 预期 |
| --- | --- | --- |
| 纯成功导入 | 正常detail/system | slim effective+fallback；staging空；无anomaly；计数守恒 |
| 成功含异常 | 正常+invalid/format/conflict | 正常有效；异常compact记录；六类计数守恒 |
| 全幂等 | 全部同key同hash | 只增skipped_count；0 anomaly/0逐行audit/0按钮 |
| 冲突 | 同key不同hash | 保留旧effective；compact conflict含比较hash/diff |
| 同批首次冲突 | 同一批两个新文件同key不同hash | 两侧 anomaly 均保存对端 hash 和精确 diff；0 effective；不保存完整 raw |
| 取消/崩溃 | staging中断 | 有效数据不部分提交；staging清空；文件级failure一条 |
| 存档绑定 | 正确/错误SHA | 正确ready+hold+清fallback；错误拒绝且fallback保留 |
| pre-business handoff | A 已持久归档后同路径替换为 B | worker 首次 hash 后、建 batch 前拒绝；业务表 0 写；A artifact 不覆盖 |
| ready artifact 复用冲突 | 同 batch/path 但 expected SHA/size 不同 | 明确冲突，不返回 alreadyArchived，既有 Blob 保持 |
| 删除/retention | artifact有hold | 🔒不可操作；manual/unlock/retention均阻断 |
| 启动 hold 重建 | ready 后、bind/hold 前崩溃并跨 retention | outbox/owner 后先建 hold，再 cleanup；失败时 cleanup 不执行 |
| 释放引用 | 删除对应有效数据 | 最后引用释放hold；其他引用保持 |
| 异常明细 | 异常/失败/纯幂等 | 固定六列；前两者可导出；纯幂等无按钮 |
| 完整原表导出 | 全部artifact健康 | 当前effective逐行重建，行数/hash/Excel回读一致 |
| 历史部分导出 | 部分source unavailable | preview计数；二次确认；不完整文件名+说明sheet+缺失汇总 |
| 零覆盖 | 全部unavailable | 说明sheet；0数据；不得声称完整 |
| 完整性故障 | artifact/hash/row错位 | 整次失败，不降级部分导出 |
| SYSTEM_OP/v1 bound 完整性 | bound artifact failed/corrupt | 不得借 raw_json 降级；只有无 source 历史 v1 可走过渡导出 |
| SYSTEM_OP 临时 fallback | 新导入 source 为 pending/failed、从未绑定 artifact | preview 9/9 可导出；从 snapshot raw 完整重建；曾绑定故障仍禁止降级 |
| SYSTEM_OP 绑定后含已审计异常 | 同一 artifact 含有效主体与异常主体，record=`success_with_skips` | 只导出已提交有效主体；SHA/主体/hash/sheet/row 仍严格一致；异常主体不二次否决 |
| v3.1.9 降级写 | contract-v2 库由已发布旧连接打开 | 所有 VCC I/U/D fail-closed；新版连接正常工作 |
| v3.1.9 importing 升级恢复 | legacy import_rows 已分块提交后崩溃 | rolled_back/异常/六类计数守恒，旧正常宽行清理 |
| 多文件末次 SHA 失败 | ordinal 2 在读取后变化 | anomaly/source/六列文件名精确指向 ordinal 2 |
| 迁移空间不足 | statfs不足 | 不创建可切换新库；旧库不变 |
| checkpoint busy | WAL未收口 | 迁移拒绝；旧库不变 |
| copy中断 | 故障注入 | journal可恢复/安全重做；旧库唯一有效 |
| 切换窗口崩溃 | rename前/后/reopen前 | journal唯一判定；不双写、不误删旧库 |
| 切换后回滚崩溃 | `rolling-back` 已落盘后、失败候选移动后、备份恢复前 | failed path 可解释；旧 v1 备份恢复；失败候选清理；二启幂等 |
| 候选 ready 交接 | 复验后并发 mutation/主库 close 失败/ack 后 worker crash | ack 前源锁仍在；关闭失败 abort；未经完整握手不切换 |
| transition 交叉 | updater↔migration↔普通退出 | owner/token lease 互斥，错误 owner/token 不得释放他方 gate |
| recovery 删除耐久 | backup/sidecar 删除后再次崩溃 | DB dir fsync 后才 done；journal 删除后 fsync journal dir；二启幂等 |
| Windows 文件落盘 | 候选库与切换前主文件使用真实 Windows 文件句柄 | 文件以可写句柄 fsync，不因只读句柄 `EPERM` 跳过或中断耐久门禁 |
| 守恒失败 | 计数/hash/余额注入差异 | 切换前失败；旧库不变 |
| 成功迁移 | 代表全库 | IDs/结果/九币种/审计守恒；首次只读成功后按用户选择保留或删除旧库；二启幂等 |

## 3. P1 应测场景

| 场景 | 预期 |
| --- | --- |
| 多文件同source | source ordinal与row source精确，artifact分组读取一次 |
| 同名不同hash | 不误绑定；重试拒绝 |
| 同artifact多有效引用 | 一个hold owner释放不影响其他owner |
| 归档批次混合artifact | 任一业务hold阻断整批删除并解释原因 |
| fallback按需导出 | 未归档新行仍可完整导出；绑定后fallback归零 |
| v1过渡期重建 | 未归档fallback原样保留；ready+SHA/size匹配者清fallback并建hold |
| 历史exact binder | 只绑定flow+record+SHA唯一匹配；歧义保持unavailable |
| 迁移已有archive cleanup/outbox | 维护准入等待/拒绝，不吞待办 |
| 大文件流式导出 | 主进程响应、内存、输出行数与hash守恒 |
| dbstat目标 | 核心约4.3–4.6GB且下降>=75%，外部存档分列 |

## 4. 回归与人工

- 自动：计算、opening、调整、归档、解归档、result/opening/detail/system删除、历史导出、Archive manual/retention/retry、release-check。
- 环境：Windows installer/portable、UNC/网络盘/长路径、WAL checkpoint/原子切换、Excel/WPS。
- ⚠️ 资金人工：主体×九币种、有效行金额、冲突保旧、部分导出缺口、删除审计、artifact SHA/size和打开回读。

## 5. 执行顺序

1. schema与计数合同先Red/Green。
2. detail最小纵切，再system。
3. artifact/fallback/hold。
4. export/UI。
5. migration故障矩阵。
6. 扩大回归、性能、check-vars、release-check和人工门禁。

## 6. 本地自动化执行证据

- v3.1.10 扩大聚焦：313/313 PASS。
- 迁移共享错误协议与 COW 故障矩阵：33/33 PASS，其中 rebuild 11/11。
- `npm run lint`、全部 changed/new JS `node --check`、`git diff --check` PASS。
- `npm run check:vars -- --include-minor`：按设计 exit 2，仅 Important/Runtime review 命中，无 Critical/Risk-sensitive。
- 唯一完整 `npm run release-check`：lint/smoke PASS；unit 5165/5165（336 files）；integration 48/48 scripts、2385/2385 assertions PASS。
- 独立 Ultra Review：首轮确认 5×P1、4×P2；修后发现并修复 1×P1 A→B 时序；最终 PASS，无 surviving P0–P3，最终复核相关 198/198 PASS。
- 修后组合证据：migration 28/28+104/104；contract/recovery 116/116+32/32+5/5；archive 71/71+219/219；A→B 124/124+113/113+31/31；最终 unit 5191/5191、lint/smoke/node/diff PASS。
- 修后唯一完整 `npm run release-check`：lint/smoke PASS；unit 5191/5191（336 files）；integration 48/48 scripts、2385/2385 assertions（368077ms）PASS；runner 仅全绿后自动同步 policy。
- PR #147 首次 Windows CI 将 19 项失败归并为两个环境合同缺口：shallow checkout 缺冻结 `v3.1.9` tag（2 项）与只读文件句柄 fsync `EPERM`（17 项）；修复后本地聚焦 68/68、完整 release-check 5191/5191 + 48/48/2385 PASS。
- PR #147 首轮 review 两项 P2 均为真实合同缺口：新增 red tests 后 47/49；修复同批 peer evidence 与 SYSTEM_OP 临时 fallback 后，相关 detail/system/dataset/rebuild 91/91 PASS；最终 release-check lint/smoke、unit 5193/5193、integration 48/48 与 2385/2385（305367ms）PASS。
- PR #147 第二轮 Windows CI 唯一失败为测试 teardown 顺序：contract-v2 业务断言通过后，先删仍打开的 SQLite 报 `EBUSY`；修为单一 hook 中先 close current/legacy 连接再删除目录，生产 trigger 合同不变。
- PR #147 第二轮 review 两项 P2 先红 28/30；补齐 `rolling-back` durable path 与 SYSTEM_OP candidate 重建后，相邻 migration/import/export 67/67、lint/node/diff PASS。
- 第二轮 review 修后最终 `npm run release-check`：lint/smoke PASS；unit 5195/5195（336 files）；integration 48/48 scripts、2385/2385 assertions（304013ms）PASS；check-vars 0 命中。
- 尚未关闭：真实约 27GB 库迁移前后 `dbstat`、Windows installer/portable 文件切换与 WAL、主体×九币种及 artifact SHA 人工复核。
