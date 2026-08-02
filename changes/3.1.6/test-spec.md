# v3.1.6 Test Spec

## 资金与数据契约

- 四类明细业务键按原表类型全历史唯一；同键同内容跳过，同键异内容整批阻断。
- 每条输入只进入新增、幂等跳过、冲突、格式异常或事务回滚中的一个最终类别。
- 金额最多 2 位小数和 15 位有效数字，按精确十进制累计；币种限定九币种并执行 CNY→CNH。
- Pending credit/debit 的双侧币种和 J:K 有符号发生额与 spec 一致，错币标记非法值失败关闭。
- 系统财务OP必须严格匹配正式 16 列模板，每个“账期 × 主体”含归一化后唯一完整九币种血缘。
- 活动导入阻断计算/归档；归档绑定输入 revision，归档后冻结并作为下月唯一自动期初。
- 删除只作用于未归档当前有效数据，事务内固化审计、标记成功类导入记录已删除并使草稿失效。
- 数据管理导出只读取当前有效事实，行数守恒、自动续 sheet，失败不得覆盖既有目标文件。

## 自动化门禁

- `npm run release-check`
- `npm run verify:main-panel-alignment`
- `npm run scan:vars`
- `npm run check:vars -- --since origin/main --include-minor`
- VCC、平盘 owner-token、前端契约和大表 scanner 定向回归。
- `git diff --check`

## 正式收尾证据

- PR #118 最终实现提交 `92f91f6ca9f9daf3a1b06b0c096beaaf54027d22`；merge commit `54acd9ea0dc5a8b9bfa9528a9d0d264018c7c3f1`。
- 合并前定向回归 164/164 PASS；self-review 修复 1 个 P3 后无未解决 P0-P3 Finding。
- 合并前和合并后干净依赖 `release-check` 均通过；最新为 unit 4,592/4,592、44 个 integration 脚本 2,051/2,051。
- Windows 候选 run `30755450625` 的 smoke-test 和 build jobs 均成功。
- 主页面几何 6/6 PASS；变量扫描为 282 files / 3,515 top-level names；release 分支无 `src` diff。
- 生产依赖审计为 0 critical、7 high、2 moderate；本次不升级依赖。

## Release 验证

- tag 必须为 annotated `v3.1.6`，且 peeled commit 等于创建时最新 `main`。
- tag、`package.json.version` 和 `latest.yml.version` 必须一致。
- Release workflow 的 main/tag 校验、完整 release-check、布局、构建、包体、资产暂存、发布和公开回读全部成功。
- GitHub Release 必须为 latest、non-draft、non-prerelease，并且仅有一套：
  - `bank-bill-excel-tool-setup-3.1.6.exe`
  - `bank-bill-excel-tool-setup-3.1.6.exe.blockmap`
  - `bank-bill-excel-tool-portable-3.1.6.exe`
  - `latest.yml`
- 四项资产必须独立下载核对大小和 SHA-256；`latest.yml` 的 path、size、SHA-512 必须与 Setup 实际字节一致。

## 非自动化结论

完整历史唯一性、真实资金逐项复核、真实大库删除/导出、Windows Excel/WPS、平盘现场单文件重试及 v3.1.5→v3.1.6 升级 canary 均保持未执行。技术 Release 成功不得替代这些业务和实机结论。
