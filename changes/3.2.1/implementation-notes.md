# v3.2.1 Release Metadata Closeout — Implementation Notes

## Decisions

- 通过 merge commit 纳入最终 v3.2.0 metadata/docs closeout，保持版本链可审计；随后只在最终 v3.2.1 收口节点更新为 `3.2.1`。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不使用主工作区中与冻结来源不一致的旧 proposal。
- E04-C 第二 Writer gate 保持 rejected；Toolbox 只使用受管生成 Worker、单一 Writer/FIFO Publisher，不以“未实现”名义扩大写入拓扑。
- 文档区分 capability 与 effective production strategy；PreFund parser pool 的资源/性能 gate 未通过时生产保持 legacy/false。

## Assumptions

- #176～#183 的精确合并状态和 R3/R4 evidence 是功能完成的远端来源；本节点不替代对应 CI 或人工门禁。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。

## Evidence

- v3.2.0 closeout head `a7d9bf47` 已通过双父 merge commit `0a8ae056` 成为本分支真实祖先。
- package 三处版本一致性、v3.2.0/v3.2.1 顶层 Spec/TechDoc 冻结字节一致性、三份发布文档交叉校验与 `git diff --check`：PASS。
- v3.2.0/v3.2.1 metadata closeout 与既有 v3.1.14 发布文档定向组合：`16/16 PASS`。
- 干净 `npm ci` 后完整 unit：`6178/6181 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260831-135655.log`。
- 修改测试 ESLint、`node --check`、`git diff --check` 与本地 diff review：PASS；未发现 `src/`、production、资金/恢复合同或打包输入范围漂移。
- 提交后 `npm run check:packaged-inputs`：PASS，`build.files` 9 条覆盖范围与 HEAD 一致。
- 本地 commit review：最终 v3.2.0 收口通过双父 merge commit 成为真实祖先；v3.2.1 收口只含版本元数据、权威/发布文档与合同测试，无 `src/`、production、资金或恢复行为改动。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged/退出、PreFund 真实资金样本、金额/币种/文件顺序和恢复处置仍由 release owner/资金负责人确认。
- `BLOCK / production gate`：本节点不得启用 production，E04-C/E05-C 拒绝结论不被文档收口覆盖。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
