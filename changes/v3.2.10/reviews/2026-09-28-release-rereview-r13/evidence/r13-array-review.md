# R13 数组 helper 的限定回归复核

**RR12-01 在本次限定 fixtures 范围内可关闭，未发现新的高置信问题。** 准确 before 中 10 个 `RangeError` 在当前分析器中全部消失：7 个违规例各产生 1 条 scope 诊断，6 个安全例零诊断，1 个已记录的保守拒绝保持 1 条诊断。未捕获原始 helper 探针当前正常 exit 0，并输出 scope 诊断。

工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10`。按最新收窄指令，仅重放 R12 审查的 8 个已有 fixtures，再使用现有 `tests/unit/architecture/release-rereview-r12.test.js` 中对象参数、解构参数和单层嵌套调用的 6 个已有正反 setup；验证脚本断言这 6 个 setup 原样存在于该测试文件，没有新增任意语义枚举。

没有修改生产源码、仓库测试、配置或历史证据。未运行正式 CLI、全架构测试、release-check，也未增加实际 20 Renderer 边界扫描；当前采用原归档探针的最小配置，仅复用真实 BankStatement allowedApiFields。完整配置核验与其他范围由主审及另一位审查者负责。

## 结果

| Fixture | VM 同注入对象 / 额外方法 | before | current |
|---|---|---|---|
| receiver-alias-reorder | true / true | 1 条诊断 | 1 条诊断 |
| helper-reorder-after-write | true / true | RangeError | 1 条诊断 |
| helper-write-and-reorder | true / true | RangeError | 1 条诊断 |
| helper-reorder-before-write-safe | false / false | RangeError | 0 条诊断 |
| overwritten-before-reorder-safe | false / false | 1 条诊断 | 1 条诊断（保守拒绝） |
| last-write-before-reorder | true / true | 1 条诊断 | 1 条诊断 |
| helper-write-after-reorder-safe | false / false | RangeError | 0 条诊断 |
| captured-before-later-reorder-safe | false / false | 0 条诊断 | 0 条诊断 |
| object-parameter-write-then-reorder | true / true | RangeError | 1 条诊断 |
| object-parameter-reorder-then-write | false / false | RangeError | 0 条诊断 |
| destructured-parameter-write-then-reorder | true / true | RangeError | 1 条诊断 |
| destructured-parameter-reorder-then-write | false / false | RangeError | 0 条诊断 |
| single-nested-helper-write-then-reorder | true / true | RangeError | 1 条诊断 |
| single-nested-helper-reorder-then-write | false / false | RangeError | 0 条诊断 |

`RangeError` 保存在 JSON 的 `scanError`，不被计为零诊断。当前 14 个 fixture 均无 scanError；`r13-array-verify.cjs` 对 before 异常、current 诊断、VM 同对象关系、额外方法存在性、保守拒绝以及原始退出进行显式断言，输出 PASS。VM 只执行 synthetic source 和 mock API/factory，不访问网络、真实文件数据或实际业务 IPC。

`overwritten-before-reorder-safe` 的保守拒绝单独保留：先向槽位写 clean、再覆盖 old、然后重排，当前仍收集所有重排前可见写入。它在 before/current 均被拒绝，属于已记录限制，不计为新的误报，也不冒充安全代码合法通过。

## 实现及合同核对

当前数组解析在只比较接收者身份时先保留分配位置/调用环境，并通过私有延迟元素读取，在真正访问内容时保留原 depth/visited 求值链。原 `sameObject → spread → helper 参数 → sameObject` 的循环不再因身份比较提前展开数组内容。参数绑定与执行先后使用同一唯一调用入口，已有限验证先写后重排和先重排后写的正反结果。

依据：R12 repair/repair.md；G8 Spec AC-05 及 §6 的可操作诊断合同；G8 TechDoc §4.4 的 R12 段落（当前第130行）及 architecture/README.md 的 R12 支持边界。结论只证明上述普通有限 helper/数组 fixtures，不扩展为所有 JavaScript 静态解释、任意动态调用或整个 release 验收。

## 准确 before/current 与自举

- before：`changes/v3.2.10/reviews/2026-09-23-release-r12-repair/before/scripts/architecture/renderer-contracts.js`，SHA256 `6b57b228b5fb576bbd3ea40d42ff010c5414c1a6a96fb7efdc6aba92fd2c2bec`。
- current：SHA256 `f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082`，匹配 R13 冻结清单。
- scan/contracts/rules/schema 四共享工具匹配 repair 起点及当前冻结清单；两份机器配置 hash 前后相同。
- 793 个 src/* 与 index.html 文件逐一核对前后清单和当前字节，0 mismatch。

`r13-array-compare.cjs` 每次从上述 repo before 目录重建临时工具树，检查 hash，链接当前 node_modules，运行同一 fixture，最后清理临时工具树。所有 fixture/probe 的相对 require 使用脚本自身目录，不依赖 R12 或任何旧 /tmp 工具目录。读取 archive 的最终断言脚本也已再次执行成功。

## 执行命令

每条命令的工具 workdir 均为本报告开头的 release worktree：

```sh
node /tmp/r13-array-compare.cjs r13-array-original-probe.cjs minimal > /tmp/r13-array-original-before-current.json 2> /tmp/r13-array-original-before-current.log
node /tmp/r13-array-compare.cjs r13-array-finite-probe.cjs minimal > /tmp/r13-array-finite-before-current.json 2> /tmp/r13-array-finite-before-current.log
node /tmp/r13-array-capture-raw.cjs
node /tmp/r13-array-verify.cjs > /tmp/r13-array-verification.json
```

原始子进程的实际 cwd、命令、status=0 和 signal=null 见 `r13-array-raw-helper-exit.json`；stdout 是未捕获探针的完整正常诊断，stderr 无 RangeError。

本轮 evidence 中保存同名文件，重放时把命令的 `/tmp/` 替换为 `changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence/`。参数中的 probe 文件名仍为 basename，保持所有脚本处在同一目录，cwd 仍为冻结 worktree。实际从归档路径运行过 verify 断言，结果见 `r13-array-archive-replay.json`。

## 文件

- 9 个脚本：original-cases、original-probe、finite-cases、finite-probe、compare、raw-helper-cases、raw-helper-probe、capture-raw、verify（均有 r13-array- 前缀和 .cjs 扩展名）。
- original-before-current.json/.log、finite-before-current.json/.log。
- raw-helper-exit.json、raw-helper.stdout、raw-helper.stderr。
- verification.json、archive-replay.json、本报告。

本轮结果为 14 个已有 fixtures 的独立复核，未声称新增 14 个正式仓库测试。
