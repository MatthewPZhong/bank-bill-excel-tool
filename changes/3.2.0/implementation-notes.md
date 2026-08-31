# v3.2.0 Release Metadata Closeout — Implementation Notes

## Decisions

- 版本元数据只在最终 v3.2.0 分支收口为 `3.2.0`，后续版本分别在各自最终收口节点更新。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不使用主工作区中与冻结来源不一致的旧 proposal。
- 文档区分“能力已实现并有证据”与“production 已启用”；后者保持 false。
- v3.1.14 历史发布测试继续锁定其 section、tag 和资产证据，但当前 package/USER_GUIDE header 允许推进到一致的稳定版本。

## Assumptions

- #168～#175 的精确合并状态和 R3/R4 evidence 是功能完成的远端来源；本节点不替代对应 CI 或人工门禁。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。

## Evidence

- package 三处版本一致性、顶层 Spec/TechDoc 冻结字节一致性、三份发布文档交叉校验与 `git diff --check`：PASS。
- `tests/unit/scripts/v3-2-0-release-metadata-closeout.test.js` 与既有 `tests/unit/vcc-financial-op-release-docs.test.js`：`15/15 PASS`。
- 首轮定向测试发现 USER_GUIDE 的 v3.2.0 历史摘要未显式承诺 Excel/Workbook 输出合同不变；补齐该兼容性文案后复跑通过。首轮 `14/15` 只作为修复证据，不记 PASS。
- 干净 `npm ci` 后完整 unit：`6019/6022 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260831-135019.log`。
- 修改测试文件 ESLint、`node --check`、`git diff --check` 与本地 diff review：PASS；未发现 `src/`、production、资金/恢复合同或打包输入范围漂移。
- 提交后 `npm run check:packaged-inputs`：PASS，`build.files` 9 条覆盖范围与 HEAD 一致。
- 本地 commit review：提交唯一父为最终 v3.2.0 `9b9887c1`，只含版本元数据、权威/发布文档与合同测试；无 `src/`、production、资金或恢复行为改动。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged 行为、VCC OP 真实样本及资金/恢复边界仍由 release owner/业务负责人确认。
- `BLOCK / production gate`：本节点不得启用 production。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
