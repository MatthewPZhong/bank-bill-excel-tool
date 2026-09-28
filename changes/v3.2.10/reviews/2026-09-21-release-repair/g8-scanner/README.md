# G8 扫描职责修复证据

本目录记录 release 审查 R2 的扫描规则修复，受验代码仍在 `release/v3.2.10` 工作区；没有提交、推送或修改生产 `src/`。配置与 Renderer 规则由其他修复切片共同完成。本目录的专项 PASS 不替代最终完整 release-check。

## 规则修复

- **G5 查询读取职责**：移除“require 可达整个模块就视为其所有函数都被读取协调器执行”的扩大判断。从实际保护作用域跟踪具名导出、CJS/ESM 转发、本地函数、工厂返回成员、类构造器/实例方法及真实调用的参数能力。同步 helper 的函数、对象成员、返回回调均传播到真实被调用能力；未执行的 policy 回调不会自动变成事实读取。
- **副作用与未知目标**：require/import 的顶层副作用仍检查；require.resolve 仅解释路径。仅依据绑定到 node:worker_threads 的 isMainThread 条件区分 Main 导入常量与实际 worker 启动，worker 启动后的分支和回调继续检查。最终 callee 的未知动态成员失败关闭；receiver 的动态数据索引不等于动态调用名。静态默认值/调用实参的方法名字面量继续准确解析。
- **G2 通用任务**：全文件公共 executor 的 Position 依赖闭包保护保留。Main 具名编排按实际调用职责追踪，不把同一 composition 中未执行的领域注册当成执行器直接调用。仅在已有准确 allowedSite 位置收口授权装配，普通 helper、返回函数及参数转发不能取得 Position 私有能力。
- **G7 显式装配**：支持同一 composition 按目标分别登记具名导出，不能用其他目标的名字相互授权。只在 const namespace 的全部使用均可解释为具名静态读取时确定 importedNames；整对象转交、动态成员和 namespace 突变仍拒绝。
- **Renderer 基础事实解析**：识别直接 UMD IIFE 的真实 global 参数、无参内联 IIFE 的确定末尾导出、静态对象/数组 spread；不把任意 helper、局部同名对象或未知 spread 当成合法完整能力。Renderer 的具体授权字段、生产装配与独立反例见相邻 Renderer 修复证据。

## 回归和独立复验

新增 `tests/unit/architecture/release-closure-regressions.test.js` 的 15 套正反例覆盖上述边界。首次独立复核发现的 imported/returned/object callback 传播遗漏已修复；原 7 路和新增 call/apply/bind、嵌套解构、identity 返回等 5 路均有真实 SQL 执行并被规则拒绝，仅注册而未执行回调的对照保持通过，独立日志见 `../independent-review/`。

- [架构专项日志](architecture-tests.log)：170/170 PASS，0 fail、0 skip。
- [真实 CLI 日志](architecture-check.log) / [完整 JSON](architecture-check.json)：765/765 解析，31 active，0 pending / partial，0 诊断、0 失效历史例外。报告中的 2 个未解析路径与 33 个动态点仍保留事实计数，由精确生成/加载合同解释，不是漏文件。
- [目标 lint](lint.log)：exit 0，空日志表示无诊断。
- [命令结果和受验 SHA-256](verification.json)。原第一次 CLI 误用相对 JSON 路径被参数检查拒绝，随后使用绝对路径成功；未将参数错误计为业务测试 PASS。

这套分析器提供有限静态合同证据，不执行任意业务模块，不证明任意 JavaScript 语义、真实 Main 恢复、GUI 或 Windows/Excel/WPS 验收。
