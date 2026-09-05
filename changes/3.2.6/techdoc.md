# v3.2.6 TechDoc — 对账操作符与大账号维护检查

目标版本 3.2.6；基线 3.2.5 / e5047831；2026-09-05；状态：实现完成，本轮定向检查通过，完整回归与人工验收状态见实施记录。
产品合同见 [Spec](spec.md)，决策与验收见 [实施记录](implementation-notes.md)。

## 1. 基线调用链与修改边界

- `src/renderer-dialogs.js`：3.2.5 的 `createScenarioConfigDialogC2` 渲染 vs，`buildScenarioConfirmDetailHtml` 显示固定等号；3.2.6 分别接入单选框和实际操作符。
- `src/main-process/scenario-engines/c2-offset-bill-mark.js`：3.2.5 的 `pairsMatch` 仅调用 valuesEqual；3.2.6 增加比较分派，runC2Scenario 继续负责分类、多候选、锁定与赋值。
- `src/backend/database/scenarios-repository.js`：normalizeC2Config 归一化旧 billTypes；createScenario/updateScenario 负责持久化，bundle 导入经过 createScenario。
- `src/main.js`：原始行 → buildBigAccountRecognitionBasis → finalizeBigAccountRecognitionBasis → buildBigAccountOrderEvidence；桥接账号不在维护列表时返回 null，导致识别值丢失。

提取链：选择窗口 → desktopApi.files.extractBigAccountOrder → file:extract-big-account-order → extractBigAccountOrderFromEvidence。提取保持只读；用户确认阻断后走 file:cancel-big-account-selection 清理当前上下文。后台执行策略与 production 开关保持当前配置。

## 2. C2 配置与执行

每条 `reconFields` 增加 `op: '等于' | '包含'`。例：

```json
{"seq":1,"leftType":1,"leftField":"CustomerRef","op":"包含","rightType":2,"rightField":"ReconciliationId"}
```

UI 新增行写入等于，编辑旧配置补默认，`data-multi-field=op` 使用既有 change 事件；确认详情展示实际 op。仓储读、写归一化缺省值，写入校验显式非法枚举，限定 C2。执行入口独立兼容旧配置并在分类、锁定、赋值前拦截非法 op，返回既有 invalid-config 告警及空修改／锁定集合。

比较：包含使用 `normalizeCellValue(left/right)`，两端非空且 `left.includes(right)`；等于继续按既有字段名判断 numeric 并调用 valuesEqual。多个 reconFields 用 every，保留 reconFields=[]、多候选、锁定和实际修改语义。bundle 保持透传，无表结构迁移。

`pairsMatch` 以第一条字段的类型确定传入候选行的角色，再按每条 `rf.leftType` / `rf.rightType` 分别解析取值行，等于与包含共用该绑定。同一类型对反向配置时交换来源；不得对包含做双向判断，也不得通过行的多类型分类结果随意选择来源。后续条件引用配对内同一个类型时，两端读取该类型的行；引用配对之外的类型时返回不匹配，避免借用错误行。第一条两侧同类型时保留左右候选的位置；不带类型的直接 helper 调用保持按入参位置比较。候选配对和赋值目标选择保留；歧义过滤按下述完整计数执行。

`runC2Scenario` 对每个左行算出 `matched` 后，先把其中每个右行计入 `rightRowMatchCount`，再处理 `matched.length > 1` 的告警及跳过。只有单候选左行进入 `successfulPairs`；最后按完整计数生成 `blockedRightRowIds` 和多对一告警。写值前同时满足左侧唯一和右侧唯一，交叉歧义不锁行，独立合法配对继续执行。不得在一对多 `continue` 之后才计数，也不得对单候选重复计数。

## 3. 大账号证据与接口

冻结顺序证据中增加独立的全量维护检查证据。实际存储于 `bigAccountOrderEvidence.files[].maintenanceChecks[]`，各条含 blockOrdinal、sourceRowNumber、extractedMerchantId，fileOrdinal、fileName 复用父级文件证据，返回错误时合并成完整来源。序号内部从 0 开始；sourceRowNumber 是分段定位行；以 statementSelectionSessionId 绑定。证据遍历全部文件与分段，不依赖 renderer 的 rowIndexes 或 orderedAccountKeys。

维护证据的 `sourceRowNumber` 按 `headerWindows[blockOrdinal].headerRowNumber → previewRow.sourceRowNumber → 0` 取值。有冻结表头时统一指向本段表头：空段的 `startIndex` 可能已经落在下一分段的交易行，不能让预览行优先覆盖本段证据。仅调整维护提示位置；正常顺序证据的 sourceRow、账号识别、交易分段和取消流程沿用原实现。

桥接路径直接保留未过滤的 bridgeClearingIdsByBlock；不得用匹配后的 maintained merchantId 替换识别原值。没有明确识别结果保留空，不从任意数字猜账号。不跨文件、分段借用证据；正常顺序证据与币种提示保留。

提取顺序：验证上下文／证据身份 → 建立本次维护列表 MerchantId 的 trim 精确集合 → 全量检查非空识别值 → 未维护直接返回专用错误 → 全部通过后才按 mode + rowIndexes 执行既有提取。rowIndexes=[] 仍先检查维护情况。按钮不重新读文件；生成仍走既有新鲜度验证。

请求保持 `{contextId, mode, rowIndexes}`；错误扩展：

```javascript
{
  status: 'error',
  errorCode: 'BIG_ACCOUNT_NOT_MAINTAINED',
  message: '存在未维护大账号，本次导入将终止。',
  failedRows: [],
  unmaintainedAccounts: [{
    merchantId: 'M002', fileName: '账单.xlsx',
    fileOrdinal: 0, blockOrdinal: 1, sourceRowNumber: 5
  }]
}
```

文件／分段稳定排序，同段同账号去重、跨段保留位置；该结果不返回部分 accounts。成功、普通失败与币种歧义保持现有结构；Preload 不新增方法。

## 4. 前端与取消状态

选择窗口 → 提取中（禁用提取与完成）→ 成功进入提取确认／普通失败提醒后回原窗口／未维护进入终止提醒。未维护错误分支优先于普通 status=error，文本做 HTML 转义。

用户确认后调用 cancelBigAccountSelection(contextId)，仅清理当前匹配上下文；success 或 not-active 均结束界面。取消异常显示可重试提醒，不恢复导入按钮。旧 contextId 的完成请求继续被后端上下文检查拒绝。不得调用清空历史会话／历史生成结果的逻辑。提取、完成请求互斥，失败给出可见反馈。

请求期间整张选择卡片设为 inert，阻止用户改变待提交选择；取消请求展示禁用按钮的进度框，仅在该框仍属于当前 modalRoot 时关闭或显示重试。未维护账号列表在有界容器中滚动，终止提示置于列表前，确认按钮固定可见；C2 对账行的类型和操作符下拉框收窄，防止删除按钮溢出。

## 5. 验证、实施与回滚

定向覆盖 C2 方向／空值／0／大小写／金额字段／AND／非法枚举／多候选／无对账字段；仓储归一化幂等、CRUD 与 bundle 往返；账号原值保留、全量分段、已绑定、空分段、空 rowIndexes、前导零、子串近似、多币种、未知账号；实际 UI 事件的提取与完成互斥、取消重试及历史结果保留。

实施顺序：失败用例 → 原值证据／全量检查 → UI 提醒取消 → C2 配置持久化与执行 → 定向测试／界面预览／release-check → 版本文档收尾。版本调整前执行 scan:vars 和 check:vars，输出关联功能 review。

基线定向测试 68/68 PASS，仅代表 3.2.5。本轮空分段定位的 5 项新增回归由 3 PASS / 2 FAIL 变为 5/5 PASS；其中三项使用实际临时 XLSX，走 reader、映射、账号识别及分段后生成冻结证据，覆盖首／中／尾空段，另外两项覆盖无表头和无行号回退。账号链路与 C2 定向合计 154/154 PASS，lint、smoke 通过。

完整 release-check 最近一次在交叉候选修复提交 1b3363b 执行，退出码 0：单测 6942/6945（3 SKIP、0 FAIL），53 个集成脚本全部通过、2488/2488 断言通过。本轮只改维护提示定位，未重复完整回归或此前 f8ae6a4 的隔离 Electron 界面验证。数据库无迁移；降版前停用或转换包含场景。脱敏样本人工核对匹配和账号归属仍待执行，自动测试不替代人工验收。

复验命令：

```bash
node --test tests/unit/main-process/statement-big-account-maintenance.test.js tests/unit/main-process/statement-big-account-preview.test.js tests/unit/main-process/big-account-recognition.test.js tests/unit/main-process/scenario-engines/c2-offset-bill-mark.test.js tests/unit/main-process/scenario-engines/c2-recon-operators.test.js tests/unit/main-process/scenario-engines/c2-recon-field-direction.test.js tests/unit/main-process/scenario-engines/c2-candidate-conflicts.test.js tests/unit/main-process/scenario-dispatcher.test.js
npm run lint
npm run smoke
npm run release-check
node scripts/verify-v3-2-6-dialogs.js
npm run scan:vars
npm run check:vars
```

界面验证脚本使用独立临时 userData、合成账号和 stub IPC，运行真实 DOM 事件；它不读写运行中的用户账单库。历史 R3.2.5 单测使用对应版本元数据 fixture，历史 validator 仍严格拒绝 3.2.6，冻结发布快照不变。
