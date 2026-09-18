---
name: implementation-notes
description: 为中大型或多阶段实现持续维护简洁的 Decisions、Assumptions、Deviations、Evidence 和 Remaining unknowns，防止计划与代码静默漂移。用于跨模块、长时、多人协作、高风险或实施中发现新事实的任务；不要为一次性文案、格式化或明确的微小修复制造记录负担。
---

# Implementation Notes

记录会影响理解、验收、回滚或后续维护的内容，不写命令流水账。

## 建立记录

1. 优先使用当前 change/spec 目录中的 `implementation-notes.md`。
2. 若任务已有 `changes/<change-name>/`，在该目录内创建；不要在仓库根目录散落文件。
3. 从 [implementation-notes-template.md](assets/implementation-notes-template.md) 复制所需章节；删除不适用的占位行。
4. 已有文件只增量更新，不覆盖用户或其他协作者的内容。
5. Baseline 只链接原始需求、spec 和初始计划，不重复抄写已有文档。

## 记录标准

### Decisions

只记录存在合理替代方案、且决定会影响行为或结构的选择。写明选择、原因、证据和被放弃方案。

### Assumptions

记录尚未完全证明但允许继续推进的低风险假设。写明失效影响、验证方式和回滚方式。高风险未知不得伪装成假设。

### Deviations

计划、spec 或验收口径发生变化时立即记录：原计划、实际方案、变化原因、影响和是否需要用户确认。

如果偏差改变用户可见行为、数据契约、状态机、兼容性或验收标准，先反向同步 spec，再继续实现。计划可以改变，但不能静默改变。

### Evidence

记录可复现证据：测试命令与结果、样本回放数量、关键日志、截图或代码位置。不要只写“已验证”“应该没问题”。

### Remaining Unknowns

仅保留仍影响上线、合并、运维或后续需求的未知。为每项标注 `BLOCK`、`PROBE` 或 `ASSUME` 及负责人/下一步。

## 更新时机

- 关键技术或业务决定落定后
- probe、原型或真实样本推翻原假设后
- 实现偏离计划或 spec 后
- 关键测试完成或失败后
- 最终交付前清理过期项并确认 spec 已同步

不要记录逐文件编辑过程、无决策价值的探索、重复测试输出或可以直接从 Git diff 看出的机械事实。
