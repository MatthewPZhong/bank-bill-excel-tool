# G4 adapters 与 SST provider 独立审查

审查快照：`/private/tmp/shared-xlsx-review-1li0jlx4/snapshot`，基线 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，比较对象为该快照中的工作区覆盖内容。审查依据为本分支 `spec.md` 与 `techdoc.md`，重点 G4-AC-04、05、06、07、08。

结论：在本子范围内未发现由本次迁移引入、可报告为代码缺陷的行为差异。没有修改生产代码或测试。

## 核验内容

- `src/backend/xlsx/shared-strings-provider.js` 与 `git show HEAD:src/backend/position-reconciliation-import/shared-strings-provider.js` 逐行比较：仅依赖改为公共路径，并将 Position 默认常量替换为值相同的公共常量。append/get/缓存淘汰/落盘/identity 检查/关闭/失败处理全部原样保留。新文件第 15–16 行缺省为 64 MiB / 8192，与 Position constants 当前值一致。
- Position `xlsx-reader.js:212` 继续传入原 `sstTempRoot`、`preserveSstOnClose`、`cancelToken`，只对严格等于 `undefined` 的 memory/LRU 用本域默认，因此 `null` 和数值字符串仍交给 provider 原校验/Number 转换；未新增 cache/strict 覆盖。
- VCC S1 `workbook-reader.js:82` 的变更同样仅显式补 undefined 默认；没有加入原本不接受的 preserve/strict/cache/cancel 选项，原 UUID 临时路径与 close 链保持。
- BizOP R1 `import-pipeline.js:95` 保留 memory/cache 的 `??` 默认，LRU 新显式默认仅匹配 `undefined`；因此 memory/cache 的 null 保留默认，而 LRU null 保留拒绝。候选目录 SST 路径、取消和错误记录未改。
- BizOP R2 `export-source.js:57` 仍使用 single-sheet reader、`sst-raw-*` 私有根、32 MiB memory/cache；`export-validator.js:38` 仍使用多页 reader、`sst-actual-*`、`expected.pages.length`。两点只将 LRU=8192 显式化。
- VCC R3 `review-export-plan.js:362` 保留显式 64 MiB cache；R4 `workbook-import-plan.js:74`、`system-op-importer.js:859`、`vcc-financial-op-dataset-writer.js:953`、`vcc-financial-op-review-validator.js:154` 保留不提供 cache 的区别。既有 signal/shouldCancel 桥接保持，其中 dataset-writer 仍不传 cancelToken。每个调用点原 close 链均未改，system-op 的关闭后 `throwIfCancelled` 仍存在。
- L1/L2/T1 及其他生产 consumer 的 diff 为导入路径迁移，手写行映射/lexical/列宽/maxRows/输出验证契约未改。`toolbox-format-io` 从 aggregate 导入改为叶子导入后，对应导出来源仍相同。
- 生产 `src` 旧入口引用搜索仅余注释和 README，未发现遗漏的旧 API require；SST 旧路径为直接 `module.exports = require('../xlsx/shared-strings-provider')`，保持同一 constructor/module identity。

## 本轮执行验证

命令（在上述只读代码快照执行）：

```sh
node --test tests/unit/backend/xlsx/consumer-options.test.js tests/unit/backend/xlsx/shared-strings-contract.test.js tests/unit/backend/shared-strings-ownership.test.js
```

结果：29 tests，29 pass，0 fail/skip/cancel，Node v25.8.0，约 1.67 秒。完整输出：`adapter-contract-tests.tap`。

消费方测试经真实 ZIP、SST、数据库、导入及输出回读观察实际 provider，有效覆盖 L1/L2/S1/R1/R2/R3/R4/T1；覆盖 undefined/null/Number 转换、不同 cache 显式性、私有路径、provider closed、信号桥接。资源测试覆盖缺省/空路径、已存在目录、部分创建失败、取消和解析失败、无关文件/identity 替换、strict/non-strict fd 失败、旧新 constructor identity。

本轮是 macOS/Node 自动化证据，不代表 Windows 文件占用或 Excel/WPS 人工验收。针对本次目录迁移不将原有 legacy 全量 ZIP/SST 内存行为或既有强制 terminate 边界报告为新增缺陷。
