# R10 修复增量盲点复核

结论：按声明函数隔离参数绑定后，同一组 6 个 VM/静态正反例全部 **6/6 符合预期**。初补丁曾发现 1 个参数词法作用域混淆，表现为 1 个新增误报和 1 个既有漏报；这两个具体反例已关闭。最终复验对应 `results.json` 中记录的工具 hash，初补丁证据保留在 `preliminary-results.json`，不代表后续修改状态。

最终六例重放已覆盖主 Agent 补齐 `mergeIdentities` 的不确定数组来源并集与非空证明交集之后的字节：`scripts/architecture/renderer-contracts.js` SHA-256 为 `dd34f594f57d0d5d6f33944bed80802d50b4712077e9f4dba1f205d93b19dbb7`。结果仍为 6/6：3 个安全例全部 0 诊断，3 个越权例各 1 条 scope；这次只重放原六例，未追加检查范围。

范围仅为 `renderer-contracts.js` 新增的工厂参数环境、单调用 helper 来源推导和 literal spread 身份传播。使用合成对象和临时 fixture，没有读取真实业务数据，没有修改 source、tests、产品文档或已有历史证据，也没有运行全套测试。

### [已关闭，原 P2] 外层工厂和内层 helper 的同名参数共用名称槽位

- **初补丁事实**：`parameterValue` 确认声明函数 frame 存在后，仍从 `env.get(chain[0])` 读取参数。`make(value)`、`helper(value)` 的 frame 都保留，但进入 helper 后名称 `value` 已被 helper 实参覆盖。`retain()` 中的 `value` 绑定在 `make`，运行时应读取 make 的参数。
- **事实**：下列代码中，VM 证明 alias 是 `current.api`，且最终注入对象含可调用的 `outsideScope`；初补丁静态扫描返回 0 诊断。

```js
function make(value) {
  function retain() { return value; }
  function helper(value) { return retain(); }
  const args = [];
  args.push(helper(old));
  return args;
}
const list = [...make(current)];
const alias = list[0].api;
alias.outsideScope = window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({ api: current.api });
```

- **事实**：将调用改成 `helper(current)` 和 `make(old)` 后，VM 证明只改写 `old.api`，最终注入的 `current.api` 只有 `run`；初补丁却产生 1 条 `ARCH-RENDERER-SCOPE`。
- **修复前分类**：按修复起点 `input-manifest.json` 校验全部 checker 字节后重跑同组探针。越权版本 before/初补丁均 0 诊断，为既有遗漏；合法版本 before 为 0、初补丁为 1 条 scope，为本轮新增误报。不能据此声称词法绑定缺陷始于本轮。
- **推断**：frame 集合证明哪些函数存在调用上下文，不能证明名称槽位属于哪个参数声明；需要按声明函数和参数名隔离绑定。
- **影响**：合法的闭包参数引用会被误判；通过数组传播的同对象越权改写仍可能漏过静态门禁。
- **证据**：`probe.cjs` 中 `lexical-capture-shadow-safe` 与 `lexical-capture-shadow-unsafe`；`results.json`、`preliminary-results.json` 和 `before.json` 同时保存源代码、VM 对照、诊断和工具 hash。
- **最便宜验证**：修复后重跑同一 `probe.cjs`，要求两例分别 0 诊断和 scope/coverage，VM 身份结果保持原样。
- **处置**：已覆盖。主 Agent 按声明函数建立私有参数绑定表，内层同名参数不再覆盖外层声明绑定；同组复验确认安全版本 0 诊断、越权版本 1 条 scope，VM 身份结果未变。

## 六例结果

| 例子 | VM 注入对象越权 | 修复起点诊断 | 初补丁诊断 | 最终复验诊断 | 最终是否符合预期 |
| --- | --- | --- | --- | --- | --- |
| shared-helper-independent-safe | 否 | 0 | 0 | 0 | 是 |
| shared-helper-independent-unsafe | 是 | 0 | 1 scope | 1 scope | 是 |
| lexical-capture-shadow-safe | 否 | 0 | 1 scope | 0 | 是 |
| lexical-capture-shadow-unsafe | 是 | 0 | 0 | 1 scope | 是 |
| sibling-factory-local-helper-safe | 否 | 0 | 0 | 0 | 是 |
| sibling-factory-local-helper-unsafe | 是 | 0 | 1 scope | 1 scope | 是 |

已反证的候选问题：同一个单调用 helper 在工厂的两次实例中没有把 old/current 混合；两个 sibling 工厂各自声明同名局部 helper 时，两个安全/越权对照都符合预期。

本组范围内未发现仍会改变本轮方案的存活问题。主 Agent 将这 6 例固定为正式回归；未验证任意递归、多文件工厂、全部动态 JavaScript 或产品 GUI，本文不对这些范围作结论。

## 重现

在 release worktree 根目录执行：

```sh
node changes/v3.2.10/reviews/2026-09-23-release-r10-repair/r10-adjacent-review/probe.cjs
python3 changes/v3.2.10/reviews/2026-09-23-release-r10-repair/r10-adjacent-review/compare-before.py
```

第一条读取当前工具，输出结果到 stdout；第二条只在临时目录复原已冻结起点工具并验证 hash，将同组结果写入本目录 `before.json`。初补丁冻结输出保留在 `preliminary-results.json`，本轮最终复验输出为 `results.json`；后续复验应写新文件。
