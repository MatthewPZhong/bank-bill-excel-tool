# release/v3.2.10 审查修复记录

起点：`9a38b96b1b8006c5851535d0c1e586bbaeb63f10`；依据为[原独立审查](../2026-09-21-release-review/review.md)及其冻结证据。用户明确授权修复 R1/R2。本次在原 release 独立工作区工作，原审查文件保持；不提交、推送、升版或发布。

## 决策与范围

- R1 按 G3 原 submitted/cancelled 合同修复具体弹窗句柄的提交关闭；关闭被拒、句柄过期时禁止后续业务。覆盖真实 controller、确认框、bridge 和 host，不改金额或对账算法。
- R2 按 G1–G8 已有合同对齐机器登记，精确区分模块依赖与实际调用职责。公共模块仍禁止反向依赖领域；Main 具名编排和 BizOP 事实读取跟踪被调用能力，不能把仅为注册而导入的整域仓储当作执行。
- G7 显式装配按源文件、准确目标及导出登记；不开放整个领域目录。G1 授权 worker 的 execute-recovery 与旧 recover 均受保护，准确允许位置由既有授权流程和测试支撑。
- 激活需要真实入口、消费者、对应行为测试和旁路负例；不因文件存在就宣布通过。失效历史例外逐项收缩，保留固定基线及历史防倒退。
- 使用 implementation-notes 保存决定与证据；blindspot-pass 核对合法路径、旧测试漏洞、授权旁路和配置弱化。

## 分工

- R1：bank-statement controller 与真实组合回归。
- G8 调用分析：query/task/composition 规则和回归。
- Renderer 机器合同：实际工厂、参数、API、DOM 来源与保护测试。
- 主任务：其余机器配置、授权恢复登记、证据与最终组合验证。

## 当前证据与剩余项

- R1 四条用户路径已在修复前重新复现，原审查保持不变。
- R2 修复前 CLI exit 1：2195 诊断；见 architecture-before.json / architecture-before.log。
- 原审查 24 文件及主工作区 865 个 dirty 文件的保护清单见 input-preservation.json。
- R1 真实宿主单测 31/31、相关专项 94/94、隔离 Electron 确认流程 27/27 通过；原四条阻断路径及关闭被拒路径已覆盖。
- G8 全套架构专项 170/170、目标 lint 通过；最终 CLI 为 765/765 解析、31 active、0 pending/partial、0 诊断、0 stale。精确动态加载登记迁移绑定原 commit/blob，目标集不扩大。
- 独立探针发现的执行 callback 与 Renderer authority/mutation 漏检均已修复，最后冻结后复验 12 条 SQL 旁路与 5 条 Renderer 越权均被拒，合法对照仍通过。各次原始证据与旧版对照均保留。
- XLSX 聚合入口仅改为从中性模块取得原 helper，完整导出名称与引用身份兼容测试 11/11 通过。
- 最终完整 release-check PASS，exit 0；8944 单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过，有计数合计 2901/2901。真实 Electron Renderer 生命周期 233/233。冻结 1698 个代码、配置及测试输入均保持，HEAD 未漂移。
- 原审查 24 文件、主工作区 865 个 dirty 文件交付前 SHA-256 全部保持。集成策略清单由成功 runner 自动更新；本次没有提交或推送。详见 repair.md / verification.json。
- 真实产品 Main 全流程、Windows/安装包、Excel/WPS 和既有 G3 资金人工复核不由本轮自动验证替代。
