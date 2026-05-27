# Manual Test Checklist — v2.1.9

| 字段 | 值 |
|---|---|
| 文档版本 | v0.3（2026-05-27 — SR-log-1 立项 Phase 8.8 加验收项）；v0.2 α 范围扩 4 主题；v0.1 起草 |
| 关联文档 | `PRD-v2.1.9.md` v0.3 / `spec.md` v0.4 / `tasks.md` v0.3 |
| 测试范围 | α 范围 — N5（银行渠道）+ N7（场景模板）+ N6（状态框）+ SR-backup-1（前置）+ G1-cont（unit 全量铺）+ SR-policy-1（自动同步）+ N1-settings（idle 阈值）+ N4 重构（顺带）+ **SR-log-1（全局告警统一日志化）** |
| 测试节奏 | 每完成一个 Phase 由用户手测；全部 Phase 完成后跑 release-check + 用户验收 |

---

## 一、测试环境准备

- [ ] 检出 `v2.1.9` 分支
- [ ] `npm install` 无报错
- [ ] `npm run smoke` v2.1.8 基线全绿
- [ ] **备份** 当前 `tool-data.sqlite`（用户数据备份点，回滚保险）
- [ ] 准备 v2.1.8 老库 fixture（无 channels 表，scenarios.channel_id 不存在）
- [ ] 准备 ≥ 2 个真实银行对账单 fixture（不同 `<Channel>-<地区>` 组合）

---

## 二、Phase 1 — SR-backup-1 验收

### 2.1 单元测试

- [ ] `npm run test:unit -- tests/unit/backend/database/backup.test.js` 全绿

### 2.2 手测：N4 raw_json migration 不受影响

- [ ] 启动应用 → 检查启动日志 `[N4 migration]` 无报错
- [ ] 验证 `<userData>/backups/` 目录无新增异常文件

---

## 二.5、Phase 1.5 — G1-cont 单元测试全量铺验收

### 2.5.1 全量跑批

- [ ] `npm run test:unit` 退出码 = 0
- [ ] **预期**：
  - [ ] 累计 case ≥ 400（v2.1.8 基线 123 + v2.1.9 新增 ~280+）
  - [ ] 0 失败 + 0 跳过
  - [ ] 报告显示 28+ describe 区块（v2.1.8 已 28 + v2.1.9 新增）

### 2.5.2 文件覆盖率检查

- [ ] 第 1 层（纯函数）14 文件全在 `tests/unit/` 镜像目录存在（含 v2.1.8 已铺 normalizers + v2.1.9 新铺 13）
- [ ] 第 2 层（带 fixture）24 文件全在 `tests/unit/` 镜像目录存在
- [ ] 检查命令：`find tests/unit/ -name "*.test.js" | wc -l` ≥ 38

### 2.5.3 期望值权威性抽检

- [ ] 随机抽 5 个新铺 case，对照业务真实期望（spec §11.3 评审标准）
- [ ] **预期**：无 "期望值=实现 bug 复刻" 类型 case；如发现 → 优先修代码

---

## 三、Phase 2 — N5 DB schema + migration 验收

### 3.1 老库升级（关键）

- [ ] 把 v2.1.8 老库 fixture 替换 `<userData>/tool-data.sqlite`
- [ ] 启动应用
- [ ] **预期**：
  - [ ] activity log 出现 `[N5 migration] 自动备份完成` + `[N5 migration] 成功`
  - [ ] `<userData>/backups/tool-data-bak-pre-N5-{timestamp}.sqlite` 文件存在
  - [ ] sqlite3 客户端验证 channels 表存在 + 「通用」行存在 (id=1, is_builtin=1)
  - [ ] scenarios 表 channel_id 列存在 + 所有现有 scenarios.channel_id = 1
  - [ ] settings 表 `n5_channels_migrated='1'`

### 3.2 重启幂等

- [ ] 重启应用
- [ ] **预期**：activity log 出现 `[N5 migration] 已迁移，跳过`；数据不变

### 3.3 失败回滚（故障注入，可选）

- [ ] 修改 migrations.js 在 ALTER 后人为抛错
- [ ] 启动应用 → 启动失败 / activity log 含 ROLLBACK
- [ ] 验证数据库状态回到迁移前 + 备份文件保留

---

## 四、Phase 3 — N5 渠道 CRUD UI 验收

### 4.1 场景管理顶部「银行渠道」选择器

- [ ] 进入银行对账单处理模块 → 点「场景管理」
- [ ] **预期**：
  - [ ] dialog 标题右侧出现 `银行渠道` label + 单选下拉 + 「管理」按钮
  - [ ] 下拉初始选中「通用」（2026-05-27 fix1-N5-UI-6.2：内置渠道 label 由「通用-通用」简化为「通用」）
  - [ ] 下拉枚举仅含「通用」（首次）
  - [ ] 单选下拉的视觉样式与主面板「模式」下拉相同（2026-05-27 fix1-N5-UI-3）
  - [ ] 场景列表表格固定 8 行高度（2026-05-27 fix1-N5-UI-1）— 当场景数 ≤ 8：底部留白；> 8：超出滚动；切渠道前后弹框高度不抖动

### 4.2 渠道管理弹框

- [ ] 点「管理」按钮
- [ ] **预期**：
  - [ ] 弹出新 dialog 「银行渠道管理」
  - [ ] 表格 3 列：名称 / 开户地 / 执行操作
  - [ ] 顶部「新增」按钮（样式与账户映射页面一致）
  - [ ] **不再**显示「通用」行（2026-05-27 fix1-N5-UI-6.1：is_builtin=1 行 UI 隐藏，DB 层删除 / 修改保护依然存在）

### 4.3 新增渠道

- [ ] 点「新增」
- [ ] **预期**：新行 inline 编辑态 + 输入框 + 「完成」按钮
  - [ ] 输入框 placeholder **为空**（2026-05-27 fix1-N5-UI-2：去掉「例：工商」/「例：上海」示例文案）
- [ ] 输入「工商」/「上海」→ 点「完成」
- [ ] **预期**：
  - [ ] 行落库（DB 验证：`SELECT * FROM channels WHERE name='工商'`）
  - [ ] 按钮文案变「修改」
  - [ ] 场景管理顶部下拉枚举新增「工商-上海」
  - [ ] 新建的「工商-上海」在下拉中排在「通用」**之前**（2026-05-27 fix1-N5-UI-6.3 + 6.4：自定义渠道新增的排最上，通用殿后）

### 4.4 修改渠道

- [ ] 点「工商」行的「修改」按钮
- [ ] **预期**：行切换编辑态
- [ ] 改名为「工商银行」→ 点「完成」
- [ ] **预期**：落库 + 下拉枚举显示「工商银行-上海」

### 4.5 删除渠道（无 scenarios）

- [ ] 点「工商银行」行的「删除」按钮
- [ ] **预期**：确认框 → 确认后行消失 + 下拉枚举移除

### 4.6 删除渠道（有 scenarios）

- [ ] 重新建「工商-上海」
- [ ] 顶部下拉切到「工商-上海」→ 新增一个场景（如 C3 类型）
- [ ] 返回渠道管理弹框 → 点「工商-上海」删除
- [ ] **预期**：提示「该渠道下有 1 个场景，请先转移或删除」

### 4.7 「通用」保护

- [ ] 2026-05-27 fix1-N5-UI-6.1 修订：「通用」行在渠道管理弹框 UI **不再渲染**
  - [ ] 用户在 UI 上**无法看到**「通用」行 → 无法编辑也无法删除
  - [ ] DB 层保护仍生效：直接调 IPC `channels.update(1)` / `channels.deleteOne(1)` 仍抛错「系统内置「通用」渠道不可…」

### 4.8 UNIQUE 约束

- [ ] 新增「工商-上海」（已存在）
- [ ] **预期**：UI 提示「渠道已存在」+ 不落库

---

## 五、Phase 4 — N5 dispatcher 双维调度验收

### 5.1 准备

- [ ] 在「通用」渠道下建 1 个 C3 场景（如「通用对账 C3」）
- [ ] 新建「工商-上海」渠道
- [ ] 切到「工商-上海」下建 1 个 C3 场景（如「工行上海对账 C3」），规则与「通用对账 C3」不同（如金额阈值不同）
- [ ] 准备银行对账单 fixture 含 3 类行：
  - 行 A：Channel=工商, 地区=上海, 金额=100（应命中「工行上海对账 C3」）
  - 行 B：Channel=工商, 地区=北京（未匹配渠道），金额=100（应通用兜底命中「通用对账 C3」）
  - 行 C：Channel=招商, 地区=深圳（未匹配渠道），金额=10（通用未命中）

### 5.2 导入 + 处理

- [ ] 导入对账单 → 点「处理」
- [ ] **预期状态框**：`已处理：2 行命中（场景 1、2），0 警告`
  - [ ] 不出现"未匹配渠道走通用兜底"单独提示（D3=a 用户明确不要）

### 5.3 主输出 xlsx

- [ ] 点「导出」 → 选保存路径
- [ ] **预期**：
  - [ ] xlsx 仅 2 sheet：Sheet 1「渠道对账单」+ Sheet 2「未命中场景行」
  - [ ] **没有** Sheet 3（v2.1.9 撤除）
  - [ ] Sheet 1 含行 A + 行 B（命中行）
  - [ ] Sheet 2 含行 C（未命中行）

### 5.4 独立报表

- [ ] 检查 `Documents/网银账单生成小助手/error-reports/{今天日期}/` 目录
- [ ] **预期**：
  - [ ] 文件 `命中场景行-{对账单 basename}-{timestamp}.xlsx` 存在
  - [ ] 打开文件 → 列结构：原 44 列 + 匹配渠道 / 匹配状态 / 命中场景
  - [ ] 行 A 数据：匹配渠道=`工商-上海`, 匹配状态=`命中`, 命中场景=`[1] 工行上海对账 C3`（或 displayIndex 实际值）
  - [ ] 行 B 数据：匹配渠道=`工商-北京`, 匹配状态=`兜底`, 命中场景=`[1] 通用对账 C3`

---

## 六、Phase 5 — N5 转移 + 批量操作验收

### 6.1 单条转移

- [ ] 顶部下拉切「工商-上海」
- [ ] 点「工行上海对账 C3」场景行的「转移」按钮
- [ ] **预期**：弹框「请选择转移到的目标银行渠道」+ 单选下拉（不含「工商-上海」自身）
  - [ ] 下拉视觉同主面板「模式」下拉（2026-05-27 fix1-N5-UI-3）
- [ ] 选「通用」 → 点「完成」
- [ ] **预期**：
  - [ ] 弹框关闭
  - [ ] 「工商-上海」下场景列表不再显示该场景
  - [ ] 切到「通用」→ 场景列表显示该场景（搬运语义）

### 6.2 批量勾选

- [ ] 顶部下拉切「通用」
- [ ] 点底部「批量操作」按钮
- [ ] **预期**：
  - [ ] 表格左侧出现勾选框列
  - [ ] 表头出现全选框
  - [ ] 「批量操作」按钮文案变「退出批量」（2026-05-27 fix1-N5-UI-4）
  - [ ] 「退出批量」右侧紧贴出现「转移」「删除」按钮（间隙缩小）
  - [ ] 「导入模板文件」「导出模板文件」「完成」始终紧贴右侧

### 6.3 批量转移

- [ ] 勾选 2+ 场景 → 点「转移」按钮
- [ ] **预期**：弹框选目标渠道 → 「完成」后 2+ 场景搬到目标渠道

### 6.4 批量删除

- [ ] 切回「通用」→ 勾选 1+ 场景 → 点「删除」按钮
- [ ] **预期**：确认框列出场景名清单 → 确认后场景消失

### 6.5 全选

- [ ] 点表头全选框
- [ ] **预期**：所有可见场景被勾选
- [ ] 再次点 → 取消全选

---

## 七、Phase 7 — N7 bundle 导入/导出验收

### 7.1 footer 按钮

- [ ] 场景管理 dialog footer
- [ ] **预期**（D8=a + 2026-05-27 fix1-N5-UI-4）：
  - [ ] 左组（紧贴左侧）：`[新增场景] [批量操作]`，按钮之间用左组 flex gap
  - [ ] 中间留白（spacer 占据剩余宽度，把右组推到最右）
  - [ ] 右组（紧贴右侧）：`[导入模板文件] [导出模板文件] [完成]`，按钮之间间隙 6px（比左组紧凑）
  - [ ] 进入批量模式：左组变为 `[新增场景] [退出批量] [转移] [删除]`，右组不变

### 7.2 单渠道导出

- [ ] 点「导出模板文件」
- [ ] **预期**：弹框「选择导出的银行渠道的模板」+ 多选下拉
  - [ ] 弹框**无**「加载渠道列表中...」提示文案（2026-05-27 fix1-N5-UI-5.2）
  - [ ] 多选下拉每行 checkbox 在左、渠道名在右（2026-05-27 fix1-N5-UI-5.1）
  - [ ] 右下角按钮顺序：`[导出] [取消]`（2026-05-27 fix1-N5-UI-5.3）
- [ ] 点「取消」 → 弹框关闭（不导出）；重开点「工商-上海」→ 点「导出」 → saveDialog 默认文件名 `scenarios-bundle-{YYYYMMDD}.json`
- [ ] 保存到 Desktop
- [ ] 打开文件 → **预期**：
  - [ ] 顶层 `scenarioBundleVersion: 1`
  - [ ] `channels` 数组含 1 个元素：`{name: "工商", ownerLocation: "上海", isBuiltin: 0, scenarios: [...]}`

### 7.3 多渠道导出

- [ ] 重新点「导出模板文件」
- [ ] 勾选「工商-上海」+「通用」→ 导出
- [ ] **预期**：文件含 2 个 channels 元素 + 通用渠道 `isBuiltin: 1`

### 7.4 导入：缺失渠道自动创建

- [ ] 删除「工商-上海」（确保库内不存在）
- [ ] 点「导入模板文件」 → 选刚才导出的多渠道文件
- [ ] **预期**：
  - [ ] 弹确认框「即将创建以下渠道：工商-上海」
  - [ ] 点「确认创建」 → 渠道库新增「工商-上海」+ scenarios 落入对应渠道
  - [ ] 通用渠道（isBuiltin=1）**不重建**，scenarios 合并入现有通用

### 7.5 导入：同名场景冲突

- [ ] 再次导入同一文件（已存在）
- [ ] **预期**：
  - [ ] 弹确认框 → 「确认创建」（实际无新增因为渠道已存在）
  - [ ] 结果框「成功导入 0 场景；N 同名冲突跳过」
  - [ ] 冲突清单可查看

### 7.6 导入：误用 bundleVersion=4 文件

- [ ] 导出现有的网银账单模板（`bundleVersion=4`）
- [ ] 在场景管理「导入模板文件」入口选该文件
- [ ] **预期**：报错「文件类型不匹配，请用模板管理入口导入」

---

## 八、Phase 8 — N6 状态框验收

### 8.1 4 状态对比

- [ ] 准备 v2.1.8 状态框截图（用户提供 / 上次发版截图）
- [ ] 启动 v2.1.9 → 走 4 个状态：
  - 状态 1 - 欢迎：`欢迎使用小助手`（应无冒号，与 v2.1.8 一致）
  - 状态 2 - 已导入：`已导入：\n{fileName}（{rowCount} 行）` → **预期冒号后只 1 次换行**
  - 状态 3 - 已处理：`已处理：{count} 行命中...` → **预期冒号后无换行**（与 v2.1.8 比无变化）
  - 状态 4 - 已导出：`已导出：\n{fileName}` → **预期冒号后只 1 次换行**

### 8.2 preview 截图回归

- [ ] `npm run preview` → 截图归档到 `docs/iterations/v2.1.9/previews/`
- [ ] 对比 v2.1.8 截图 — 仅状态框换行差异，其他元素不变

### 8.3 其他 5 模块状态框零外溢回归（D18=a 修订后强制项）

> ⚠️ D18 从 (b) 改 (a) 后，T31 仅改 `renderer.js:3338, 3351` 2 行；其他 5 模块零改动；本节验证视觉零变化。

| 模块 | 触发动作 | 文案样本 | 预期换行行为 |
|---|---|---|---|
| 主面板（setStatus） | 加载有账户映射数据时 | `当前账户映射条数：${count}` | 「：」后 **1 次换行**（v2.1.7 R3 内层 replace 保留） |
| 新账户（setNewAccountStatus） | 生成账户失败 | `result.message`（如 `参数错误：xxx`） | 「：」后 **1 次换行** |
| 业银对账（setBankBuReconStatus） | 触发 `${yearMonth}：已取消选择 Pending 数据管理文件` | 同 | 「：」后 **1 次换行** |
| 业银对账（同上） | 导入失败 `导入失败：${msg}${detail}` | 同 | 「：」后 **1 次换行** |
| 业银对账（同上） | 差异表生成 `差异表已生成：${path}` | 同 | 「：」后 **1 次换行** |
| 业务运营对账（setBizOpReconStatus） | `${date}：已取消选择业务OP文件` | 同 | 「：」后 **1 次换行** |
| 业务运营对账（同上） | `业务OP 导入失败：${msg}${detail}` | 同 | 「：」后 **1 次换行** |
| C4 修复（reconIdFixStatusBox） | 触发任意「：」文案 | 同 | 「：」后 **1 次换行** |

- [ ] 上述 8 个文案样本逐个手测触发或 preview 截图比对
- [ ] **预期**：与 v2.1.8 完全一致（仅银行对账单冒号后换行从 2 → 1，其他模块视觉无差异）
- [ ] **若发现其他模块换行行为有变化（如塌成 0 换行或意外加倍）→ 立即停止 T31 修复，回归代码现状，重新评估 D18 决策**

---

## 八.5、Phase 8.5 — SR-policy-1 integration-runner 自动同步清单验收

### 8.5.1 跑集成测试触发同步

- [ ] `npm run test:integration` 退出码 = 0
- [ ] **预期**：终端 stdout 末尾输出当前清单 markdown 表

### 8.5.2 in-place 编辑验证

- [ ] `git diff rules/integration-test-policy.md`
- [ ] **预期**：
  - [ ] §七 章节内容自动更新（包含所有 scripts/integration/*.js 脚本名 + 用例数 + 断言数 + 耗时）
  - [ ] 时间戳行 `<!-- last-updated: YYYY-MM-DDTHH:mm:ss+08:00 -->` 刷新
  - [ ] 表外其他章节零变化

### 8.5.3 一致性校验

- [ ] 对比 `rules/integration-test-policy.md §七` 表内容 vs `scripts/integration/` 目录下实际脚本清单
- [ ] **预期**：0 偏差（无遗漏 / 无多余）

---

## 八.6、Phase 8.6 — N1-settings idle 阈值配置化验收

### 8.6.1 默认值兼容

- [ ] 准备 v2.1.8 老库 fixture（settings 表无 `acquiring_bill_idle_cleanup_minutes` 键）
- [ ] 启动 v2.1.9 应用
- [ ] **预期**：
  - [ ] migration 自动插入键 + 值='30'
  - [ ] 应用内 idle 触发计时器 = 30 分钟（行为与 v2.1.8 一致）

### 8.6.2 ~~应用设置弹框~~ ❌ 撤回（D21=c）

> 2026-05-27 用户审查后否决 dev agent #2 自扩展的 `createAppSettingsDialog` + ⚙️ 入口按钮；本节验收项已撤回。用户改阈值用 sqlite3：`UPDATE app_settings SET setting_value='60' WHERE setting_key='acquiring_bill_idle_cleanup_minutes';` + 重启生效。

~~原 8.6.2 验收清单 ↓↓↓（保留作历史参考）~~

- [ ] 打开应用设置弹框（spec 阶段定位入口）
- [ ] **预期**：
  - [ ] 新字段「收单单据 idle 清理阈值」可见
  - [ ] input 默认值 = 30
  - [ ] min=5 max=180 + 单位「分钟」+ hint 文案

### 8.6.3 改值后即时生效

- [ ] 改为 60 → 点保存
- [ ] **预期**：
  - [ ] settings 表值更新为 '60'
  - [ ] **无需重启** idle 计时器读新值（60 * 60 * 1000 ms）
  - [ ] 验证 idleTimer 内部状态（activityLog 或 dev tools）

### 8.6.4 范围校验

- [ ] 改为 0（小于 min=5）→ 点保存
- [ ] **预期**：前端报错「必须在 5-180 范围内」+ 不落库
- [ ] 改为 200（大于 max=180）→ 点保存
- [ ] **预期**：同上报错
- [ ] 改为字符串 → 前端 input 拦截

### 8.6.5 重启持久化

- [ ] 改为 90 → 点保存
- [ ] 关闭应用 → 重新打开
- [ ] **预期**：弹框打开值 = 90 + idle 计时器 90min

---

## 八.7、Phase 8.7 — N4 重构（顺带）回归验收

### 8.7.1 N4 行为不变（0 regression）

- [ ] 准备 v2.1.8 老库 fixture（bill_imports.raw_json 26 字段 + settings.bill_raw_json_v2_migrated 不存在）
- [ ] 启动 v2.1.9 应用
- [ ] **预期**：
  - [ ] N4 migration 自动跑 + 完成
  - [ ] activityLog `[N4 migration] 备份完成：<userData>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite`
  - [ ] raw_json 缩减到 9 字段（与 v2.1.8 行为一致）
  - [ ] settings.bill_raw_json_v2_migrated = '1'

### 8.7.2 备份文件 atomic 验证

- [ ] 检查 `<userData>/backups/` 目录
- [ ] **预期**：
  - [ ] 文件 `tool-data-bak-pre-N4-{timestamp}.sqlite` 存在
  - [ ] 文件大小 = 库大小（用 ls -l 对比）
  - [ ] 无 .tmp / .partial 半文件残留

### 8.7.3 N4 smoke 全跑

- [ ] `npm run smoke -- --grep "N4"` 全绿
- [ ] **预期**：v2.1.8 既有 N4 用例 100% 通过

### 8.7.4 grep fs.copyFileSync 在 migrations.js

- [ ] `grep -n "fs.copyFileSync" src/backend/database/migrations.js`
- [ ] **预期**：0 命中（全部切换到 createBackup）

---

## 八.8、Phase 8.8 — SR-log-1 全局告警统一日志化验收

### 8.8.1 日志目录结构（D29 修订）

- [ ] 启动 v2.1.9 应用 + 触发任意 setStatus(msg, 'error') 调用
- [ ] 检查目录 `Documents/网银账单生成小助手/logs/{当前 YYYY-MM}/{MM-DD}/`
- [ ] **预期**：
  - [ ] 目录自动创建（首次告警时）
  - [ ] 含至少 1 个 `{level}.log` 文件（取决于触发级别）
  - [ ] 月份目录可见（如 `2026-05/`）+ 日级目录可见（如 `05-27/`）

### 8.8.2 JSON Lines 格式校验

- [ ] 用 `cat logs/2026-05/05-27/error.log | jq -c .` 解析
- [ ] **预期**：
  - [ ] 每行独立 JSON 对象 0 解析错误
  - [ ] 字段含 ts / level / source / domain / message / details（必填）
  - [ ] level 字段值 = `'error'`（与文件名一致）
  - [ ] 异常 stack 字段（如有抛错）存在

### 8.8.3 renderer setStatus error/warning 自动上报

- [ ] 手测触发以下场景：
  - [ ] 银行对账单导入失败 → `setBankBuReconStatus('导入失败：xxx', 'error')` 触发
  - [ ] 收单单据校验失败 → `setBizOpReconStatus('校验失败：xxx', 'error')` 触发
  - [ ] 主面板生成失败 → `setStatus('生成失败：xxx', 'error')` 触发
- [ ] **预期**（每个场景）：
  - [ ] UI 状态框红色显示原消息（行为不变）
  - [ ] `logs/{YYYY-MM}/{MM-DD}/error.log` 末尾新增 JSON Line
  - [ ] JSON 中 source=`'renderer'`、level=`'error'`、message=触发文案

### 8.8.4 renderer createAlertDialog 自动上报

- [ ] 触发任意 `openModal(createAlertDialog('错误：xxx'))` 弹框
- [ ] **预期**：
  - [ ] UI 弹框正常显示
  - [ ] `logs/.../error.log` 新增对应 JSON Line

### 8.8.5 main 端 49 处 console.error 改造验证

- [ ] `grep -rn "console\.error\|console\.warn" src/main.js src/main-process/ src/backend/ --include="*.js" | grep -v "logger.js"`
- [ ] **预期**：0 命中（logger.js 内部兜底 console.error 例外保留）

### 8.8.6 双写兼容验证

- [ ] 触发任意 main 端 appendActivityLogEntry 调用（如启动 / migration / IPC）
- [ ] **预期**：
  - [ ] 旧 `Documents/网银账单生成小助手/app_activity_log.txt` 仍正常 append 新行（v2.1.8 行为不变）
  - [ ] 新 `logs/{YYYY-MM}/{MM-DD}/{level}.log` 同步 append JSON Line
  - [ ] 两份内容语义一致（消息 / 时间戳同步）

### 8.8.7 wrapper hijack graceful（异常隔离）

- [ ] DevTools console 模拟：`window.desktopApi.reportLog = () => { throw new Error('mock'); }`
- [ ] 触发 setStatus(msg, 'error')
- [ ] **预期**：
  - [ ] UI 红色状态框仍正常显示原消息
  - [ ] setStatus 调用未抛错（DevTools console 无报错堆栈）
  - [ ] 即日志没写成 UI 也不阻塞

### 8.8.8 跨月切换验证

- [ ] 修改系统时间到下月 1 号（如 `sudo date 0601000026` macOS）
- [ ] 触发告警
- [ ] **预期**：
  - [ ] 新月份目录 `logs/2026-06/06-01/` 自动创建
  - [ ] 旧月份目录 `logs/2026-05/` 保留不删（D32=a 永久保留 + D35 取消清理）
- [ ] 恢复系统时间

### 8.8.9 USER_GUIDE 故障排查章节

- [ ] `docs/USER_GUIDE.md` 含「故障排查」段
- [ ] **预期**：
  - [ ] 说明日志位置 `Documents/网银账单生成小助手/logs/{YYYY-MM}/{MM-DD}/{level}.log`
  - [ ] 说明 JSON Lines 解析示例（`cat error.log | jq -c .`）
  - [ ] 说明用户可手动删超期月份目录释放空间

### 8.8.10 永久保留 + 手动清理引导

- [ ] 模拟 `Documents/网银账单生成小助手/logs/` 下含 6+ 个月份目录
- [ ] **预期**：应用启动不会自动删（D32=a / D35 取消）；用户手动 `rm -rf logs/2025-XX` 后应用正常

---

## 九、Phase 9 — 集成测试 + 收尾验收

### 9.1 集成测试

- [ ] `npm run test:integration` 全绿（含 N5/N7/N6 新增用例 + SR-policy-1 自动同步触发 + SR-log-1 4+ 用例）
- [ ] **预期断言数**：v2.1.8 基线 1276 + v2.1.9 α 新增 ~330（N5+N7+N6+N1-settings+N4 重构+SR-log-1）= **~1606 / 0 regression**
- [ ] **预期 unit 数**：v2.1.8 基线 123 + v2.1.9 G1-cont 新增 ~280 + SR-log-1 unit ~12 = **~415 / 0 regression**

### 9.2 release-check gate

- [ ] `npm run release-check` 全绿
  - [ ] smoke
  - [ ] unit
  - [ ] integration

### 9.3 check-vars

- [ ] `npm run check:vars` 输出含 channels / channel_id / hitChannelKey / matchStatus
- [ ] PR body 粘贴 check-vars 报告

### 9.4 文档三件套

- [ ] CHANGELOG 含 v2.1.9 章节 + **Sheet 3 撤除显著警告**
- [ ] VFH 含 v2.1.9 + 银行渠道引入
- [ ] USER_GUIDE 场景管理/银行对账单处理章节重写
- [ ] preview 截图归档

---

## 十、回归测试（v2.1.8 既有功能不破坏）

| 模块 | 功能 | 验证方式 |
|---|---|---|
| 收单单据币种校验 | runCheck 全流程 | smoke + 手测一遍 |
| 网银账单生成 | 导入 → 导出 | smoke + 手测一遍 |
| 网关账单不平账 | 处理 + 导出 | smoke |
| C4 网关对账 ReconID 修复 | TEST2.xlsx baseline 28 行 / maxSize=16 甜点 43 行 | 集成测试 |
| N1' cleanup idle 30min | 退出时清 + 进入兜底 + idle 30min | 集成测试 |
| N4 差异表 12 列输出 | 收单 diff.xlsx 列数 = 12 | smoke |
| N3-1 displayIndex 一致性 | 状态框场景号 = 场景管理 UI 序号 | 手测 |

**0 regression 硬约束**：所有 v2.1.8 既有 smoke / unit / integration 用例必须全绿。

---

## 十一、Bug 报告模板

发现问题时按以下格式记录到 `docs/iterations/v2.1.9/bug-log.md`（待 dev 阶段创建）：

```markdown
### BUG-001 — 简短标题

- **发现日期**：2026-XX-XX
- **测试阶段**：Phase X
- **复现步骤**：
  1. ...
- **预期行为**：...
- **实际行为**：...
- **严重程度**：Critical / Important / Minor
- **修复 commit**：（dev 修复后回填）
```

---

**当前状态**：v0.1 起草中（2026-05-27）。
**下一步**：spec 评审通过 + 用户拍板 D18 + SR-backup-1 + 「通用」删除阻止策略后，T01 启动。
