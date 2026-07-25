# Tasks — v3.0.26

## 1. 文档与基线

- [x] 建立 spec、test-spec、tasks、implementation notes
- [x] 完成 PM/spec 核对并反向同步负合计、告警血缘、DBS 隔离与模板原状
- [x] 将 WIP 从 `main` 原样承接到 `codex/v3.0.26`
- [x] 更新版本号与三份版本文档
- [x] 更新重要变量清单

## 2. 前端文案

- [x] 平盘按钮与占位提示改为“对账数据管理”
- [x] 资金链接表删除框标题固定为“删除数据”
- [x] 保持前置资金临时删除框与删除业务契约不变
- [x] 更新 UI 单测与 preview 验证

## 3. 不平结果与 C4

- [x] `FundType` 插入“不平结果”第 6 列
- [x] 更新真实导出模板并保持样式
- [x] 更新 mapper/writer 单测与输出契约集成测试
- [x] C4 兼容旧 19/20 列与新 21 列
- [x] 覆盖 5/6-sheet、零不平和错误表头

## 4. R5 `Extra Fee`

- [x] 新增 R5 专用含手续费金额助手
- [x] 默认调拨来源接入新口径
- [x] 调拨对账单来源接入新口径
- [x] 多对多审计接入新口径
- [x] 非法手续费退出候选并输出一次可见 warning
- [x] 按 `_rowId` 去重 warning，并在可见 message 中保留原始手续费值
- [x] 解除 DBS 步骤2对 R5 新比较器的依赖，补两个步骤的非零手续费回归

## 5. 验证

- [x] 定向单测
- [x] 相关 preview
- [x] reconciliation blindspot pass
- [x] release-check
- [x] scan:vars / check:vars
- [x] startup:measure
- [x] team-lead 三层质量门禁
- [x] 记录真实资金样本人工复核缺口

## 6. 交付边界

- [x] 创建 PR #101，并完成合并前 self-review
- [x] 不创建 tag、不发布 Release
