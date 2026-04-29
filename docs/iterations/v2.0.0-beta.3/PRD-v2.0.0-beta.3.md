# PRD — v2.0.0-beta.3 银行对账单处理模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.0.0-beta.3` |
| 起始版本 | `v2.0.0-beta.2`（继承 PR #27 模块持久化 + PR #28 主题色 + 月末日资金红线反转） |
| 起草日期 | 2026-04-28 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft（待用户 review） |
| 关联文档 | `TechDoc-v2.0.0-beta.3.md`（待写） |
| 关联样例 | `银行对账单.xlsx`（44 列）/ `资金对账导出不平.xlsx`（4 sheet，本模块只用「网关账单」31 列） |

---

## 一、需求概述

新增第 4 个模块「**银行对账单处理**」（与现有「网银账单生成」「新开账户余额账单生成」「月度 Pending 数据核对」并列）。

模块职责：导入银行下发的标准 44 列对账单，按用户配置的"场景"对每行做 ReconId 提取 / 冲销账单打标 / 资金对账 join，最终输出**只含被修改行**的 xlsx，被改的单元格标黄。

场景由用户在"场景管理"弹窗里 CRUD，分 3 大类：

| 类别 | 简介 | 输出字段 |
|---|---|---|
| **C1 提取 ReconId** | 在指定字段中按 regex 模式（特征码或其他字段）找 ReconId | `ReconciliationId` |
| **C2 冲销账单打标** | 按笛卡尔配对找冲销对，给"被冲销行"打标 | 如 `FundType` |
| **C3 根据资金对账不平结果提取 ReconId** | 与「网关账单」做 join 拿 ReconId | `ReconciliationId` |

---

## 二、背景与目标

### 2.1 业务背景

- 用户每天接收银行下发的对账单（CSV/Excel），需要做 3 类处理：
  1. 银行返回的"原始账单"里 ReconId 字段为空，但其它字段（CustomerRef、Extra Information、Payment Detail 等）含有形似 `[A-Z]FT\d{12}` 的 ID，需要用 regex 提取
  2. 同一笔交易银行可能产生 2 条流水（如"出款失败" + "原出款"），需要按"对账字段"配对找出冲销对，给被冲销那条打 `FundType=outbound Fail` 标
  3. 资金对账系统输出"不平结果"（含网关账单 ReconId），需要按 4 字段 join 把 ReconId 回填到银行对账单
- 当前用户**手工处理**这 3 类，每月 2-3 万行规模，耗时 4-8 小时
- 用户已在桌面准备样例文件 `银行对账单.xlsx` + `资金对账导出不平.xlsx` 用于本迭代验证

### 2.2 目标

| 必做 | 不做 |
|---|---|
| ✅ 新模块「银行对账单处理」UI（页面同月度 Pending） | ❌ 月度 Pending 模块的复用代码改造（仅 fork UI 结构） |
| ✅ 场景管理 CRUD（含 3 类配置弹窗） | ❌ 跨模块共用模板 / 场景导入导出（不进 template-bundle） |
| ✅ 3 类场景的算法引擎 + first-match-wins 调度 | ❌ 实时增量处理（一次性批处理即可） |
| ✅ 双文件导入（银行对账单 + 可选资金对账不平） | ❌ 在原 xlsx 上修改（必须另存为） |
| ✅ 输出文件标黄修改格 + 只含被修改行 | ❌ Web/HTML 预览、复杂报表 |
| ✅ 内置 3 个开箱即用场景 | ❌ 内置场景 read-only 强制保留（用户可编辑可删除） |
| ✅ 资金红线 / 数据完整性测试覆盖 | ❌ 多语言 / 国际化 |

### 2.3 用户价值

| 维度 | 改善 |
|---|---|
| 时间 | 4-8 小时/月 → 5-10 分钟/月 |
| 准确性 | 手工 regex 易错 → 自动 + error-report 警告 |
| 可追溯 | 输出文件标黄一目了然哪些行被改 |

---

## 三、决策记录

> 用户已确认的全部决策（来源：本迭代起草前的对话）。

### D1 — 场景执行顺序

- **优先级**：0-3（3 最高，0 最低）；用户在创建/编辑时输入
- **跨场景排序**：按 `(优先级 desc, 序号 asc)` 全局排序
- **多场景命中规则**：**first-match-wins，"实际写了字段值"才算命中**
  - 一行先用最高优先级场景尝试 → 实际改动了字段 → 锁定，不进入低优先级场景
  - 实际未改动（条件不满足、提取失败、配对失败等）→ 继续低优先级场景
- **跨类别排序**：序号跨 3 个类别全局递增

### D2 — ReconId 提取算法（C1）

#### D2.1 特征提取模式

- 用户输入 3 参数：英文特征（如 `FT`）/ 数字位数 / 总位数
- regex 公式：`/[A-Z]{N}<英文特征>\d{<数字位数>}/g`，其中 `N = 总位数 - len(英文特征) - 数字位数`
- 例：英文特征=`FT`、数字=12、总=15 → `N=1` → regex `[A-Z]{1}FT\d{12}`，搜出形如 `AFT123456789012` 的 ID

#### D2.2 多字段匹配的"值一致性"

筛选字段（如 `[CustomerRef, Extra Information, Payment Detail]`）逐个搜索，按以下规则判定：

| 命中模式 | 处理 |
|---|---|
| 全部字段都搜到了同一个 ReconId 值 | 写入 ✓ |
| 部分字段搜到、部分字段无匹配，**搜到的值全相同** | 写入 ✓（合法） |
| 多字段搜到 + **值不一致** | 跳过 + 写 error-report 警告 |
| 单字段内搜到多个不同值（如 Extra Info 同时含 `AFT...` 和 `BFT...`） | 同上：值不一致 → 跳过 + 警告 |
| 任何字段都没搜到 | 视为该场景对该行不命中 → 进入下一场景 |

#### D2.3 落点

- 直接覆盖 `ReconciliationId` 列
- 原值非空时**警告**（写 error-report，但仍执行覆盖）

### D3 — 冲销账单打标算法（C2）

- **配对**：账单类型 1 的所有行 × 账单类型 2 的所有行做笛卡尔积；按"对账字段"AND 比对
- **匹配后**：把"账单类型 2"行的"打标字段"改成指定值
- **边界**：
  - 一对多（类型 1 某行匹配到多行类型 2）→ **报错**（终止该场景执行，写 error-report）
  - 多对一（类型 2 某行被多个类型 1 匹配）→ **报错**（终止该场景执行，写 error-report）

### D4 — 资金对账 join 算法（C3）

- **匹配条件**：4+ 条对账字段 AND
- **多行同时满足**（数据脏）→ 取第一条 + error-report 警告
- **银行对账单某行匹配不上**任何网关账单行 → 保留原 `ReconciliationId`（视为该场景对该行不命中 → 进入下一场景）
- **网关账单孤儿单**（没匹配上任何银行对账单行）→ 默默丢弃，不报告

### D5 — UI / 状态机

- 导入流程：先点"导入文件"选银行对账单，再点"开始运行"，**不一键**
- 二次导入：如果启用了 C3 场景，状态栏提示"请导入资金对账不平结果表（可跳过）"；可跳过，跳过则 C3 类场景不参与运行
- 输出：xlsx 文件，弹"另存为"对话框；文件名 `YYYYMMDDhhmmss-场景名.xlsx`（多场景命中时拼场景名？见 §六，待定）
- 输出目录默认 `~/Documents/网银账单生成小助手/bank-statement-process/{date}/`
- 序号：跨类别全局递增（`scenarios` 表 PK auto-incr）
- 内置场景：可编辑可删除（与用户场景同等地位）
- 编辑按钮：两段式锁——"编辑"解锁右侧"查看场景"→"修改场景"，深度修改进弹窗

### D6 — 数据持久化

- **方案 A**：单表 `scenarios` + JSON blob 存配置（与现有 amount-split / bill-split 风格一致）
- 不进 `template-bundle.json` 导入导出

### D7 — 文件结构

- 银行对账单文件**固定 44 列**（按样例 `银行对账单.xlsx`），列顺序写死
- 资金对账不平文件 4 sheet，本模块只用「网关账单」sheet（31 列）

### D8 — 标黄 + 仅导修改行

- 输出 xlsx **只含被场景修改的行**（未命中任何场景的行不导出）
- 表头保留；行序保持原顺序
- 被修改的单元格背景色 `#FFFF00`（标准黄）；同行未修改的单元格保持原样
- 空运行结果（无任何行被改）→ 弹提示"无修改记录"，不生成文件

### D9 — UI 复用

- 模块面板复用「月度 Pending 数据核对」结构（`pendingModulePanel`）：标题栏 + "场景管理"按钮 + "导入文件"按钮 + "开始运行"按钮 + "导出文件"按钮 + 状态栏

### D10-D15 — Q-A ~ Q-F 收口（详见 §十）

- **D10 (Q-A)**：C2 一对多 / 多对一报错 → 仅终止该 r1 的处理，r1 进入下一场景；其它 r1 仍继续配对
- **D11 (Q-B)**：多场景命中文件名 → `YYYYMMDDhhmmss-多场景.xlsx`；单场景命中 → `YYYYMMDDhhmmss-{场景名}.xlsx`
- **D12 (Q-C)**：error-report 格式 → xlsx，路径 `bank-statement-process/{date}/{ts}-error-report.xlsx`
- **D13 (Q-D)**：场景管理"是否启动"checkbox → 即时写库
- **D14 (Q-E)**：`is_builtin` 标志位仅记录；本迭代不实现"恢复出厂"
- **D15 (Q-F)**：运行前"导出文件"按钮 disabled

---

## 四、代码现状（必须有出处）

| 主题 | 文件:行 | 现状 |
|---|---|---|
| 模块面板基础结构 | `index.html:157-182` | `pendingModulePanel` 现成；含 control-row + 按钮 + statusBox |
| 模块切换状态机 | `src/renderer.js:96 + 1133-1153` | `state.currentModule` + `setCurrentModule(moduleId)` 已支持新模块 ID |
| 模块枚举 | `src/renderer.js`（搜 `MODULES`） | 现有 3 个（statementGenerator / newAccountGenerator / pendingReconciliation）；本次需要扩展 |
| 模块下拉菜单 | `index.html:40-44` | 3 个 `<button class="module-option">`；本次需新增 1 项 |
| 模块持久化 | `src/backend/database/settings-repository.js`（PR #27） | `current_module` setting；合法值需追加新模块 ID |
| Pending 模块运行时 | `src/renderer-pending.js` + `src/main-process/pending-session.js` | 业务无关，但 UI 模式可参考 |
| 数据库 facade | `src/backend/database.js` | 有 `templateRepository` / `settingsRepository`；需新增 `scenariosRepository` |
| 文件读 | `src/backend/file-service/readers.js` | `readRows / extractHeaders` 通用 reader；本次"银行对账单"reader 独立 |
| 输出 xlsx 写 | `src/backend/file-service.js` `writeWorkbookRows` | 不支持单元格背景色；本次需扩展或新增 writer |
| Dialog 模板 | `src/renderer-dialogs.js` | 已有 13+ 类 dialog factory；新增 5 个（场景管理 / 类别选择 / 3 类配置 / 确认场景详情）|

---

## 五、术语

| 术语 | 含义 |
|---|---|
| **场景（Scenario）** | 用户配置的一条规则，包含类别 + 名称 + 优先级 + 类别专属字段 + 是否启动 |
| **类别（Category）** | 3 个枚举：`extract-recon-id` / `offset-bill-mark` / `gateway-recon-join` |
| **筛选字段（Search Fields）** | C1 中"在哪些字段里搜 ReconId 候选"，多选 |
| **特征码（Feature Code）** | C1 中 ReconId 的英文部分（如 `FT`） |
| **账单类型（Bill Type）** | C2 中用条件标记的"虚拟分组"（如类型 1 = `FundType=outbound Fail`、类型 2 = `FundType=outbound`） |
| **对账字段（Recon Field）** | C2 / C3 中用于配对的字段名（左右两端） |
| **打标值（Mark Value）** | C2 配对成功后写入"账单类型 2"那行的固定值 |
| **first-match-wins** | 一行被某场景**实际改动**后即锁定，不再进入低优先级场景 |
| **error-report** | 处理过程中产生的警告/错误清单（xlsx 格式，独立于主输出） |
| **银行对账单原始字段** | 样例 `银行对账单.xlsx` 的 44 列固定列名 |
| **网关账单字段** | `资金对账导出不平.xlsx` 中「网关账单」sheet 的 31 列固定列名 |
| **发生额绝对值** | C3 中的特殊计算字段：`|Credit Amount - Debit Amount|`（不在 44 列里，但可作为对账字段右值） |

---

## 六、功能清单

### 6.1 主页面 (F1)

- **F1.1 模块切换**：模块下拉菜单新增"银行对账单处理"项
- **F1.2 模块面板**：复用 `pendingModulePanel` 结构，文案改造
  - 控制行 1：左 ▶ "场景管理" / 右 ▶ "导入文件" + "开始运行"
  - 控制行 2：左 ▶ "导出文件" / 右 ▶ statusBox
- **F1.3 文案**：
  - 状态栏初始 "请先点击导入文件，选择银行对账单"
  - 启用 C3 场景且未导入资金对账时："请导入资金对账不平结果表（可跳过，跳过则 C3 类场景不运行）"
  - 运行后："共 N 行被处理，X 行修改，Y 行警告"

### 6.2 场景管理弹窗 (F2)

- **F2.1 触发**：点 "场景管理" 按钮
- **F2.2 布局**：
  - 标题："场景管理"（加粗）
  - 表格 6 列：序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动
    - 序号：自增主键（不可改）
    - 功能类别：3 枚举之一（不可改，只能删除重建）
    - 场景名称 / 优先级：通过"修改场景"修改
    - 执行操作：3 个文字按钮（编辑→完成 / 查看场景→修改场景 / 删除）
    - 是否启动：checkbox（点击即写库）
  - 左下："新增场景"按钮
- **F2.3 编辑模式两段式锁**：
  - 默认状态：3 按钮显示 "编辑" / "查看场景" / "删除"
  - 点 "编辑" → 进入"已解锁"状态，按钮变 "完成" / "修改场景" / "删除"
  - 点 "完成" → 回到"默认"状态
  - 点 "修改场景"（仅解锁状态可点）→ 弹深度修改弹窗（3 类之一，对应该行的 category）
- **F2.4 删除**：
  - 弹 confirm "确认删除场景 {名称}？"
  - 确认后 DB 删除（即使是内置场景也允许）

### 6.3 新增场景流程 (F3)

#### F3.1 类别选择弹窗
- 标题："新增场景"
- 文本："请选择功能类别"
- 单选下拉框：3 枚举（提取 ReconId / 冲销账单打标 / 根据资金对账不平结果提取 ReconId）
- 右下："继续" + "取消"

#### F3.2 → F3.4：3 类配置弹窗（详细见 §七）

#### F3.5 确认场景详情弹窗
- 标题："确认场景详情"
- Body：上一级填写内容的"文本化预览"（详见 §七.5）
- 右下："完成"（落库）+ "返回"（回到上级配置弹窗，保留已填内容）

### 6.4 导入与运行 (F4)

- **F4.1 导入银行对账单**：点"导入文件" → 弹文件选择 → 校验固定 44 列 → 缓存到 main 进程的 session
  - 列校验：表头必须严格等于固定列名集合（顺序也固定）；不符合 → FileValidationError + error-report
- **F4.2 导入资金对账不平**：仅当启用 C3 场景且银行对账单已导入时，状态栏提示并允许第二次"导入文件"
  - 校验：4 sheet 必须包含「网关账单」（其它 3 sheet 不强校验）
  - 跳过条件：用户不点"导入文件"直接点"开始运行"，C3 类场景全部跳过
- **F4.3 开始运行**：点"开始运行" → 触发场景执行引擎（详见 §七.4）→ 输出准备完毕 → 启用"导出文件"按钮
- **F4.4 导出文件**：点"导出文件" → 弹"另存为" → 写 xlsx + error-report
  - 主输出空（无修改行）→ 弹提示，不生成主输出
  - 仍生成 error-report（如有警告）

### 6.5 内置场景 (F5)

首次初始化（`app_settings.scenarios_seeded` marker 不存在）且 `scenarios` 表为空时，自动 seed 3 条内置场景（详见 §七.6）+ 写 marker；后续启动 marker 已存在 → 永不重新 seed，即使用户删光所有场景表为空也不复活（D14 删除终态保障，PR #29 Codex F1 P2 修复）。

用户后续 CRUD 与普通场景同等。

---

## 七、详细设计

### 7.1 类别 1：提取 ReconId 配置弹窗

#### 7.1.1 UI 布局

| 行 | 字段 | 控件 | 验证 |
|---|---|---|---|
| 1 | 场景名称 | 输入框 | 非空 + 全局唯一 |
| 2 | 优先级 | 输入框 + tooltip | 整数 0-3 |
| 3 | 条件 | 多行：[字段] [操作] [值] + ❌（可"新增"）| 至少 1 行 |
| 4 | 根据特征提取 ReconId | checkbox + [筛选字段多选] [英文特征] [数字位数] [总位数] | 详见 §7.1.3 |
| 5 | 根据其他字段提取 ReconId | checkbox + [字段下拉] | 详见 §7.1.4 |

行 4 和行 5 **互斥**（只能勾一个）；都不勾 = 该场景纯过滤无产出（可保存但运行时不会修改任何行）。

#### 7.1.2 条件（行 3）

每行：`[字段下拉] [操作下拉] [值输入]`

- 字段下拉枚举值 = **银行对账单 44 列**
- 操作下拉枚举值：`等于 / 不等于 / 包含 / 不包含 / 空值 / 非空值 / 开头为`
- 选 `空值` / `非空值` 时值输入框消失

**条件之间是 OR**（按需求文字"满足其中一个条件即可"，行 3 标题左侧 tooltip 解释）。

#### 7.1.3 根据特征提取 ReconId（行 4）

- **筛选字段**：多选下拉，枚举值 = 银行对账单 44 列
- **英文特征**：限英文输入（regex `^[A-Z]+$`），如 `FT`
- **数字位数**：限纯数字输入，如 `12`
- **总位数**：限纯数字输入，如 `15`，必须 ≥ 数字位数 + 英文特征长度

**算法**（运行时）：
```
englishExtraN = 总位数 - 数字位数 - len(英文特征)
regex = new RegExp(`[A-Z]{${englishExtraN}}${英文特征}\\d{${数字位数}}`, 'g')

for 行 in 输入文件:
    if 行不满足"行 3 条件"（OR 任意一条）: continue
    matches = []
    for 字段 in 筛选字段:
        cellValue = 行[字段]
        found = cellValue.matchAll(regex)
        for m in found:
            matches.push({ field: 字段, value: m[0] })
    if matches 为空: 该场景不命中该行 → 下一场景
    distinctValues = unique(matches.map(m => m.value))
    if distinctValues.length === 1:
        // 一致 → 写入
        if 行[ReconciliationId] 非空: 写 error-report 警告
        行[ReconciliationId] = distinctValues[0]
        标记该行被场景命中（→ first-match-wins 锁定）
        标记该单元格 needsHighlight=true
    else:
        // 不一致 → 跳过 + 警告
        写 error-report：场景名 / 行号 / 多个候选值
        该场景不命中该行 → 下一场景
```

#### 7.1.4 根据其他字段提取 ReconId（行 5）

- 单选下拉，枚举值 = 银行对账单 44 列

**算法**（简单复制）：
```
for 行 in 输入文件:
    if 行不满足"行 3 条件"（OR）: continue
    sourceValue = 行[其他字段]
    if sourceValue 为空: 该场景不命中 → 下一场景
    if 行[ReconciliationId] 非空: 写 error-report 警告
    行[ReconciliationId] = sourceValue
    标记单元格 needsHighlight=true
```

### 7.2 类别 2：冲销账单打标配置弹窗

#### 7.2.1 UI 布局

| 行 | 字段 | 控件 |
|---|---|---|
| 1 | 场景名称 | 输入框 |
| 2 | 优先级 | 输入框 0-3 |
| 3 | 账单类型 | 多行：[#序号][字段下拉][操作下拉][值] + ❌（可"新增"）|
| 4 | 对账字段 | 多行：[#序号][账单类型下拉1][字段下拉1][vs][账单类型下拉2][字段下拉2] + ❌ |
| 5 | 对账成立的打标值 | [账单类型下拉][字段下拉][值输入] |

行 3 序号自动从 1 起（用户加一行即 +1）；行 4 引用行 3 序号作为"账单类型"标识。

#### 7.2.2 算法

```
// 1. 把每行打标为"匹配的账单类型集合"
for 行 in 输入文件:
    行.types = []
    for typeRow in 账单类型行（行 3）:
        if 满足 typeRow 的[字段] [操作] [值]: 行.types.push(typeRow.序号)

// 2. 笛卡尔配对
type1Rows = 输入文件.filter(r => r.types.includes(1))
type2Rows = 输入文件.filter(r => r.types.includes(2))

// 3. 对每个 type1Row 找匹配的 type2Row
for r1 in type1Rows:
    matched = type2Rows.filter(r2 => 对所有对账字段 AND 都满足 r1[左字段] === r2[右字段])
    if matched.length === 0: continue（不命中 r1，但 r1 可能进入低优先级场景）
    if matched.length > 1:
        报错 + error-report：场景名 / r1 行号 / 匹配到多行 r2
        终止该场景  // 注意：仅终止该场景，不影响后续场景对其它行的处理（first-match-wins 是 per-row 概念）
        ↑ 等等，"报错终止"的语义需要细化（见待澄清问题 Q-A）

    // 反向：检查 r1 是否唯一匹配 matched[0]
    reverseMatched = type1Rows.filter(r3 => 对所有对账字段 AND 都满足 r3[左字段] === matched[0][右字段])
    if reverseMatched.length > 1:
        报错 + error-report：多对一
        终止该场景

    // 配对成功
    matched[0][打标字段] = 打标值
    标记 r1 + matched[0] 都被场景命中（→ first-match-wins 锁定）
    matched[0][打标字段] 单元格 needsHighlight=true
```

⚠️ 见 §十 Q-A 澄清。

### 7.3 类别 3：根据资金对账不平结果提取 ReconId 配置弹窗

#### 7.3.1 UI 布局

| 行 | 字段 | 控件 |
|---|---|---|
| 1 | 场景名称 | 输入框 |
| 2 | 优先级 | 输入框 0-3 |
| 3 | 对账字段 | 多行：[#序号][网关账单字段][vs][银行对账单字段] + ❌ |
| 4 | 对账成立后赋值 | [网关账单字段][赋值给][银行对账单字段] |

- 网关账单字段下拉：`资金对账导出不平.xlsx` 「网关账单」sheet 31 列
- 银行对账单字段下拉：44 列 + **`发生额绝对值`**（特殊计算字段）

#### 7.3.2 算法

```
gwRows = 网关账单数据（资金对账不平.xlsx 「网关账单」sheet）

for 行 in 银行对账单:
    matched = gwRows.filter(gw => 对所有对账字段 AND 都满足 gw[左] === 行[右]，
                                    若右字段 === '发生额绝对值'，按 |Credit Amount - Debit Amount| 计算)
    if matched.length === 0:
        该场景不命中 → 下一场景（保留原 ReconciliationId）
    if matched.length > 1:
        取 matched[0] + 写 error-report 警告（数据脏）
        // 不终止场景，继续处理
    chosen = matched[0]
    if 行[赋值给目标] 非空: 写 error-report 警告
    行[赋值给目标] = chosen[赋值源]
    标记该单元格 needsHighlight=true
    标记该行被场景命中
```

### 7.4 场景执行引擎（调度）

```
function runScenarios(bankRows, gwRows | null, scenarios):
    enabledScenarios = scenarios.filter(s => s.enabled)
    sortedScenarios = enabledScenarios.sort((a, b) =>
        b.priority - a.priority || a.id - b.id  // 优先级 desc + 序号 asc
    )

    if gwRows === null:
        sortedScenarios = sortedScenarios.filter(s => s.category !== 'gateway-recon-join')

    rowLockSet = new Set()  // first-match-wins：一行被命中即锁

    for scenario in sortedScenarios:
        unlocked = bankRows.filter(r => !rowLockSet.has(r._rowId))
        modifiedThisScenario = runOneScenario(scenario, unlocked, gwRows)
        for row in modifiedThisScenario:
            rowLockSet.add(row._rowId)

    modifiedRows = bankRows.filter(r => rowLockSet.has(r._rowId))
    return { modifiedRows, errorReport }
```

注意：C2 场景内部"配对"会同时锁定 r1 + r2 两行；C2 报错时仅终止该场景执行，不影响低优先级场景对未锁定行的处理。

### 7.5 标黄 + 仅导修改行 + 导出

```
function exportModifiedRows(modifiedRows, originalHeaders):
    if modifiedRows.length === 0:
        showDialog("无修改记录，未生成文件")
        return

    workbook = new XLSX.utils.book_new()
    sheet = XLSX.utils.aoa_to_sheet([originalHeaders, ...modifiedRows.map(r => headers.map(h => r[h]))])

    // 标黄
    for r in modifiedRows:
        for col in r._modifiedColumns:
            cellRef = XLSX.utils.encode_cell({ r: r._exportRowIndex, c: col })
            sheet[cellRef].s = { fill: { fgColor: { rgb: 'FFFF00' } } }

    XLSX.utils.book_append_sheet(wb, sheet, "渠道对账单")
    let fileName = `${YYYYMMDDhhmmss}-${scenarioName | '多场景'}.xlsx`
    XLSX.writeFile(wb, savePath)
```

**多场景命中文件名规则（待澄清，见 Q-B）**：
- 单一场景命中 → `20260428173959-调拨ReconId自提取.xlsx`
- 多场景命中 → 待定（候选：`...-多场景.xlsx` / `...-{场景 1 名}_{场景 2 名}.xlsx`）

### 7.6 内置场景定义

#### Scenario 1：调拨 ReconId 自提取（C1，优先级 3，默认开启）

```json
{
  "id": 1,
  "category": "extract-recon-id",
  "name": "调拨ReconId自提取",
  "priority": 3,
  "enabled": true,
  "config": {
    "conditions": [
      { "field": "Extra Information",  "op": "包含", "value": "AFT" },
      { "field": "Extra Information",  "op": "包含", "value": "BFT" },
      { "field": "Extra Information",  "op": "包含", "value": "CFT" },
      { "field": "Extra Information",  "op": "包含", "value": "DFT" },
      { "field": "CustomerRef",        "op": "包含", "value": "AFT" },
      { "field": "CustomerRef",        "op": "包含", "value": "BFT" },
      { "field": "CustomerRef",        "op": "包含", "value": "CFT" },
      { "field": "CustomerRef",        "op": "包含", "value": "DFT" },
      { "field": "Payment Detail",     "op": "包含", "value": "AFT" },
      { "field": "Payment Detail",     "op": "包含", "value": "BFT" },
      { "field": "Payment Detail",     "op": "包含", "value": "CFT" },
      { "field": "Payment Detail",     "op": "包含", "value": "DFT" }
    ],
    "extractByFeature": {
      "enabled": true,
      "searchFields": ["CustomerRef", "Extra Information", "Payment Detail"],
      "featureCode": "FT",
      "digitCount": 12,
      "totalLength": 15
    },
    "extractByOtherField": null
  }
}
```

#### Scenario 2：outbound Fail 打标（C2，优先级 2，默认开启）

```json
{
  "id": 2,
  "category": "offset-bill-mark",
  "name": "outbound Fail打标",
  "priority": 2,
  "enabled": true,
  "config": {
    "billTypes": [
      { "seq": 1, "field": "FundType", "op": "等于", "value": "outbound Fail" },
      { "seq": 2, "field": "FundType", "op": "等于", "value": "outbound" }
    ],
    "reconFields": [
      { "seq": 1, "leftType": 1, "leftField": "CustomerRef",   "rightType": 2, "rightField": "CustomerRef" },
      { "seq": 2, "leftType": 1, "leftField": "Credit Amount", "rightType": 2, "rightField": "Debit Amount" }
    ],
    "markValue": {
      "type": 2,
      "field": "FundType",
      "value": "outbound Fail"
    }
  }
}
```

#### Scenario 3：调拨 ReconId From 网关（C3，优先级 1，默认**不**开启）

```json
{
  "id": 3,
  "category": "gateway-recon-join",
  "name": "调拨ReconId From网关",
  "priority": 1,
  "enabled": false,
  "config": {
    "reconFields": [
      { "seq": 1, "gwField": "Currency",   "bankField": "Currency" },
      { "seq": 2, "gwField": "Amount",     "bankField": "发生额绝对值" },
      { "seq": 3, "gwField": "MerchantId", "bankField": "MerchantId" },
      { "seq": 4, "gwField": "Bank",       "bankField": "Channel" }
    ],
    "assign": {
      "gwField": "reconciliationId",
      "bankField": "ReconciliationId"
    }
  }
}
```

---

## 八、数据模型

### 8.1 SQLite schema

```sql
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 全局序号
  category TEXT NOT NULL CHECK (category IN (
    'extract-recon-id',
    'offset-bill-mark',
    'gateway-recon-join'
  )),
  name TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,                    -- 类别专属字段 JSON blob
  is_builtin INTEGER NOT NULL DEFAULT 0,        -- 1=内置（用于"恢复出厂"，但不阻止删除）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name)                                  -- 名字唯一
);
```

迁移：在 `database/migrations.js` 加 `ensureScenariosSupport(db)`，幂等创建表 + seed 3 条内置场景**当且仅当 `app_settings.scenarios_seeded` marker 不存在且表为空时**。seed 完成后写 marker；marker 一旦写入永不重复 seed（保障 D14 删除终态）。老库迁移路径（无 marker 但表已有数据）→ 仅写 marker，不重复 seed。

### 8.2 in-memory session（main 进程）

```js
state.bankStatementSession = {
  filePath: '/path/to/银行对账单.xlsx',
  rows: [...],          // 解析后的对象数组（含 _rowId 唯一标识）
  headers: [...],       // 44 列
  importedAt: '...'
}

state.gatewayReconSession = {  // 可选
  filePath: '...',
  gwRows: [...],         // 网关账单 sheet 解析结果
  importedAt: '...'
}

state.processingResult = {  // 运行后产生
  modifiedRows: [...],     // 含 _rowId / _modifiedColumns
  errorReport: [...]       // 警告/错误清单
}
```

进程重启 session 丢失（与现有 `lastFileImportContext` 一致）。

---

## 九、IPC 接口

| Channel | 方向 | Payload | 返回 |
|---|---|---|---|
| `scenarios:list` | renderer→main | — | `[{id, category, name, priority, enabled}]` |
| `scenarios:get` | renderer→main | `{id}` | 完整场景含 config |
| `scenarios:create` | renderer→main | `{category, name, priority, enabled, config}` | `{status, id}` |
| `scenarios:update` | renderer→main | `{id, ...}` | `{status}` |
| `scenarios:delete` | renderer→main | `{id}` | `{status}` |
| `scenarios:toggle-enabled` | renderer→main | `{id, enabled}` | `{status}` |
| `bank-statement:import` | renderer→main | — | `{status, fileName, rowCount}` |
| `gateway-recon:import` | renderer→main | — | `{status, fileName, rowCount}` |
| `bank-statement:run` | renderer→main | — | `{status, modifiedRowCount, warningCount}` |
| `bank-statement:export` | renderer→main | `{savePath}` | `{status, mainFilePath, errorReportPath?}` |
| `bank-statement:cancel` | renderer→main | — | `{status}` |

---

## 十、待澄清问题（已全部 closed）

- [x] **Q-A**：C2 笛卡尔配对的"报错终止"语义 → **选项 ①：仅终止该场景对当前 r1 的处理**，r1 进入下一场景；其它 r1 仍继续配对
- [x] **Q-B**：导出文件名多场景命中的拼接规则 → `YYYYMMDDhhmmss-多场景.xlsx`（单场景命中时 `YYYYMMDDhhmmss-{场景名}.xlsx`）
- [x] **Q-C**：error-report 格式 → xlsx，落到 `~/Documents/网银账单生成小助手/bank-statement-process/{date}/{timestamp}-error-report.xlsx`
- [x] **Q-D**：场景管理"是否启动"checkbox → **即时写库**（与 PR #27 模块持久化一致）
- [x] **Q-E**：内置场景 `is_builtin` 标志位 → 仅记录用，本迭代不实现"恢复出厂"
- [x] **Q-F**：运行前"导出文件"按钮 → **disabled**（与"导出明细 / 余额"按钮一致）

---

## 十一、风险

### 11.1 重要风险（高亮）

| 风险 | 等级 | 缓解 |
|---|---|---|
| **数据完整性**：场景算法 bug 导致漏改 / 错改 | 资金红线 | 单元测试 + 集成测试覆盖 12 个内置场景规则 + 用户用样例文件回归 |
| **first-match-wins 调度死锁**：实现细节错位（"实际改动"判定不准）→ 全行错过 | 高 | 用 `_rowId` 锁机制 + 详细单元测试 |
| **xlsx 单元格背景色兼容性**：SheetJS Free 版可能不支持 cell.s | 中 | 早期 spike 验证；如不支持则改用 `xlsx-style` 或换库 |
| **大文件性能**：3 万行 × 多场景 → O(N²) 笛卡尔积可能慢 | 中 | 实施时 profile；必要时按"账单类型"加索引 |

### 11.2 资金红线

- C2 打标修改 `FundType` 是资金语义关键字段（决定后续清算路由）
- C3 join 写入 `ReconciliationId` 是对账依赖字段
- 必须：每个内置场景都有手工测试用例 + 必跑 smoke

### 11.3 兼容性

- 不影响现有 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）
- 不修改现有数据库表结构（仅新增 `scenarios` 表）
- 不影响现有 IPC channels

---

## 十二、实施计划

按方案 B 切分（用户确认 2026-04-28）：阶段保留 8 个内部里程碑，但 PR 合并为 4 个。

| 阶段 | PR | 内容 | 工作量 | 状态 |
|---|---|---|---|---|
| **阶段 1** | PR #29 | 数据底座：`scenarios` 表 schema + migrations + seed 3 内置 + scenariosRepository CRUD + 6 IPC + preload | 1-2 天 | ✅ 已 merge |
| **阶段 2+3** | PR #30 | 模块入口：MODULES 加新成员 + 模块面板 fork + 模块持久化合法值追加 + 场景管理弹窗 + 类别选择弹窗（不含 3 类配置弹窗） | 1.5 天 | ✅ 已 merge |
| **阶段 4+5+6（算法部分）** | PR #31 | 算法引擎：C1 / C2 / C3 纯函数 + 字段常量（44 + 31 列）+ 18 个边界单测；不接 UI / IO（方案 B 微调：原"配置弹窗 + 算法"中算法部分单独 ship） | 1.5-2 天 | 🚀 当前 |
| **阶段 4+5+6（UI 部分）+ 7 + 8** | PR #32 | 3 类配置弹窗 + 确认场景详情 + 接入 PR #30 占位 + 调度引擎（first-match-wins）+ 文件 IO（导入银行对账单 / 资金对账）+ 标黄输出 + 仅导修改行 + 导出文件 IPC + E2E 集成测试 + 用户样例文件回归 + 文档三件套 + 版本号 bump 到 `2.0.0-beta.3` | 5-7 天 | ⏳ 待启动 |

**总工作量**：约 11-15 天（仍 4 个 PR，方案 B 微调：把"算法引擎"和"UI + 调度 + IO + 文档"切开，因为算法纯函数有 18 单测保障，UI/调度/IO 是顺序拼装，逻辑边界更清晰且降低单 PR 体量风险）。

每个 PR 都跑 check-vars + smoke + preview；最后一个 PR 还要跑 v1.5.3 回归脚本。

### 方案 B 合并理由（2026-04-28 微调）

- **2+3 合并**：模块面板 fork + 场景管理 UI 同质，分 PR 反而割裂；体量小（~1.5 天）
- **4+5+6 算法 / UI 切分**（原计划"4+5+6 合并"中途调整）：
  - 算法引擎纯函数有 18 个边界单测（C1 8 + C2 4 + C3 5 + 入口 1）保障，独立成 PR #31
  - 3 类配置弹窗 + 接入 PR #30 占位归入 PR #32（与调度 + IO + 文档一起 ship 出"用户能用的完整功能"）
  - 实施期间发现单 PR "算法 + 4 dialog factory" 体量到 3000+ 行风险高（一次会话内写 4 个相互关联 dialog 易出错）
- **PR #32（4+5+6 UI + 7 + 8）合并**：
  - UI 配置弹窗 + 调度引擎 + 文件 IO 是"用户工作流闭环"必备
  - 文档三件套 + 版本 bump 是发版动作，必须等闭环就位
  - 这一 PR 体量会大（5-7 天），但顺序拼装（UI → 调度 → IO → 标黄 → 测试）依赖明确

---

## 十三、手动测试清单

### 13.1 P0 必测场景（资金红线）

| ID | 场景 | 操作 | 期望 |
|---|---|---|---|
| P0-1 | 内置 C1 调拨自提取 | 导入样例银行对账单（含 1 行 `Extra Information` 含 `AFT123456789012`）→ 运行 → 导出 | 该行 ReconciliationId 被写为 `AFT123456789012`，单元格标黄 |
| P0-2 | C1 多字段值不一致 | 构造一行：CustomerRef=`AFT123456789012`，Extra Info=`BFT123456789012` | 该行不修改 + error-report 含警告 |
| P0-3 | 内置 C2 outbound Fail 打标 | 导入含 1 笔 outbound Fail + 1 笔对应 outbound（CustomerRef + Credit/Debit 相等）→ 运行 | outbound 那行 FundType 改为 `outbound Fail`，单元格标黄 |
| P0-4 | C2 一对多报错 | 1 笔 outbound Fail + 2 笔对应 outbound（同 CustomerRef）→ 运行 | error-report 含一对多报错；该 outbound Fail 行进入低优先级场景（按 Q-A 推荐方案） |
| P0-5 | 内置 C3 关闭 | 默认状态 → 导入银行对账单 → 运行 | 状态栏不提示导入资金对账（C3 默认关闭）|
| P0-6 | 启用 C3 | 在场景管理勾选 C3 → 导入银行对账单 → 运行 | 状态栏提示"请导入资金对账不平结果表（可跳过）" |
| P0-7 | C3 跳过 | 启用 C3 不导入资金对账，直接"开始运行" | C3 类场景不参与，输出无 C3 修改 |
| P0-8 | C3 join 命中 | 启用 C3，导入银行对账单 + 资金对账（含 1 行 4 字段全匹配）→ 运行 | 银行对账单该行 ReconciliationId 被写入网关账单的 reconciliationId，标黄 |
| P0-9 | first-match-wins | 1 行同时被 C1 + C3 命中 → 优先级 C1=3 > C3=1 | 该行被 C1 修改后，不再进入 C3 |
| P0-10 | 标黄 + 仅导修改行 | 100 行输入，仅 5 行被修改 | 输出 xlsx 含 5 行 + 表头；被改单元格标黄 |
| P0-11 | 空运行结果 | 0 行被修改 | 弹"无修改记录"，不生成主输出 |

### 13.2 P1 应测场景

| ID | 场景 |
|---|---|
| P1-1 | 场景管理 CRUD（新增 / 编辑 / 删除内置） |
| P1-2 | 场景管理两段式锁（编辑 → 修改场景 → 完成）|
| P1-3 | 列校验失败（导入非 44 列文件）|
| P1-4 | 资金对账文件缺「网关账单」sheet |
| P1-5 | 优先级输入超出 0-3 范围 |
| P1-6 | 同名场景重复创建 |
| P1-7 | 进程重启后场景仍存在；session 数据丢失 |

### 13.3 不测项与原因

- 模块切换 UI 已在 PR #27 测过
- 模块持久化已在 PR #27 测过
- 主页面标题颜色已在 PR #28 测过

---

## 十四、非功能性要求

- **性能**：3 万行输入 + 5 个场景 ≤ 30 秒处理（基础线）
- **内存**：单次处理峰值 ≤ 500 MB（不要全量保留多份副本）
- **可观测性**：error-report xlsx 含 `时间戳 / 场景名 / 行号 / 原因` 4 列
- **i18n**：所有 UI 文案中文，无 i18n
- **跨平台**：Windows + macOS 都支持（与现有项目一致）

---

## 十五、变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-04-28 | v0.1 draft | 初稿 |

---

## 十六、实施记录

（实施期间，每个阶段 PR merge 后追加一节）

### 阶段 1 — 数据底座（PR #29，commit `f00b60e` + Codex P2/P3 修复 `5eb2061`，merge `2c5fba5`）

- **schema 变更**：新增 `scenarios` 表（9 列 + 4 个 CHECK 约束 + UNIQUE name）；不影响现有 11 张表
- **迁移**：`migrations.js → ensureScenariosSupport(db)` 幂等
- **seed**：3 内置场景（PRD §7.6 完整 JSON）：调拨ReconId自提取（C1, p3, on）/ outbound Fail打标（C2, p2, on）/ 调拨ReconId From网关（C3, p1, off）
- **repository**：`scenarios-repository.js` — list / get / create / update / delete / toggleEnabled + 校验（category / priority / enabled / name 唯一）
- **IPC**：6 个 `scenarios:*` handler；preload 暴露 `desktopApi.scenarios`
- **决策修正**：Codex F1 (P2) 指出"COUNT(*)===0 才 seed" 违反 D14 删除终态语义（用户删完所有场景后重启会复活）→ 改用 `app_settings.scenarios_seeded` marker 机制：marker 已存在永不再 seed；老库迁移路径（无 marker 但表有数据）仅写 marker 不重复 seed
- **测试**：单测 14/14 + F1 边界单测 5/5（A1 全新库 seed / B1 删完后重启不复活 / C1 部分删不补齐 / D1 老库迁移 / E1 marker+空表）；`npm run smoke` 通过；`npm run check:vars` 命中 `ipcRenderer` 已自查

### 阶段 2+3 — 模块入口 + 场景管理弹窗（PR #30，commit `c597bcf` + Codex P3 修复 `81adf88`，merge `9e131a2`）

- **模块入口（阶段 2）**：
  - `index.html` 加第 4 个 module-option `bank-statement-process` + 新 panel `bankStatementModulePanel` fork `pendingModulePanel`（4 按钮 + statusBox）
  - `renderer.js` `MODULES.bankStatementProcess` + 5 个新 elements + `setCurrentModule` 切换分支 + 4 按钮 binding（"导入文件"/"开始运行"/"导出文件" 占位 alert）
  - `settings-repository.js` `CURRENT_MODULE_VALID` 追加 `'bank-statement-process'`（PR #27 持久化链路对齐）
- **场景管理弹窗（阶段 3）**：
  - `renderer-dialogs.js` 新增 `createScenariosManagerDialog`（6 列：序号/类别/名称/优先级/操作/启动）+ `createScenarioCategorySelectDialog`（类别选择，3 枚举单选）
  - 编辑模式两段式锁（D5）：默认"编辑/查看场景/删除" → 点编辑解锁 → "完成/修改场景/删除"
  - toggle 启用即时写库（D13），失败回滚 + 刷新
  - 删除走 createConfirmDialog；内置场景与用户场景同等（D14）
  - 占位 alert：查看/修改场景 + 类别选择"继续" 提示"将在 v2.0.0-beta.3 阶段 4-6 启用"
- **CSS**：双风格（`styles.css` + `styles-gemini-extra.css`）各加 +96 行 — 6 列布局（fixed table-layout）+ `.is-editing` 状态高亮 + 类别选择弹窗
- **Preview**：3 张新 preview state（`bank-statement-panel` / `scenarios-manager` / `scenario-category-select`）+ 主入口分发
- **测试**：`npm run smoke` 通过；`npm run preview` + 3 张新 modal preview 渲染正常；`npm run check:vars` 命中 3 个 Runtime-state（`MODULES`/`dialog`/`elements`）已自查
- **Codex 修正**：F1 (P3) tasks.md todo→done；F2 (P3) PRD §6.5 + §8.1 同步 marker 机制描述（与 PR #29 实现对齐）

### 阶段 4+5+6 — 算法引擎纯函数（PR #31，commit `cb3a211` + Codex 3 轮修复 `52f142b`/`fa31911`/`5d13fd4`，merge `b977815a`）

- **范围切分**：实施途中由"4+5+6 配置弹窗 + 算法"（约 3000 行）切分为 PR #31（算法引擎）+ PR #32（UI/调度/IO/文档/bump），原因：单 PR 4 个相互关联 dialog factory + 算法风险高，算法层有完整单测可独立 ship
- **算法引擎独立 module**：`src/main-process/scenario-engines/` 5 文件
  - `engine-utils.js`：`ensureRowId`（写回 _rowId）/ `makeModificationCollector`（lock + record 分离）/ `makeWarningCollector` / `valuesEqual` / `parseNumber` 等共享工具
  - `c1-extract-recon-id.js`：`runC1Scenario` / `buildFeatureRegex` + 多字段值一致性校验
  - `c2-offset-bill-mark.js`：`runC2Scenario` 笛卡尔配对 + 一对多/多对一报错 + 双侧锁
  - `c3-gateway-recon-join.js`：`runC3Scenario` 4 字段 AND join + 多行取首 + 发生额绝对值
  - `index.js`：`runScenario(scenario, bankRows, gwRows?)` 按 category 分发
- **算法稳定签名**：`{scenario, bankRows, gwRows?} → { lockedRowIds: Set, modifications: [], warnings: [] }`
  - `lockedRowIds`：first-match-wins 锁定 + 仅导修改行依据；C2 配对成功时双方都锁，即使 leftRow 未改字段
  - `modifications`：标黄依据
  - `warnings`：error-report 依据
- **字段常量**：`src/constants/bank-statement-fields.js`（44 列 + `'发生额绝对值'` 虚拟字段）+ `src/constants/gateway-recon-fields.js`（31 列）；runtime 不从导入文件提取（PRD D7 列结构固定）
- **migrations seed 修复**：`BUILTIN_SCENARIOS[2].config.reconFields[0].gwField` `'currency'` → `'Currency'`（与网关 sheet 实际表头大小写对齐，Codex F3 P1）；非 schema 变更，由 PR #29 marker 保护幂等性
- **测试**：23 单测落 `scripts/smoke/scenario-engines.js` 接入 `npm run smoke`
  - C1（9 个）：regex 构建（2）/ 单字段命中 / 多字段一致 / 多字段不一致 / 单字段双值 / condition 不满足 / 原值非空覆盖 / extractByOtherField
  - C2（5 个）：一对一双锁 / 一对多 warn / 多对一 warn / 类型不匹配 / 无 _rowId 自动写回（F1 回归）
  - C3（9 个）：4 字段 AND / 不匹配保留 / 多行取首 / 原值覆盖 / 大写 Currency 命中（F3 回归）/ 入口分发 / gwRows 空 / reconFields 空 / assign 缺失（Round 2 F1 回归）
- **Codex 修正（3 轮 7 finding）**：
  - Round 1（commit `52f142b`）：F1 (P1) ensureRowId 写回 row / F2 (P1) C2 leftRow 也进 lockedRowIds / F3 (P1) seed currency → Currency / F4 (P2) 18 单测落 smoke
  - Round 2（commit `fa31911`）：F1 (P1) C3 三个 invalid early-return 漏改 listLockedRowIds + smoke 补 invalid 分支 / F2 (P2) spec.md/log.md API 文档同步 lockedRowIds
  - Round 3（commit `5d13fd4`）：F1 (P3) spec.md F2-F6 / §5 / §9 标注"已移到 PR #32"
- **不含本 PR 范围（移到 PR #32）**：4 个 dialog factory（C1/C2/C3 配置 + 确认详情）/ 接入 PR #30 占位 / first-match-wins 调度 / 文件 IO / 标黄输出 / E2E / 文档三件套 / 版本号 bump beta.3
- **关联功能 review**：手工补判（脚本不跨 branch 比较）—— migrations.js 仅 seed 字符串非 schema 变更，PR #29 marker 保护幂等；7 新文件不在重要变量表（升格评估留给 PR #32）

### 阶段 7 — first-match-wins 调度 + IO + IPC（PR #32a，commit `e9aea4b` + Codex 6 轮 + self-review，merge `e21be0d`）

- **范围切分（用户决策 2026-04-29）**：
  - 原 PR #32 切两 PR：**PR #32a（本 PR）= 后端**（调度 + IO + IPC）；**PR #32b（下一个）= 前端**（dialog + 接入 + 文档 + bump）
  - **xlsx 标黄库选型 = exceljs**（Q1=C，避免 SheetJS Free 版 cell.s 兼容性风险）
  - PR #32b dialog 全做完后一次 Codex review（Q3=A）
- **新增依赖**：`exceljs ^4.4.0`（仅本模块用；其他 3 模块继续 SheetJS）
- **新增模块**：
  - `src/main-process/exceljs-writer.js`：`writeBankStatementOutput`（标黄）/ `writeErrorReport`（4 列）/ `YELLOW_FILL=FFFFFF00`
  - `src/main-process/scenario-dispatcher.js`：`runAllScenarios(bankRows, gwRows, scenarios)` first-match-wins 调度（priority desc, id asc）
  - `src/main-process/bank-statement-io.js`：`readBankStatement` 44 列校验 + _rowId 注入 / `readGatewayRecon`「网关账单」sheet + 31 列校验 / `writeBankStatementMainOutput` 文件名规则（单一/多场景/空命中）/ `writeErrorReportOutput` / `sanitizeFileName` 跨平台兜底
- **IPC + state（main.js + preload.js）**：5 channel + 3 session state
  - `bank-statement:import` / `gateway-recon:import` / `bank-statement:run` / `bank-statement:export` / `bank-statement:session-status`
  - main.js session：`bankStatementSession` / `gatewayReconSession` / `processingResult`（进程级，不持久化）
- **算法稳定签名**：dispatcher → `{ modifiedRows: Array, modifications, errorReport, stats }`，PR #32b 直接消费
  - `lockedRowIds` PR #31 算法层负责（C2 双锁）
  - `modifications` dispatcher 层注入 `scenarioId/scenarioName`
  - `warnings` PR #31 makeWarningCollector 已注入 → dispatcher 不重复 inject（self-review 修订）
- **测试**：49 单测落 `scripts/smoke/{scenario-dispatcher,bank-statement-io}.js` + 接入 `scripts/smoke-test.js` async runner
  - dispatcher 11 用例：D1-D5 基础 + D6/D7 in-place clone 回归 + D8 warnings-only + D9 gwRows=[] warning + 2 helper unit
  - exceljs-writer 3 用例：标黄 round-trip / error-report 4 列 / 空数据
  - bank-statement-io 12 用例：R1-R6 reader 异常路径 + W1-W4 writer + F1 文件名 + S1 sanitizeFileName 13 unit（控制字符/禁用字符/尾点空格/设备保留名/长度）
- **Codex 修正（6 轮 11 finding）**：
  - Round 1 (`1cd9503`)：F1 (P1) dispatcher in-place 修改 → bank-statement:run structuredClone（D6/D7）/ F2 (P1) 重新导入清空 gatewayReconSession
  - Round 2 (`e058527`)：F1 (P1) export 提前 return 把 error-report 丢掉 → 先写 error-report 再判 empty（D8）
  - Round 3 (`5e3ee56`)：F1 (P2) dispatcher 把 gwRows=[] 当未导入 → 仅 null/undefined 过滤（D9）
  - Round 4 (`a1f3b76`)：F1+F2 (P3) PR32-v2.0.0.md / tasks.md smoke 计数 + IPC 数量同步
  - Round 5 (`7e0bbf6`)：F1+F2 (P3) Test plan / spec.md §3 IPC + smoke 计数同步
  - Round 6 (`56b51b7`)：F1+F2 (P3) PR32-v2.0.0.md 改动文件表 + spec.md §1/§5/§9 IPC 残留同步
- **Self-review**（commit `63aa332`）：F1 (P3) dispatcher warnings 不再重复 inject scenarioId/scenarioName（PR #31 算法层已注入）；F2 (P3) sanitizeFileName 加 Windows 兜底（控制字符 / 尾点空格 / 设备保留名 / 长度限制）
- **资金红线 4 个 P1 全清**：in-place clone / 重新导入清 gw / error-report 独立 / gwRows=[] warning
- **关联功能 review（check-vars）**：3 处命中已自查
  - Critical `FileValidationError`（仅消费现有 schema，未改字段）
  - Important-skeleton `ipcRenderer`（5 channel preload + main.js 同步注册）
  - Runtime-state `dialog`（import handler 处理用户取消分支）
- **不含本 PR 范围（→ PR #32b）**：4 dialog factory / 接入 PR #30 占位 / 4 按钮 binding / statusBox / preview / E2E 用户样例文件 / 文档三件套 / 版本 bump beta.3
