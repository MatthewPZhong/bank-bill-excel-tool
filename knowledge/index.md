# 知识索引

> 这里放“如何触发加载某份知识”的索引。

| 关键词 | 文档 | 说明 |
|--------|------|------|
| backlog / 待办 / 后续 PR 候选 | `knowledge/backlog.md` | 已识别但暂不实施的非阻塞改进项（按 P0-P3 分级，版本 bump 前 review）|
| CSS flex / grid 嵌套 overflow / max-height / 滚动条不出现 / scrollHeight=clientHeight | `knowledge/css-flex-grid-overflow-pitfalls.md` | v2.1.7 大账号 dialog B4 round 3-6 教训：两条必修线 = 每层 flex/grid item `min-height: 0` + grid 父容器 `grid-template-rows: 1fr`，缺一不可 |
| renderer 运行时错误 / ReferenceError / escapeHtml is not defined / 跨文件作用域 / 前端 bug 定位 / 明细框不弹 | `knowledge/renderer-runtime-blind-spot.md` | release-check 照不到 renderer.js 运行时；escapeHtml 跨文件作用域定时炸弹（beta.1 潜伏到 beta.6 PR#65）；定位套路 = 诊断 log + DevTools console |
| 示例：登录风控 | `knowledge/login-risk.md` | 登录风控历史方案与坑点 |
| 示例：支付重试 | `knowledge/payment-retry.md` | 重试幂等与补偿约束 |

## 维护原则

- 长期复用的经验再沉淀
- 一次性讨论不要直接写进知识库
- 文档标题尽量可搜索
