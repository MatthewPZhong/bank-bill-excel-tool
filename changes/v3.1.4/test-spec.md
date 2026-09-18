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

- 三份调拨：行级预检预期 filter 3 / 2 / 1；第三份因另 1 行付款成功缺金额触发硬错误，
  最终整文件拒绝、0 行提交且不发布该文件的过滤报告。
- 三份测试付款：预期 filter 197 / 181 / 26。
- 核对正常候选 row hash、金额、币种、方向、link leg 和严格 1:1 结果不变。

## Formal Closeout Evidence

- PR #114 已以 merge commit `1e5dfc697f043a83ef4881843fd6a284ff31e6d2`
  合入 `main`；最终实现 commit 为 `836dc5d1db975c0bee69d83ea1f22a79e91b0639`。
- PR 全部 review 线程已关闭；Codex 对最终 commit 的复核未发现 major issue，未留下
  P3 或更高 Finding。
- 最终实现门禁：lint、smoke、unit `4481/4481`、44 个 integration 脚本
  `2051/2051` 全部通过；报告依赖、部分成功、重复 owner、报告计数和主进程 pending
  持久化定向回归 `200/200` 通过。
- `main@1e5dfc6` 的 Windows Build workflow
  [run 30697133308](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30697133308)
  已完成 smoke、主页面对齐、Windows Setup/portable 构建、包体检查和更新资产暂存。
- 发布准备分支使用 Node `24.13.0` 重新执行 `npm run release-check`：lint、smoke、
  unit `4481/4481`、integration `2051/2051` 全部通过，integration 总耗时 297,909ms。
- `npm run verify:main-panel-alignment` 首次在桌面沙箱内因 Electron 无法启动返回
  `electron exit null`；沙箱外按真实 Electron 路径重跑，两种窗口尺寸和三种缩放
  `6/6 PASS`。
- `scan:vars` 为 263 个源文件、3,322 个顶层名称；发布准备未修改 `src/`，
  `check:vars -- --include-minor` 安全跳过。
- `npm audit --omit=dev` 为 7 high、2 moderate、0 critical；依赖治理不混入发布收尾。
- 2026-08-01，业务负责人确认 Spec 13.3 五项资金判断并批准技术发布；不可变批准副本见
  [PR #115 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/115#issuecomment-5151496159)。
- Windows 10/11 候选 Setup/portable/SmartScreen 验证和候选安装包 `v3.1.3 → v3.1.4`
  离线覆盖 canary 尚无实测证据；发布负责人已通过
  [PR #115 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/115#issuecomment-5151827405)
  单独豁免 tag 前门禁。测试结论保持“未执行”，两项转发布后人工跟进。
- Windows 打包环境的大报告恢复及进程硬退出/文件锁/存档重试仍为发布后人工跟进；
  技术发布状态不得解释为这些实机演练已通过。

## Release Result

- annotated tag `v3.1.4` 指向 `main@14a9ce9de1d5607fe3c4dc58ae3adf81defef611`。
- Windows Release [run 30703982194](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30703982194)
  的 unit 汇总为 `4478/4481 PASS`、2 fail、1 skip；两项失败都是 test hook 的
  `EBUSY`，不是资金或产品断言失败。
- 失败原因是 Windows 不允许删除仍由 `PositionReconciliationStore` 打开的
  `position-data.sqlite`；macOS 允许 unlink 已打开文件，因而发布前本地门禁未暴露该问题。
- workflow 在构建/发布前停止，未创建 GitHub Release 或公开资产；恢复验证与正式资产发布转入 v3.1.5。
