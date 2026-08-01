# v3.1.4 Test Spec

## 行分类

- 调拨非付款成功且金额/币种证据不完整 → filtered / `FT_NON_SUCCESS_EVIDENCE_INCOMPLETE`。
- 调拨付款成功缺证据 → hard error / 整文件拒绝。
- 测试付款缺源金额或源币种且目标金额/币种合法 → filtered / `TEST_PAYMENT_SOURCE_EVIDENCE_INCOMPLETE`。
- 测试付款目标金额/币种、业务键、日期异常 → hard error。
- 网关和账户来源行为与 3.1.3 一致。

## 文件与批次事务

- 混合文件满足 `physical = accepted + filtered + duplicate`。
- 第一条 filtered 不终止扫描，报告包含最后一条 filtered。
- 同文件和跨文件 accepted/filtered 业务键碰撞均拒绝过滤文件，且文件选择顺序不影响结果。
- 库内已有正常业务键时过滤文件 0 修改；其他成功文件不回滚。
- 全量过滤文件提交 0 source/link、N tombstone，提升 source revision。

## 墓碑与报告

- 同精确异常重导关闭旧活动墓碑并产生新审计记录，活动唯一。
- 正常记录导入解除同来源/业务键活动墓碑。
- 报告包含汇总、对应来源明细、全部原始列、文本格式 ID；超上限拆 sheet。
- 报告生成/哈希/归档意图失败时禁止相应过滤文件提交。
- 导入立即导出与存档 artifact 的 SHA-256 相同。

## 运行与结果

- 必要来源在目标月有效行 0 且有活动墓碑 → `position-source-all-filtered`。
- 部分过滤仍直接运行并自动打开既有结果确认弹窗。
- run 冻结墓碑 ID、报告引用和 source revision。
- “过滤数据导出”无数据禁用、有数据合并且按冻结 tombstone 去重。
- 过滤导出不设置 `exported_at`；普通导出/回导门禁保持。
- 报告丢失或哈希错误时过滤导出与最终确认失败关闭。

## 真实文件

- 三份调拨：预期 filter 3 / 2 / 1；第三份因另 1 行付款成功缺金额整文件拒绝。
- 三份测试付款：预期 filter 197 / 181 / 26。
- 核对正常候选 row hash、金额、币种、方向、link leg 和严格 1:1 结果不变。
