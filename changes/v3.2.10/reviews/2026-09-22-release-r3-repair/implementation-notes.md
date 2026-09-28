# 第三轮 G8 修复记录

依据：[第三轮审查](../2026-09-22-release-rereview-r3/review.md)。复用现有 release worktree 和未提交修复；原有文件冻结 SHA-256，计划修改的检查器和说明另外按字节备份到 before/。不修改业务生产源码，不提交、推送或发布。

## 决策与验证

- 沿用 implementation-notes / blindspot-pass，按 RR3-01～05 补充原反例及合法对照，不用全套 PASS 代替反例验证。
- 未知长度数组 spread 不能决定后续索引位置：保留位置不确定性，受保护调用无法确定目标则报 coverage。
- 有对象 AST 身份的嵌套成员也执行变更和逃逸检查；对象构造本身作为实参要与已构造对象的别名逃逸分开，避免误报现有合法工厂输入。
- 属性描述使用无原型字典；computed 自有 __proto__ 与真实字面量 prototype setter 分别处理。
- 数据字段按实际路径 config.initialBillCategory 检查；保留正常字符串和 app:get-info 来源。
- G1 使用实际调用闭包代入静态容器/参数/返回值，比较最终恢复函数身份；准确授权位置仍是停止点，不能扩展成 prepare 的许可。
- 先运行新增回归和全部架构专项，原样复验真实配置探针；最终候选再运行完整 release-check，保留输入和工作区保护证据。

## 进展与补充决定

原 Renderer 探针中 factory_return_alias 仍有漏报，已作为同类对象身份问题一并关闭，新增 1 项（两种 mutation）回归。用函数返回描述缓存避免重复遍历 AST；缓存按本次 analysis 身份隔离，不跨扫描复用。最终新增回归 33 项，在修复前字节副本上 26 FAIL / 7 PASS；修复后与 RR2 合计 67/67。架构专项 237/237，通过实际配置。

完整门禁于 2026-09-22 01:45:20–02:09:31（Asia/Shanghai）完成，1700 个冻结输入及 HEAD 未漂移；9011 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过（有计数用例合计 2901/2901）。792 个 src/ 文件、135 个既有审查/修复证据、2 个架构 JSON 和主工作区 865 个 dirty 文件全部保持。最终证据见 repair.md / verification.json / preservation-final.json。
