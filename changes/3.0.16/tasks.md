# Tasks — v3.0.16

## Task 1：规格与规则契约
- 固化 Extra Fee 公式、14 类规则、错误分类和失败令牌契约。
- 状态：done

## Task 2：匹配引擎
- 实现精确十进制加法、规则资格索引和带 tradeType 的稳定 1:1 消费。
- 增加不平原因与规则统计，保持输出和行数守恒。
- 状态：done

## Task 3：错误行工作流
- 流式收集全部行错误，严格导入回滚。
- 实现错误 xlsx 导出、逻辑删除重跑和 side DB 审计。
- 状态：done

## Task 4：前端与 IPC
- 失败页增加 `导出错误数据 / 删除错误数据并重跑 / 关闭`。
- 只使用主进程失败令牌，不暴露任意路径接口。
- 状态：done

## Task 5：验证与发布收尾
- 补齐单元/集成/预览测试，执行 release-check、check-vars 和人工资金复核。
- 更新版本号、CHANGELOG、VERSION_FEATURE_HISTORY、USER_GUIDE。
- 状态：doing（自动验证完成；人工资金复核待完成）
