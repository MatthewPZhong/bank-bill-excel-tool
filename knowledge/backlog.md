# 项目 Backlog（待办候选 / 非阻塞改进）

> 收集已识别但暂不实施的改进项。版本 bump 前过一遍，决定是否升优先级到下一个 PR 的 spec。

## 维护约定

- **添加**：识别到非阻塞改进 → 在 "未实施" 段 append（按时间倒序，最新在上）
- **每条记录格式**：来源（哪个 PR / 哪轮 review）+ 严重等级（P0~P3）+ 影响范围 + 推荐实施时机
- **完成**：单独 PR 落地后从 "未实施" 段移到 "已完成"，引用对应 PR 编号 + commit
- **过期**：明确不再做（如方案被推翻）→ 移到 "已废弃"，写废弃理由

## 未实施

### B4（P3）`recon-id-fix-scenario-ipc` smoke simulator 与真实 main.js 漂移

- **来源**：PR #35 self-review（commit `7327b43`）
- **影响**：`scripts/smoke/recon-id-fix-scenario-ipc.js` 用 simulator 跑 IPC handler 行为，不是真 `ipcMain.handle` 路径。修分流逻辑时如果忘了同步 simulator 会让测试假绿。
- **现状**：simulator 是手工拷贝的 main.js handler 逻辑（含 round 3 的 `clearResultCacheForCategory` 分流）；和真实代码两份维护
- **推荐**：补 simulator-vs-real 一致性断言；或 PR-D 加 electron e2e（spawn electron + IPC roundtrip）做兜底验证
- **触发实施**：v2.1.0-beta.1 PR-D（收尾 + 文档三件套）一并加 e2e；或第二次出现"smoke 绿但真实跑挂"时优先

### B1（P3）`streaming-xlsx-writer.js` 流式 archive 表头字号

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：121 万行流式 archive xlsx（月度 Pending 留底文件）表头字号未设 10pt；其他 4 处 writer 已统一（`exceljs-writer.js` / `pending-export/writer.js` / `pending-session.js` / `writers.js`）
- **现状**：`src/backend/pending-import/streaming-xlsx-writer.js` 是自定义 OOXML XML writer（绕过 SheetJS 解决 121 万行 × 31 列内存峰值 2-3GB 问题），要在生成的 styles.xml 加 fonts 节
- **推荐**：单独 PR 实施前先做 spike — 验证 OOXML font + styles.xml 兼容（Excel / WPS / Numbers）；流式逻辑本身是性能优化，不能为了表头字号破坏内存收益
- **触发实施**：用户报怨"为什么 archive 文件表头字号不一致" / 流式 writer 因别的原因要重构时

### B2（P3）`FUNCTION_REGISTRY` 与 IPC handler 元数据合并

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：`FUNCTION_REGISTRY`（`src/backend/usage-stats.js`）和 25 处 `trackedIpcHandle('m', 'f', ...)` 调用（`src/main.js`）两份字符串硬编码维护；未来重命名功能时若漂移 → tickUsageStats 静默忽略 + console.warn，统计偏低且难发现
- **现状**：每次新增"用户感知功能"需要同步两处，靠人工保证不漏
- **推荐**：把功能元数据集中到一处。备选方案：
  - A. IPC channel name → moduleKey/fnKey 映射表（trackedIpcHandle 改为 `trackedIpcHandle(channel, handler)`，从 map 推导）
  - B. usage-stats 模块导出一个 `defineFunction(moduleKey, fnKey)` 工厂，trackedIpcHandle 接收 token 而非字符串
- **触发实施**：第二次出现"漂移导致计数丢失"的实际事故 / 新加 ≥5 个用户感知功能时

### B3（P3）`error-causes` CAUSE_MAP 新增 code 自动 smoke 校验

- **来源**：PR #34 self-review（commit `9952255`）
- **影响**：未来加新 warning code 时若漏映射，`errorCodeToCause` 返回 fallback `未知错误`；当前 smoke E5 仅校验代表性 code（7 个），非全量
- **现状**：`src/main-process/scenario-engines/c1/c2/c3*.js` 等处 `code: 'xxx'` 字符串可被 grep 出来；`CAUSE_MAP`（`src/backend/file-service/error-causes.js`）也是静态对象
- **推荐**：smoke 加一段自动校验
  - 扫 `src/**/*.js` 提取所有 `code: '...'` 字符串
  - 与 `CAUSE_MAP` keys 比对
  - 未映射的 code 报告（默认 fail，可加白名单 escape）
- **触发实施**：下次新增场景算法（C4 / C5 等新场景类）时一并加

## 已完成

（暂无）

## 已废弃

（暂无）
