# Log — v2.0.0-beta.4：usage-stats + error-report 可能原因 + 升 2.0.0

## 2026-04-30 初始

- 动作：落 spec/tasks/log，状态=apply
- 用户决策（已落 spec §6）：
  - **Q1.1=A** 路径 `~/Documents/网银账单生成小助手/.usage-stats.txt`
  - **Q1.2=A** 格式 key=value 简单文本
  - **Q1.3=B** 颗粒度 用户视角"功能"
  - **Q1.4=C** 写盘 关闭时 flush + 每 5 分钟自动 flush
  - **Q1.5** 按模块小计 + 总操作次数
  - **Q3.1=C** error-report 范围 全 3 模块统一
  - **Q3.2=A** 实现 xlsx 加列「可能原因」
  - **Q3.3** 精简口语风格（用户原话"再精简一点"）
  - 分支：v2.0.0-beta.4（从 v2.0.0 HEAD `6a51bb1` 切出）
  - 节奏：beta.4 完成 → 直接 bump 2.0.0 GA 一次发版（不出 beta.5）
- 风险：
  - **D8 USER_GUIDE 元规则**：用户原话"使用手册只能记录功能，其他的不记录"——本 PR 落实，并形成项目长期规则
  - 隐藏 txt 写盘失败可能影响应用启动 / 退出体验（设计原子写入 + 错误吞掉，不阻塞主流程）
  - error-report 加列影响下游分析脚本？— 项目内无下游，外部用户无强结构依赖（用户决策 GA 时机加列可接受）
  - 22+ code 的口语化文案需精简易懂——交付前用户人工 review 一遍

## 可沉淀知识（实施后回填）

- [ ] usage-stats INI-lite parser 手写实现的边界（空行 / 中文 section / 等号在值里 / Windows CRLF）
- [ ] error-causes 映射的覆盖率（漏映射默认 fallback 是否够好）
- [ ] 项目长期规则候选：USER_GUIDE 写什么不写什么（spec D8 沉淀到 rules/coding-style.md）

## 2026-04-30 增量需求（实施中追加）

3. **所有导出文件表头字号统一 10pt**
   - 影响 4 个 writer：exceljs-writer.js（2 处 headerRow.font）+ pending-export/writer.js（applyHeaderRowFont 加 sz）+ pending-session.js（切 xlsx-js-style + 新增 applyHeaderRowFont）
   - writers.js（主模块）已在 v2.0.0 设过 sz: 10，免改
   - streaming-xlsx-writer.js（121 万行流式留底）暂保留无字号（流式 OOXML 写出复杂，本 PR 不动）
   - **决策**：pending-session.js 从 `xlsx`（CE，不支持 styles 写出）切到 `xlsx-js-style`（fork 支持），与其他 writer 包一致
4. **使用手册另存为格式简化**
   - main.js#app:save-user-guide：filter 去 `.md`，仅保留 `.html` + `.txt`
   - 默认格式：HTML（filter 第一项 + defaultPath `使用手册.html`）
   - 移除 `if (ext === '.md')` 分支（dead code）
