# v3.1.7 Test Spec

## Unit

- 调拨 builder：新增 `付款方式`、`是否被使用=''`，in/out 行字段和行数守恒不变。
- Payment：派生行筛选、付款账号与 `Drawee CardNo`、空 ReconID、三轮匹配、消费标记和回填前快照。
- 日期：单周前一整周、多连续周动态区间、同周多日期取最早、左右边界、跨年、断档阻断。
- R5s2-recon：跳过已使用派生行、排除 Payment 银行行、同值仍消费、in/out 独立。
- 编排器：Payment 强制派生来源且先于 R5；Payment 关闭路径 parity。
- Writer：三个核对 sheet 名称、派生表头、银行原始快照、命中/未命中结构不变。

## Integration And Sample

- 固定样本输出：命中 192、未命中 1,639、Payment 三个核对 sheet 各 220。
- 运行失败：订单周断档时无 Payment/R5 modification、无可导出 processing result。
- 旧结果失效：新一轮运行开始即清空上一轮 processing result，任何预检失败都不能继续导出旧结果。
- 运行态重置：连续两次运行结果一致，数据库派生表“是否被使用”保持空值。

## Release Gates

- 聚焦 unit/integration。
- `npm run release-check`。
- `npm run scan:vars`、`npm run check:vars`。

## 业务启用门禁

- 固定样本 220 条 Payment 配对及 2 条 R5 回填必须由业务逐笔复核；技术 Release 不解除该门禁。

## 正式收尾证据

- PR #121 最终实现提交 `73c35a3f2b8ea2b7cc69e94bc1c44ae641c4cbe6`，squash merge commit `6fe118b8c4d665e1ce877fb792e6a4bbcda64cdf`。
- 合并前和正式收尾复查均无未解决 P3 及以上 Finding。
- 合并后 Windows Build run `30794912210` 成功，覆盖 smoke、SQLite teardown、主页面布局、Setup/portable 构建、包体检查和 updater 资产暂存。
- 2026-08-03 干净依赖 `release-check`：unit 4,575/4,575，integration 44 个脚本 2,051/2,051，lint 与 smoke PASS。
- 主页面布局 6/6 PASS；变量扫描为 282 个 JS 文件、3,526 个顶层声明。`check-vars` 命中 `processingResult`、`app`、`state`，均已按清单核对并由运行结果失效测试、完整 smoke 和 UI 回归覆盖。
- 固定样本正式收尾回放再次得到 Payment 220（R1=218、R2=0、R3=2）、Payment 改写 190、R5 改写 2、命中 192、未命中 1,639，并保持 220 条付款账户完全相等。
- 生产依赖审计为 0 critical、7 high、2 moderate；本次资金发布收尾不混入依赖升级。

## Release 验证

- tag 必须为 annotated `v3.1.7`，且 peeled commit 等于创建时最新 `main`。
- tag、`package.json.version` 和 `latest.yml.version` 必须一致。
- Windows Release workflow 的 main/tag 校验、完整 release-check、布局、构建、包体、资产暂存、发布和公开回读必须全部成功。
- GitHub Release 必须为 latest、non-draft、non-prerelease，并且只发布一套 Setup、Setup blockmap、portable 和 `latest.yml`。
- 四项资产必须独立下载并核对大小与 SHA-256；`latest.yml` 的 version、path、size、SHA-512 必须与 Setup 实际字节一致。

## 非自动化结论

固定样本中的 220 条 Payment 配对及 2 条 R5 后续回填尚未取得业务逐笔复核证据。用户已授权继续生成技术 Release，但正式业务启用和公告仍被该人工资金门禁阻断，CI、样本基线和公开资产状态均不能替代业务签字。

## 正式发布结果

- release-closeout PR #122：Windows run `30796827775` PASS；merge `1117c8b7d047cf408807b023368c63123a90d81f`；main run `30797197015` PASS。
- tag：annotated `v3.1.7`，object `3b001b60c4e00a4c946ba2681f45c1ff6a15c9ff`，peeled commit 与发布时最新 main 均为 `1117c8b7d047cf408807b023368c63123a90d81f`。
- Windows Release run `30797428933`：tag/main/version、release-check、布局、构建、包体、资产暂存、updater 校验、不可变发布和公开回读全部 PASS。
- Release `364087395`：2026-08-03 17:01:02 +08:00 发布为 latest、non-draft、non-prerelease，公开且仅有四项预期资产。
- 资产独立回读：portable 99,619,052 bytes / SHA-256 `10e48e17cb78c1b56b06d8955f8aa8b7f04cab1d584029cd52b6168672f0144d`；Setup 100,115,826 / `c6332203082334c0b1daeb8c6ef75f4fec2adff586d1210bacb8e319a20b3b1a`；blockmap 105,513 / `e659f29a3d7c097dcc4ae9fac94c438824b8b4555ef46b48e455fcf6ade50a12`；`latest.yml` 369 / `d7100dd6706e3c17e081d727f91a039c99ee208fef9424b38848eceaae8401de`。
- `latest.yml`：version `3.1.7`，path `bank-bill-excel-tool-setup-3.1.7.exe`，`files[0].size=100115826`，SHA-512 `g90PD6fhQyoFA+4/jpsAYa1HmVA4fcFvkEmZ1tQbHMul/IaW2i5O8tHx4BWZ3IvgNQBuZ+/eSuCtt4ZgqhwCcA==` 与 Setup 实际字节一致；两个 EXE 文件头均为 `MZ`。
