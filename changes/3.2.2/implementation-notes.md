# v3.2.2 Release Metadata Closeout — Implementation Notes

## Decisions

- 版本元数据只在最终 v3.2.2 分支收口为 `3.2.2`，不提前把后续分支统一改成同一版本。
- 顶层 Spec/TechDoc 逐字节同步冻结基线，不在收口提交中改写业务合同。
- 文档区分“能力已实现并有证据”与“production 已启用”；后者保持 false。

## Assumptions

- #184～#191 的精确合并状态和 R3.2.2 evidence 是功能完成的权威远端证据；本节点不替代对应 CI 或人工门禁。

## Deviations

- 功能 PR 合并时未同步 package 元数据与三份发布文档，因此增加独立 metadata closeout 节点。

## Evidence

- package 三处版本一致性、顶层 Spec/TechDoc 冻结字节一致性、三份发布文档交叉校验与 `git diff --check`：PASS。
- `tests/unit/scripts/v3-2-2-release-evidence.test.js`：`28/28 PASS`；历史 snapshot 继续精确记录 `3.1.14 / bumped=false`，当前 authority 只接受 `3.2.2+` 的稳定 `v3.2.x` 且 package-lock 必须一致。
- `tests/unit/scripts/v3-2-2-release-metadata-closeout.test.js` 与 `tests/unit/vcc-financial-op-release-docs.test.js`：`15/15 PASS`；旧 v3.1.14 发布证据保持历史锁定，当前用户指南/元数据允许版本向前推进。
- 首轮文档组合测试发现旧 v3.1.14 测试把当前 USER_GUIDE 顶部永久绑定为 v3.1.14；已改为历史 section 继续严格校验、当前 header 跟随一致的稳定 package version，复跑通过。
- 完整 unit（干净 `npm ci`、`electron-builder/app-builder-lib 26.15.7`）：`6335/6338 PASS`、`0 FAIL`、`3 SKIP`；日志 `logs/unit-tests/unit-20260830-111040.log`。首轮误用了主工作区旧依赖树 `26.8.1`，先因隔离 worktree 缺少本地模板出现 2 个 ENOENT；临时映射后又由旧模板的 `System::Store` 正确触发 1 个 Windows 合同失败。按 lock 干净安装后，Windows 合同 `5/5 PASS`、`2 SKIP`，随后完整 unit 零失败；首轮结果只记录为环境诊断，不作为产品失败或 PASS 证据。
- 精确提交上的 `npm run check:packaged-inputs`：PASS；`build.files` 9 条覆盖范围与 HEAD 一致。提交前该检查按设计拒绝 dirty `package.json`/`docs/USER_GUIDE.md`，因此只采用提交后的结果。

## Remaining Unknowns

- `BLOCK / 人工复核`：Windows packaged 行为及资金/恢复样本仍由 release owner 人工确认。
- `BLOCK / production gate`：本节点不得启用 production。

按用户明确要求，不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
