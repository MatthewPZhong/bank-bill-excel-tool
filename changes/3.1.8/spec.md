# v3.1.8 Spec — VCC 财务OP校验迭代

> status: `ready-for-implementation`  
> baseline: `main@dff07df11fb94ce84940b474b55ac796f084d241`（当前 `package.json=3.1.7`）  
> target-version: `3.1.8`  
> suggested-branch: `codex/v3.1.8-vcc-financial-op`  
> updated: `2026-08-08`  
> nature: 财务结果、跨期归档、人工调整及金额精度红线。实现、回归和发布前均须保留人工财务复核门禁。
> decision-lock: `2026-08-08` 用户确认其余问题全部采用本 Spec 推荐方案；当前不存在待确认产品决策。
> decisions: `Q01=A`、`Q02=A`、`Q03=A`、`Q04=A`、`Q05=A`、`Q06=A`、`Q07=同一调整坐标只允许一次`、`Q08=A`、`Q09=A`、`Q10=A`、`Q11=A`、`Q12=A（以用户上传的 46 列 Pending 模板为唯一新导入契约）`。

---

## 0. Codex 执行约束

1. 以本 Spec 及已锁定的 `Q01～Q12` 决策为唯一实施口径；不得凭 UI 习惯、旧版本行为或实现便利修改已确认的资金规则。
2. 开工前确认工作区基线；若 `main` 已领先本文 baseline，先重新审计 VCC 财务OP相关文件，再更新 Spec 的 baseline，不得直接在漂移代码上套补丁。
3. `Q01～Q12` 已全部确认，Codex 不得再次发起同一决策选择，也不得改用其他方案。仅当最新代码、用户模板或真实数据与本 Spec 出现无法由现有规则解释的实质冲突时，才可使用 `askUserQuestion`，并必须说明冲突证据和资金影响。
4. 不得修改 VCC 财务OP之外的资金匹配、回填、幂等键或对账方向规则；如因共用组件必须改动，先列出影响范围和回归矩阵。
5. 所有金额计算继续使用十进制定点字符串及现有 `financial-decimal` / `canonicalizeVccAmount` 能力；不得在业务计算链路引入 JS 浮点加减。
6. 解归档、删除期初、删除结果、添加调整、重新归档均必须有数据库事务、二次门禁、审计证据和提交后状态断言；禁止“部分成功”。
7. Excel 模板样式必须从模板读取，不得肉眼估色或硬编码用户点名的 AUD/CAD 色值。
8. 本迭代完成后反向同步 Spec、实施说明、CHANGELOG、版本功能清单、使用手册、重要变量清单和预览/测试脚本。

---

## 1. 目标

在现有 VCC 财务OP校验模块上完成以下能力：

- 支持对已归档月份执行受控解归档；
- 隐藏首月期初初始化审计数据，并允许在满足门禁时删除后重新初始化；
- 在确认结果表阶段以可审计的“调整行”修改结果；
- 开始运行前检查参与计算的校验表完整性；
- 按指定的新结果模板重做结果表结构、字体和颜色；
- 修复系统财务OP大额两位小数被显示格式截断的问题；
- 导出时允许选择任意已归档月份；
- 数据管理支持删除未归档结果表；
- 以 `VCC_移除归档Pending账单.xlsx` 为金标准重新锁定模板和识别契约。

本迭代不改变充值清退、费用换汇、通道、Pending 的金额方向和业务分组规则；调整值作为独立、可追溯的人工结果调整，不覆盖原始导入事实或基础计算结果。

---

## 2. 当前基线审计结论

### 2.1 当前版本与状态

- 最新仓库基线为 `v3.1.7`；VCC 财务OP模块在该基线上使用 `vcc_fin_op_runs.status = calculated | archived` 和 `vcc_fin_op_datasets.data_status = unprocessed | archived`。
- 归档时会把计算余额写入 `vcc_fin_op_archives`，并把当月全部数据集改为 `archived`；当前没有解归档事务和解归档审计表。
- 数据管理当前会把 `vcc_fin_op_opening_balances` 返回前端并展示；删除目标仅支持五类导入源表。
- 当前导出入口只获取“最新一份已归档结果”，不能按月份选择。
- 当前结果 writer 依赖固定行号 `2/3/7/29/37/38/39/40` 从旧模板拷贝样式，模板路径为 `assets/VCC财务OP校验/财务OP校验结果表.xlsx`；这种实现无法安全适配用户指定的新模板结构。
- 当前运行前置检查要求充值清退、费用换汇、通道和系统财务OP存在；`VCC_移除归档Pending账单` 当前不是必需表。

### 2.2 金额精度问题复核

上传样例 `财务OP (22).xlsx` 的工作表为 `1432061822992779266`：

- JPY 行位于第 4 行；
- `财务余额` 单元格为 `M4`；
- OOXML 原始数值为 `1.3588602459E8`，等价于 `135886024.59`；
- 当前 importer 同时生成 `raw:false` 的显示矩阵和 `raw:true` 的原始矩阵，但 `systemAmountToken(displayValue, rawValue)` 优先使用显示值。General 格式可能把显示值变成 `135886024.6`，因此产生一位小数的错误结果。

结论：1.7 不是计算舍入问题，而是**导入取值优先级错误**。修复必须让数值单元格优先使用原始值，显示值只用于文本/会计格式兼容和审计展示。

### 2.3 Pending 模板复核（已按用户上传文件纠正）

用户明确指定本轮上传的 `VCC_移除归档Pending账单.xlsx` 作为唯一权威模板。实施时将该文件以以下仓库路径替换旧资产：

```text
assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx
```

实读结果：

- 单 sheet，上传文件中的 sheet 名为 `1410507246137837570`；sheet 名不属于识别契约；
- 有效区域为 `A1:AT1`；
- 第 1 行共 **46 个正式表头**；
- 文件 SHA-256：`f7967d46f2c95a87d53b99f15622d6e5480e77f67c3d345daa1c250e7b6ca9fc`；
- 46 列表头 JSON 指纹 SHA-256：`3a67e7e16c19a7ba79afd510aa75cdb3c4b3d5e545da407b6ff5fafdd0d9e9cf`。

与当前 `main` 的 48 列 `PENDING_HEADERS` 相比，新模板移除了两个原表字段：

```text
是否错币
金额差
```

这两个字段不得继续作为校验原表必需列：

- `是否错币` 继续由系统在导入后根据 `币种 !== 流水_币种` 派生，写入校验表/计算审计；
- `金额差` 不属于当前 Pending 发生额公式的输入，不导入、不补空，也不进入新原表内容哈希；
- 新导入只接受本节 46 列契约；旧 48 列文件不再作为可导入模板；
- 已持久化的旧 48 列历史审计不得删除，须通过原始契约版本继续正确展示，并完成 §4.10.5 的幂等迁移。

### 2.4 结果模板复核（Q01 已解决）

用户已上传 `VCC财务OP校验结果表_模板.xlsx`。实施时以以下路径纳入仓库：

```text
assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx
```

实读结果：

- 文件 SHA-256：`f920fd2161156314a0d523eacb7cf7d11f7002b7781fe9cca01b298edfa4a1f4`；
- 目标 sheet 名：`财务OP校验结果表`；
- 业务内容有效区：`A1:N45`；工作表物理 dimension 为 `A1:N51`，其中第 46～51 行仅含空值/样式占位，不得被识别为业务结果行；
- 第 1 行固定为 14 列：
  `主体、大类、分类、AUD、CAD、CNH、EUR、GBP、HKD、JPY、SGD、USD、调整值、调整原因`；
- 正常币种填充样式锚点：`D1（AUD）`；
- 非正常币种填充样式锚点：`E1（CAD）`；
- 调整值字体/数值格式锚点：`D45（差异行币种金额格）`；
- 调整原因字体锚点：`B45（“差异”文本格）`。

`Q01=A` 已锁定：禁止回退旧 `财务OP校验结果表.xlsx`。需求 1.5/1.6 只以该工作簿的 `财务OP校验结果表` sheet 为结果样式契约；其第二个 sheet 不替代现有 Pending 发生额计算表契约，避免把模板中的样例/占位值误当业务表头。

---

## 3. 术语、状态与核心不变量

### 3.1 术语

| 术语 | 定义 |
|---|---|
| 基础计算结果 | 由导入事实、期初余额和系统财务OP计算后写入 `run_rows` / `run_balances` 的不可变结果。 |
| 调整行 | 用户在确认结果阶段新增的、带主体/大类/分类/币种/调整值/原因的独立记录。 |
| 生效结果 | 基础计算结果加该 run 已保存的一次性调整行后得到的结果；页面、归档、导出均使用它。 |
| 首月 | VCC 财务OP模块的全局初始化账期，建议持久化后不因删除期初而漂移。 |
| 解归档 | 删除目标月的归档快照并将结果及数据集恢复为未处理；不删除基础计算结果。 |
| 尾月 | 当前已归档月份中按 `YYYY-MM` 排序最新的月份。 |

### 3.2 状态转换

```text
无结果
  └─开始运行→ calculated / 未处理
       ├─添加调整→ calculated / 未处理（result_revision + 1）
       ├─重新运行→ 旧未归档结果失效，新 calculated 结果替换
       ├─删除结果→ 无结果
       └─确认归档→ archived / 已归档
                         └─解归档→ calculated / 未处理
```

数据集状态：

```text
unprocessed --确认归档--> archived --解归档--> unprocessed
```

### 3.3 资金不变量

1. `archived` 结果必须同时满足：
   - 当月每个主体均有 `vcc_fin_op_archives`；
   - 归档快照的 `run_id` 等于归档结果；
   - 当月全部有效数据集均为 `archived` 且 `archived_run_id` 等于该 run；
   - 归档余额使用生效结果，不得忽略人工调整。
2. `calculated` 结果必须满足：
   - 当月不存在指向该 run 的归档快照；
   - 当月数据集为 `unprocessed`；
   - 允许新增调整，但不得修改导入事实和基础 `run_rows`。
3. 删除首月期初后，当月所有未归档结果必须同步失效；用户重新输入期初并重新运行后才能归档。
4. 删除结果表不得删除导入数据、导入审计、数据集、首月期初或已归档历史。
5. 解归档仅允许作用于当前尾月，即最新已归档月份；非尾月必须阻断，不得让后续月份继续保留依赖于旧归档余额的有效结果。
6. 金额统一保留至两位小数，不得因 Excel 显示格式、科学计数法或 JS Number 格式化丢失小数。

---

## 4. 需求详细设计

## 4.1 需求 1.1 — 数据管理新增【解归档】

### 4.1.1 入口布局

- 在 VCC 财务OP“数据管理”页面底部操作栏新增【解归档】。
- 【解归档】固定左对齐；现有【删除】【导出】【返回】仍保持右对齐及原顺序。
- 主入口按钮不使用红色；真正执行动作的弹框【删除】按钮使用红色危险样式。
- 没有任何一致的已归档结果时：【解归档】禁用，悬停/辅助文本显示“暂无已归档结果”。

### 4.1.2 弹框结构

点击【解归档】打开弹框：

```text
请选择月份

月份  [年份 ▼]  [月份 ▼]

                         [删除] [取消]
```

精确要求：

- 左上角标题文本：`请选择月份`；
- 中间为两个单选下拉框；
- 年份下拉框左侧仅显示一次文本：`月份`；
- 年份枚举：从一致的已归档结果表中提取去重年份，按新到旧排列；
- 月份枚举：仅显示所选年份下存在已归档结果的月份，按新到旧排列；
- 默认选中全局最新已归档结果的年份和月份；
- 切换年份后，月份自动选中该年份最新的已归档月份；
- 右下角按钮顺序固定为【删除】【取消】；
- 【删除】为红色；【取消】为普通次级按钮；
- 弹框本身即不可逆动作确认，不再弹第二层确认框；
- `Esc` 等同【取消】，但执行中禁止关闭。

### 4.1.3 解归档预检

点击【删除】前，前端先调用 preview；提交事务后后端必须再次检查：

1. 目标月存在且仅存在一份有效 `archived` run；
2. 目标月每个主体均存在归档快照，且全部指向该 run；
3. 目标月数据集全部为 `archived`，`archived_run_id` 一致；
4. 没有 VCC 财务OP导入、计算、导出、删除或其他解归档任务进行中；
5. 没有未解决导入异常；
6. 满足 `Q02` 确认的跨月依赖策略；
7. 数据库状态与 preview 时的 revision/token 一致。

任一条件失败时不得修改任何状态，返回结构化错误和受影响月份。

### 4.1.4 最终事务口径（Q02=A）

仅允许解归档尾月，即当前最新已归档月份。为满足“枚举取现有已归档结果表”的要求，下拉框仍列出全部已归档月份；选择非尾月后立即执行 preview，【删除】禁用并展示后续依赖月份，不让用户到提交后才发现失败。

```sql
BEGIN IMMEDIATE;
-- 1. 二次门禁及尾月检查
-- 2. 写入解归档前审计快照
DELETE FROM vcc_fin_op_archives WHERE target_month = :month;
UPDATE vcc_fin_op_runs
SET status = 'calculated', archived_at = NULL, updated_at = now
WHERE id = :run_id AND status = 'archived';
UPDATE vcc_fin_op_datasets
SET data_status = 'unprocessed', archived_run_id = NULL, updated_at = now
WHERE target_month = :month;
-- 3. 提交前状态断言
COMMIT;
```

成功后：

- 目标月“财务OP校验结果表”处理状态显示为 `未处理`；
- 目标月全部校验表处理状态显示为 `未处理`；
- 由于当前原表和校验表共享数据集状态，校验原表页也会显示 `未处理`；
- 基础结果、调整记录、导入事实和导入审计均保留；
- 目标月从“可导出的已归档月份”枚举中移除；
- 数据管理刷新并定位到目标月“结果表”；
- 用户可继续修改调整后重新归档，或重新运行生成新结果。

### 4.1.5 审计

审计至少记录：

- 目标月、run id；
- 原 `archived_at`；
- 解归档前每个主体的归档余额 JSON；
- 数据集类型、revision、原状态；
- 调整 revision；
- 操作时间、应用版本、build SHA；
- 结果：success / rolled_back；
- 失败原因。

---

## 4.2 需求 1.2 — 首月期初初始化数据隐藏与删除

### 4.2.1 前端隐藏范围

- 删除数据管理“结果表”页面现有的首月期初初始化审计卡片/列表；
- `dataManagerOverview` 不再向普通前端响应返回 `openingBalances`；
- 不提供查看初始化金额、说明、初始化时间的普通前端入口；
- **结果表中的“上月财务OP/期初余额”计算行继续保留**，否则用户无法核对计算链路。`Q04=A` 仅隐藏独立的首月期初初始化审计卡片/列表。
- 后端数据库和操作审计继续保存期初事实，不能因“不显示”而删除审计能力。

### 4.2.2 首月定义

最终方案（Q03=A）：新增全局模块状态 `first_month`。

- 第一次成功提交人工期初时，将其账期持久化为 `first_month`；
- 所有主体共用同一个首月；
- 删除期初余额时仅删余额数据，不清除 `first_month`，确保首月不会动态漂移；
- 后续月份缺少上月归档时，不允许再通过人工期初绕过，必须先归档上月；
- 旧库迁移：若已有期初记录，以最早的 `target_month` 回填；若检测到多个不同初始化月份，升级门禁失败并输出诊断，不自动删除资金数据。

`Q03=A` 已确认：首月为模块全局固定账期，首次初始化后永久保持，不因删除期初数据而漂移。

### 4.2.3 删除目标枚举

“数据管理 → 删除数据”页面的目标表新增：

```text
首月期初初始化数据
```

显示规则：

- 仅当月份账期等于持久化的 `first_month` 时显示该枚举；
- 即使该月暂时没有期初记录，也可显示但【删除】禁用，提示“暂无首月期初初始化数据”；
- 非首月完全不显示该枚举；
- 该目标不进入“导出数据”目标枚举。

### 4.2.4 删除门禁

允许删除必须同时满足：

1. 选择月份等于 `first_month`；
2. 存在至少一条期初余额；
3. 当月不存在 `archived` 结果和归档快照；
4. 当月所有数据集不是 `archived`；
5. 没有活动 VCC 财务OP任务；
6. 事务开始时的期初内容哈希与 preview 一致。

当“财务OP校验结果表”处理状态为已归档时：

- 【删除】禁用；
- 明确提示：`该月财务OP校验结果已归档，请先解归档后再删除首月期初初始化数据`。

### 4.2.5 删除事务

按该月全部主体整体删除（Q05=A）：

1. 将所有期初余额、说明和时间写入不可变审计快照；
2. 删除该月全部 `vcc_fin_op_opening_balances`；
3. 删除/失效该月全部 `calculated` run 及其 run rows、balances、Pending 汇总和调整记录；
4. 保留导入事实、数据集、导入记录和 `first_month`；
5. 提交前断言：期初记录为 0、未归档结果为 0、源数据行数不变；
6. 全部成功后提交，否则回滚。

删除成功后：

- 返回数据管理页并刷新；
- 用户下次对首月点击【开始运行】时，系统必须再次打开首月期初初始化输入；
- 期初输入成功后仍需用户重新点击【开始运行】，不得自动沿用旧结果或自动归档。

---

## 4.3 需求 1.3 — 确认结果表页面支持人工调整

### 4.3.1 交互入口

- 现有“确认结果表”页面从仅显示三行汇总升级为可查看完整结果表；
- 页面操作区新增【修改结果】按钮；
- 只有 `calculated / 未处理` run 可修改；`archived` run 禁止修改；
- 关闭并重新进入页面后，已保存调整仍存在；
- 每次新增调整后：
  - 结果表立即刷新；
  - 当月计算财务OP、差异和币种颜色立即重算；
  - “我已核对”勾选状态清空；
  - 用户必须再次核对才能确认归档。

### 4.3.2 调整弹框

点击【修改结果】后弹框字段顺序固定为：

1. 单选下拉框：`主体`
2. 单选下拉框：`大类`
3. 单选下拉框：`分类`
4. 单选下拉框：`币种`
5. 输入框：`调整值`
6. 输入框/多行文本框：`调整原因`

行为：

- 下拉框级联：主体 → 大类 → 分类；币种为九币种固定枚举；
- 选项由当前 run 的实际结果行生成，不能提交页面未展示的伪造组合；
- 前端 option 持有不可见 `rowKey`，后端按 `rowKey + runId` 二次验证，不能仅相信显示文字；
- 若不同来源表出现同名“大类 + 分类”，UI 在显示文字后附来源表名用于消歧，但字段本身仍保持用户要求的四个下拉框；
- 默认不预选资金目标；用户必须明确选择完整坐标后才能确认；
- `调整值`：必填，表示带正负号的增量；支持 `1,234.56`、`-1234.56`、会计负数 `(1234.56)`，规范化后最多两位小数；禁止空、非数、超过两位小数、超范围和 `0.00`；
- `调整原因`：trim 后必填，1～500 字；
- 右下角【确认】为蓝色、【取消】为普通按钮；
- 执行中禁用全部字段和关闭入口。

`Q06=A` 已确认：调整值表示在原结果上增加的正负增量，不表示目标单元格最终值。

### 4.3.3 调整账本（Q07 已确认）

新增 `vcc_fin_op_run_adjustments`，每次确认新增一条记录，不修改基础 `run_rows`：

```text
run_id
row_key
subject
source_type
category_major
category_minor
currency
adjustment_amount      -- 规范十进制字符串
reason
sequence
created_at
created_app_version
created_build_sha
```

用户已确认：**同一调整坐标只允许修改一次**。调整坐标固定为：

```text
run_id × row_key × currency
```

规则：

- 数据库必须建立 `UNIQUE(run_id, row_key, currency)`，不能只靠前端禁用；
- 第一次调整成功后，该坐标从可选项中移除或显示为“已调整”，再次提交返回 `adjustment-already-exists`；
- 已保存调整不可编辑、不可删除、不可追加反向调整，也不得在解归档后对同一坐标再次调整；
- 同一基础结果行的不同币种属于不同坐标，可各调整一次；
- 重新运行会生成新 run；新 run 的坐标可重新调整一次，旧 run 的调整不继承；
- 若第一次调整录入错误，唯一纠错路径为：删除该月全部未归档结果（`Q11=A`）→ 重新运行 → 重新调整；
- 归档后全部调整锁定；解归档只恢复该 run 的未处理状态，不重置“已调整”约束。

### 4.3.4 可调整范围（Q08=A）

默认只允许选择以下结果行：

- 充值清退发生额行；
- 费用及换汇发生额行；
- 通道发生额行；
- 当月移除 Pending 行/模板允许的 Pending 调整行。

禁止直接调整：

- 首月/上月期初；
- 系统财务OP；
- 当月计算财务OP；
- 差异。

后四类均为输入事实或派生汇总，必须由系统重算；不得通过人工调整绕过输入事实修复或系统派生公式。

### 4.3.5 生效公式

对主体 `S`、币种 `C`：

```text
基础发生额(S,C) = Σ 基础 run_rows.amount
人工调整(S,C)   = Σ persisted adjustments.adjustment_amount
生效发生额(S,C) = 基础发生额 + 人工调整
生效计算余额     = 期初余额 + 生效发生额
生效差异         = 系统财务OP - 生效计算余额
```

规则：

- 页面、Excel 导出、归档快照和下月期初全部使用“生效计算余额”；
- 基础 `run_balances` 保持不可变；通过统一 `getEffectiveRunResult()` 动态计算生效值；
- 归档事务必须重新计算，不得信任 renderer 传回的金额；
- `vcc_fin_op_runs.result_revision` 每次新增调整递增；确认归档须携带用户核对时的 revision，revision 不一致则要求重新核对。

### 4.3.6 调整在结果表中的展示

- 每条调整作为独立行加入结果表，不覆盖原业务行；独立行是为了支持同一基础行的不同币种分别调整一次；
- 调整行紧跟目标“大类 + 分类”结果行，按调整创建顺序排列；
- A～C 列保留目标主体、大类、分类；D～L 仅目标币种显示调整值，其余币种显示 `-`；
- M 列“调整值”写入同一规范调整值，N 列“调整原因”写入原因；
- D～L 目标金额格及 M 列的字体/数值格式复制模板 `D45`；
- N 列字体复制模板 `B45`；超长原因允许换行，但不得改变基础结果行高度；
- A～L 的结构样式从目标业务行复制；M/N 表头固定取模板 `M1/N1`；
- 结果导出回读必须能从该行唯一还原 `row_key + currency + adjustment_amount + reason`；
- 不得把模板第二个 sheet 的样例/占位值用于调整行。

---

## 4.4 需求 1.4 — 开始运行前检查校验表是否齐全

### 4.4.1 双层门禁

1. **前端预检**：用户选择账期后、worker 启动前调用 `run:preflight`；失败时不创建 worker。
2. **后端二次预检**：worker 在持久化计算结果前重新检查，并验证预检 revision；防止预检后数据被导入、删除或解归档。

### 4.4.2 检查内容

返回每个目标表的结构化状态：

```json
{
  "sourceType": "pending_archive_removal",
  "label": "VCC_移除归档Pending账单",
  "datasetExists": true,
  "rowCount": 10,
  "dataStatus": "unprocessed",
  "revision": 3,
  "complete": true,
  "reason": ""
}
```

至少检查：

- 必需校验表是否存在；
- 必需明细表是否至少有一条有效数据；
- 系统财务OP是否存在，且每个参与主体均有九币种完整快照；
- 各数据集状态是否为 `unprocessed`；
- 是否有活动导入；
- 是否有未解决导入异常；
- 首月是否存在完整人工期初；
- 非首月是否存在上一月已归档余额，禁止以人工期初绕过；
- 参与主体是否在发生额、系统财务OP和期初来源之间一致；
- 是否存在已归档结果；
- 输入 revision/fingerprint 是否稳定。

### 4.4.3 必需表口径（Q09 已确认）

用户已确认以下五类全部为必需：

1. VCC充值清退明细_校验表
2. VCC费用及换汇明细_校验表
3. VCC通道明细_校验表
4. VCC_移除归档Pending账单_校验表
5. 系统财务OP

门禁规则：

- 五类中缺少任意一类，立即阻断开始运行；
- 四类明细校验表均必须至少存在 1 条当前有效数据；只有 dataset 元数据但有效行数为 0 仍视为缺失；
- 系统财务OP必须至少存在 1 个完整主体快照，并满足每主体九币种；
- **业务不存在零 Pending 月**，因此不设计“本月无 Pending”声明、空表豁免或缺表按 0 处理；
- 当前代码把 Pending 视为可选，3.1.8 必须同步修改前端预检、worker 二次预检、错误文案和测试。

### 4.4.4 错误展示

错误弹框标题：`无法开始运行`。

示例：

```text
2026-06 的参与运算校验表不齐全：
• 缺少 VCC_移除归档Pending账单_校验表
• 系统财务OP 缺少主体 PPHK 的 CAD、AUD
• 存在 1 条未处理导入异常

请前往“数据管理 → 校验原表”补充或处理后重试。
```

不得只返回“数据不完整”或只写日志。

---

## 4.5 需求 1.5 — 结果表结构和字体按新模板重做

### 4.5.1 唯一模板源

确认后使用：

```text
assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx
```

- 禁止自动回退到旧 `财务OP校验结果表.xlsx`；
- 新文件必须进入安装包和 portable 包；
- 启动/导出时缺失或契约不一致，导出失败并明确提示模板路径，不得生成半样式文件。

### 4.5.2 从“固定行号”改为“语义锚点”

新增模板契约加载器，按文本和表头定位。当前上传模板的正式契约为：

- sheet：`财务OP校验结果表`，有效区域基线 `A1:N45`；
- 主表头完整顺序：
  `主体、大类、分类、AUD、CAD、CNH、EUR、GBP、HKD、JPY、SGD、USD、调整值、调整原因`；
- 业务行样式锚点：上月财务OP、有分类业务行、无分类业务行、通道行、当月移除pending、当月计算财务OP、当月系统财务OP、差异；
- 正常币种填充锚点：`D1（AUD）`；
- 非正常币种填充锚点：`E1（CAD）`；
- 调整值字体/数值格式锚点：`D45`；
- 调整原因字体锚点：`B45`；
- 调整列标题锚点：`M1/N1`。

模板没有专用“调整行”样例，因此不得再搜索一个不存在的固定调整行。调整行按 §4.3.6 从目标业务行结构样式、`D45/B45` 字体锚点及 `M1/N1` 列契约组合生成。

如果 sheet、14 列表头、币种顺序或任一唯一锚点缺失/重复，抛出 `result-template-contract-mismatch`。

### 4.5.3 必须复制的样式/布局

- sheet 名、列顺序；
- 列宽、行高；
- 合并单元格；
- 字体、字号、粗体、斜体、颜色；
- 填充；
- 边框；
- 水平/垂直对齐、自动换行；
- 数值格式；
- freeze panes；
- 打印方向、纸张、缩放、边距、打印区域；
- 模板允许的页眉页脚和隐藏行列。

动态行数量变化时，应复制对应语义行样式并重建合并区域，禁止继续依赖模板固定行号。

### 4.5.4 输出结构

本迭代保留当前输出习惯：

- 每个主体生成一个工作簿；
- Sheet 1：`财务OP校验结果表`；
- Sheet 2：`移除归档Pending发生额计算表`；
- 单主体走保存文件，多主体走选择目录；
- 文件名继续为：`YYYY-MM_主体_VCC财务OP校验结果表.xlsx`。

---

## 4.6 需求 1.6 — 币种单元格颜色填充

### 4.6.1 判定值

颜色判定使用**生效差异**，即已包含全部调整后的差异。

对每个主体、每个币种：

```text
生效差异 != 0  → 非正常
生效差异 == 0  → 正常，差异单元格显示“-”
```

- 使用十进制规范值比较，不使用格式化字符串或 JS 浮点；
- `0`、`0.00`、`-0.00` 均视为 0；
- 任意非零正负值均为非正常。

### 4.6.2 填充来源

- 正常颜色：复制新模板中 AUD 币种单元格的 `fill`；
- 非正常颜色：复制新模板中 CAD 币种单元格的 `fill`；
- 不硬编码 ARGB；
- 仅替换目标单元格的填充，其他字体、边框和对齐仍按模板币种表头样式。

### 4.6.3 着色范围（Q10=A）

“币种单元格”固定指结果表首行的九个币种表头单元格，每个币种按其生效差异单独着色；不对整列或仅差异金额格着色。

页面预览和导出 Excel 必须使用同一判定函数，避免页面蓝色、导出红色的分叉。

---

## 4.7 需求 1.7 — 修复系统财务OP读取精度

### 4.7.1 取值优先级

重写系统财务OP金额读取规则：

1. 单元格为数值或公式缓存数值：优先使用 raw value；
2. raw value 是安全、有限数字时，转换为稳定十进制 token 后交给 `canonicalizeVccAmount`；
3. 单元格为文本时，使用显示/文本值，兼容千分位、括号负数和 `-`；
4. 显示值仅用于报错和审计，不得覆盖有效 raw numeric；
5. raw 与 display 均存在且规范化后不一致时，记录 `amount-display-raw-mismatch` 审计信息，但以 raw 为准；
6. 原始金额超过安全范围、超过两位小数或无法稳定规范化时拒绝导入，不得自动四舍五入。

### 4.7.2 审计负载

系统快照 `raw_json` 中每个余额增加读取证据：

```json
{
  "field": "财务余额",
  "cell": "M4",
  "source": "raw-numeric",
  "rawValue": 135886024.59,
  "displayValue": "135886024.6",
  "canonicalValue": "135886024.59"
}
```

### 4.7.3 样例验收

使用上传的 `财务OP (22).xlsx`：

- PPHK / JPY / 财务余额导入后必须为字符串 `135886024.59`；
- 数据管理导出、结果计算、确认页面和最终 Excel 均不得出现 `135886024.6`；
- CNY 仍按既有规则规范为 CNH；
- 其他八币种不得回归。

---

## 4.8 需求 1.8 — 导出校验结果表增加月份选择

### 4.8.1 弹框

点击主页面【导出校验结果表】后，不再直接导出最新结果，先打开：

```text
请选择要导出的月份

月份  [年份 ▼]  [月份 ▼]

                         [导出] [取消]
```

要求：

- 左上角标题：`请选择要导出的月份`；
- 年份、月份为两个单选下拉框；
- 年份左侧文本：`月份`；
- 枚举仅来自一致的已归档结果表；
- 默认选中最新已归档月份；
- 年份和月份级联规则与解归档弹框相同；
- 右下角【导出】在左、【取消】在右；
- 【导出】为蓝色；
- 无已归档结果时主按钮禁用并显示空状态。

### 4.8.2 后端查询

新增：

- `listArchivedResultMonths()`：返回按月倒序的归档结果摘要；
- `getArchivedRunByMonth(targetMonth)`：严格返回目标月唯一归档 run；
- 一致性检查：run、archive subjects、datasets 三方一致才进入枚举；异常月份写日志并从枚举排除；
- `exportResult` 仍只接受 archived run，renderer 不得自行传任意 runId 绕过月份解析。

### 4.8.3 与解归档联动

- 解归档成功后，该月立即从导出枚举移除；
- 重新归档后重新进入枚举；
- 正在导出时禁止解归档同月；正在解归档时禁止导出同月。

---

## 4.9 需求 1.9 — 删除数据新增“财务OP校验结果表”

### 4.9.1 枚举

“数据管理 → 删除数据 → 目标表”新增：

```text
财务OP校验结果表
```

- 选择月份存在结果 run 时显示；
- 仅存在已归档结果时仍可显示，但【删除】禁用并提示“已归档结果不可删除，请先解归档”；
- 不进入数据导出页面的目标表枚举，结果导出仍走主页面专用入口。

### 4.9.2 可删除范围（Q11=A 已确认）

- 只允许删除 `calculated / 未处理` 结果；
- **一次删除目标月全部未归档 run**，不得只删除最新一份、不得让更旧 run 重新成为可归档结果；
- 正常情况下同月只有一份未归档 run；若旧库或异常状态存在多份，preview 必须显示实际数量，并在同一事务中全部删除；
- 删除每个 run 时级联删除：
  - run rows；
  - run balances；
  - Pending 汇总及币种合计；
  - 该 run 的全部调整；
- 保留：
  - 五类导入事实和数据集；
  - 导入记录、幂等及异常审计；
  - 首月期初；
  - 任何已归档月份；
- 删除前按 run 分别固化完整结果、调整、输入 fingerprint 和删除原因，保证“有效结果清空、历史证据保留”；
- 该行为同时作为错误调整的唯一纠错入口：删除全部未归档 run 后重新运行，生成新 run 再调整。

### 4.9.3 门禁和事务

- 已归档：禁止；
- 活动任务：禁止；
- 无结果：删除禁用；
- preview token 与提交时不一致：拒绝；
- 单事务执行审计快照、active run 删除和提交后断言；
- 删除成功后数据管理“结果表”为空，但校验表/原表仍为未处理并可重新运行。

---

## 4.10 需求 1.10 — 以最新 Pending 模板纠正模板和识别契约

### 4.10.1 金标准（Q12 已确认）

唯一金标准：

```text
assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx
```

该路径必须使用用户本轮上传文件替换旧资产。模板元数据：

- 46 列，有效区域 `A1:AT1`；
- 表头位于第 1 行；
- 最后一列为 `是否已流水替换`；
- sheet 名不属于用户导入识别条件，用户文件可重命名 sheet；
- 文件/表头指纹见 §2.3；
- 新导入只接受本 46 列模板，不继续兼容旧 48 列模板。

### 4.10.2 识别契约

保留严格识别原则：

- 每个表头 trim 前后空格；
- 移除末尾全空表头格；
- 列数、字面值、大小写、下划线和顺序必须完全相同；
- 不提供列别名、乱序容忍或缺列补空；
- 在前 220 个有意义行中寻找表头；
- 工作簿中只能有一张可识别业务 sheet；
- 正式导入时再次验证同一表头，防止识别与读取契约分叉；
- 缺列、额外非空列、错序、重复业务 sheet 均拒绝导入，并报告首批差异列；
- 旧 48 列文件必须明确报错“模板已更新，请使用 46 列 VCC_移除归档Pending账单.xlsx”，不得被识别为近似合法文件。

新原表不包含 `是否错币` 和 `金额差`：

- `PENDING_HEADERS` 必须删除这两列；
- `row-mapper` 继续从 `币种` 与 `流水_币种` 计算 `currencyMismatch`；
- 校验表仍输出派生列 `是否错币`；
- `金额差` 不进入原表、校验表、幂等内容或发生额公式。

### 4.10.3 防漂移实现

新增 `test-vcc-pending-template-contract`：

1. 读取真实资产第一个非空表头行；
2. 与新 `PENDING_HEADERS` 逐列比对；
3. 断言 46 列、`A1:AT1` 和 header fingerprint；
4. 断言 golden asset 的 SHA-256；
5. 复制资产生成合法 fixture，验证识别和正式导入共用同一契约；
6. 对删除一列、增加一列、交换两列、改下划线、重复可识别 sheet 分别断言失败；
7. 以旧 48 列模板作为反例，断言返回专用升级提示；
8. 任意一侧有意更新时，必须在同一提交中更新模板、常量、指纹、契约版本、测试和使用手册。

### 4.10.4 正式 46 列表头

完整清单见附录 A。

### 4.10.5 历史 48 列数据与幂等迁移

仅改变新导入表头而不迁移历史哈希，会使同一 `PendingBizId` 的 46 列重放被误判为“同键异内容”。3.1.8 必须引入版本化原始契约：

```text
Pending raw contract v1 = 历史 48 列（含 是否错币、金额差）
Pending raw contract v2 = 本次 46 列
Pending content hash v2 = 对 v2 的 46 个源字段计算
```

迁移要求：

1. `vcc_fin_op_import_rows` 和 `vcc_fin_op_effective_rows` 新增 `raw_contract_version`；旧数据回填 `1`，新 Pending 导入写 `2`。
2. `vcc_fin_op_effective_rows` 新增 `legacy_content_hash`，保存迁移前 v1 哈希。
3. 对历史 Pending 有效行：
   - 保留原 48 项 `raw_json` 不改；
   - 按旧列定义移除 `是否错币`、`金额差`后得到 canonical 46 项；
   - 计算 v2 `content_hash`，设置 `hash_version=2`，原哈希写入 `legacy_content_hash`；
   - `raw_contract_version` 仍为 `1`，保证历史详情按旧 48 列正确显示。
4. 新 Pending 导入直接以 46 项 `raw_json`、`raw_contract_version=2`、`hash_version=2` 落库。
5. 导入详情、幂等对比和审计导出必须根据 `raw_contract_version` 选择 48/46 列标题；不得用新 46 列标题错位解释旧 `raw_json`。
6. 迁移前先 dry-run：历史 Pending `raw_json` 既不是 48 项也不是已知 46 项时阻断升级并输出记录 ID，不做部分迁移。
7. 同一业务键在迁移后必须保持原有效事实唯一；同内容 46 列重放为幂等跳过，真实字段变化仍为冲突。

---

## 5. 数据库迁移设计

## 5.1 `vcc_fin_op_module_state`

```sql
CREATE TABLE IF NOT EXISTS vcc_fin_op_module_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  first_month TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

迁移：

- 插入 singleton；
- 若 `first_month` 为空且存在 opening balances，以最早 target_month 回填；
- 若存在多个 opening 月份，记录升级诊断并阻断相关月运行，禁止自动删改；
- 删除期初时不清 `first_month`。

## 5.2 `vcc_fin_op_run_adjustments`

```sql
CREATE TABLE IF NOT EXISTS vcc_fin_op_run_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_type TEXT NOT NULL,
  category_major TEXT NOT NULL,
  category_minor TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  adjustment_amount TEXT NOT NULL,
  reason TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_app_version TEXT,
  created_build_sha TEXT,
  FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE,
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, row_key, currency)
);

CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_adjustments_run_row
  ON vcc_fin_op_run_adjustments(run_id, row_key, currency);
```

调整记录为不可变一次性事实，不增加编辑、删除、撤销或反向冲销字段。第二次写入同一 `run_id × row_key × currency` 必须由数据库唯一约束拒绝。

## 5.3 `vcc_fin_op_runs` 扩展

```text
result_revision INTEGER NOT NULL DEFAULT 0
updated_at TEXT
input_fingerprint TEXT
```

- 新 run 写入版本化输入 fingerprint；
- 每次添加调整 `result_revision + 1`；
- 解归档和重新归档更新 `updated_at`；
- 旧 calculated run 若缺少新 fingerprint，不允许直接归档，要求重新运行；
- 旧 archived run 保持只读并可导出/解归档，但解归档后重新归档前必须通过输入 fingerprint 校验。

## 5.4 Pending 原始契约版本列

```sql
ALTER TABLE vcc_fin_op_import_rows
  ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE vcc_fin_op_effective_rows
  ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE vcc_fin_op_effective_rows
  ADD COLUMN legacy_content_hash TEXT;
```

实现要求：

- 仅 Pending 新导入写 `raw_contract_version=2`；其他原表保持既有版本口径；
- Pending 内容哈希版本单独提升为 2，不能无差别改变其他三类明细的 `HASH_VERSION`；
- 升级迁移必须在单事务中完成 dry-run、旧哈希保存、v2 哈希更新和提交后数量/哈希断言；
- 历史 `raw_json` 不重写，导入详情按版本选择旧 48 列或新 46 列表头；
- 迁移失败时数据库保持 v3.1.7 原状态，应用不得开放 Pending 新模板导入。

## 5.5 `vcc_fin_op_operation_audit`

```sql
CREATE TABLE IF NOT EXISTS vcc_fin_op_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_month TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  run_id INTEGER,
  status TEXT NOT NULL,
  preview_token TEXT,
  evidence_json TEXT NOT NULL,
  error_message TEXT,
  app_version TEXT,
  build_sha TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

`operation_type` 至少包含：

- `unarchive`
- `delete_opening_initialization`
- `delete_unarchived_result`
- `replace_calculated_result`

失败事务的业务数据必须回滚；失败审计可在回滚后单独落一条轻量记录，但不得让失败审计写入掩盖原异常。

---

## 6. 后端服务、Worker 与 IPC 契约

## 6.1 新增/调整后端能力

建议新增文件：

```text
src/backend/vcc-financial-op/result-adjustments.js
src/backend/vcc-financial-op/unarchive.js
src/backend/vcc-financial-op/data-target-deletion.js
src/backend/vcc-financial-op/result-template-contract.js
src/backend/vcc-financial-op/pending-template-contract.js
```

统一 API：

| 方法 | 作用 |
|---|---|
| `preflightRun(targetMonth)` | worker 前结构化完整性预检。 |
| `getEffectiveRunResult(runId)` | 返回基础值、调整行和生效汇总。 |
| `listAdjustmentOptions(runId)` | 返回可调整 rowKey 及级联下拉选项。 |
| `addRunAdjustment(payload)` | 校验并追加调整，递增 result revision。 |
| `listArchivedResultMonths()` | 只返回一致的已归档月份。 |
| `previewUnarchive(targetMonth)` | 解归档门禁、依赖和 token。 |
| `unarchiveMonth(payload)` | 单事务解归档。 |
| `listDeleteTargets(targetMonth)` | 返回动态删除目标和可用性。 |
| `previewDataTargetDeletion(payload)` | 统一预检源表/期初/结果删除。 |
| `deleteDataTarget(payload)` | 统一后台删除。 |
| `getArchivedRunByMonth(targetMonth)` | 解析导出目标 run。 |

## 6.2 Worker action

扩展 `worker-entry.js`：

```text
preflight-run               -- 可在主进程轻量执行；若读量大则 worker
unarchive-month
delete-data-target
```

- destructive action 期间 VCC 模块全局 busy；
- 取消规则：事务开始前可取消，事务开始后禁止强制终止，等待提交/回滚；
- 不得把 `worker.terminate()` 用在已进入写事务的解归档/删除操作。

## 6.3 IPC / preload

建议通道：

```text
vccFinancialOp:run:preflight
vccFinancialOp:run:adjustment-options
vccFinancialOp:run:adjustment-add
vccFinancialOp:run:archived-months
vccFinancialOp:run:unarchive-preview
vccFinancialOp:run:unarchive
vccFinancialOp:run:get-by-month
vccFinancialOp:data-manager:delete-targets
vccFinancialOp:data-manager:delete-preview
vccFinancialOp:data-manager:delete
vccFinancialOp:export:result
```

现有 `latestArchivedRun()` 可暂留兼容，但 renderer 主流程不再依赖它。

## 6.4 Preview token

所有 destructive preview 返回 token，至少覆盖：

- targetMonth；
- run id/status/result revision；
- archive subject/hash；
- dataset revisions/status；
- opening content hash；
- active task generation。

提交时重新计算 token；不一致返回 `state-changed`，提示用户重新打开页面。

---

## 7. Renderer 设计

## 7.1 可复用年月选择控件

抽出 `createArchivedMonthPickerDialog(options)`，供解归档和结果导出复用：

- 共享年份/月级联、最新默认、空状态、键盘和 loading 逻辑；
- 标题、主按钮文本和主按钮样式通过参数传入；
- 解归档：`请选择月份` / `删除` / danger；
- 导出：`请选择要导出的月份` / `导出` / primary blue。

不得复制两套后逐渐产生默认值或排序分叉。

## 7.2 数据管理删除页

- 目标表下拉改为后端动态返回，不再只由前端 `SOURCE_LABELS` 写死；
- 根据月份实时加入/移除“首月期初初始化数据”；
- 结果表存在时加入“财务OP校验结果表”；
- 每个目标携带 `available/disabledReason/count`；
- 选择变化后重新 preview，禁止沿用旧 count/token。

## 7.3 结果确认页

- 渲染完整结果结构和调整行；
- 调整行具有可辨识的“人工调整”标记，但不得改变模板要求的字体；
- 汇总和差异由后端生效结果返回，不在前端自行金额加总；
- 保存调整、删除/解归档或 run revision 变化后，归档确认勾选清空；
- 归档时提交 `expectedResultRevision`。

## 7.4 前端隐藏期初

删除：

- `renderOpeningAudit(...)`；
- data manager opening balance 卡片和相关 renderer state；
- 普通 preload response 中的期初明细。

保留：

- 首月运行时的期初输入弹框；
- 结果表中的期初计算行；
- 删除 preview 中只显示“主体数/数据条数”，不回显具体余额。

---

## 8. Excel Writer 设计

## 8.1 数据加载

`loadRunData()` 改为加载：

- 基础 balances；
- 基础 movements；
- pending summary/totals；
- adjustments；
- effective balances；
- result revision。

归档和导出必须共用 `getEffectiveRunResult()`，不得各自重写调整公式。

## 8.2 模板契约缓存

- 首次导出读取模板并生成内存契约；
- 以文件 stat/hash 作为缓存键；
- 打包环境只读；
- 模板读取失败不降级到手工样式。

## 8.3 行生成

建议中间模型：

```json
{
  "rowType": "movement | adjustment | calculated | system | difference | opening | pending",
  "rowKey": "...",
  "subject": "PPHK",
  "major": "...",
  "minor": "...",
  "reason": "...",
  "amounts": {"AUD":"0.00", "JPY":"-100.00"}
}
```

writer 只负责按中间模型套模板，不负责重新解释数据库业务来源。

## 8.4 数值输出

- Excel 写入值为有限 number，但来源必须先经过规范十进制校验；
- 结果测试应以重新读取后的数值和 number format 为准，不使用工作簿字节 hash 作为唯一 golden；
- 差异零值由 number format 或显式样式显示 `-`；
- 大额两位小数必须 round-trip。

## 8.5 输出校验

临时文件写完、原子替换前检查：

- 两个预期 sheet 且顺序正确；
- 表头和九币种顺序正确；
- 目标主体正确；
- 调整行数量、原因和金额与 DB 一致；
- 当月计算余额/差异与后端 effective result 一致；
- 九个币种表头 fill 与正常/异常判断一致；
- 样式锚点关键属性与模板一致；
- 文件可被 ExcelJS 重新打开。

---

## 9. 错误码与用户文案

| code | 触发条件 | 建议文案 |
|---|---|---|
| `no-archived-results` | 无已归档结果 | 暂无已归档财务OP校验结果。 |
| `unarchive-not-tail` | 选择非尾月且采用尾月策略 | 该月之后仍存在已归档/已计算月份，请先从最新月份开始解归档。 |
| `archive-state-inconsistent` | run/archive/dataset 不一致 | 该月归档状态不一致，已阻止操作，请导出错误报告。 |
| `active-vcc-task` | 有活动任务 | 已有 VCC 财务OP任务正在运行，请完成后重试。 |
| `state-changed` | preview token 失效 | 数据状态已变化，请刷新并重新确认。 |
| `not-first-month` | 非首月删期初 | 仅首月可删除期初初始化数据。 |
| `opening-archived` | 首月结果已归档 | 请先解归档该月结果，再删除期初初始化数据。 |
| `missing-datasets` | 运行表不齐 | 参与运算的校验表不齐全。 |
| `invalid-adjustment-target` | rowKey 不属于当前 run | 调整目标已变化，请刷新结果表后重试。 |
| `adjustment-locked` | archived run 添加调整 | 已归档结果不能修改，请先解归档。 |
| `result-revision-changed` | 核对后又有调整 | 结果已发生变化，请重新核对后归档。 |
| `result-template-missing` | 新模板缺失 | 未找到 VCC财务OP校验结果表_模板.xlsx，已停止导出。 |
| `result-template-contract-mismatch` | 新模板锚点异常 | 结果模板结构与契约不一致，未生成文件。 |
| `pending-template-contract-mismatch` | Pending 表头异常 | Pending 原表表头与最新正式模板不一致。 |
| `amount-raw-display-mismatch` | raw/display 不一致 | 记录审计，数值 raw 有效时不阻断；raw 无效时阻断。 |
| `amount-precision-invalid` | 金额无法稳定保留两位 | 财务余额精度无效，未导入该批数据。 |
| `result-archived-delete-forbidden` | 删除已归档结果 | 已归档结果不可删除，请先解归档。 |

---

## 10. 代码改动地图

### 10.1 后端/数据库

- `src/backend/vcc-financial-op/definitions.js`
  - `PENDING_HEADERS` 从旧 48 列纠正为用户模板的 46 列；
  - 保留历史 v1 48 列定义，仅供旧审计反序列化，不参与新文件识别；
- `src/backend/vcc-financial-op/workbook-reader.js`
  - 严格识别新 46 列；对旧 48 列返回专用模板升级提示；
- `src/backend/vcc-financial-op/system-op-importer.js`
  - raw numeric 优先、读取证据；
- `src/backend/vcc-financial-op/row-mapper.js`
  - Pending 新原表不再读取 `是否错币/金额差`；`是否错币`继续派生；
  - Pending v2 canonical hash 和 raw contract version；
- `src/backend/vcc-financial-op/detail-importer.js`
  - 识别跨 v1/v2 Pending 历史幂等，避免模板升级制造假冲突；
- `src/backend/vcc-financial-op/calculator.js`
  - 五表强制 preflight、输入 fingerprint、effective result、归档使用调整；
- `src/backend/vcc-financial-op/dataset-deletion.js`
  - 不直接塞入伪 source type；由统一 data-target deletion dispatcher 调用；
- `src/backend/vcc-financial-op-db/migrations.js`
  - 新表/新列和旧库诊断；
- `src/backend/vcc-financial-op-db/repository.js`
  - archived months、state、adjustments、audit 查询；
- 新增：
  - `result-adjustments.js`
  - `unarchive.js`
  - `data-target-deletion.js`
  - `result-template-contract.js`
  - `pending-template-contract.js`

### 10.2 主进程/IPC

- `src/main-process/vcc-financial-op-service.js`
  - 新服务方法；data manager 不返回 opening 明细；
- `src/backend/vcc-financial-op/worker-entry.js`
  - destructive actions；
- `src/main-process/vcc-financial-op-writer.js`
  - 语义模板、调整行、颜色和 effective result；
- `src/main.js`
  - 新 IPC handlers；
- `src/preload.js`
  - 新安全 API；
- 业务操作 registry / usage stats：为解归档、修改结果、删除结果注册成功动作统计，query/preview 不计数。

### 10.3 Renderer / CSS / Preview

- `src/renderer-vcc-financial-op.js`
  - 解归档、月份导出、动态删除目标、完整结果和调整弹框；
- 对应 CSS 文件
  - 底部左右布局、危险/主按钮、弹框双下拉、调整表；
- `src/renderer-previews.js` 与 preview 脚本
  - 新增所有关键 UI 状态。

### 10.4 Assets / Docs

- `assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx`（使用用户上传文件，SHA-256 见 §2.4）；
- `assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx`（用用户上传的 46 列文件替换旧资产，作为 golden，不得被测试修改）；
- `changes/3.1.8/spec.md`；
- `changes/3.1.8/implementation-notes.md`；
- `CHANGELOG.md`；
- `docs/VERSION_FEATURE_HISTORY.md`；
- `docs/USER_GUIDE.md`；
- `rules/important-variables.md`；
- package/package-lock 版本同步到 `3.1.8`。

---

## 11. 测试计划

## 11.1 单元测试

### U1 解归档

- 最新月成功：archive 行删除、run→calculated、datasets→unprocessed；
- 非最新月按默认策略阻断；
- archive subject 缺失、run id 不一致、dataset 混合状态均 fail-closed；
- 调整行在解归档后保留；
- 事务中途异常全部回滚；
- preview token 变化阻断。

### U2 首月期初

- 首次初始化写 first_month；
- 删除期初不清 first_month；
- 非首月不显示/不允许删除；
- archived 结果阻断；
- 删除期初同步删除 calculated result；
- 源数据和导入审计不变；
- 多 opening 月旧库触发诊断，不自动迁移资金值。

### U3 调整

- 正/负增量；
- 千分位、括号负数；
- 0、三位小数、NaN、Infinity、超范围拒绝；
- 同一 `run × rowKey × currency` 首次成功、第二次由数据库唯一约束拒绝；
- 同一基础行不同币种可各调整一次；
- 已调整坐标不再出现在可选项中，伪造二次提交仍失败；
- rowKey 伪造拒绝；
- 禁止调整派生/输入行；
- archived 锁定；解归档后同一坐标仍不可再次调整；
- 错误调整通过“删除目标月全部未归档 run → 重跑”纠正；
- result revision 递增；
- 重新运行不继承旧调整；
- effective balance/difference 公式逐币种正确。

### U4 运行完整性

- 五表齐全通过；
- 每一种缺表分别返回准确表名；
- 四类明细表存在 dataset 但有效行数为 0 时均阻断；Pending 不存在零数据月豁免；
- 缺主体、缺币种、缺期初、缺上月归档、活动导入、未处理异常分别阻断；
- preview 与 worker 二次检查一致。

### U5 系统财务OP精度

- 样例 JPY `135886024.59`；
- General 大额两位小数；
- 公式缓存数值；
- 文本千分位；
- 会计负数；
- `-` 零值；
- raw/display 不一致时 raw 优先并记录审计；
- 超两位小数拒绝且不静默 round。

### U6 模板与契约迁移

- Pending 资产 SHA/46 列/`A1:AT1`/指纹；
- 新模板明确不含 `是否错币`、`金额差`；
- 缺列、增列、换序、下划线变化、重复 sheet 失败；
- 旧 48 列文件作为新导入反例，返回专用升级提示；
- 历史 48 项 `raw_json` 迁移后仍按旧表头正确展示；
- 历史同内容数据以新 46 列重放为幂等跳过，不产生假冲突；
- 结果模板 `A1:N45`、14 列表头和所有语义锚点唯一；
- `D1/E1` fill 能读取且不相同；
- `D45/B45` 调整字体锚点存在；
- 旧固定行号变化不影响 writer。

## 11.2 数据库集成测试

至少构造连续三个月：

1. M1 人工期初 → 计算 → 调整 → 归档；
2. M2 使用 M1 调整后归档作为期初 → 计算 → 归档；
3. M3 计算未归档。

覆盖：

- 选择 M1 解归档因 M2 依赖被阻断；
- 解归档 M2 成功，M1 保持归档；
- M2 调整保留，重新归档后 M3 重新运行使用新余额；
- 删除 M1 期初前必须解归档并处理后续依赖；删除后 M1 结果不存在；
- 删除 M3 结果后源数据仍完整，重新运行可生成新 run；
- 导出选择 M1/M2 得到正确月份，不再恒导出最新；
- worker/主进程重启后状态和审计仍一致。

## 11.3 Excel 集成测试

- 用真实 `_模板.xlsx` 生成结果；
- 对每个主体重新打开输出；
- 核对 sheet、行列、合并、关键字体、边框、fill、numFmt、打印设置；
- 构造 AUD 差异 0、CAD 差异非 0，断言表头 fill 分别等于模板锚点；
- 添加 JPY 调整，断言调整值字体等于差异金额字体、原因字体等于差异文本字体；
- 断言最终计算余额和差异包含调整；
- 断言样例 `135886024.59` round-trip；
- 多主体文件名冲突和目录导出回归。

## 11.4 Renderer / Preview

必须有可重复预览：

- 数据管理：有/无归档，左下角解归档；
- 解归档弹框：默认最新、切年、非尾月阻断、执行中；
- 导出月份弹框：默认最新、空状态、蓝色按钮；
- 删除页：普通月、首月、首月已归档、未归档结果；
- 结果确认：无调整、单调整、多调整、已归档锁定；
- 缺表预检错误；
- 100%/125%/150% 缩放，窗口最小尺寸无截断。

## 11.5 回归与发布门禁

- 现有 VCC import/idempotency/calculator/archive/delete/export 全量测试；
- 其他模块 smoke；
- `npm run test:unit`；
- `npm run test:integration`；
- `npm run smoke`；
- `npm run release-check`；
- `npm run scan:vars` / `check:vars`；
- Windows 构建、模板打包存在性、portable/installer 读取模板；
- 财务人员对至少一个真实月份逐主体、逐币种核对：基础值、调整、生效余额、差异、颜色、归档和下月期初。

---

## 12. 验收矩阵

| ID | Given | When | Then |
|---|---|---|---|
| AC-1.1-01 | 存在多个已归档月份 | 打开解归档 | 年/月只来自归档结果，默认最新；删除红色。 |
| AC-1.1-02 | 目标为允许解归档的月份 | 点击删除 | 归档快照删除，结果及校验数据变未处理，基础结果保留。 |
| AC-1.1-03 | 目标不是当前最新已归档月份 | 点击删除 | preview 和事务二次门禁均阻断，并列出依赖它的后续月份；不得级联、不得只改目标月。 |
| AC-1.2-01 | 打开数据管理结果表 | 查看页面 | 不展示首月期初初始化审计数据。 |
| AC-1.2-02 | 删除页选择首月 | 查看目标表 | 显示“首月期初初始化数据”；其他月份不显示。 |
| AC-1.2-03 | 首月结果已归档 | 尝试删除期初 | 禁止，并提示先解归档。 |
| AC-1.2-04 | 首月未归档 | 删除期初 | 期初和未归档结果失效，源表保留；下次运行要求重新输入。 |
| AC-1.3-01 | calculated 结果且坐标未调整 | 添加合法调整 | 调整持久化，完整结果、汇总、差异、颜色即时更新。 |
| AC-1.3-02 | 同一 run 的同一 rowKey + 币种已调整 | 再次提交 | 前后端均拒绝，既有调整不变。 |
| AC-1.3-03 | archived 结果 | 尝试调整 | 禁止。 |
| AC-1.3-04 | 有调整结果 | 归档并计算下月 | 归档和下月期初使用调整后余额。 |
| AC-1.4-01 | 缺任一必需表或 Pending 有效行数为 0 | 点击开始运行 | worker 不启动，明确列出缺失/空表；不提供零 Pending 豁免。 |
| AC-1.4-02 | 预检后数据变化 | worker 二次检查 | 拒绝持久化旧快照结果。 |
| AC-1.5-01 | 新模板可用 | 导出 | 结构、字体、边框、布局与模板语义锚点一致。 |
| AC-1.5-02 | 新模板缺失/异常 | 导出 | 明确失败，不回退旧模板、不生成半成品。 |
| AC-1.6-01 | 某币种生效差异为 0 | 页面/导出 | 差异显示“-”，币种单元格使用 AUD fill。 |
| AC-1.6-02 | 某币种生效差异非 0 | 页面/导出 | 币种单元格使用 CAD fill。 |
| AC-1.7-01 | 导入样例 JPY | 完成导入 | 保存和显示 `135886024.59`。 |
| AC-1.8-01 | 有多个归档月 | 点击导出 | 可选择年份/月，默认最新，导出选中月。 |
| AC-1.8-02 | 某月已解归档 | 再打开导出 | 该月不在枚举中。 |
| AC-1.9-01 | 某月有一份或多份 calculated run | 删除结果 | 该月全部未归档 run/子表/调整一次性删除，源数据和期初保留。 |
| AC-1.9-02 | 某月结果 archived | 删除结果 | 禁止，提示先解归档。 |
| AC-1.10-01 | 使用用户指定的 46 列 Pending 模板 | 识别并导入 | 识别和正式导入均通过，是否错币由系统派生。 |
| AC-1.10-02 | 模板表头任一处变化 | 识别/正式导入 | fail-closed，并报告差异列。 |
| AC-1.10-03 | 使用旧 48 列模板 | 新导入 | 拒绝并提示改用 46 列模板。 |
| AC-1.10-04 | 数据库已有 48 列历史 Pending 行 | 升级后以同内容 46 列重放 | 历史审计仍可读，重放为幂等跳过而非冲突。 |

---

## 13. 实施拆分建议

### Phase 0 — 决策与资产门禁

- 决策已全部锁定；实施前仅复核代码基线、两份用户模板及金额样例与本 Spec 是否一致，不再重新选择 Q01～Q12；
- 将用户上传的结果模板纳入指定 `_模板.xlsx` 路径；
- 用用户上传的 46 列 Pending 文件替换旧资产；
- 建立两个模板契约测试及 Pending v1→v2 dry-run fixture；
- 先固化上传样例的 precision regression fixture。

### Phase 1 — 精度、Pending 契约迁移与运行前预检

- 修 `system-op-importer` raw-first；
- `PENDING_HEADERS` 切换为 46 列并完成历史 v1→v2 哈希迁移；
- 扩展五表强制 preflight 和结构化错误；
- 完成样例回归；
- 不触碰 UI 状态机。

### Phase 2 — 数据库状态模型

- module_state、adjustments、operation_audit、runs 新列；
- 旧库迁移与诊断；
- effective result 共享函数。

### Phase 3 — 解归档与两类删除

- unarchive transaction；
- 首月期初删除；
- 未归档结果删除；
- worker、token、审计和集成测试。

### Phase 4 — 调整和确认页面

- adjustment options/add；
- full result review；
- revision gate；
- 归档使用 effective result。

### Phase 5 — 模板 writer、颜色与月份导出

- 语义模板 loader；
- 调整行样式；
- AUD/CAD fill；
- 历史归档月份选择导出；
- Excel 集成测试。

### Phase 6 — 回归、文档与发布

- previews、全量回归、check-vars；
- 文档反向同步；
- 版本号 3.1.8；
- Windows CI、财务人工核对和 release evidence。

建议提交：

1. `fix(vcc-op): preserve raw system-op amount precision and lock pending contract`
2. `feat(vcc-op): add first-month state and effective result adjustment ledger`
3. `feat(vcc-op): add audited unarchive and data-manager result deletion`
4. `feat(vcc-op): add full result review and manual adjustments`
5. `feat(vcc-op): adopt semantic result template and archived-month export`
6. `docs(release): document and prepare v3.1.8`

---

## 14. 用户决策状态（全部确认）

用户已确认“其他按推荐方案执行”。`Q01～Q12` 全部锁定如下，实施中不得再次切换方案：

| ID | 用户最终决策 | 最终实施口径 |
|---|---|---|
| Q01 | A：使用用户上传的 `VCC财务OP校验结果表_模板.xlsx` | 纳入 `assets/VCC财务OP校验/`；只以 `财务OP校验结果表` sheet 为 1.5/1.6 样式契约；禁止回退旧模板。 |
| Q02 | A：只允许解归档当前最新已归档月份 | 非尾月仍可在下拉框中查看，但 preview 和事务均阻断；不做级联解归档，也不允许只改单月破坏跨期血缘。 |
| Q03 | A：首月为模块全局固定月份 | 第一次成功初始化后持久化 `first_month`；删除期初余额不清除、不漂移该值；所有主体共用。 |
| Q04 | A：仅隐藏独立期初初始化审计展示 | 数据管理结果页不显示初始化卡片/列表；结果表中的“上月财务OP/期初余额”计算行继续保留。 |
| Q05 | A：删除首月期初时删除该月全部主体 | 不增加主体筛选；期初、说明和未归档结果在单事务内整体删除/失效，源表和 `first_month` 保留。 |
| Q06 | A：调整值为正负增量 | 生效金额 = 基础金额 + 调整值；不把输入值解释为最终单元格值。 |
| Q07 | 同一调整坐标只允许修改一次 | `UNIQUE(run_id, row_key, currency)`；不可编辑、删除、冲销或解归档后再次调整；错误时删除全部未归档结果后重跑。 |
| Q08 | A：只允许调整业务发生额和 Pending 行 | 期初、系统财务OP、当月计算财务OP和差异禁止直接调整，均由系统重新派生。 |
| Q09 | A：五类表全部必需，且不存在零 Pending 月 | 五类全部存在；充值、费用、通道、Pending 四类明细均至少 1 条有效数据；缺失或空表均阻断，不提供零 Pending 声明。 |
| Q10 | A：着色对象为九个币种表头单元格 | 每个币种表头依据该币种生效差异单独复制 AUD/CAD fill；不着色整列，也不只着色差异金额格。 |
| Q11 | A：删除该月全部未归档 run | 同月异常存在多份未归档结果时也全部删除；同时删除其子表和调整，保留源数据、导入审计及首月期初。 |
| Q12 | A：使用用户上传的 Pending 模板 | 新导入唯一契约为 46 列；旧 48 列不再接收，但历史数据按契约版本保留并迁移幂等哈希。 |

### 14.1 决策变更门禁

上述任一决策若未来需要改变，必须新开版本或独立变更 Spec，并至少重新评审：

- 跨月归档余额血缘；
- 历史数据迁移与幂等哈希；
- 已归档结果及下月期初；
- 人工调整审计；
- 数据删除和回滚范围；
- 页面、Excel 输出和自动化测试。

不得在 3.1.8 实施过程中以“更易实现”“兼容旧行为”或“UI 更方便”为由静默修改。

## 15. Definition of Done

只有同时满足以下条件，3.1.8 才可标记“实施完成”：

- `Q01～Q12` 已全部锁定并反向同步到页面、事务、数据库、Excel 和测试契约；
- 指定结果模板已纳入仓库和 Windows 打包产物；
- 上传样例 JPY 全链路保持 `135886024.59`；
- 解归档、删除期初、删除结果均有事务/审计/二次门禁/回滚测试；
- 调整记录可持久化、可重开查看、归档与下月期初使用生效余额；
- 开始运行前和 worker 内均检查表完整性；
- 历史月份导出准确，解归档月份不再可导出；
- Pending 模板资产与代码契约 CI 锁定；
- 结果 Excel 结构、字体、调整行及 AUD/CAD fill 经真实模板测试；
- 全量自动化、Windows 构建和财务人工核对完成；
- 未解决资金人工门禁不得被 CI 成功替代或静默关闭。

---

# 附录 A — `VCC_移除归档Pending账单.xlsx` 正式 46 列表头

顺序必须完全一致：

1. `pending类型`
2. `pending资金类型`
3. `账单类型`
4. `billDate`
5. `valueDate`
6. `平账账期`
7. `业务BU`
8. `对手业务BU`
9. `财务BU`
10. `主体`
11. `对账类型`
12. `recon_id`
13. `金额`
14. `币种`
15. `order_no`
16. `acc_id`
17. `finish_time`
18. `穿透ID`
19. `channel`
20. `merchant_id`
21. `bank_ref`
22. `对账明细ID`
23. `对账单ID`
24. `PendingBizId`
25. `备注`
26. `计算金额`
27. `计算币种`
28. `是否拆分Pending`
29. `流水_账单日期`
30. `流水_公司主体`
31. `流水_流水类型`
32. `流水_业务部门`
33. `流水_主对账ID`
34. `流水_出入方向`
35. `流水_流水单号`
36. `流水_用户编号`
37. `流水_账户编号`
38. `流水_币种`
39. `流水_对账金额`
40. `流水_账户类型`
41. `授信金额`
42. `非授信金额`
43. `维护人`
44. `维护人BU`
45. `客户所在地`
46. `是否已流水替换`

> 历史 v1 48 列仅比本清单多 `是否错币`、`金额差`，只用于旧审计反序列化，不属于 3.1.8 新导入契约。

# 附录 B — 建议的关键不可变函数

建议在 `rules/important-variables.md` 登记为 Risk-sensitive/Critical：

- `preflightCalculation` / 新 `preflightRun`
- `loadOpeningBalances`
- `getEffectiveRunResult`
- `addRunAdjustment`
- `archiveRun`
- `unarchiveMonth`
- `deleteOpeningInitialization`
- `deleteUnarchivedResult`
- `systemAmountToken` 或其替代实现
- `headersEqual` / Pending contract loader
- `buildResultSheet` / result template contract loader
- `listArchivedResultMonths`

这些函数的任何后续修改都必须触发资金回归测试和 Spec 反向同步。
