# v2.1.8 手测 Checklist（PR #52 发版前）

> **使用方法**：按顺序跑 §一 ~ §五；每步对照 ✅ / ❌ + 备注；全部 ✅ 后告诉 Claude "提 PR" 才合并。
> **失败时**：截图 + 复制错误信息 + 回报；不要继续往下跑（避免数据污染）。

| 字段 | 值 |
|---|---|
| 测试目的 | v2.1.8 发版前 4 项核心改造 + 边界回归 |
| 自动化已覆盖 | smoke 全套 PASS（acquiring 203 / progress 32 / pragma 27 / dispatcher 21 / scenario-engines 45 / ...）+ 3 集成脚本 159/159 + unit 123/123 |
| 本 checklist 覆盖 | smoke 无法做到的：真实 GUI / OS-level / 真实 DB 量级 / 真实 30min 闲置 |
| 备份建议 | 测试前先手动备份 `tool-data.sqlite` + `*-wal` + `*-shm` 3 文件到安全位置 |

---

## ⚠️ 测试前必做

- [ ] **手动备份 DB**（v2.1.8 启动会自动备份，但手测前再备份一份保险）：
  - macOS：`~/Library/Application Support/bank-bill-excel-tool/` 下 3 个文件
  - Windows：`%APPDATA%/bank-bill-excel-tool/` 下 3 个文件
- [ ] **关闭 v2.1.7 应用**（如果在跑）
- [ ] **拉到 v2.1.8 分支**：`git checkout v2.1.8 && git pull`（已确认本地是 v2.1.8）
- [ ] **DB 量级心理预期**：备份耗时约「DB 大小 / 50MB/秒」 — 若 DB 1GB 则备份约 20 秒

---

## 一、N4 — 首次启动自动备份 + raw_json 瘦身

### 1.1 启动应用 + 备份验证

- [ ] **执行**：`npm start`（首次启动 v2.1.8）
- [ ] **观察**：启动窗口短暂"未响应"（5-30 秒，取决于 DB 大小） → 正常
- [ ] **验证备份文件**：到 `<userData>/backups/` 目录
  - 预期：`tool-data-bak-pre-N4-<时间戳>.sqlite` 文件存在
  - 大小约 = 原 DB 大小
- [ ] **验证 activity log**（应用启动后查 `~/Documents/网银账单生成小助手/app_activity_log.txt`）：
  - 期望（若有数据 migration）：`[migration N4] bill_imports.raw_json slim done: rows=N, backup=...`
  - 期望（若 bill 表空）：日志无 N4 输出（migrated-empty 静默跳过）

### 1.2 raw_json 验证

```bash
# 用 sqlite3 CLI 直接查（应用关闭或后台不写时）
sqlite3 ~/Library/Application\ Support/bank-bill-excel-tool/tool-data.sqlite \
  "SELECT json_extract(raw_json, '$') FROM acquiring_bill_currency_bill_imports LIMIT 1;"
```

- [ ] **预期**：raw_json 仅含 9 字段（账单日期 / originBillBizId / 单据类型 / 主对账Id / 业务订单号 / 对账金额 / 对账币种 / valueDate / channel）
- [ ] **17 字段已删**：不应看到 `公司主体` / `业务部门` / `账户号` / `remark` / `创建时间` 等

### 1.3 marker 验证

```bash
sqlite3 ~/Library/Application\ Support/bank-bill-excel-tool/tool-data.sqlite \
  "SELECT setting_value FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated';"
```

- [ ] **预期**：返回 `true`

### 1.4 第二次启动幂等

- [ ] **关闭应用 → 重新 `npm start`**
- [ ] **预期**：启动正常（无延迟），无新备份文件生成（已有 marker → 跳过 migration）
- [ ] **activity log**：无 `[migration N4]` 新日志

### 1.5 失败回滚（仅在 migration 出错时）

- [ ] 关闭应用
- [ ] 删除 `tool-data.sqlite` / `*-wal` / `*-shm`
- [ ] 用 `tool-data-bak-pre-N4-<时间戳>.sqlite` 复制为 `tool-data.sqlite`
- [ ] 重启应用 → 应回到 v2.1.7 数据状态

---

## 二、N4 — 差异表导出 12 列结构

### 2.1 导出差异表

- [ ] **打开「收单单据币种校验」模块**（左上角模块切换菜单 → 8）
- [ ] **若有历史月份数据**：直接选月份 → 点 `导出差异结果`
- [ ] **若无**：先 `导入流水` + `导入单据` + `开始运行` → 再导出
- [ ] **保存 xlsx 到桌面**

### 2.2 验证 12 列

- [ ] 用 Excel / WPS / Numbers 打开
- [ ] **Sheet 1 列数 = 12**（v2.1.7 是 29，**对比要明显**）
- [ ] **列顺序按模版**：
  1. 账单日期
  2. originBillBizId
  3. 单据类型
  4. 主对账Id
  5. 业务订单号
  6. 对账金额
  7. 对账币种
  8. valueDate
  9. channel
  10. 单据_对账币种
  11. 流水_通道清算币种
  12. 流水_通道清算金额
- [ ] **不应看到**：`ReconBillBizId` / `公司主体` / `业务部门` / `账户号` / `remark` / `创建时间` 等 17 列

### 2.3 Sheet 「运行结果汇总」仍存在

- [ ] xlsx 末尾应有 Sheet 「运行结果汇总」（11 区块统计），**不变**
- [ ] 数据正确（行数 / 用时等）

---

## 三、N1' — idle 30min 自动 cleanup（含临时缩短测试）

> **完整 30 分钟测试耗时长**，推荐用「临时改常量短跑 + 长跑确认」两步走。

### 3.1 临时缩短常量快速验证（推荐）

- [ ] **临时改 `src/main.js`**：找到 `const IDLE_CLEANUP_MS = 30 * 60 * 1000;` 改为 `30 * 1000;`（30 秒）；`IDLE_CHECK_INTERVAL_MS` 改为 `5 * 1000;`（5 秒检查一次）
- [ ] **重启 `npm start`**
- [ ] **打开「收单单据币种校验」模块** → 选月份 → `开始运行`（产生新 run，cleanup_pending=1）
- [ ] **运行成功后立即停止任何鼠标 / 键盘活动 35 秒**（不要切窗口，不要碰鼠标）
- [ ] **预期**：约 35 秒后 activity log 出现 cleanup 触发 + `flow_imports` 已清

```bash
# 验证
sqlite3 ~/Library/Application\ Support/bank-bill-excel-tool/tool-data.sqlite "
  SELECT
    (SELECT COUNT(*) FROM acquiring_bill_currency_flow_imports) AS flow,
    (SELECT COUNT(*) FROM acquiring_bill_currency_bill_imports) AS bill,
    (SELECT COUNT(*) FROM acquiring_bill_currency_diff_rows) AS diff,
    (SELECT COUNT(*) FROM acquiring_bill_currency_runs) AS runs,
    (SELECT SUM(cleanup_pending) FROM acquiring_bill_currency_runs) AS pending;
"
```

- [ ] **预期** `flow=0 / bill>0 / diff>0 / runs>0 / pending=0`

### 3.2 数据保留验证

- [ ] **bill_imports** > 0（FK 约束 + 业务保留）
- [ ] **diff_rows** > 0（有效输出保留）
- [ ] **runs** > 0（diff 元数据保留）
- [ ] **cleanup_pending** = 0（标志位归零）

### 3.3 鼠标活动延迟 cleanup

- [ ] **再跑一次 runCheck**（让 cleanup_pending=1 again）
- [ ] **每 20 秒动一下鼠标**（持续 90 秒）
- [ ] **预期**：cleanup 不应触发（lastUserActivityTs 持续刷新 → 永远不满 30 秒）

### 3.4 还原常量

- [ ] **改回**：`IDLE_CLEANUP_MS = 30 * 60 * 1000` / `IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000`
- [ ] **重启验证**：启动正常

### 3.5 退出兜底（before-quit）

- [ ] 跑 runCheck → cleanup_pending=1
- [ ] **不等 idle 触发，直接 Cmd+Q 关闭应用**
- [ ] **应用关闭可能短暂延迟**（静默串行 cleanup）
- [ ] **重启后查 DB**：`flow_imports = 0`、`cleanup_pending = 0`、`bill/diff/runs 保留`

### 3.6 强杀崩溃恢复（进入模块兜底）

- [ ] 跑 runCheck → cleanup_pending=1
- [ ] **`kill -9 <pid>` 强杀 Electron 进程**（before-quit 不触发）
- [ ] **重启 `npm start` → 不立即打开收单模块**（停在首页 10 秒）
- [ ] **DB**：`cleanup_pending` 仍 = 1（应用启动未触发，因为没进模块）
- [ ] **打开「收单单据币种校验」模块**（触发 listMonths）
- [ ] **预期**：状态栏出现 toast 「正在清理上次未完成的临时数据」
- [ ] **几秒后查 DB**：`flow=0 / cleanup_pending=0 / bill+diff+runs 保留`

---

## 四、N3 — 银行对账场景号 + Sheet 3「命中场景行」

### 4.1 状态框显示 displayIndex

- [ ] **打开「银行对账单处理」模块**（左上角菜单 → 4）
- [ ] **选已有账单类别**（如有；无则跳本节）
- [ ] **导入 1 个银行对账单 xlsx → 选场景 → 开始运行**
- [ ] **状态框观察**：命中场景文案应类似 `命中场景 [3] OG 公司主体打标`（`[N]` = displayIndex）
- [ ] **打开场景管理**（点 `场景管理` 按钮）
- [ ] **验证一致**：状态框 `[3]` ↔ 场景管理列表第 3 行的场景名应**完全一致**（v2.1.7 之前这里对不上）

### 4.2 Sheet 3 导出

- [ ] 跑完后 `导出处理结果` → 保存桌面
- [ ] **打开 xlsx**
- [ ] **预期 3 个 sheet**：
  1. 渠道对账单（命中并修改的行，含黄底标记）
  2. 未命中场景行（v2.1.7 F8 加的）
  3. **命中场景行**（v2.1.8 N3-2 新增）
- [ ] **Sheet 3 列结构**：
  - 前面所有列 = Sheet 1 列（原 44 列）
  - **末尾新列「命中场景」** = `[displayIndex] 场景名` 形式（如 `[3] OG 公司主体打标`）
- [ ] **Sheet 3 行数** = Sheet 1 行数（命中行集合相同）
- [ ] **不应看到** `_rowId` / `_hitScenarioId` / `_hitScenarioName` 等内部字段（INTERNAL_FIELDS 已过滤）

### 4.3 无命中边界 case

- [ ] **新建一个永远不会命中的场景**（如 condition `Date = 'NEVER_2099'`）
- [ ] **只 enable 这个场景 → 跑对账**
- [ ] **预期**：
  - 状态框：「无命中场景」
  - 导出 xlsx 只有 Sheet 1（modifiedRows=0 → 默认 saveDialog 不触发 / 或返回 empty）
- [ ] **再 enable 1 个能命中的场景 → 跑** → 3 sheet 都应正常

---

## 五、N2 — C3「对账成立后赋值」新增"自取值"

### 5.1 dialog UI 显示

- [ ] **「银行对账单处理」模块** → 点 `场景管理`
- [ ] **点 `新增场景`**
- [ ] **类别下拉选「提取ReconId-From 网关」**（C3）
- [ ] **填名称**：`N2 自取值测试-2026-05-26`
- [ ] **「对账字段」区块**：加 1 行（如 bank `CustomerRef` ↔ gw `OrderId`）
- [ ] **滚到「对账成立后赋值」区块**：
  - **第 1 下拉**：选 bank 字段（如 `Description`）
  - **第 2 下拉**：展开看下拉选项
- [ ] **预期** 第 2 下拉**第 2 位**新增「自取值」选项（v2.1.7 之前没这个）

### 5.2 输入框联动

- [ ] **选「自取值」**
- [ ] **预期**：下方弹出文本输入框（之前是空白 / 隐藏）
- [ ] **输入字符串**：`STATIC-CHANNEL-X`
- [ ] **点保存**

### 5.3 保存验证

- [ ] **保存成功 → dialog 关闭**
- [ ] **再次进入场景管理 → 点编辑刚保存的场景**
- [ ] **预期**：
  - 第 2 下拉仍选中「自取值」
  - 输入框仍显示 `STATIC-CHANNEL-X`
- [ ] **验证 DB**（DevTools Console）：

```js
window.desktopApi.scenarios.list().then(rs => console.table(
  rs.filter(s => s.name.includes('N2 自取值测试')).map(s => ({
    name: s.name,
    mode: s.config?.assign?.mode,
    customValue: s.config?.assign?.customValue
  }))
))
```

- [ ] **预期**：`mode: 'custom'`、`customValue: 'STATIC-CHANNEL-X'`

### 5.4 老 scenario 兼容

- [ ] **DevTools Console**：

```js
window.desktopApi.scenarios.list().then(rs => console.table(
  rs.filter(s => s.category === 'gateway-recon-join' && !s.name.includes('N2')).map(s => ({
    name: s.name,
    mode: s.config?.assign?.mode,
    customValue: s.config?.assign?.customValue
  }))
))
```

- [ ] **预期**：所有老 C3 scenario 都自动补 `mode: 'direct'`、`customValue: ''`（DB migration `ensureC3AssignAddMode` 已做）

### 5.5 实际跑对账（高难度，可选）

- [ ] **有真实 bank + gw 数据时**：导入 → 选含此场景的账单类别 → 开始运行
- [ ] **预期**：命中的 bank 行 `Description` 列被写入 `STATIC-CHANNEL-X`
- [ ] **未命中的 bank 行不受影响**

### 5.6 清理测试场景

- [ ] **场景管理 → 找到 `N2 自取值测试-2026-05-26` → 删除**（避免污染生产数据）

---

## 六、回归 — v2.1.7 老功能仍正常

> **目的**：v2.1.8 改动多（N1' + N2 + N3 + N4 + F5），确认没破坏 v2.1.7 已有功能。

### 6.1 银行对账单处理（C1 / C2 / C3）

- [ ] **现有场景跑对账** → 状态栏文案 + 输出 xlsx 正常
- [ ] **Sheet 1「渠道对账单」+ Sheet 2「未命中场景行」**（v2.1.7 F8）仍存在且正确

### 6.2 对账单 ReconID 修复模块

- [ ] **业务对账单子模式（C1 + C2 + C3）** → 跑修复 → 输出正常
- [ ] **网关对账单子模式（C4 manyToOne）** → 跑修复（F5 算法重设）→ 输出正常
- [ ] **F5 期望**：相比 v2.1.7 命中行数 **不应下降**；TEST2.xlsx 类似数据应有改善（28 → 43 行级别）

### 6.3 收单单据币种校验

- [ ] **基础流程**：导入流水 + 单据 → 运行 → 导出差异（12 列结构）
- [ ] **进度提示**（v2.1.7 F6）：状态栏文案按 6 阶段切换 — 清理历史 / 统计数据量 / 初始化 / 比对币种 / 写入 / 收尾

### 6.4 生成网银账单（主功能 1）

- [ ] **跑 1 笔完整流程**：导入 → 映射 → 大账号选择 → 导出明细 + 余额 → 输出正常
- [ ] **无与 v2.1.7 行为差异**

### 6.5 其他模块

- [ ] Pending 数据核对、月度银行对账单BU回填校验、业务OP数据核对：**冒烟一遍**（不必详跑），确认无加载报错

---

## 七、性能 / 体感

### 7.1 启动时间

- [ ] **v2.1.7 vs v2.1.8 启动时间对比**（首次启动 = 含 N4 migration）
  - 预期：首次启动多 5-30 秒（备份 + migration）；之后启动无差异

### 7.2 SQLite 体积

- [ ] **migration 前后 DB 大小**：
  - 备份文件大小（migration 前）
  - 当前 `tool-data.sqlite` 大小（migration 后 + 可能 VACUUM）
  - 预期：当前大小 ≤ 备份大小（raw_json 字段平均减 70%）
  - 实际可能因 SQLite 页未回收略大，运行一段时间后差异更明显

```bash
ls -la ~/Library/Application\ Support/bank-bill-excel-tool/tool-data*.sqlite
ls -la ~/Library/Application\ Support/bank-bill-excel-tool/backups/
```

### 7.3 内存

- [ ] **应用空闲时内存** vs v2.1.7 baseline（活动监视器 / 任务管理器）
- [ ] 预期：无显著差异（idle 计时器 setInterval 2min 不占内存）

---

## 八、判定 + 反馈

完成后请回报：

```
N4 migration：✅ / ❌
N4 12 列输出：✅ / ❌
N1' idle 触发：✅ / ❌
N1' 数据保留：✅ / ❌
N1' before-quit 兜底：✅ / ❌
N1' 崩溃恢复兜底：✅ / ❌
N3 状态框 displayIndex：✅ / ❌
N3 Sheet 3：✅ / ❌
N2 自取值 UI：✅ / ❌
N2 老兼容：✅ / ❌
v2.1.7 回归：✅ / ❌
性能体感：✅ / ❌（可选）
```

全 ✅ 后告诉 Claude **「提 PR」** → team-lead 把 `docs/prs/待merge-PR #52.md` 提到 GitHub。

任何 ❌ 立即回报，附错误信息 + 复现路径。

---

## 附录：DevTools 快速查询命令

打开 DevTools Console（Cmd+Opt+I）：

```js
// 1. 当前所有场景 + N2 字段
window.desktopApi.scenarios.list().then(rs => console.table(rs.map(s => ({
  id: s.id, name: s.name, category: s.category,
  mode: s.config?.assign?.mode || '-',
  customValue: s.config?.assign?.customValue || '-'
}))))

// 2. 当前 idle 状态（main 进程，需通过 IPC 拿）
// 暂未暴露专门 API，可看 activity log

// 3. 当前 v2.1.8 版本号
window.desktopApi.app.getInfo().then(i => console.log(i.version))
```

## 附录：DB 量级参考

| 状态 | DB 大小估算 |
|---|---|
| 全新安装 | < 1 MB |
| 1 个月数据（典型）| ~50-200 MB |
| 12 个月累积（v2.1.7）| ~500 MB - 2 GB |
| v2.1.8 首次启动备份耗时 | DB / 50MB/秒（即 1 GB 约 20 秒） |
| migration 耗时 | DB / 200MB/秒（即 1 GB 约 5 秒） |
| raw_json 瘦身后体积缩减 | ~50-70%（取决于原 17 字段值长度） |
