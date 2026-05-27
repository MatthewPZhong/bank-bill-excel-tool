# Spec — v2.1.9 资金红线评审 + 17 决策点详解

| 字段 | 值 |
|---|---|
| 文档版本 | v0.9（2026-05-27 — **SR-FIX-1 资金红线修复**；§1.6 加 D38-D40 3 项；§2.1 / §2.4 / §3.1 / §3.2 / §5.2 / §6.3.2 加 Reverse Sync marker；新增 §十六 完整修复设计）；v0.4 SR-log-1 立项；v0.3 加 D19-D22 + 4 个新主题详设；v0.2 D18 grep 修订；v0.1 起草 |
| 关联文档 | `PRD-v2.1.9.md` v0.3 / `backlog.md` v0.5 / `tasks.md` v0.4（SR-FIX-1 已加）/ `manual-test-checklist.md` v0.4（SR-FIX-1 已加） |
| 评审范围 | N5（银行渠道区分场景）+ N7（场景模板按渠道导入/导出）+ N6（状态框换行）+ SR-backup-1（前置） |
| 评审人 | PM + 用户（资金红线条目必复核） |

---

## 一、决策点全表（27 项 — N5 + N7 + N6 共 18 项全锁；α 升格新增 D19-D22 待本 spec 阶段拍板）

### 1.1 N5 决策点（11 项 — 全锁）

| ID | 决策点 | 用户拍板 | 解释 |
|---|---|---|---|
| **D1** | 「通用」渠道性质 | **(a)** 系统内置不可删不可改名 | 所有 fallback / migration 都依赖它；硬约束 UI 按钮 disabled + DB `is_builtin=1` 标志 |
| **D2** | 处理顺序（核心） | **(c)** 先专属 + 后通用 | 专属优先 + 通用兜底；first-match-wins 在专属+通用合并序列上分阶段执行；**reverse sync §三** |
| **D3** | `<Channel>-<地区>` 未匹配渠道时 | **(a)** fallback 通用 + 保留原始信息 | 走通用场景兜底；保留 `_hitChannelKey` 用于审计；不在状态框单独提示 |
| **D4** | 「转移」语义 | **(a)** 搬运 | A→B 后 A 内场景不再存在；scenarios.channel_id 单值更新 |
| **D5** | scenarios 与 channel 关联 | **(a)** `channel_id INTEGER FK` | + `ON UPDATE CASCADE`；避免渠道改名级联问题 |
| **D6** | 「完成 / 修改」按钮二态 | **(a)** 新增行落库后变「修改」 | 编辑态/查看态切换；与账户映射页面 UX 对齐 |
| **D7** | `Channel` / `地区` 取值来源 | **(b)** column mapping 后的逻辑字段 | 复用 v2.1.6 mapping 体系；`bank-statement-fields.js:15-16` 已是标准字段 |
| **D14** | 独立报表落位目录 | **(a)** `Documents/网银账单生成小助手/error-reports/{date}/` | 与 error-report 同目录，复用现有设施 |
| **D15** | 独立报表默认文件名 | **(a)** `命中场景行-{原文件 basename}-{timestamp}.xlsx` | 含原文件名便于多对账单回溯 |
| **D16** | 「匹配渠道」列值格式 | **(b) ✅ 修订**（2026-05-27 用户反馈后从 (a) 改 (b)）：实际命中场景所属渠道 label（通用→「通用」；专属→「name-ownerLocation」） | 与「命中场景」列对齐，用户视角直观；原始 Channel/地区 仍在主输出 xlsx 44 列保留供审计 |
| **D17** | 列序（原 44 列之后追加） | **(b)** `匹配渠道 / 匹配状态 / 命中场景` | 渠道前置（粗维度→细维度阅读顺序） |

### 1.2 N7 决策点（6 项 — 全锁）

| ID | 决策点 | 用户拍板 | 解释 |
|---|---|---|---|
| **D8** | footer 按钮顺序 | **(a)** `新增场景 / 导入模板 / 导出模板 / 完成` | 主要操作最左，文件操作居中，关闭最右 |
| **D9** | bundle 文件结构与版本号 | **(b)** 独立 `scenarioBundleVersion=1` | 与 `bundleVersion=4` 互认隔离 |
| **D10** | 多选导出文件结构 | **(a)** 单文件多渠道 | `channels: [{name, ownerLocation, scenarios: [...]}]` |
| **D11** | 导入时缺失渠道处理 | **(a)** 自动创建 + 落库前弹确认框 | 列出新增渠道清单让用户确认/取消 |
| **D12** | 导入同名场景冲突 | **(a)** 跳过 + 报告冲突 | 保守策略；用户显式动作改库 |
| **D13** | 默认导出文件名 | **(a)** `scenarios-bundle-{YYYYMMDD}.json` | 中性命名；用户在 saveDialog 可改 |

### 1.3 N6 D18 决策（2026-05-27 spec 阶段拍板）

| ID | 决策点 | 选项 | PM 推荐 | 拍板 |
|---|---|---|---|---|
| **D18** | N6 修复位置 | (a) 外层文案删 `\n`（仅银行对账单 2 行） / ~~(b) 内层 `updateStatusBox` 去掉「：」自动换行~~ | **(a)** — 见 §7 grep 证据；(b) 会静默破坏 5 个其他模块视觉 | **(a)** ✅ |

**v0.1 推荐 (b) 已推翻**：基于 §7.1 grep 事实，其他 5 模块文案全部依赖内层 replace 提供单换行，(b) 会破坏 v2.1.7 round 2 R3 §8.4.2 有意设计。详 §7.2 影响对比表。

### 1.4 α 升格新增决策点（4 项 — 2026-05-27 用户全部拍板按 PM 推荐 ✅）

> 2026-05-27 用户决定 v2.1.10 候选项除 F5-cont 全部前移到 v2.1.9 α；本节 4 个新增决策点已全部拍板。

| ID | 主题 | 决策点 | 拍板 |
|---|---|---|---|
| **D19** | G1-cont | 测试框架 + CI 阻断 | **(a)** ✅ 沿用 v2.1.8 既定（node:test + CI 不阻断） |
| **D20** | SR-policy-1 | integration-runner 输出格式 | **(c)** ✅ in-place 编辑 `rules/integration-test-policy.md §七` + 时间戳 + stdout |
| **D21** | N1-settings | settings UI 位置 | **(c) ✅ 修订**：不做 UI 仅 settings 表手动改（2026-05-27 用户审查后从 (a) 修订到 (c) — Phase 8.6 自扩展的 `createAppSettingsDialog` + ⚙️ 入口全部回退；后端 settings + 范围校验 + IDLE_CLEANUP_MS 启动期读保留） |
| **D22** | N4 重构（顺带） | 是否本版同步改 v2.1.8 已发 N4 备份调用 | **(a)** ✅ 是 — backup.js 基建已建，N4 切换成本 0；一致性消除存量风险 |

### 1.5 SR-log-1 决策点（9 项 — 2026-05-27 用户全部拍板）

| ID | 决策点 | 拍板 | 含义 |
|---|---|---|---|
| **D29** | 日志目录结构 | **(a-修订) `logs/{YYYY-MM}/{MM-DD}/{level}.log`** | 月+日两层归档；与 D32 永久保留搭配跨年浏览自然（用户拍板修订原 (a)） |
| **D30** | 告警类型分类 | (a) 仅级别 error/warning/info（3 类） | 用户原话「告警类型」直观指级别；最简单+最常用 |
| **D31** | 日志格式 | (b) JSON Lines | 结构化便于 `cat | jq` 解析；IDE 仍可阅读 |
| **D32** | 日志保留策略 | **(a) 永久保留**（用户拍板） | 不滚动；用户后续可手动清理 |
| **D33** | renderer 上报 IPC | (a)+(c) preload 单接口 + wrapper hijack | preload 暴露 `desktopApi.reportLog` + setStatus/createAlertDialog 内部自动调用；调用方零改动 |
| **D34** | 兼容 `app_activity_log.txt` | (a) 双写 1 版本 | v2.1.9 双写 / v2.1.10 评估删旧 |
| **D35** | 启动期清理超期日志 | **取消**（D32 永久保留级联推断） | 不实施清理机制 |
| **D36** | 日志查看 UI | **(a) 仅文件系统暴露**（用户拍板） | 不加按钮入口；USER_GUIDE 写明日志位置 |
| **D37** | ESLint 强约束 | (b) 暂不引 ESLint | 保持轻量化偏好（devDeps 仅 3 个）；v2.1.10+ 评估 |

**D35 级联推断说明**：D32=a 永久保留 → D35「自动清理 > 90 天日志」永远清不到 = 死代码 → 级联取消。如未来用户希望保留清理能力（如 UI 按钮），可在 v2.1.10+ 立项。

### 1.6 SR-FIX-1 决策点（3 项 — 2026-05-27 用户合并前 self-review 后拍板 F1）

> v2.1.9 PR #53 提交后的 self-review 发现 SR1 #1/#2/#3/#4 4 个 Critical（详 §十六 修复设计）：dispatcher per-row 单调破坏 C3 1v1 资金红线 + C2 笛卡尔配对永不命中 + scenarios.name 全表 UNIQUE 与 N7 channel 内同名跳过语义冲突 + C2/C3 双维 0 测试覆盖。用户拍板 F1 方案：合并前修。

| ID | 决策点 | 拍板 | 含义 |
|---|---|---|---|
| **D38** | dispatcher 调度模型修订 | **(a) per-channel batch first-match-wins** | 阶段 A 每个专属渠道独立批量调 `runScenario(scenario, candidateRows, gwRows)`，阶段 B 通用渠道批量；保留 v2.1.7 F2 + F8 资金红线不变量（C3 `usedGwRowIdx` 在 runScenario 内自然 1v1；C2 笛卡尔配对收到完整 row 集；rowLockSet 跨阶段累积保证 first-match-wins）；详 §16.1 / §16.2 |
| **D39** | scenarios.name UNIQUE 修订 | **(a) 复合 UNIQUE (channel_id, name)** | 全表 UNIQUE 改为 channel 内 UNIQUE；与 spec §6.3.2「channel 内同名跳过」语义一致；migration 检查老库跨渠道同名冲突（理论上 N5 migration 后所有 scenarios.channel_id=1 不会冲突，但 N7 导入路径修复后需要）；详 §16.3 |
| **D40** | C2/C3 双维单元覆盖 | **(a) 必须补 ≥15 case** | 现有 dispatcher.test.js 30+ 双维 case 全用 C1，C2/C3 双维路径 0 覆盖；新增矩阵：C3 阶段 A 命中 / C3 阶段 B 兜底 / C3 跨阶段 gw 共享边界 / C2 阶段 A 命中 / C2 阶段 B 兜底 / 复合 UNIQUE 跨渠道同名插入；详 §16.4 |

**D38 关键约束**：跨 scenario / 跨 channel 的 gw 行**可能**被多次消费（如阶段 A 工商-上海 C3 消费 gw[0]，阶段 B 通用 C3 又消费 gw[0]）— 这是 v2.1.8 单维 + N5 双维**一致**的已知边界（v2.1.7 F2 1v1 红线只约束单 scenario 内）；用户层规避：同 gw 字段的 C3 场景不应在专属 + 通用同时启用相同 reconFields。USER_GUIDE 同步加注解。

---

## 二、N5 资金红线评审

### 2.1 dispatcher 双维调度模型（D2=c）伪代码

> ⚠️ **v0.9 SR-FIX-1 Reverse Sync（2026-05-27）**：本节伪代码为 **per-row 单调** 设计，已被 §十六 修订为 **per-channel batch first-match-wins**。原 per-row 路径破坏 C3 `usedGwRowIdx` 1v1 资金红线 + C2 笛卡尔配对永不命中（详 §16.1）。**实施以 §16.2 伪代码为准**；本节保留供历史参考。

**调度入口**：`src/main-process/scenario-dispatcher.js:runAllScenarios`（v2.1.8 N3-1 已含 displayIndex / hitScenarios，本次扩双维）

```js
// v2.1.9 N5：双维 first-match-wins（专属优先 + 通用兜底）
async function runAllScenarios(row, deps) {
  const { channelRepo, scenariosRepo, dispatcherCtx } = deps;

  // Step 1 — 拼接渠道 key（D7=b 用 column mapping 后的逻辑字段）
  const channelKey = buildChannelKey(row);
  // channelKey 形如 "工商-上海"；空值用 '' 兜底

  // Step 2 — 查渠道库
  const matchedChannel = channelRepo.findByNameAndLocation(
    extractChannelName(row),
    extractChannelLocation(row)
  );
  // matchedChannel = { id, name, owner_location, is_builtin } 或 null

  const generalChannel = channelRepo.getBuiltinGeneral();
  // generalChannel = { id: 1, name: '通用', ... }

  // Step 3 — 双维 first-match-wins（D2=c 专属优先）
  let hit = null;
  let hitChannelId = null;

  if (matchedChannel && matchedChannel.id !== generalChannel.id) {
    // 阶段 A：跑专属渠道场景集
    const dedicatedScenarios = scenariosRepo.listByChannelIdAndCategory(
      matchedChannel.id,
      row._category
    );
    hit = firstMatchWins(dedicatedScenarios, row);
    if (hit) hitChannelId = matchedChannel.id;
  }

  if (!hit) {
    // 阶段 B：跑通用渠道场景集（兜底）
    const generalScenarios = scenariosRepo.listByChannelIdAndCategory(
      generalChannel.id,
      row._category
    );
    hit = firstMatchWins(generalScenarios, row);
    if (hit) hitChannelId = generalChannel.id;
  }

  // Step 4 — 写 metadata
  row._hitChannelKey = channelKey;
  row._matchStatus = matchedChannel ? '命中' : '兜底';
  row._matchedChannelId = matchedChannel?.id || null;
  row._fallbackChannelId = !hit ? null : (hitChannelId === generalChannel.id && matchedChannel ? generalChannel.id : null);

  if (hit) {
    row._hitScenarioId = hit.id;
    row._hitScenarioName = hit.name;
    row._hitScenarioDisplayIndex = hit.displayIndex;
  }
  // 未命中 → row 进入 Sheet 2「未命中场景行」

  return { hit, channelId: hitChannelId };
}
```

### 2.2 调度模型语义详解

**4 种行结果矩阵**（按 _matchStatus × hit 状态）：

| _matchStatus | hit 结果 | 含义 | 输出去向 |
|---|---|---|---|
| 命中 | hit ≠ null（命中专属 X） | 行匹配到渠道 X，且 X 内有场景命中 | Sheet 1（渠道对账单）+ 独立报表「匹配状态=命中, 命中场景=专属场景」 |
| 命中 | hit ≠ null（命中通用） | 行匹配到渠道 X，但 X 无场景命中，通用兜底命中 | Sheet 1 + 独立报表「匹配状态=命中, 命中场景=通用场景」 |
| 命中 | hit = null | 行匹配到渠道 X，X + 通用全都没命中 | Sheet 2（未命中场景行）|
| 兜底 | hit ≠ null（命中通用） | 行未匹配任何渠道，通用兜底命中 | Sheet 1 + 独立报表「匹配状态=兜底, 命中场景=通用场景」 |
| 兜底 | hit = null | 行未匹配渠道 + 通用也没命中 | Sheet 2（未命中场景行）|

### 2.3 D2=(c) 与 §1 用户原话的 Reverse Sync 解读

用户需求 §1 原话：

> 「所有银行渠道的银行对账单的处理都需要过"通用"的场景」

**PM 实施解读**：

- ❌ **不是**「每行强制依次跑通用所有 scenarios + 再跑专属所有 scenarios」（这是 D2=b 双跑语义）
- ❌ **不是**「每行先跑通用 first-match-wins 命中后停止；未命中再跑专属」（这是 D2=b 顺序语义）
- ✅ **是**「通用渠道对所有渠道都生效，作为专属未命中后的兜底；同一行不会被双重处理」（D2=c 当前实施）

**关键含义**：

1. 用户配专属渠道场景 = **覆盖**通用同 category 的默认行为
2. 通用场景作为各渠道默认规则的"最小公约数"
3. 行只命中一个场景（first-match-wins 不变）
4. 未匹配渠道行走通用兜底，但保留原始 `_hitChannelKey` 用于审计

**关键风险**：若用户后续反馈"我希望每行强制都过通用"（D2=b 语义），需重新评审。spec v0.1 锁定 D2=c，**用户审本 spec 时若发现解读偏差，必须显式说明**。

### 2.4 first-match-wins 不变量

> ⚠️ **v0.9 SR-FIX-1 Reverse Sync（2026-05-27）**：本节不变量描述基于 per-row 作用域，已被 §16.2 修订为「per (channel × phase) 子作用域 + 跨子作用域 rowLockSet 累积」。语义保持「同一行最多命中 1 个场景」；变化点见 §16.2。

- v2.1.7 F8 + v2.1.8 N3-1 已确立 first-match-wins 调度（dispatcher.js:99 改 hitScenarios.push 后 break）
- v2.1.9 N5 保持 first-match-wins，但**作用域扩为分阶段执行**：
  - 阶段 A（专属）first-match-wins，命中 → break，不进阶段 B
  - 阶段 A 未命中 → 进阶段 B（通用）first-match-wins，命中 → break
  - 阶段 A + B 都未命中 → 行进 Sheet 2
- 同一行**最多命中 1 个场景**（无双重处理）
- **v0.9 SR-FIX-1 修订（§16.2）**：作用域细化为「每个 (channel × phase) 子作用域内 first-match-wins 批量执行」，跨子作用域通过 `rowLockSet` 累积保证「同行最多 1 命中」不变量；同时让 C3 `usedGwRowIdx` 在每次 runScenario 调用内自然 1v1 + C2 笛卡尔配对收到完整 row 集

---

## 三、DB schema 设计

### 3.1 `channels` 表 DDL

> v0.9 SR-FIX-1 Reverse Sync：本节 channels 表 DDL 不变；scenarios.name UNIQUE 全表 → (channel_id, name) 复合 UNIQUE 详 §16.3。

```sql
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_location TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (name, owner_location)
);

-- 启动期幂等插入「通用」内置渠道（保留 id=1 给通用）
INSERT OR IGNORE INTO channels (id, name, owner_location, is_builtin, sort_order)
VALUES (1, '通用', '通用', 1, 0);
```

**字段语义**：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `name` | TEXT NOT NULL | 渠道名称（如 "工商" / "通用"） |
| `owner_location` | TEXT NOT NULL | 开户地（如 "上海" / "通用"） |
| `is_builtin` | INTEGER (0/1) | 1 = 系统内置不可删（仅「通用」） |
| `sort_order` | INTEGER DEFAULT 0 | 排序权重（预留，UI 显示按 id + sort_order） |
| `created_at` | TEXT | 创建时间戳 |

**UNIQUE 约束**：`(name, owner_location)` 联合唯一 — 避免重复创建 `工商-上海`。

### 3.2 `scenarios` 表 ALTER

> v0.7 Reverse Sync（2026-05-27 Phase 2 dev agent 实施）：`scenariosRepository.listScenarios()` 返回值附加 `channelId` 字段（兜底 1），便于 T11 UI 按渠道过滤场景。Additive change 不破坏既有消费方。


```sql
-- 幂等检测 + 加列
-- 检查 channel_id 是否已存在
SELECT COUNT(*) FROM pragma_table_info('scenarios') WHERE name='channel_id';
-- 若 = 0：
ALTER TABLE scenarios ADD COLUMN channel_id INTEGER
  REFERENCES channels(id) ON UPDATE CASCADE;

-- backfill 现有 scenarios 到「通用」渠道
UPDATE scenarios SET channel_id = 1 WHERE channel_id IS NULL;
```

**FK 设计**：

- `ON UPDATE CASCADE` — 渠道 id 改变时（理论不会，因为 AUTOINCREMENT）scenarios.channel_id 自动跟随
- **不加** `ON DELETE CASCADE` — 渠道删除时 scenarios 应：(a) 强制转移 / (b) 阻止删除（如有 scenarios）/ (c) 一起删；本版 spec 选 **(b) 阻止删除**（UI 删除按钮检测 scenarios 数量 → 提示先转移）

### 3.3 migration 流程（启动期幂等）

新函数：`ensureSchemaV2_1_9_N5()` in `src/backend/database/migrations.js`

```js
function ensureSchemaV2_1_9_N5(db) {
  // Step 1 — 检测标志位
  const flag = db.prepare("SELECT value FROM settings WHERE key='n5_channels_migrated'").get();
  if (flag?.value === '1') return { skipped: true };

  // Step 2 — 前置自动备份（SR-backup-1 sqlite backup API）
  const backupPath = createBackup('pre-N5');
  activityLog.info(`[N5 migration] 自动备份完成：${backupPath}`);

  try {
    db.exec('BEGIN');

    // Step 3 — 建 channels 表 + 插「通用」
    db.exec(/* §3.1 DDL */);

    // Step 4 — scenarios 加列 + backfill
    const hasChannelIdCol = db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('scenarios') WHERE name='channel_id'"
    ).get().cnt > 0;

    if (!hasChannelIdCol) {
      db.exec(`ALTER TABLE scenarios ADD COLUMN channel_id INTEGER REFERENCES channels(id) ON UPDATE CASCADE`);
    }
    db.exec(`UPDATE scenarios SET channel_id = 1 WHERE channel_id IS NULL`);

    // Step 5 — 写标志位
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('n5_channels_migrated', '1')"
    ).run();

    db.exec('COMMIT');
    activityLog.info(`[N5 migration] 成功`);
    return { migrated: true, backupPath };
  } catch (e) {
    db.exec('ROLLBACK');
    activityLog.error(`[N5 migration] 失败：${e.message}；备份保留 ${backupPath}`);
    throw e;
  }
}
```

**关键设计**：

- 标志位用 `settings` 表（v2.1.8 N4 范式）
- 整段事务包裹 — 失败回滚到迁移前状态
- 备份在事务外 — 失败时备份保留供手动恢复
- 幂等 — 标志位 = '1' 跳过；下次启动重试时不重复建表

---

## 四、UI 设计

### 4.1 场景管理页面顶部（renderer-dialogs.js:5468-5491 改造）

```html
<div class="dialog-header">
  <div class="dialog-title">场景管理</div>
  <!-- v2.1.9 N5 新增 -->
  <label class="channel-filter-label">银行渠道</label>
  <select id="scenario-channel-filter" data-channel-id="1">
    <option value="1">通用-通用</option>
    <!-- 动态注入其他渠道 -->
  </select>
  <button class="secondary-btn small" data-action="manage-channels">管理</button>
  <!-- 现有 -->
  <button class="icon-close" type="button">×</button>
</div>
```

### 4.2 渠道管理弹框

新建 dialog factory `createChannelManagerDialog()`：

```
┌─────────────────────────────────────────┐
│ 银行渠道管理                         × │
├─────────────────────────────────────────┤
│ [新增]                                  │
├─────────────────────────────────────────┤
│  名称       │ 开户地    │ 执行操作       │
├─────────────┼──────────┼────────────────┤
│  通用       │ 通用      │ (内置不可删)    │
│  工商       │ 上海      │ [完成] [删除]   │
│  招商       │ 北京      │ [修改] [删除]   │
└─────────────────────────────────────────┘
```

**「新增」按钮样式**：复用 `createAccountMappingDialog`（账户映射页面）的新增按钮 CSS class + 行为模式 — spec 阶段定位具体 class 名后填入 tasks。

**「完成 / 修改」二态**（D6=a）：

- 新增行 → 默认编辑态，按钮文案「完成」
- 落库后 → 切查看态，按钮文案改「修改」
- 点「修改」 → 切回编辑态，按钮文案改「完成」

**「通用」行特殊处理**（D1=a）：

- 名称/开户地 input disabled
- 删除按钮**不渲染**（v0.7 修订：Phase 3 dev agent 选「不渲染」而非 disabled，更安全防 DevTools 绕过；dataset.builtin="1" 留调试钩子）

**非通用渠道删除按钮**（spec §3.2 (b) 阻止策略）：

- 不做前置场景数查询，依赖 DB 抛错回显（点了才知道）
- 未来 v2.1.10+ 评估前置提示 `[删除] (N 场景)` UX 改进（R3 留挂）

### 4.3 场景行新增「转移」按钮

场景表格「执行操作」列在「管理」按钮（spec 待定具体 label，参 v2.1.8 N3 现状）右侧加：

```html
<button class="text-btn small" data-action="transfer-scenario" data-id="${scenario.id}">
  转移
</button>
```

点击 → 弹「转移到的目标银行渠道」框：

```
┌─────────────────────────────────────┐
│ 请选择转移到的目标银行渠道           │
├─────────────────────────────────────┤
│ [▼ 工商-上海                  ]    │
│                                     │
│                         [完成]      │
└─────────────────────────────────────┘
```

- 单选下拉框枚举 = channels 表（**不含当前所在渠道**）
- 「完成」点击 → `UPDATE scenarios SET channel_id=? WHERE id=?` + UI 立即刷新

### 4.4 「批量操作」按钮

footer 「新增场景」右侧新增「批量操作」：

- 点击 → 表格左侧出现勾选框列（每行 + 表头全选）
- 同时「批量操作」右侧出现「转移」「删除」两按钮
- 「转移」走单条转移弹框（目标=单选）
- 「删除」走批量删除确认框

### 4.5 footer 按钮顺序（D8=a + N7-1）

```
[新增场景] [批量操作] [导入模板文件] [导出模板文件] [完成]
```

> 注：D8=a 原拍板 `新增场景 / 导入模板 / 导出模板 / 完成`；「批量操作」是 N5-7 新增按钮，按用户表述插入「新增场景」右侧。

---

## 五、独立报表 writer 设计

### 5.1 落位与命名（D14=a + D15=a）

```js
const reportDir = path.join(
  app.getPath('documents'),
  '网银账单生成小助手',
  'error-reports',
  formatDate(new Date(), 'YYYYMMDD')
);

const baseName = path.basename(originalFilePath, path.extname(originalFilePath));
const timestamp = formatTimestamp(new Date());  // YYYYMMDDTHHmmss
const fileName = `命中场景行-${baseName}-${timestamp}.xlsx`;
const fullPath = path.join(reportDir, fileName);
```

### 5.2 列结构（D16=b ✅ + D17=b）

> v0.9 SR-FIX-1 Reverse Sync（SR1 #5 修订）：D16 已从 (a) 修订到 (b) — 「匹配渠道」列取**实际命中场景所属渠道 label**（详 §1.1 D16）。本表描述同步更新。

```
| 原 44 列银行账单 headers ... | 匹配渠道 | 匹配状态 | 命中场景 |
```

| 列 | 取值 | 示例 |
|---|---|---|
| 原 44 列 | bank-statement-fields headers | （v2.1.6 标准银行字段） |
| 匹配渠道 | **D16=b**：实际命中场景所属渠道 label；命中专属 → `${name}-${ownerLocation}`；命中通用兜底 → `通用`；未命中 → 空字符串 | `工商-上海` / `通用` / `` |
| 匹配状态 | `命中` / `兜底` | （由 _matchStatus 字段决定 — 行匹配到专属渠道 = 命中；未匹配 = 兜底） |
| 命中场景 | `[displayIndex] ${scenarioName}` | `[1] 工行上海对账场景` |

**writer 实现要点**（dispatcher 写 `_hitChannelId` → writer 反查 channels.label）：

```js
const channels = channelsRepo.listChannels(db);
const channelLabelById = new Map(channels.map(c => [
  c.id, c.isBuiltin ? '通用' : `${c.name}-${c.ownerLocation}`
]));

const matchedLabel = row._hitChannelId
  ? channelLabelById.get(row._hitChannelId) || ''
  : '';
cells.push(matchedLabel);
```

### 5.3 writer 实现（新建 `src/main-process/scenario-hit-rows-writer.js`）

```js
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function writeScenarioHitRows(modifiedRows, originalFilePath, opts = {}) {
  // ...
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('命中场景行');

  // 表头
  const headers = [...STANDARD_BANK_HEADERS_44, '匹配渠道', '匹配状态', '命中场景'];
  ws.addRow(headers);

  // 行
  for (const row of modifiedRows) {
    const cells = STANDARD_BANK_HEADERS_44.map(h => row[h] ?? '');
    cells.push(row._hitChannelKey || '');
    cells.push(row._matchStatus || '');
    cells.push(
      row._hitScenarioId
        ? `[${row._hitScenarioDisplayIndex}] ${row._hitScenarioName}`
        : ''
    );
    ws.addRow(cells);
  }

  await wb.xlsx.writeFile(fullPath);
  return fullPath;
}
```

### 5.4 主输出 xlsx Sheet 3 撤除（破坏性 — exceljs-writer.js）

v2.1.8 N3-2 引入的 Sheet 3「命中场景行」写入分支**全部删除**：

```js
// 删除 v2.1.8 N3-2 引入的代码段：
// if (ENABLE_SHEET3) {
//   const ws3 = wb.addWorksheet('命中场景行');
//   ...
// }
```

Sheet 1（渠道对账单）+ Sheet 2（未命中场景行）写入逻辑保持不变。

---

## 六、N7 bundle 设计

### 6.1 bundle 文件结构（D9=b + D10=a）

完整示例：

```json
{
  "scenarioBundleVersion": 1,
  "exportedAt": "2026-05-27T10:30:00",
  "appVersion": "2.1.9",
  "channels": [
    {
      "name": "工商",
      "ownerLocation": "上海",
      "isBuiltin": 0,
      "scenarios": [
        {
          "category": "gateway-recon-join",
          "name": "工行上海对账场景",
          "sortOrder": 1,
          "enabled": 1,
          "configJson": {
            "assign": { "mode": "direct", "gwField": "Amount", "bankField": "Credit Amount" }
          }
        },
        {
          "category": "extract-recon-id",
          "name": "工行上海提取 ReconID",
          "sortOrder": 2,
          "enabled": 1,
          "configJson": { /* ... */ }
        }
      ]
    },
    {
      "name": "通用",
      "ownerLocation": "通用",
      "isBuiltin": 1,
      "scenarios": [ /* ... */ ]
    }
  ]
}
```

### 6.2 reader 类型识别

```js
function detectBundleType(json) {
  if ('scenarioBundleVersion' in json) return 'scenarios';
  if ('bundleVersion' in json) return 'template';
  throw new Error('未知 bundle 类型');
}
```

入口分流：

- 场景管理「导入模板文件」 → 仅接受 `scenarios` 类型
- 模板管理「导入模板文件」（现有，`renderer-dialogs.js:2646`） → 仅接受 `template` 类型

### 6.3 导入冲突处理

#### 6.3.1 缺失渠道（D11=a）

```js
// 解析后扫描
const missingChannels = bundle.channels.filter(c =>
  !c.isBuiltin && !channelRepo.findByNameAndLocation(c.name, c.ownerLocation)
);

if (missingChannels.length > 0) {
  // 弹确认框
  const confirmed = await showConfirmDialog({
    title: '即将创建以下渠道',
    body: missingChannels.map(c => `${c.name}-${c.ownerLocation}`).join('\n'),
    buttons: ['取消', '确认创建']
  });
  if (!confirmed) return { status: 'cancelled' };
}
```

#### 6.3.2 同名场景冲突（D12=a）

> v0.9 SR-FIX-1 Reverse Sync（SR1 #3 修订）：v0.8 实施时 scenarios.name 仍是**全表 UNIQUE**（migrations.js:407/519/571），跨渠道复用同名会被 catch 全表 UNIQUE 错误误判为「冲突跳过」（如「通用」有「工行对账场景」+ 导入「工商-上海」也叫「工行对账场景」→ 应该按 channel 内 UNIQUE 允许并存，但实际被跳过）。SR-FIX-1 D39 修订 UNIQUE 为 (channel_id, name)，本节 `findByChannelAndName` + catch 逻辑配套修订；详 §16.3。

```js
const conflicts = [];
for (const channel of bundle.channels) {
  for (const scenario of channel.scenarios) {
    const exists = scenariosRepo.findByChannelAndName(targetChannelId, scenario.name);
    if (exists) {
      conflicts.push({ channel: channel.name, scenario: scenario.name });
      continue;  // 跳过
    }
    scenariosRepo.insert({ ...scenario, channelId: targetChannelId });
  }
}

// 结果框
showResultDialog({
  title: '导入完成',
  body: `成功导入 ${importedCount} 场景；${conflicts.length} 同名冲突跳过`,
  conflicts,
});
```

---

## 七、N6 状态框换行修复

### 7.1 现状定位（基于 grep 确证 2026-05-27）

**外层文案位置**：

- 文案：`src/renderer.js:3338, 3351`
  - `已导出：\n${ex.mainFileName}` — `:3338`
  - `已导入：\n${bs.fileName}` — `:3351`
  - `已处理：${pr.hitRowCount} 行命中${idsText}...` — `:3345`（**无 `\n`，不冗余**）

**内层位置**：`src/renderer.js:542-566` `updateStatusBox` 函数

- `:554` 关键逻辑：`String(message).replace(/：/g, '：\n')`
- 注释明确：`v2.1.7 round 2 R3：中文「：」（U+FF1A）后强制换行；半角 ':' 不动（避开 URL/timestamp/账号 case）`；spec §8.4.2 有意设计

**渲染**：CSS `.status-box-text { white-space: pre-wrap; }` 识别 `\n`

**Grep 全文件 `：\n` 模式（仅 statusBox 文案相关）**：

| 行号 | 位置 | 是否 statusBox 文案 | 是否冗余 |
|---|---|---|---|
| 554 | `updateStatusBox` 内层 replace | 内层主逻辑 | — |
| 660 / 665 | `window.alert(...)` | ❌ 非 statusBox | 不相关 |
| **3338** | **`已导出：\n${...}` 银行对账单** | ✅ 银行对账单 | ⚠️ **冗余 → bug 源** |
| **3351** | **`已导入：\n${...}` 银行对账单** | ✅ 银行对账单 | ⚠️ **冗余 → bug 源** |
| 4164 | 注释说明 | — | 不相关 |

**其他 5 个 statusBox 调用方文案样本**（30+ 处全部抽样）：

| 模块 | 调用 | 文案样本 | `：\n` 模式 |
|---|---|---|---|
| 主面板（`setStatus`） | `:574` | `当前账户映射条数：${accountMappingCount}` | ❌ 无 |
| 新账户（`setNewAccountStatus`） | `:583` | `result.message` 透传 | ❌ 无 |
| 业银对账（`setBankBuReconStatus`） | `:3938` | `${yearMonth}：已取消...` / `导入失败：${msg}${detail}` / `差异表已生成：${path}` | ❌ 无 |
| 业务运营对账（`setBizOpReconStatus`） | `:4168` | `${date}：已取消...` / `业务OP 导入失败：${msg}${detail}` | ❌ 无 |
| C4 修复（`reconIdFixStatusBox`） | `:3711` | 同模式 | ❌ 无 |

→ **结论**：其他 5 个模块所有 `xxx：${...}` 文案**全部依赖** v2.1.7 round 2 R3 内层 `replace` 提供「：」后单次换行。**银行对账单是唯一外层带 `\n` 的模块**。

### 7.2 修订后推荐：D18 = (a) 改外层文案

**之前 v0.1 草稿推 (b) 改内层 —— 基于 grep 事实推翻**。

**(a) vs (b) 影响重新对比**：

| 维度 | (a) 改外层文案 | (b) 改内层 updateStatusBox |
|---|---|---|
| 改动范围 | `renderer.js:3338, 3351` 2 行 | `renderer.js:554` 1 行 |
| 影响 statusBox 数 | **1 个**（精确，银行对账单） | **6 个**（全部其他模块） |
| 用户原意符合度 | ✅ 用户原话「银行对账单处理模块」 | ❌ 全局改，波及其他模块 |
| 破坏其他模块风险 | ✅ 零外溢 | ❌ 其他 5 模块所有 `xxx：${...}` 文案塌成一行（如 `2026-05：已取消...` 当前两行 → 改后一行） |
| 推翻已有 spec | ✅ 否（保留 R3 设计 + §8.4.2） | ❌ 推翻 v2.1.7 round 2 R3 §8.4.2 |

**(b) 静默破坏 5 个模块视觉** + **超出用户原话范围** → 否决。

### 7.3 具体改动（D18 = a）

```js
// renderer.js:3338 改前
text = `已导出：\n${ex.mainFileName}`;
// 改后
text = `已导出：${ex.mainFileName}`;
// 行 :3339 保留：
//   if (ex.errorReportName) text += `\nerror-report：${ex.errorReportName}`;
//                                   ^^^^^^^^^ 这是行间换行，非冒号后冗余

// renderer.js:3351 改前
text = `已导入：\n${bs.fileName}（${bs.rowCount} 行）`;
// 改后
text = `已导入：${bs.fileName}（${bs.rowCount} 行）`;
// 行 :3352 保留：
//   if (gw) text += `\n不平账结果表：${gw.fileName}（${gw.rowCount} 行）`;
//                   ^^^^^^^^ 这是行间换行，非冒号后冗余
```

### 7.4 验收

- preview 截图 `npm run preview` 4 个状态与 v2.1.8 对比，**银行对账单冒号后换行数从 2 → 1**
- **其他 5 模块 statusBox 视觉无差异**（业银对账 / 业务运营对账 / C4 修复 / 主面板 / 新账户）
- 内层 `updateStatusBox`（`renderer.js:542-566`）零改动，R3 设计完整保留

---

## 八、SR-backup-1 sqlite backup API 改造

### 8.1 现状

v2.1.8 N4 备份用 `fs.copyFileSync`（`migrations.js` ensureBillRawJsonV2Slim 内部）— self-review SR2 Important-1 沉淀。

### 8.2 改造方案（v0.6 Reverse Sync — POC 2026-05-27 验证 API 不存在，方案调整）

**POC 关键发现**：

- ❌ Node 22 `node:sqlite` `DatabaseSync` 类**没有** `.backup()` 方法
- ✅ `VACUUM INTO 'path'`（SQLite 3.27+ 标准 SQL）可用 + 原子 + WAL 安全

**最终方案**：`src/backend/database/backup.js`（已实现 v2.1.9 Phase 1）：

```js
const fs = require('fs');
const path = require('path');

const SAFE_LABEL_RE = /^[A-Za-z0-9_-]+$/;

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createBackup(db, label, backupDir) {
  // 校验 db / label / backupDir
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = formatTimestamp();
  const fileName = `tool-data-bak-${label}-${timestamp}.sqlite`;
  const destPath = path.join(backupDir, fileName);
  const tmpPath = `${destPath}.tmp`;
  try {
    const escapedTmp = tmpPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedTmp}'`);  // SQLite 原子写
    fs.renameSync(tmpPath, destPath);         // atomic rename 双重保险
    return destPath;
  } catch (e) {
    if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`createBackup 失败 (label=${label}): ${e.message}`);
  }
}
```

`AppDatabase` 实例方法暴露（`src/backend/database.js`）：

```js
createBackup(label) {
  const backupDir = path.join(path.dirname(this.dbPath), 'backups');
  return createBackupImpl(this.db, label, backupDir);
}
```

**关键设计**：

- **VACUUM INTO**：SQLite 内部原子写 + WAL 安全 + 备份过程库可读不锁写 + 文件大小可能更小（顺带 VACUUM 整理）
- **tmp 文件名 + atomic rename**：双重保险 — VACUUM 中途失败不留半文件
- **label 白名单 `[A-Za-z0-9_-]`**：防 SQL 注入（label 拼入 SQL 字符串）+ 防文件名特殊字符
- **mkdirSync recursive**：自动建目录
- **路径转义** `'` → `''`：VACUUM INTO 单引号字符串安全

**验证**：16 unit case 全绿（`tests/unit/backend/database/backup.test.js`），含 SQL 注入字符拒绝、tmp 文件无残留、备份过程库可读、备份是 snapshot 不含后续写入等场景。

### 8.3 N4 / N5 共享接口

- N4 migration 已合并 main，改用 `createBackup(db, 'pre-N4')` —— 本版本可顺手重构 OR 留 N4-cont-1/2 处理
- **PM 建议**：N4 重构留 v2.1.10；本版仅新建 backup.js 供 N5 使用，N4 后续版本一起 unify

---

## 九、重要变量影响（待 scan:vars 详查）

预计触及（spec 阶段 `npm run scan:vars` 后定稿）：

| 层级 | 变量 | 文件 | 升格建议 |
|---|---|---|---|
| 🔴 Critical | `scenarios.channel_id` | scenarios-repository / migrations | **新增 Critical** |
| 🔴 Critical | `channels` 表 | migrations / channels-repository | **新增 Critical** |
| 🔴 Critical | `dispatcher.firstMatchWins 双阶段` | scenario-dispatcher | 升 Critical（已 Important-skeleton） |
| 🟡 Important-skeleton | `processingResult._hitChannelKey` | scenario-dispatcher / writers | 新增 Important-skeleton |
| 🟡 Important-skeleton | `processingResult._matchStatus` | scenario-dispatcher / writers | 新增 Important-skeleton |
| 🟡 Important-skeleton | `SUPPORTED_SCENARIO_BUNDLE_VERSION` | main.js | 新增 Important-skeleton |
| 🟢 Runtime-state | scenarios-bundle 文件 schema | scenarios-bundle-io | Runtime-state |

---

## 十、风险红线总结

### 10.1 资金红线条目（CLAUDE.md 规则 7 触发）

| 风险项 | 描述 | 缓解 |
|---|---|---|
| dispatcher 双维改造 | 调度模型变更，可能影响金额/字段计算结果 | 集成测试 ≥ 6 个新增渠道维度用例；0 regression 硬约束 |
| DB schema 破坏性 migration | channels 表 + scenarios.channel_id FK + backfill | SR-backup-1 前置 + 事务包裹 + 标志位幂等 + 失败回滚 |
| Sheet 3 输出契约变更（v2.1.8 加 → v2.1.9 拆） | 用户后处理脚本可能依赖 Sheet 3 | USER_GUIDE / CHANGELOG 显式说明 + PR body 警示 |
| 转移搬运语义不可逆 | A→B 后无法自动恢复到 A | UI 二次确认 + 活动日志记录 |
| 「通用」渠道删除保护 | 万一被绕过会导致所有 fallback 失败 | is_builtin 列 + UI button disabled + DB CHECK 约束（spec 评估） |

### 10.2 兼容性红线

| 风险项 | 描述 | 缓解 |
|---|---|---|
| bundle 类型互认 | scenarioBundleVersion vs bundleVersion 误用 | reader 严格按顶层 key 分流 + 类型不匹配报错 |
| 老用户升级路径 | v2.1.8 PR #52 已发，v2.1.9 立即破坏 Sheet 3 | CHANGELOG 显著位置说明 + 提示用户检查后处理脚本 |
| 集成测试断言数 | v2.1.8 累计 ~1276 断言；v2.1.9 新增 ~200 断言 | 0 regression 硬约束（release-check gate） |

---

## 十一、G1-cont 单元测试全量铺设计

### 11.1 范围（37 个 test 文件）

**第 1 层（纯函数，剩余 13 文件）**：

```
tests/unit/backend/file-service/
  common.test.js                          # FileValidationError 构造/序列化
  error-causes.test.js                    # 错误分类映射
tests/unit/backend/acquiring-bill-currency-import/
  validator.test.js
tests/unit/backend/bank-bu-recon-import/
  validator.test.js
tests/unit/backend/biz-op-recon-import/
  validator.test.js
tests/unit/backend/pending-import/
  validator.test.js
tests/unit/main-process/scenario-engines/
  engine-utils.test.js
  c1-extract-recon-id.test.js
  c2-offset-bill-mark.test.js
  c3-gateway-recon-join.test.js           # v2.1.8 N2 已部分覆盖；本版补剩余分支
  c4-recon-id-fix.test.js                 # v2.1.8 已铺；本版补剩余函数
tests/unit/constants/
  bank-statement-fields.test.js           # 字段表自洽性
  gateway-recon-fields.test.js
  ...（其他 constants 按需）
tests/unit/backend/*-db/
  columns.test.js × 4                     # acquiring-bill / bank-bu / biz-op / pending
```

**第 2 层（带 fixture，24 文件）**：

```
tests/unit/backend/database/
  template-repository.test.js
  scenarios-repository.test.js            # 含 v2.1.9 N5 listByChannelIdAndCategory
  channels-repository.test.js             # v2.1.9 N5 新建
  settings-repository.test.js
tests/unit/backend/
  balance-seed-store.test.js
  balance-adjustment-store.test.js
  big-account-mode-store.test.js
  big-account-order-store.test.js
  own-account-store.test.js
tests/unit/backend/file-service/
  readers.test.js                         # tmpdir + 小 fixture xlsx
  writers.test.js
tests/unit/backend/pending-db/
  ...repository.test.js × 4
tests/unit/backend/acquiring-bill-currency-db/
  ...repository.test.js × 2
tests/unit/backend/bank-bu-recon-db/
  ...repository.test.js × 2
tests/unit/backend/biz-op-recon-db/
  ...repository.test.js × 3
tests/unit/main-process/
  monthly-balance.test.js
  recon-id-fix-engine.test.js
  statement-generation.test.js
```

### 11.2 case 模板（v2.1.8 已建）

```js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('<模块名>', () => {
  describe('<函数名>', () => {
    test('正常路径', () => {
      assert.strictEqual(fn(input), expected);
    });
    test('边界 - 空输入', () => { ... });
    test('边界 - null/undefined', () => { ... });
    test('异常路径', () => {
      assert.throws(() => fn(invalidInput), /错误信息/);
    });
  });
});
```

### 11.3 case 期望值权威性评审

每个新 case PR review 时必须确认：

- ✅ 期望值反映**业务真实**（如金额计算应该是 X）
- ❌ 期望值反映**实现现状**（如目前代码返回 Y，无论对错都期望 Y）

如发现期望值=实现现状但与业务真实冲突 → **优先修代码**（不修 case 期望值）。

### 11.4 与 v2.1.8 N3-1 / N4 / N1' / N2 已铺 case 协同

- v2.1.8 已铺 case 不动（除非发现期望值错误）
- v2.1.9 新铺 case 与 v2.1.8 同范式（describe / test / assert）
- 如同文件 v2.1.8 已部分覆盖（如 c3 / c4），本版补充剩余分支，不破坏既有

### 11.5 验收

- `npm run test:unit` 累计 case ≥ 400 全绿（v2.1.8 基线 123 + v2.1.9 新增 ~280+）
- 第 1 层 14 文件全覆盖（v2.1.8 已 1 + v2.1.9 新 13 = 14）
- 第 2 层 24 文件全覆盖
- README 更新示例 + fixture 复用说明

---

## 十二、SR-policy-1 integration-runner 自动同步清单设计

### 12.1 背景

`scripts/integration-runner.js` 跑完后人工维护 `rules/integration-test-policy.md §七 当前清单` markdown 表（v2.1.8 SR4 沉淀）。本版自动化。

### 12.2 D20=(c) 设计 — in-place 编辑

#### 12.2.1 输出格式

`rules/integration-test-policy.md` §七 章节内插入/更新：

```markdown
## 七、当前清单

<!-- auto-generated by scripts/integration-runner.js, last-updated: 2026-05-27T18:30:00+08:00 -->
<!-- DO NOT EDIT MANUALLY — modify scripts/integration/*.js then re-run -->

| 脚本 | 用例数 | 断言数 | 耗时 (ms) |
|---|---|---|---|
| acquiring-bill-currency.js | 12 | 245 | 320 |
| v2.1.9-n5-channel-dispatch.js | 6 | 156 | 180 |
| v2.1.9-n5-migration.js | 3 | 48 | 95 |
| v2.1.9-n7-bundle.js | 5 | 110 | 145 |
| bank-bu-recon.js | 4 | 88 | 60 |
| ... | ... | ... | ... |
| **合计** | **N** | **M** | **T** |
```

#### 12.2.2 实现伪代码（v0.8 Reverse Sync — 2026-05-27 Phase 8.5 实施）

**JS regex 不支持 `\Z` 锚点**，改用 `$(?![\s\S])` 等价写法：

```js
// scripts/integration-runner.js 末尾
function syncPolicyChecklist(results) {
  const policyPath = path.join(__dirname, '..', 'rules', 'integration-test-policy.md');
  const original = fs.readFileSync(policyPath, 'utf8');

  // 用正则定位 §七 章节（结尾用 $(?![\s\S]) 替代 \Z，JS regex 兼容）
  const sectionMarker = /## 七、当前清单[\s\S]*?(?=^## |$(?![\s\S]))/m;
  const newSection = buildPolicyChecklistSection(results); // 含时间戳 + DO NOT EDIT 注释

  const updated = original.replace(sectionMarker, newSection);
  if (updated !== original) {
    fs.writeFileSync(policyPath, updated, 'utf8');
    console.log('[SR-policy-1] integration-test-policy.md §七 已自动同步');
  }
  console.log('\n=== 当前清单 ===\n' + newSection); // 同时输出 stdout
}

// 全 PASS 才同步（FAIL 时跳过避免覆盖损坏数据）
if (allPassed) syncPolicyChecklist(results);

// require.main === module 守卫（便于 unit test require）
if (require.main === module) main();
```

时间戳格式：`<!-- last-updated: YYYY-MM-DDTHH:mm:ss+08:00 -->`（固定东八区）
DO NOT EDIT 注释：`<!-- DO NOT EDIT MANUALLY — modify scripts/integration/*.js then re-run -->`

#### 12.2.3 git diff 控制

- 时间戳行变化每次跑都会引入 diff（接受作为审计痕迹）
- 表内容变化 = 真实清单变更（必须 commit）
- 若发现频繁噪音 → 评估改为时间戳 floor 到天（每日只更新一次）

### 12.3 验收

- 集成测试新增用例自动同步到清单
- 时间戳每次刷新（commit 时纳入）
- `rules/integration-test-policy.md §七` 与 `scripts/integration/*.js` 实际清单 0 偏差

---

## 十三、N1-settings idle 阈值 settings 化设计

### 13.1 现状

`src/main.js` 内 `IDLE_CLEANUP_MS = 30 * 60 * 1000` 常量（v2.1.8 N1''-D8 锁硬编码）。

### 13.2 D21=(a) 设计 — 应用设置弹框新增字段

#### 13.2.1 settings 表

新增键 `acquiring_bill_idle_cleanup_minutes`：

```sql
-- migration 期幂等插入默认值 30
INSERT OR IGNORE INTO settings (key, value)
VALUES ('acquiring_bill_idle_cleanup_minutes', '30');
```

#### 13.2.2 main.js 读取 + 监听

```js
// 启动时
const IDLE_CLEANUP_MINUTES = parseInt(
  settingsRepo.get(db, 'acquiring_bill_idle_cleanup_minutes') || '30',
  10
);
const IDLE_CLEANUP_MS = IDLE_CLEANUP_MINUTES * 60 * 1000;

// settings 更新时（IPC `settings:set`）
function onSettingsChange(key, newValue) {
  if (key === 'acquiring_bill_idle_cleanup_minutes') {
    const minutes = parseInt(newValue, 10);
    if (minutes >= 5 && minutes <= 180) {
      idleTimer.update(minutes * 60 * 1000);
    } else {
      throw new Error('idle 阈值必须在 5-180 分钟范围内');
    }
  }
}
```

#### 13.2.3 设置弹框 UI（v0.8 Reverse Sync — 2026-05-27 Phase 8.6 实施）

**实际现状**：grep 后未发现现成 `createAppSettingsDialog` factory。Phase 8.6 dev agent 新建该 factory + 在 `index.html` 加入口按钮 `appSettingsBtn` ⚙️（紧贴 moduleCabinetBtn 右侧）+ `src/renderer.js` 加 element + click handler。

涉及文件（9 个，超 3-5 软约束但跨层级所必需）：

- `src/renderer-dialogs.js`（新建 `createAppSettingsDialog` factory）
- `src/renderer.js`（+ import + elements.appSettingsBtn + click handler）
- `index.html`（+ `appSettingsBtn` DOM ⚙️）
- `src/main.js`（IDLE_CLEANUP_MS const→let + `loadIdleCleanupMsFromSettings`）
- `src/preload.js`（+ desktopApi.settings.* 2 接口）
- `src/backend/database/migrations.js`（+ `ensureAcquiringBillIdleCleanupMinutesSetting`）
- `src/backend/database/settings-repository.js`（+ get/set 范围 5-180 校验）
- `src/backend/database.js`（+ 3 实例方法 + migration 调用）
- `tests/unit/backend/database/settings-repository-idle-cleanup.test.js`（+ 15 case）

字段示例：

```html
<div class="settings-field">
  <label>收单单据 idle 清理阈值</label>
  <input type="number" min="5" max="180" value="30" id="idle-cleanup-minutes">
  <span class="unit">分钟</span>
  <span class="hint">范围 5-180 分钟，默认 30 分钟；超时自动清理收单 cleanup_pending=1 的 runs 数据</span>
</div>
```

#### 13.2.4 校验

- 前端 input min=5 max=180 + 保存按钮校验
- 后端 IPC handler 二次校验 + 范围外抛错

### 13.3 验收

- 设置弹框可改值，重启后生效
- 改值后**无需重启**也即时生效（settings 监听）
- 范围外值（如 0 / 200）前端 + 后端双校验报错
- smoke 用例：(1) 默认 30min 行为不变；(2) 改 60min 后 idle 触发计时器读新值

---

## 十四、N4 重构（顺带）— migration 备份切换设计

### 14.1 D22=(a) 设计 — 是

#### 14.1.1 改动点（v0.8 Reverse Sync — 2026-05-27 Phase 8.7 实施）

**实际签名**：`ensureBillRawJsonV2Slim(db, dbPath, createBackupFn)` —— 加第三参 `createBackupFn`（函数注入），AppDatabase wrapper 传 `(label) => this.createBackup(label)`。

```js
// 改前（v2.1.8）
fs.copyFileSync(srcDbPath, backupPath);
activityLog.info(`[N4 migration] 备份完成：${backupPath}`);

// 改后（v2.1.9 Phase 8.7）
const backupPath = createBackupFn('pre-N4'); // VACUUM INTO + atomic rename
activityLog.info(`[N4 migration] 备份完成：${backupPath}`);
```

**调用方契约变更（必须同步改造）**：

- `src/backend/database.js` wrapper：传 createBackupFn
- `scripts/integration/acquiring-bill-currency-n4-migration.js`（4 处直调 ensureBillRawJsonV2Slim）：传 createBackupFn
- `scripts/smoke/acquiring-bill-currency.js`（2 处）：传 createBackupFn

**向后兼容**：createBackupFn 缺失时跳过备份阶段但 migration 继续（避免破坏老调用方）。

#### 14.1.2 不改清单

- 主流程逻辑不变
- 标志位 `settings.bill_raw_json_v2_migrated` 不变
- 事务包裹 + 失败回滚 + 标志位幂等 不变
- 备份路径前缀 `tool-data-bak-pre-N4-{timestamp}.sqlite` 不变（v2.1.8 已发契约护栏）
- raw_json 9 字段裁剪规则不变

### 14.2 验收

- v2.1.8 N4 smoke 全跑 0 regression（标志位 / 备份文件 / raw_json 字段 9 列）
- 备份文件路径仍是 `<userData>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite`
- 文件大小 = 库大小（atomic 不出半文件）
- 大库（500MB+）备份过程主进程不阻塞

---

## 十五、SR-log-1 全局告警统一日志化详设（新立项）

### 15.1 现状审计（基于 grep）

| 告警源 | 数量 | 走 activityLog | 持久化率 |
|---|---|---|---|
| main `appendActivityLogEntry` 调用 | 41 处 | 100% | ✅ |
| main `console.error / console.warn` | 49 处 | **0%** | ❌（打包后用户机器看不到） |
| renderer `setStatus` error/warning tone | 45 处 | **0%** | ❌（关闭即失） |
| renderer `createAlertDialog` 错误弹框 | ~50 处 | **0%** | ❌ |
| renderer `console.error / console.warn` | ~30 处 | **0%** | ❌ |
| **合计告警** | **~215 处** | **41 处** | **覆盖率 ≈ 19%** |

**已存在基础设施**（`src/backend/logger.js`）：

- `appendActivityRecord(filePath, payload)` 函数（行 108）
- 现格式 `[time] [LEVEL] message | details`，按日期 header 分组同文件
- `appendActivityLogEntry` 主入口（main.js:514）

**缺口**：
1. preload 仅 `reportStartupMetrics` + `reportUserActivity`，**无通用告警上报 IPC**
2. 49 处 main console.error 未配套 `appendActivityLogEntry`
3. 项目无 ESLint（devDeps 仅 3 个）

### 15.2 日志目录结构（D29 修订）

```
Documents/网银账单生成小助手/
├── app_activity_log.txt              # D34=a 保留双写
├── logs/                             # D29 新结构
│   ├── 2026-05/                      ← 月级归档
│   │   ├── 05-27/                    ← 日级目录
│   │   │   ├── error.log             ← JSON Lines
│   │   │   ├── warning.log
│   │   │   └── info.log
│   │   ├── 05-28/
│   │   └── ...
│   ├── 2026-06/
│   └── 2027-05/                      ← 跨年自然归档
└── error-reports/                    # 业务专属，不动
```

**路径函数伪代码**：

```js
function getLogFilePath(level, date = new Date()) {
  const yyyyMm = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const mmDd = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const logsDir = path.join(getStorageRoot(), 'logs', yyyyMm, mmDd);
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, `${level}.log`);
}
```

### 15.3 JSON Lines 行格式（D31）

每行一个 JSON 对象（无逗号 / 无外层 array），便于流式 append + 流式解析：

```jsonl
{"ts":"2026-05-27T14:32:18.456+08:00","level":"error","source":"renderer","domain":"db","message":"数据库连接失败","details":["ECONNREFUSED","retry=3"],"stack":"Error: ..."}
{"ts":"2026-05-27T14:32:19.012+08:00","level":"warning","source":"main","domain":"migration","message":"N5 channels 表创建","details":["channels.id=1"]}
```

**字段 schema**：

| 字段 | 类型 | 必填 | 含义 | 默认值 |
|---|---|---|---|---|
| `ts` | ISO 8601 with TZ | 是 | 时间戳（精度 ms） | new Date().toISOString() |
| `level` | enum: error/warning/info | 是 | 级别 | — |
| `source` | enum: main/renderer | 是 | 进程来源 | — |
| `domain` | string | 否 | 可选域标签 | `'unknown'` |
| `message` | string | 是 | 主消息 | — |
| `details` | string[] | 否 | 附加细节列表 | `[]` |
| `stack` | string | 否 | error 时附 stack trace | undefined |

**写入实现**（`src/backend/logger.js` 扩展）：

```js
function appendStructuredLog(payload) {
  const filePath = getLogFilePath(payload.level || 'info');
  const line = JSON.stringify({
    ts: payload.ts || new Date().toISOString(),
    level: payload.level,
    source: payload.source,
    domain: payload.domain || 'unknown',
    message: payload.message,
    details: payload.details || [],
    ...(payload.stack ? { stack: payload.stack } : {})
  }) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}
```

### 15.4 preload IPC（D33-a）

```js
// src/preload.js
contextBridge.exposeInMainWorld('desktopApi', {
  // ...existing...
  reportLog: (payload) => ipcRenderer.send('app:report-log', payload),
});
```

```js
// src/main.js
ipcMain.on('app:report-log', (event, payload) => {
  appendActivityLogEntry({
    level: payload.level || 'info',
    source: payload.source || 'renderer',
    domain: payload.domain,
    message: payload.message,
    details: payload.details || [],
    stack: payload.stack,
  });
});
```

### 15.5 renderer wrapper hijack（D33-c）

**setStatus 内部**：

```js
// src/renderer.js
function setStatus(message, tone = 'info', options = {}) {
  // ...existing 现有 4 状态文案逻辑...

  // SR-log-1 wrapper hijack（v2.1.9 新增）
  if (tone === 'error' || tone === 'warning') {
    try {
      desktopApi.reportLog({
        level: tone,
        source: 'renderer',
        domain: options.logDomain || 'ui',
        message,
        details: options.details || [],
      });
    } catch (e) {
      // graceful — wrapper 异常不阻塞 UI
    }
  }
}
```

**createAlertDialog 工厂内部**：

```js
// src/renderer-dialogs.js
function createAlertDialog(message, opts = {}) {
  // SR-log-1 wrapper hijack
  try {
    desktopApi.reportLog({
      level: opts.logLevel || 'error',
      source: 'renderer',
      domain: opts.logDomain || 'ui',
      message,
    });
  } catch (e) {}

  // ...existing dialog 渲染逻辑...
}
```

**关键**：调用方**零改动**，所有现有 `setStatus(msg, 'error')` / `openModal(createAlertDialog(msg))` 自动上报。

### 15.6 main 端 49 处 console.error 改造（grep 驱动）

**改造前**：
```js
console.error('[xxx] 失败', err);
```

**改造后**：
```js
appendActivityLogEntry({
  level: 'error',
  source: 'main',
  domain: 'xxx',
  message: '[xxx] 失败',
  details: [err.message],
  stack: err.stack,
});
```

**批量改造步骤**：

1. `grep -rn "console\.error\|console\.warn" src/main.js src/main-process/ src/backend/ --include="*.js"` → 列 49+ 处
2. 按文件批量改（每文件单独 commit）
3. 改完 grep 重新确认 = 0 命中（除 logger.js 内部错误兜底外）

### 15.7 双写兼容（D34=a）

`appendActivityRecord`（`logger.js:108`）内部同时写：

1. 旧路径 `app_activity_log.txt`（保持现状）
2. 新路径 `logs/{YYYY-MM}/{MM-DD}/{level}.log`（JSON Lines）

```js
function appendActivityRecord(legacyFilePath, payload) {
  // 1. 旧路径写（v2.1.8 行为不变）
  appendLegacyLog(legacyFilePath, payload);
  // 2. 新路径写（SR-log-1）
  appendStructuredLog(payload);
}
```

v2.1.10 评估是否删旧（视用户反馈）。

### 15.8 重要变量影响

| 层级 | 变量 | 文件 | 升格建议 |
|---|---|---|---|
| 🟡 Important-skeleton | `desktopApi.reportLog` IPC 接口 | preload.js + main.js | 新增 Important-skeleton |
| 🟡 Important-skeleton | `appendActivityRecord` 双写实现 | logger.js | 升级 Important-skeleton |
| 🟢 Runtime-state | `getLogFilePath` 函数 | logger.js | Runtime-state |
| 🟢 Runtime-state | JSON Lines schema 字段 | logger.js | Runtime-state（向前兼容 — 不变 + 加） |

scan:vars 阶段二次确认。

### 15.9 永久保留风险（D32=a）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 日志目录无限增长 | 🟡 数据保留 | USER_GUIDE 写明日志位置 + 用户可手动清理 |
| 跑 1 年 ~365 日期目录 | 🟢 已 D29 月份归档优化 | 月份目录便于按月批量清理 |
| 磁盘占用膨胀（如告警频繁 1000+/日）| 🟡 | 1 年 ~1GB 规模；用户视情况清 |
| 文件系统小文件性能 | 🟢 LOW | macOS APFS/Windows NTFS 不敏感 |

### 15.10 大范围 refactor 风险（CLAUDE.md 规则 7）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 224 处调用改造（175 renderer + 49 main） | 🟡 MID | wrapper hijack 集中改 2 处工厂（setStatus + createAlertDialog） + main 49 处批量改 → 实际改动量 ~51 处 |
| renderer wrapper 异常阻塞 UI | 🟡 兼容 | try-catch graceful + smoke 覆盖 setStatus 原 4 状态行为不变 |
| 新代码遗漏 console.error | 中 | PR review + USER_GUIDE 显式约束；改完后定期 `grep -c "console\.error" src/` 监控 |
| 双写性能影响（每次告警写 2 个文件） | 🟢 LOW | 告警频率本身低 + JSON.stringify 极快 |

### 15.11 验收

- 日志目录 `logs/{YYYY-MM}/{MM-DD}/{level}.log` 自动按需创建（首次告警触发）
- JSON Lines 每行可被 `cat error.log | jq -c .` 解析无错
- renderer `setStatus(msg, 'error')` 自动写 `error.log`
- main 49 处 `console.error/warn` 改造完成 → `grep "console\.error" src/main.js src/main-process/ src/backend/` = 0 命中（除 logger.js 内部错误兜底）
- 旧 `app_activity_log.txt` 仍正常 append（双写兼容）
- smoke / 集成测试：4+ 用例（renderer 上报 / main 改造覆盖 / 双写一致性 / JSON 格式合法）

---

## 十六、SR-FIX-1 — 资金红线修复设计（PR #53 self-review 后补丁）

> v0.9 立项（2026-05-27 — PR #53 提交后 self-review 发现 5 个 SR1 Critical；用户拍板 F1 合并前修；本章为完整修复设计）。
>
> 关联 §1.6 D38-D40 / §2.1 / §2.4 / §3.1 / §5.2 / §6.3.2 Reverse Sync marker。

### 16.1 现状审计（self-review SR1 5 个 Critical）

| # | 严重度 | finding | 事实证据（文件:行） |
|---|---|---|---|
| **#1** | 🔴 资金红线 | C3 1v1 不变量被打破 — dispatcher per-row 单调 → C3 `usedGwRowIdx` 每次重置 → 多 bank 行共费同一 gw 行（违反 v2.1.7 F2） | `scenario-dispatcher.js:147` `runScenario(scenario, [row], gwRows)` + `c3-gateway-recon-join.js:132` `const usedGwRowIdx = new Set();` |
| **#2** | 🔴 资金红线 | C2 双维完全失效 — 笛卡尔配对依赖 ≥2 行；per-row `[row]` 入参 → leftRows / rightRows 至多一个非空 → 永不命中 | `c2-offset-bill-mark.js:124-148` 笛卡尔 + `scenario-dispatcher.js:142-153` per-row |
| **#3** | 🔴 spec 内部冲突 | scenarios.name 全表 UNIQUE 与 spec §6.3.2「channel 内同名跳过」语义冲突 — 跨渠道复用场景名会被全表 UNIQUE 错误跳过 | `migrations.js:407/519/571` `UNIQUE (name)` + `scenarios-repository.js:236/294` catch 全表错误 |
| **#4** | 🔴 测试盲区 | dispatcher.test.js 30+ 双维 case 全用 C1（attribute-fill），C2/C3 双维路径 0 覆盖 — 4 个 fix 全为生产手测发现 | `tests/unit/main-process/scenario-dispatcher.test.js` grep `offset-bill-mark\|gateway-recon-join` = 0 命中 |
| **#5** | 🟡 spec 滞后 | spec §5.2 列结构表「匹配渠道」描述未同步 D16 (a)→(b) 修订 — 后续 dev 误读风险 | v0.8 spec §5.2 表内仍写「保留原始值」（已在本版 v0.9 修订） |

### 16.2 修复设计（dispatcher per-channel batch first-match-wins）

**核心策略**：dispatcher 不再 per-row 调 `runScenario([row], gwRows)`，而是 per (channel × phase) 子作用域批量调 `runScenario(channelScenarios[i], candidateRows, gwRows)`。每个 channel 内复用 v2.1.8 legacy 单维 first-match-wins 模型（rowLockSet 累积 + 每场景跑前 filter unlocked rows）。

**伪代码（替换 §2.1 + §2.4 实施基准）**：

```js
function runAllScenarios(bankRows, gwRows, scenarios, deps) {
  // 入参约束不变：scenarios 已 enabled + 已 filterOutReconIdFix + 已 sort priority DESC + filterByGwAvailability
  const { channelsRepo, db } = deps;
  if (!deps || !channelsRepo || !db) {
    // 向后兼容：deps 缺失 → 走 legacy 单维（v2.1.8 路径，本次不动）
    return runLegacySingleDimensionDispatch(bankRows, gwRows, scenarios, ctx);
  }

  // Step 1 — 按 channel_id 切片场景（caller 保证排序已稳定）
  const scenariosByChannelId = groupScenariosByChannelId(scenarios);
  const generalChannel = channelsRepo.getBuiltinGeneral(db);

  // Step 2 — 为每行预查 matchedChannel（hot path：1 行 1 次 DB 查询）
  const rowMatchedChannelMap = new Map(); // _rowId → { id, name, owner_location } | null
  for (const row of bankRows) {
    const matched = channelsRepo.findByNameAndLocation(
      db, extractChannelName(row), extractChannelLocation(row)
    );
    rowMatchedChannelMap.set(row._rowId, matched);
  }

  // 跨阶段共享状态（保证 first-match-wins 不变量「同行最多 1 命中」）
  const rowLockSet = new Set();
  const rowMeta = new Map();          // _rowId → { scenarioId, scenarioDisplayIndex, scenarioName, modifiedColumns, hitChannelId, matchedChannel, isFallback }
  const allModifications = [];
  const allWarnings = [];
  let scenarioHitCount = 0;
  const hitScenarioIdSet = new Set();
  const hitScenarios = [];

  // Step 3 — 阶段 A：每个专属渠道独立批量 first-match-wins
  //   不变量：channel 内 scenarios 按 priority DESC + id ASC 顺序逐个调，rowLockSet 在 channel 内累积
  //   候选行 = matchedChannel == 该 channel ∩ !rowLockSet
  for (const [channelId, channelScenarios] of scenariosByChannelId) {
    if (channelId === generalChannel.id) continue; // 通用留给阶段 B
    const candidateRows = bankRows.filter(r =>
      !rowLockSet.has(r._rowId) &&
      rowMatchedChannelMap.get(r._rowId)?.id === channelId
    );
    if (candidateRows.length === 0) continue;

    runChannelBatch({
      scenarios: channelScenarios,
      bankRows: candidateRows,
      gwRows,
      // 共享状态
      rowLockSet, rowMeta, allModifications, allWarnings,
      hitScenarioIdSet, hitScenarios,
      scenarioHitCountRef: { value: scenarioHitCount },
      // metadata 标识
      hitChannelId: channelId,
      isFallbackPhase: false,
      matchedChannelMap: rowMatchedChannelMap,
    });
    scenarioHitCount = scenarioHitCountRef.value; // 同步回外层
  }

  // Step 4 — 阶段 B：通用渠道批量（候选 = 全部未锁定行：含「matched 专属未命中」+「未 matched」）
  const generalScenarios = scenariosByChannelId.get(generalChannel.id) || [];
  if (generalScenarios.length > 0) {
    const candidateRows = bankRows.filter(r => !rowLockSet.has(r._rowId));
    if (candidateRows.length > 0) {
      runChannelBatch({
        scenarios: generalScenarios,
        bankRows: candidateRows,
        gwRows,
        rowLockSet, rowMeta, allModifications, allWarnings,
        hitScenarioIdSet, hitScenarios,
        scenarioHitCountRef: { value: scenarioHitCount },
        hitChannelId: generalChannel.id,
        isFallbackPhase: true,        // 决定 _matchStatus / _fallbackChannelId
        matchedChannelMap: rowMatchedChannelMap,
      });
    }
  }

  // Step 5 — 构造 modifiedRows + unmatchedRows + 写 N5 metadata
  const modifiedRows = bankRows.filter(r => rowLockSet.has(r._rowId)).map(r => {
    const meta = rowMeta.get(r._rowId);
    const matched = rowMatchedChannelMap.get(r._rowId);
    return {
      ...r,
      _hitScenarioId: meta.scenarioId,
      _hitScenarioDisplayIndex: meta.scenarioDisplayIndex,
      _hitScenarioName: meta.scenarioName,
      _modifiedColumns: meta.modifiedColumns,
      _hitChannelKey: buildChannelKey(r),
      _matchStatus: matched ? '命中' : '兜底',
      _matchedChannelId: matched?.id || null,
      _fallbackChannelId: (matched && matched.id !== generalChannel.id && meta.hitChannelId === generalChannel.id)
        ? generalChannel.id : null,
      _hitChannelId: meta.hitChannelId,
    };
  });

  const unmatchedRows = bankRows.filter(r => !rowLockSet.has(r._rowId)).map(r => {
    const matched = rowMatchedChannelMap.get(r._rowId);
    return {
      ...r,
      _hitChannelKey: buildChannelKey(r),
      _matchStatus: matched ? '命中' : '兜底',
      _matchedChannelId: matched?.id || null,
      _fallbackChannelId: null,
      _hitChannelId: null,
    };
  });

  return { modifiedRows, unmatchedRows, modifications: allModifications, errorReport: allWarnings, stats: { ... } };
}

// 单 channel 子作用域 first-match-wins 批量调度（等同 v2.1.8 legacy 单维行为）
function runChannelBatch(args) {
  const { scenarios, bankRows, gwRows, rowLockSet, rowMeta,
          allModifications, allWarnings, hitScenarioIdSet, hitScenarios,
          scenarioHitCountRef, hitChannelId, matchedChannelMap } = args;

  for (const scenario of scenarios) {
    const unlocked = bankRows.filter(r => !rowLockSet.has(r._rowId));
    if (unlocked.length === 0) break;

    // 关键：unlocked 是整组未锁定候选行，C3 内 usedGwRowIdx 在此次 runScenario 调用内自然 1v1
    // C2 笛卡尔配对收到完整 leftRows + rightRows 集
    const result = runScenario(scenario, unlocked, gwRows);
    const { lockedRowIds, modifications, warnings } = result;

    if (lockedRowIds && lockedRowIds.size > 0) {
      scenarioHitCountRef.value += 1;
      if (!hitScenarioIdSet.has(scenario.id)) {
        hitScenarioIdSet.add(scenario.id);
        hitScenarios.push({
          id: scenario.id,
          displayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
          name: scenario.name,
        });
      }
      lockedRowIds.forEach(rowId => {
        rowLockSet.add(rowId);
        if (!rowMeta.has(rowId)) {
          rowMeta.set(rowId, {
            scenarioId: scenario.id,
            scenarioDisplayIndex: Number.isFinite(scenario.displayIndex) ? scenario.displayIndex : scenario.id,
            scenarioName: scenario.name,
            modifiedColumns: new Set(),
            hitChannelId,
          });
        }
      });
    }

    if (Array.isArray(modifications)) {
      modifications.forEach(m => {
        allModifications.push({ ...m, scenarioId: scenario.id, scenarioName: scenario.name });
        const meta = rowMeta.get(m.rowId);
        if (meta) meta.modifiedColumns.add(m.column);
      });
    }
    if (Array.isArray(warnings)) warnings.forEach(w => allWarnings.push({ ...w }));
  }
}
```

**关键不变量声明**：

1. **C3 单 scenario 调用内 1v1**（v2.1.7 F2 资金红线）：`usedGwRowIdx` 在 runScenario 函数 scope 内创建并消费 → 批量入参下 N 行 bank × M 行 gw 严格 1:1 — ✅ 修复
2. **C2 笛卡尔配对**：runChannelBatch 传入完整 unlocked rows → C2 内 `leftRows.filter` + `rightRows.filter` 收到完整集 → 配对正常 — ✅ 修复
3. **first-match-wins**（v2.1.7 F8）：rowLockSet 跨 channel 跨阶段累积 → 同行最多 1 命中 — ✅ 保持
4. **D2=c 专属优先 + 通用兜底**：阶段 A 先跑专属（按 channel 切片独立批量）→ 阶段 B 通用兜底（全部未锁定行）— ✅ 保持
5. **行序保持**：modifiedRows + unmatchedRows 按 bankRows 原始顺序 filter，无 reorder — ✅ 保持
6. **D16=b**：每行 `_hitChannelId` = 命中场景所属 channel_id，writer 反查 label 渲染「匹配渠道」列 — ✅ §5.2 实现

**已知边界（USER_GUIDE 文档化）**：

- ⚠️ 跨 scenario / 跨 channel 的 gw 行可能被多次消费（如阶段 A 工商-上海 C3 消费 gw[0]，阶段 B 通用 C3 又消费 gw[0]）
  - 与 v2.1.8 单维行为**一致**（v2.1.7 F2 1v1 红线只约束单 scenario 调用内）
  - 用户层规避：同 gw 字段的 C3 场景不应在专属 + 通用同时启用相同 reconFields
- ⚠️ matchedChannel 查询缓存（`rowMatchedChannelMap`）— 单次 dispatcher 调用内有效，无跨调用持久化
- ⚠️ scenarios.displayIndex 来源：caller 传入 `scenarios-repository.listScenarios()` 已附（v2.1.8 N3-1 + v2.1.9 N5 channel 内 1-based 修订），dispatcher 透传，无重新计算

### 16.3 scenarios.name UNIQUE 全表 → (channel_id, name) 修订设计

**现状代码**：

- `migrations.js:407` 主表 DDL：`UNIQUE (name)`
- `migrations.js:519` v2.0.0-beta.3 老库无损迁移分支：`UNIQUE (name)`
- `migrations.js:571` v2.0.0-beta.3 二次迁移：`UNIQUE (name)`
- `scenarios-repository.js:236/294` 捕获 `'UNIQUE constraint failed: scenarios.name'` 抛 friendly error

**修订设计**：

1. **新增 migration 函数** `ensureScenariosNameUniqueByChannelId(db)`：
   - 检测当前 schema：`PRAGMA index_list('scenarios')` 看是否仍是 `(name)` UNIQUE
   - 若是：BEGIN → 检查全表是否有「同 channel_id 下重名」记录（理论上 N5 backfill 后所有 channel_id=1，全表 UNIQUE 等价于 channel 内 UNIQUE → 不会冲突）
     - 若有冲突（理论不应发生 — 防御性）：activityLog 报错 + 抛 + ROLLBACK + 用户介入
     - 若无：drop old UNIQUE index + create new UNIQUE INDEX `scenarios_channel_name_unique (channel_id, name)`
   - 写标志位 `n5_scenarios_unique_migrated='1'`
   - 备份：前置 `createBackup(db, 'pre-scenarios-unique-migration')`
2. **scenarios-repository.js 错误捕获升级**：
   - 老错误 `UNIQUE constraint failed: scenarios.name` 继续兼容（migration 前的库）
   - 新错误 `UNIQUE constraint failed: scenarios.channel_id, scenarios.name`（migration 后）
   - 同时 catch 这两个模式 → 抛 `场景名「{name}」在该渠道下已存在` friendly error
3. **N7 import 路径**：`findByChannelAndName(channelId, name)` 已在 §6.3.2 中预留实现；本次只需补 scenariosRepo 上对应方法（如不存在）

**调用顺序**：

```
ensureSchemaV2_1_9_N5（已有）
  → ensureScenariosChannelIdColumn （已有 — backfill channel_id=1）
  → ensureScenariosNameUniqueByChannelId（新增 — 改 UNIQUE 索引）
```

**注意**：migration 顺序保证 `ensureScenariosChannelIdColumn` 先完成（所有 scenarios 都有 channel_id 值），再做 UNIQUE 索引切换，否则跨 channel 同名场景的迁移会因为旧库无 channel_id 列报错。

### 16.4 C2/C3 双维 unit case 矩阵（SR1 #4）

**新增 case 至 `tests/unit/main-process/scenario-dispatcher.test.js`**（最少 15 case）：

| # | category | 场景 | 候选 bank 行 | gw 行 | 预期 |
|---|---|---|---|---|---|
| 1 | C3 | 阶段 A 专属 channel `工商-上海` C3 命中 | 行 A (Channel=工商, 地区=上海) × 1 | gw[0] 金额匹配 | 行 A locked + 改字段；gw[0] 标记 used |
| 2 | C3 | 阶段 A 同 channel 多行 1v1 — 红线护栏 | 行 A1+A2 (金额相同) × 2 | gw[0]+gw[1] (金额相同) × 2 | A1 → gw[0] + A2 → gw[1]（严格 1v1，不共费） |
| 3 | C3 | 阶段 A gw 不够 → 部分 bank 未命中 | 行 A1+A2 × 2 | gw[0] × 1 | A1 命中 gw[0]，A2 unmatched |
| 4 | C3 | 阶段 A 未命中 → 阶段 B 通用 C3 命中 | 行 A (Channel=工商, 专属无 C3 匹配规则) | gw[0] 在通用 C3 规则下匹配 | 行 A 进阶段 B + 通用 C3 命中 + `_hitChannelId=1` |
| 5 | C3 | 行未 matched channel → 阶段 B 通用 C3 命中 | 行 X (Channel=招商, 库内无招商渠道) | gw[0] 在通用 C3 规则下匹配 | 行 X 兜底命中通用 + `_matchStatus='兜底'` |
| 6 | C3 | 阶段 A + B 跨 channel gw 重消费边界 | 行 A (matched 工商) + 行 X (未 matched) | gw[0] × 1 | A 在阶段 A 消费 gw[0] + X 在阶段 B 又消费 gw[0]（已知边界 — 记录不抛错） |
| 7 | C2 | 阶段 A 专属 C2 笛卡尔配对成功 | 行 A1 (leftType) + A2 (rightType) × 2 (matched 工商) | — | A1+A2 locked + rightRow 字段被改 |
| 8 | C2 | 阶段 A 专属 C2 单行入参 — 防御性 | 行 A1 (leftType, matched 工商) × 1 | — | 无配对 → unmatched（不抛错） |
| 9 | C2 | 阶段 A 未命中 → 阶段 B 通用 C2 命中 | 行 X (Channel=招商) + 行 Y (Channel=招商) | — | 进阶段 B + 通用 C2 命中 |
| 10 | C2 | C2 reconFields=0 无条件赋值（衍生方案 A）| 行 A (matched 工商, billType match) | — | A locked + 字段改值（不走笛卡尔） |
| 11 | C1+C2 | 阶段 A C1 命中 后 C2 候选缺右侧 → C2 不再命中 | 行 A1 (C1 命中) + A2 (右侧) | — | first-match-wins：A1 锁定后 A2 仍可能命中其他场景（验证 rowLockSet 不变量） |
| 12 | C3 | 阶段 A C3 命中 同行 C2 不再命中 | 行 A (matched 工商，C2/C3 都可能命中) | gw[0] | A 先被 C3 锁定 → C2 阶段不再处理 A |
| 13 | mixed | 跨 channel 同名场景插入（D39 验证）| — | — | scenariosRepo.insert: 同 channel 同名 → UNIQUE constraint；跨 channel 同名 → 允许并存 |
| 14 | mixed | 全部场景在通用，行 matched 专属 → 阶段 A 空跑 → 阶段 B 兜底命中 | 行 A (matched 工商) | gw[0] | 阶段 A 空跑（专属无场景）→ 阶段 B 通用命中 + `_fallbackChannelId=1` |
| 15 | mixed | 全部场景在通用 + 行未 matched 渠道 → 阶段 B 命中 | 行 X | — | `_matchStatus='兜底'` + `_hitChannelId=1` |

**新增 case 至 `tests/unit/backend/database/scenarios-repository.test.js`**（最少 3 case 验证 D39）：

| # | 场景 | 预期 |
|---|---|---|
| R1 | 同 channel 同 name 插入 | 抛 friendly error |
| R2 | 跨 channel 同 name 插入（如「通用」+「工商-上海」都叫「对账场景」）| 双方都落库成功 |
| R3 | findByChannelAndName 跨 channel 同名查询 | 仅返回指定 channel 的记录 |

### 16.5 D16=b writer 同步实现（SR1 #5 spec sync）

§5.2 已在 v0.9 修订表内同步 D16=b；本节为 writer 实现细节归档：

- `src/main-process/scenario-hit-rows-writer.js`：
  - 入参增加 `channels: channelsRepo.listChannels(db)` 或在 writer 内自查
  - 构造 `channelLabelById: Map<id, string>`，键 = channel.id，值 = `isBuiltin ? '通用' : ${name}-${ownerLocation}`
  - 渲染「匹配渠道」列：`row._hitChannelId ? channelLabelById.get(row._hitChannelId) || '' : ''`
- 主进程 `src/main.js` 调用 writer 处加 `channels` 参数（或 deps 传 db + repo）

### 16.6 风险与边界

| 风险 | 等级 | 缓解 |
|---|---|---|
| dispatcher 改造退化 v2.1.7 F2 1v1 红线 | 🔴 资金红线 | 单元 case 2 + 3 强制覆盖；smoke 全跑 0 regression；集成 v2.1.9-n5-channel-dispatch 加入 C3 1v1 验证 |
| 跨 channel 跨 scenario gw 多次消费 | 🟡 已知边界（v2.1.8 一致） | USER_GUIDE / CHANGELOG 文档化 + 用户层规避指引 |
| UNIQUE migration 老库冲突 | 🟢 理论不发生 | N5 backfill 后所有 scenarios.channel_id=1，全表 UNIQUE 等价 channel 内 UNIQUE；防御性检测 + ROLLBACK |
| C2 reconFields=0 衍生方案 A 单行入参 | 🟡 现状 | per-channel batch 后接收完整 unlocked rows，与 v2.1.8 行为一致 |
| dispatcher 测试 30+ 既有 case 退化 | 🟢 设计兼容 | 既有 case 全用 C1 attribute-fill 路径，per-channel batch 下行为不变（C1 不依赖批量语义）；运行全套验证 |
| scenarios.displayIndex 跨 channel 不重号 | 🟢 已有 | v2.1.9 已修订 `listScenarios` 按 channel 分组 1-based；本次不动 |

### 16.7 验收清单（SR-FIX-1 完成判定）

- [ ] §16.2 dispatcher per-channel batch 实施完成 + 6 不变量 unit case 全绿
- [ ] §16.3 UNIQUE migration 落地 + R1/R2/R3 unit case 全绿
- [ ] §16.4 C2/C3 双维 unit case ≥ 15 case 全绿
- [ ] `npm run smoke` 0 regression
- [ ] `npm run test:integration` 0 regression（不强制新增 C2/C3 双维集成 case；unit 覆盖足够）
- [ ] §5.2 writer 实现 D16=b 行为通过 case 5 验证
- [ ] CHANGELOG / USER_GUIDE 同步「已知边界（跨 channel gw 重消费）」+「scenarios.name 跨渠道复用」说明
- [ ] PR #53 body 追加「SR-FIX-1 修复」段（19 finding 收口表）
- [ ] check-vars 不引入新 Critical 命中

---

## 十七、spec 评审 checklist

启动 dev 前用户必须确认：

- [x] D1-D17（17 项决策）全锁
- [x] **D18（N6 修复方式）拍板：(a) 改外层文案**（2026-05-27 基于 §7 grep 事实修订，原 PM 推 (b) 推翻）
- [x] D2=(c) reverse sync 解读用户认可
- [x] Sheet 3 拆出策略用户认可
- [x] **D19（G1-cont 框架 + CI 策略）** (a) 沿用 v2.1.8 既定（node:test + CI 不阻断）✅
- [x] **D20（SR-policy-1 输出格式）** (c) in-place 编辑 ✅
- [x] **D21（N1-settings UI 位置）** (a) 应用设置弹框新增字段 ✅
- [x] **D22（N4 重构是否本版同步）** (a) 是 ✅
- [x] **SR-backup-1 本版前置** ✅
- [x] **「通用」删除阻止策略** spec §3.2 (b) 选项（DB + UI 双重保护）✅
- [x] **集成测试覆盖范围** N5: 6+ / N7: 5+ / G1-cont: 400+ unit case / SR-log-1: 4+ 用例 ✅
- [x] **α / β 拆分策略已锁**（α=2.1.9 / β=2.1.10 / α 提 PR 后立即开 β 分支 / α 用 v2.1.9 + β 用 v2.1.10 分支） ✅
- [x] **SR-log-1 D29-D37 9 项决策全锁**（含 D35 级联取消）✅

**🟢 全部 spec 评审 checklist 已完成 — 可启动 Dev Phase 0**

---

**当前状态**：v0.1 起草中（2026-05-27 17 项决策定案 + D18 待拍板）。
**下一步**：tasks.md 拆 task → manual-test-checklist.md 起草 → 用户审 → 建 v2.1.9 分支。
