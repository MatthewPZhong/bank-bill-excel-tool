# TechDoc — 清结算小助手 v3.2.11 设置默认值变更

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.11 |
| 日期 | 2026-09-29 |
| 状态 | Rev3；功能实现完成；单测与定向回归通过，完整页面布局验证存在基线问题 |
| 功能分支 | `v3.2.11-settings-defaults`（已从当前本地 `main` 创建） |
| 工作区 | `/Users/pzhong/.codex/worktrees/settings-defaults/bank-bill-excel-tool` |
| 开发基线 | 当前本地 `main` → `18b82b4328cf5e00c1b2549d373a5b2f2677215c`，与 `v3.2.10` 标签一致 |
| 关联 Spec | [spec.md](./spec.md)，AC01–AC22 |
| 依赖 | 现有深色调度、设置仓储、存档保留策略与设置弹窗；不新增依赖 |
| 格式来源 | `docs/templates/TechDoc-template.md`，将关联 PRD 字段替换为本任务 Spec |

## 一、Spec 评审意见（技术角度）

### 1.1 可直接落地的部分

两个需求都已有对应机制。本次应收敛为默认值变更及一致性回归，不重写调度、存档或设置架构。

深色的默认对象已位于 Main / Renderer 共用模块，设置仓储与调度器均经该模块规范化。存档策略已支持永久、全局默认、模块独立覆盖；前端有三处可见的 60 天初值，必须同步。

用户已追加要求：存档服务内部独立的默认值也改为永久。`retention-policy.js` 与 `archive-service.js` 两处默认常量均设为 `null`；服务构造器须同步接受永久值，覆盖有、无策略解析器两类调用。

### 1.2 技术意见 / 风险提醒

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| R1 | `enabled: false` 被视为缺失，升级后用户关闭失效 | 保留整组合法配置；不得使用 `stored.enabled || true` |
| R2 | 永久 `null` 被 `?? 60`、`|| 60` 或 `Number(null)` 改成有限期限 / 0 天 | 先判永久，再做有限期限校验；检查所有调用边界 |
| R3 | 只改后端，页面仍初始选中 60 天或写回旧值 | 同步 state、saved value、HTML 及回退分支；回包后以 Main 结果为准 |
| R4 | “旧值等于旧默认”被当作可迁移证据 | 不强制覆盖有效记录；不做值比较式迁移 |
| R5 | 新默认导致历史预留批次或持久归档待办期限漂移 | 保留建批时固化期限与重放快照；新默认只供尚未固化的策略求值 |
| R6 | 测试仅机械改常量，遗漏事件次数与早晨主题变化 | 重审用例意图，更新首次启动、同值保存及 06:00/07:00 断言 |
| R7 | 原“坏配置安全关闭”随默认开启变为夜间深色 | 明确按现有整组回退机制使用新默认，更新注释及测试，不声称仍安全关闭 |
| R8 | 永久被理解成不可删除或所有文件永远不清理 | 仅改变到期保留策略，不扩大至手动删除和其他资源生命周期 |
| R9 | 服务默认常量直接改为 `null`，构造器仍按正整数校验，导致初始化失败 | 默认常量与构造参数校验一并修改；先识别 `null`，再做有限值转换与校验；补无解析器路径测试 |
| R10 | 默认开始时间变化后，旧“起止相同”夹具变成合法时段 | 显式构造相等的起止时间；保留完整自定义旧时段作为兼容用例 |

### 1.3 与 Spec 的差异

无。兼容性策略以 Spec §4.3 为唯一业务口径；本文件只细化如何实现和验证。

## 二、涉及的文件清单

“必改”表示已在读取代码中发现明确旧默认；“核查”表示需要在实施工作区沿调用链检查，不能把这些文件全部机械修改。

| 文件 | 类型 | 改动或核查内容 |
| --- | --- | --- |
| `src/shared/dark-mode-schedule.js` | 必改 | 默认对象三项值；保留验证与跨日算法 [T1] |
| `src/main-process/archive-center/retention-policy.js` | 必改 | `DEFAULT_RETENTION_DAYS` 从 60 调整为 `null`；保持读取 / 继承语义 [T2] |
| `src/main-process/archive-center/archive-service.js` | 必改 | 内部 `DEFAULT_RETENTION_DAYS` 改为 `null`；构造器支持缺省及显式永久，保留有限值和解析器优先级；核查三个建批入口 [T10] |
| `src/renderer/dialogs/app-settings.js` | 必改 | `archiveState.settings.retentionDays`、`savedRetentionValue`、HTML selected；审查相同领域的其他回退 [T3] |
| `src/backend/database/settings-repository.js` | 核查 / 测试 | 保留 `getDarkModeSchedule` 只读回退、完整校验及 JSON 写入；正常情况下无需改实现 [T4] |
| `src/main-process/dark-mode-scheduler.js` | 核查 / 测试 | 默认开启后的冷启动、边界重判、同值保存、资源释放；正常情况下无需改实现 [T5] |
| `src/renderer-dark-mode.js` | 核查 / 测试 | 共享默认快照、Main 版本化回包、设置 ready 和保存逻辑，不另写默认副本 [T6] |
| `src/main-process/archive-center/controller.js` | 核查 / 必要时修正 | 设置读取 / 写入 / getRetentionDays 对 `null` 的透传 [T7] |
| `src/main-process/archive-center/task-lifecycle.js`、`outbox-store.js` 及 `src/main.js` 装配 | 核查 / 必要时修正 | Main 已注入策略解析器，保持该装配；核查三类建批调用、期限快照与重放 |
| `scripts/integration/dark-mode-schedule-settings.js` | 必改 | 当前依赖旧默认关闭、06:00 结束和首次开启推送；补新默认与旧配置兼容 [T8] |
| `scripts/integration/archive-center-module-retention.js` | 必改 | 新空配置默认为 `null`，三个建批入口默认值断言更新；保留显式有限期限测试 [T9] |
| `scripts/integration/archive-center-default-retention.js` | 计划新增 | 真实 DB / 输入输出文件，缺省永久、重启、到期清理及历史快照回归 |
| `tests/unit/shared/dark-mode-schedule.test.js` | 必改 | 默认对象、跨午夜、坏配置及相同时刻的夹具与断言 |
| `tests/unit/dark-mode-renderer.test.js` | 必改 | 默认快照、时间展示、相同时刻拒绝及非法事件快照 |
| `tests/unit/main-process/archive-retention-policy.test.js` | 必改 | 缺失 / 空 / 非法的回退断言；显式 60 天与模块继承保留 |
| `tests/unit/main-process/archive-center-controller.test.js` | 必改 | 空配置读取永久；显式有限期限写入与读取兼容 |
| `tests/unit/main-process/archive-service.test.js` | 必改 | 内部默认、构造参数 `null`、有限值、非法值、无解析器三入口与优先级；调整依赖旧缺省 60 天的断言 |
| `tests/unit/main-process/dark-mode-scheduler.test.js`、`scripts/renderer-lifecycle/fixtures/app-settings.js` | 核查 / 必要时补充 | 保留完整旧时段的自定义配置覆盖；补新默认冷启动和设置回退的界面覆盖 |
| 本目录 `spec.md`、`techdoc.md` | 方案文件 | 目标版本多功能分支目录，互相相对引用 |

Rev2 已按固定基线核对 Main 策略注入、服务构造器与三个建批入口，并补齐具体单测位置。初版审查另有 9/9 组局部探针记录，其中服务内部仍为旧默认 60 天；该结果不能证明本次新增的服务默认永久合同。本轮实现已针对最终代码完成下述验证，结果见 §九。

## 三、需求 1：定时深色模式默认值

### 3.1 实现方案

唯一生产默认来源继续使用 `src/shared/dark-mode-schedule.js`：

```javascript
const DEFAULT_DARK_MODE_SCHEDULE = Object.freeze({
  enabled: true,
  startTime: '17:30',
  endTime: '07:00'
});
```

保留 `validateDarkModeSchedule` 的完整对象校验，保留 `normalizeDarkModeSchedule` 的整组回退，不增加逐字段合并策略，不改变设置键 `dark_mode_schedule`。

### 3.2 数据流与接口

```text
app_settings.dark_mode_schedule
  → settingsRepository.getDarkModeSchedule
  → normalizeDarkModeSchedule（合法则原样规范化；否则使用新默认）
  → Main createDarkModeScheduler.start
  → resolveEffectiveTheme（电脑本地时间）
  → nativeTheme / 窗口背景 / Main 快照
  → Renderer 控制器与外观设置表单
```

沿用 `app:get-info` 快照及 `settings.setDarkModeSchedule`、`settings.onDarkModeScheduleChanged` 现有桥接能力；不增加 IPC，不把浏览器 localStorage 变成第二个配置源。

读取缺失 / 非法配置不写回数据库；只有显式用户保存才调用现有写入口。保存必须先校验并成功落库，再发布主题和 revision，保持失败不改状态的合同。

### 3.3 时段与边界

沿用 `resolveEffectiveTheme` 的跨午夜分支：`current >= start || current < end`。本次 start 为 1050 分钟，end 为 420 分钟。算法本身无需变化。

默认开关为开启，不得将有效主题固定为 dark。07:00–17:29 为浅色，17:30–次日06:59 为深色。使用本机当地时间，不硬编码杭州、北京时间或会话时区。

完整的已保存关闭配置即使时间等于旧默认，也必须保留。部分缺字段配置依照既有整组校验失败处理，不新增“只修补一个字段但保留其余字段”的行为。

### 3.4 已有测试的具体调整

`dark-mode-schedule-settings.js` 的旧测试不能只替换共享常量引用：

- 首次 23:00 冷启动原断言是浅色，改为深色；仍验证默认键没有自动写入。
- 原重启 / resume 用 06:00 期待浅色，新默认在 06:00 仍为深色；增加 06:59 和 07:00 边界，不简单删除旧覆盖。
- 原“首次保存 enabled=true”会产生一次切换；新版默认已经 true，同值保存不应提升 revision 或再推送。测试应先使用确实不同的配置验证变更推送，再单独验证相同配置保存不重复推送。
- 坏 JSON 仍回退 DEFAULT，夜间结果变为深色；修改“坏配置安全关闭”的旧注释，保留坏记录不被回写的断言。
- 新增显式完整旧配置 `{ enabled: false, startTime: '18:30', endTime: '06:00' }`、旧自定义开启配置及用户停用后重启的用例。

`tests/unit/shared/dark-mode-schedule.test.js` 与 `tests/unit/dark-mode-renderer.test.js` 中的 `enabled` 继承共享默认。旧夹具 `{ ...enabled, endTime: '18:30' }` 在新默认下不再是相同时刻，应改为 `{ ...enabled, endTime: enabled.startTime }` 或显式写出两个相同时间，继续验证拒绝路径。同步核查 Renderer 无效快照和失败编辑回显断言。

`tests/unit/main-process/dark-mode-scheduler.test.js` 的完整 `{ enabled: true, startTime: '18:30', endTime: '06:00' }` 是合法自定义配置，可以保留作为兼容覆盖；新增缺失配置下 17:30/07:00 的调度用例。

## 四、需求 2：默认保留期限永久

### 4.1 策略层与服务层默认及类型

在 `retention-policy.js` 和 `archive-service.js` 中分别修改现有默认常量，保留各自现有导出：

```javascript
// null 表示永久，沿用现有业务期限类型。
const DEFAULT_RETENTION_DAYS = null;
```

这是本次明确要求，服务内部不再保留 60 天工厂兜底。两处常量的精确值都须断言为 `null`；无需为本次变更新增公共配置模块。

#### 服务构造参数

`archive-service.js` 当前把 `options.defaultRetentionDays` 转为数值并要求正整数。修改时先区分缺省与永久，再沿用有限值的转换和范围校验：

```javascript
const defaultRetentionDays = options.defaultRetentionDays === undefined
  ? DEFAULT_RETENTION_DAYS
  : options.defaultRetentionDays === null
    ? null
    : Number(options.defaultRetentionDays);
if (defaultRetentionDays !== null && (
  !Number.isSafeInteger(defaultRetentionDays)
  || defaultRetentionDays < 1
  || defaultRetentionDays > 36500
)) {
  throw new TypeError('defaultRetentionDays 必须是 null（永久）或 1 到 36500 的安全整数');
}
```

| 构造参数 | 处理 |
| --- | --- |
| 省略或 `undefined` | 使用内部新默认 `null`，初始化成功 |
| `null` | 显式永久，初始化成功 |
| 合法有限值，如 1、60、36500、既有支持的 `'60'` | 沿用 `Number` 转换和 1–36500 安全整数校验 |
| 0、负数、小数、36501、NaN、Infinity、非数字字符串等 | 保持抛错，不回退为永久 |

`'permanent'` 是全局设置的存储值及既有建批参数支持的值；本次构造参数以 `null` 表示永久，不扩展构造器对 `'permanent'` 的接受范围。`this.defaultRetentionDays` 保存规范化后的 `number | null`，无解析器时原样透传；不能再用 `Number(null)` 或 `?? 60`。

**沿用存储与建批表示，补充构造参数的永久值：**

| 层 / 场景 | 永久 | 继承或缺失 |
| --- | --- | --- |
| 全局设置 `archive_center_retention_days` 的已保存值 | 字符串 `'permanent'` | 没有记录 / 空值：读取时回退默认 |
| 模块 JSON `archive_center_retention_days_by_module` | 对应模块键存在，值为 `null` | 模块键不存在表示继承；选择 `'inherit'` 时删除覆盖键 |
| 解析后业务值 / IPC 期限 | `null` | 不能把合法 `null` 当作缺字段 |
| 服务构造参数 `defaultRetentionDays` | 本次新增接受 `null` | 省略 / `undefined` 使用内部默认 `null` |
| 设置下拉框 | 字符串 `'permanent'` | 模块级使用 `'inherit'` |
| 已固化批次到期日 | `retentionUntil: null` | 非永久批次保存原到期日，不因默认变更回算 |

数据库全局设置字段不应写 SQL NULL 来表达永久；沿用现有 `'permanent'` 写法。模块的永久 `null` 则是 JSON 中的合法覆盖值，读取时需以“是否存在键”判断是否继承。

### 4.2 生效优先级

注入策略解析器时，建批前求值保持：

```text
现有建批调用显式传入的合法 retentionDays（含 null）
  > 模块独立设置（含 null）
  > 有效的已保存全局默认设置
  > 工厂默认值 null
```

未注入解析器时，求值顺序为：

```text
建批调用显式传入的合法 retentionDays（含 null / 'permanent'）
  > 构造器规范化后的 defaultRetentionDays（number | null）
```

构造参数省略或为 `undefined` 时，第二项就是新内部默认 `null`。已注入解析器时，其合法返回值优先于构造默认，返回 `null` 必须保留；解析器返回非法值或抛错时保持失败，不改为使用内部永久兜底。Main 当前已注入 `resolveRetentionDays(database, moduleId)`，继续沿用该路径。

`reserveTaskBatch` 已支持显式 `retentionUntil` 优先于 `retentionDays`，保持该入口既有合同；不将该能力扩展至其他入口。

已经建好的批次或持久归档待办，使用其固化期限，不重新应用以上优先级。幂等重入须返回原批次，不重算期限。

`readDefaultRetentionDays`、`resolveRetentionDays` 的默认参数应随常量更新；同时检索是否有调用者显式传入旧的 `60` 作为缺省值。不要修改业务调用者真正要求 60 天的显式参数，也不要替换测试里合法的用户 60 天配置。

`parseRetentionDays` 的读取回退不能被误用为写入验证。非法提交仍由既有写入口拒绝，不得因为 DEFAULT 变成 null 就将非法输入悄悄保存为永久。

### 4.3 前端同步

已核实的 `createAppUpdateSettingsDialog` 初值调整为：

```javascript
settings: {
  retentionDays: null,
  retentionDaysByModule: {},
  storageRoot: '',
  storageMigration: null
},
savedRetentionValue: 'permanent'
```

HTML 取消“60 天”的 selected，将 selected 移至“永久”；数值选项继续保留。`selectedRetentionModuleId` 仍为空串，对应现有“默认”项。

展示函数必须先识别 `null` / `'permanent'`；不要用 `retentionDays ?? 60` 或 `retentionDays || 60`。设置载入成功后以 Main 返回值为准，不能用初始占位覆盖老用户真实 60 天；读取失败不得把初始默认值当成已读取、已保存的配置，也不得触发写入。

保留现有保存队列、模块选择快照、请求代次与父设置会话，不为本次默认调整重做异步交互。检查同文件中的相关回包兜底，不只是修改首次 HTML。

该文件的 `createArchiveCenterPreviewApi` 当前使用 180 天演示值。它不是生产默认，不应机械全量替换；新增默认态预览或明确设为默认态后再更新对应预览期望，同时保留模块独立期限演示。

### 4.4 归档、期限清理与历史数据

分别在注入策略解析器和未注入解析器两种装配下，验证 `createBatch`、`reserveTaskBatch`、`reserveFileTaskBatch` 均正确承接永久默认，并最终固化 `retentionUntil: null`。无解析器路径还须覆盖构造参数省略、`undefined`、`null` 和显式有限值；有解析器路径核查其优先于构造默认。期限清理不能对 null 做日期相减或 Number 转换后视为到期。

新增默认永久用例须使用真实输入与输出归档文件，确认 DB 记录和物理文件在推进时间后仍存在。另设显式有限期限夹具验证原到期清理仍有效，不能通过整体停用清理任务来让永久用例通过。

不新增历史批次 UPDATE、不扫描原始文件重写到期日、不修改存档待办的既存 payload。保留锁定、业务引用和任务中断保护，不借永久默认扩大或缩小已有删除授权。

## 五、验证方案

### 5.1 单元与界面回归

覆盖 Spec AC01–AC22。重点断言实际值而不是只断言“等于导出的 DEFAULT 常量”，防止实现和测试一起写错默认值仍通过。

| 类别 | 最小覆盖 |
| --- | --- |
| 深色配置 | 显式断言 true / 17:30 / 07:00；合法旧对象不变；坏对象整组回退 |
| 时间 | 17:29、17:30、23:59、00:00、06:59、07:00；开关关闭；自定义时段 |
| 设置存储 | 只读不新增默认键；显式保存后真实 DB 重开；保存失败不变 |
| 默认期限 | 缺失 / 空 / 非法的读取回退；有效旧 60 天保留；永久值透传 |
| 服务默认与构造 | 两处默认常量均精确为 `null`；构造参数省略 / `undefined` / `null` 成功；合法有限值与原有数值转换兼容；非法值拒绝 |
| 服务求值优先级 | 批次显式值优先；注入解析器优先于构造默认；解析器无效或抛错不被永久兜底掩盖；无解析器透传构造默认 |
| 模块继承 | 键缺失继承、键存在且 null 为永久、独立数值优先、inherit 删除覆盖键 |
| 前端 | 默认 / 永久 / 跟随默认正确映射；无 60 天错误回写；读取失败与保存队列回归 |

`archive-service.test.js` 中依赖无配置创建后到期日为 `2026-09-18` 的用例，应按意图拆分：验证缺省行为的改为永久；验证有限期限及清理行为的显式设置所需期限，继续验证原边界。`retentionUntil: undefined` 的缺省用例采用新默认；已有显式有限值、永久、到期日及幂等快照用例保留。不得整体把测试 fixture 固定为 60 天而遮蔽新默认。

### 5.2 集成测试

修改既有 `dark-mode-schedule-settings.js` 与 `archive-center-module-retention.js`。后者当前多个无配置建批用例期待 60 天，应只调整这些缺省用例；显式 60 天 / 180 天等兼容性断言保留。

按仓库集成规范，计划新增 `scripts/integration/archive-center-default-retention.js`：使用临时 SQLite、临时存档根和真实文件，自包含 setup / cleanup，成功输出 `N/N PASS`，失败非零退出。覆盖有 / 无解析器两种装配下的三个建批入口、构造参数 `null`、实际输入输出永久保留、重启、显式有限期限对照、历史快照与幂等重放；无需修改自动发现 runner。

验证命令（实际运行结果见 §九）：

```bash
npm run lint
npm run test:unit
node scripts/integration/dark-mode-schedule-settings.js
node scripts/integration/archive-center-module-retention.js
node scripts/integration/archive-center-default-retention.js
```

正式 GUI 交付 / PR-ready / 发布前按仓库门禁运行 `npm run release-check`。局部回归不能替代正式门禁；本任务交付功能实现，未执行发布门禁及 Windows 人工验收。

Windows 人工验证使用隔离测试配置，不更改系统全局时间去影响其他软件；采用测试可控时钟或独立测试环境验证边界，并分别验证冷启动、恢复与设置回读。真实产品验收不得只依赖演示 API 截图。

### 5.3 实施前检索清单

```bash
rg -n 'DEFAULT_DARK_MODE_SCHEDULE|dark_mode_schedule|18:30|06:00' src tests scripts
rg -n 'DEFAULT_RETENTION_DAYS|defaultRetentionDays|archive_center_retention_days|savedRetentionValue' src tests scripts
rg -n 'retentionDays|retentionUntil' src/main-process/archive-center src/main.js src/renderer/dialogs/app-settings.js
```

逐处区分生产默认、用户合法 60 天、测试夹具、历史文档和演示值，不做数字全局替换。核查 Main 装配的显式默认参数、服务默认参数、前端 `||` / `??` 以及清理条件。

## 六、任务分解

| 序号 | 任务 | 涉及范围 | 验证 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | 核对当前 main、复用 Rev2 文档并创建指定功能分支与独立 worktree | Git / 本分支文档 | 基线一致；原工作区保留；链接及 AC01–AC22 核对 | done |
| T02 | 调整共享深色默认与相关测试 | shared / scheduler / settings tests | AC01–AC08、AC18 | done |
| T03 | 同步策略层与服务层永久默认，修改构造校验并核查全部建批入口 | retention / controller / service 构造及装配 | AC09–AC16、AC19–AC22 | done |
| T04 | 同步前端默认与回退，保持异步保存合同 | app-settings | AC09–AC13、AC17 | done |
| T05 | 补真实 DB、文件及跨重启回归 | integration / unit | 有 / 无解析器、构造永久、有限期限对照、历史快照 | done |
| T06 | 运行必要验证并记录未覆盖项 | 当前分支最终内容 | 局部回归；达到正式交付条件再完整门禁 | done |

## 七、实施计划（Commit 粒度）

仅列建议逻辑分组，不代表获得提交或推送授权：

| 分组 | 建议提交说明 | 内容 |
| --- | --- | --- |
| 1 | `fix(settings): 调整定时深色模式默认配置` | 共享默认及对应单测、集成回归 |
| 2 | `fix(archive): 默认文件保留期限改为永久` | 策略与服务默认、构造器永久语义、前端同步、调用优先级与真实文件回归 |

本功能分支已按用户指定的名称 `v3.2.11-settings-defaults`，从当前本地 `main` 的 `18b82b4328cf5e00c1b2549d373a5b2f2677215c` 创建，使用独立 worktree。该提交与上一正式标签 `v3.2.10` 一致；后续实施直接复用该分支与工作区。复核命令在上述工作区执行：

```bash
git branch --show-current
git rev-parse HEAD main
git status --short
```

文档位置：`changes/v3.2.11/v3.2.11-settings-defaults/`。功能完成后按既定流程集成到 `release/v3.2.11`；版本号与发布文档由正式发布任务统筹，本任务不提前 bump。

正文在该目录维护，使用 `spec.md` / `techdoc.md` 互链。导出为带任务前缀的附件时，同步改为 `v3.2.11-settings-defaults-spec.md` / `v3.2.11-settings-defaults-techdoc.md` 互链，避免命中其他任务的同名文档。

## 八、兼容、回滚与失败处理

保持设置键和取值格式，因此无需新 schema migration。有效既有配置优先；默认读取不强制写回。新版本已保存的 17:30/07:00 与永久值均属于旧校验支持的格式。

服务构造器新增支持 `defaultRetentionDays: null`，这项运行时参数能力在旧实现中不兼容。回滚时同步处理构造器与新增显式 `null` 调用方；不能仅回滚构造器而留下新调用参数。两处工厂默认随代码回滚，持久化的历史批次快照不重算。

回滚需区分“配置格式兼容”与“缺失配置的默认行为”：没有保存的配置会随旧代码回到旧默认；明确保存的配置不应被回滚过程重置。已建批次期限仍按原快照，不能把永久记录一键改回 60 天或补删旧文件。

设置读写失败沿用现有反馈与状态保全，不降级成伪成功。新默认造成磁盘持续增长的风险通过现有容量查看和授权手动删除管理，不新增隐蔽的强制到期清理。

## 九、实施日志

### 2026-09-29 · 初稿

**已完成：**通过仓库连接读取远端 main 和 v3.2.10 标签目标；固定基线核对共享默认、设置仓储、调度器、Renderer、保留策略及两份相关集成脚本；按目标版本多功能分支目录生成方案附件。

**初稿交付时尚未执行：**真实项目工作区改动、Git 分支创建、任何业务代码 / 测试修改、npm 测试、Windows GUI 运行、提交、推送、PR、升版与发布。当前产物是方案，不是实现完成证明。

**发现的关键回归点：**前端三处 60 天初值；默认开启后的同值保存不再产生首次启用事件；06:00 变为默认深色时段；旧集成脚本的默认关闭 / 默认60天断言需与业务意图一起更新。

### 2026-09-29 · Rev2 文档修订

**需求依据：**用户要求按审查建议修改，并明确将 `archive-service.js` 内部独立默认也改为永久。此项取代初版审查 SD-O1 中暂保留服务内部 60 天兜底的建议。

**已修订：**补齐双层永久默认、服务构造参数 `null` 校验、求值优先级、有 / 无解析器回归及 AC19–AC22；列出五份必改单测及两个核查入口，修正相同时刻夹具的实施要求；明确正文和附件各自的互链规则。Rev2 修订时，两份原稿已复用到原审查工作区；初稿快照及审查证据保留在原审查目录，未复制到本次功能 worktree。

**证据边界：**初版审查的 9/9 组探针仅模拟策略层新默认，服务内部仍为旧 60 天，不能用于验收本次新增的服务内部永久默认。Rev2 仅完成文档修订及一致性核查，尚未修改产品代码、测试代码或执行正式运行验证。

### 2026-09-29 · 功能分支与文档落盘

**已完成：**按用户指定，基于当前本地 `main` 创建 `v3.2.11-settings-defaults`，基线提交为 `18b82b4328cf5e00c1b2549d373a5b2f2677215c`。两份 Rev2 文档存入 `changes/v3.2.11/v3.2.11-settings-defaults/`，同步分支名称、互链与存放状态。保留原工作区文件和已有其他功能分支改动。

**完成边界：**本轮只创建分支和存放文档。文档为未提交文件，未修改产品或测试代码，未运行功能测试、提交、推送、升版或发布。

### 2026-09-29 · save-spec 与功能实现

**授权与存放：**用户明确要求先执行 `save-spec`，再在功能 worktree 开发。已复用本目录两份 Rev2 正文，范围与 AC01–AC22 保持一致；后续技术记录继续维护在本 TechDoc，按 `CODEX.md` 与 `implementation-notes` 的记录原则复用现有日志。分支仍为 `v3.2.11-settings-defaults`，基线未变。

**Decisions：**

- 共享深色默认改为 `true / 17:30 / 07:00`，策略层和服务层默认均改为 `null`。服务构造器先识别 `undefined` 和 `null`，再保留既有有限值转换与校验。
- 设置页新增 `settingsReady`：开始载入时清除，成功取得设置对象后置为 true。读取异常、失败回包或空 payload 时，期限与模块控件保持禁用，页面允许返回后重试；初始永久值只作占位。保存队列、模块快照和请求代次继续使用原实现。覆盖读取失败后禁止写入，而非把占位值当作已保存。
- `reserveFileTaskBatch` 既有合同在 prepared/running 状态允许重复预留，终态拒绝再次预留。集成用例在合法状态验证跨重启幂等，另用真实 TaskLifecycle 终态批次验证期限清理；未修改生命周期或删除授权。
- 全量单测发现的旧默认断言已更新；验证到期清理的 owner-recovery 用例显式传入 60 天。其他夹具保持缺省，以便真正覆盖永久新默认。深色连续编辑用例将修改后的结束时间设为 08:00，保证它与新默认 07:00 不同，保留真实队列行为覆盖。

**Evidence：**以下命令均在本功能 worktree 执行。真实文件回归使用临时 SQLite 和临时存档目录；Renderer 回归使用隔离 Electron 与受控设置 API。

| 验证命令 | 结果 | 覆盖边界 |
| --- | --- | --- |
| `npm run lint` | PASS | 最终生产代码 |
| `npm run test:unit` | PASS：9439 通过、0 失败、4 跳过；578 个文件，9443 个用例 | 4 个 Windows 专用用例按环境跳过；首轮暴露的旧默认断言已修正。最终耗时约 492 秒，[原始日志](../../../logs/unit-tests/unit-20260929-214611.log) |
| `node scripts/integration/dark-mode-schedule-settings.js` | 7/7 PASS | 真实 Preload/Main handler、SQLite 重开、默认时段、旧配置、写失败；窗口和时钟受控 |
| `node scripts/integration/archive-center-module-retention.js` | 11/11 PASS | 模块覆盖、继承、期限快照、outbox、锁定及引用保护 |
| `node scripts/integration/archive-center-default-retention.js` | 10/10 PASS | 有/无解析器、三个建批入口、构造永久/有限值、真实输入输出与物理清理、旧 60 天快照；[原始日志](../../../logs/settings-defaults/archive-default-retention.log) |
| `node scripts/test-renderer-lifecycle.js app-settings` | 14/14 PASS | 永久占位、成功读取、读取失败与重试、旧 60 天、缺省回包、模块切换、保存队列、父弹窗生命周期 |
| `git diff --check` | PASS | 差异格式 |
| `npm run verify:app-settings-layout` | FAIL，基线同样失败 | 6 个窗口/缩放组合均报 `createAppUpdateSettingsDialog is not defined`，未取得完整页面布局验收 |

**布局验证限制：**将 `HEAD/main = 18b82b4328cf5e00c1b2549d373a5b2f2677215c` 的 `index.html`、`src/` 和该验证脚本通过 `git archive` 提取到临时目录，复用同一依赖运行；6 个组合均复现同一错误。临时快照已清理。[当前分支日志](../../../logs/settings-defaults/layout-current.log)、[未修改 main 快照日志](../../../logs/settings-defaults/layout-main-baseline.log) 保存在本 worktree。这个既有脚本入口问题未在本次默认值任务中修改；不能把 14/14 组件回归写成完整页面布局或 Windows 产品验收。

**验收对应：**AC01–AC08、AC18 由深色共享规则/调度/Renderer 单测及深色集成覆盖；AC09–AC16、AC19–AC22 由策略/控制器/服务单测与两组存档集成覆盖；AC17 的设置组件行为由 Electron 14/14 覆盖。Windows 冷启动、休眠恢复等产品环境人工验收仍未执行。

**Assumptions / Deviations：**没有新增业务假设、设置格式或迁移。复用原仓库相同基线的 `node_modules`，未安装新依赖。测试全部使用临时数据或受控 API；真实用户设置、存档文件与原工作区均未修改。

**Remaining：**本轮功能实现、计划内自动回归和差异核对已完成。完整页面布局脚本的既有入口问题仍待修复，Windows 产品人工验收与完整 `release-check` 尚未执行；未将本分支标记为 PR-ready。代码和文档均保留为未提交改动，提交、推送、PR、release 集成、升版与发布由后续明确指令决定。

## 十、Open Technical Questions

无阻塞本轮实现的问题。Main 装配、三个建批入口与持久化快照已核实；最终测试结果和未执行项以 §九 为准。正式 PR-ready / 发布仍须另跑完整门禁和适用人工验收。

### 固定基线依据

[T1]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/shared/dark-mode-schedule.js
[T2]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/archive-center/retention-policy.js
[T3]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer/dialogs/app-settings.js
[T4]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/backend/database/settings-repository.js
[T5]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/dark-mode-scheduler.js
[T6]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/renderer-dark-mode.js
[T7]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/archive-center/controller.js
[T8]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/scripts/integration/dark-mode-schedule-settings.js
[T9]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/scripts/integration/archive-center-module-retention.js
[T10]: https://github.com/MatthewPZhong/bank-bill-excel-tool/blob/18b82b4328cf5e00c1b2549d373a5b2f2677215c/src/main-process/archive-center/archive-service.js
