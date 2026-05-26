// 主功能 3「月度 Pending 数据核对」集成测试
//   覆盖：
//     1. PENDING_COLUMNS 模板 31 列契约
//     2. validateHeaders 表头校验（正常 / 列数不匹配 / 列名不匹配 / 非数组）
//     3. computeRowHash 行哈希稳定性 + 区分性（SOH 分隔避免拼串歧义）
//     4. buildChangedClause SQL 字段变更条件生成
//     5. makeFieldIndexName 索引名 hash 稳定 + SQL 安全
//
// Pending 模块的 runReconciliation 涉及独立 pending-db SQLite + 完整 schema，由 GUI 手测覆盖；
// 本脚本验证纯函数 + SQL 片段生成（关键回归点：拼串歧义 / 表头契约 / SQL 注入风险）
//
// 用法：node scripts/integration/pending-data-reconciliation.js

const PENDING_COLUMNS = require('../../src/backend/pending-db/columns');
const validator = require('../../src/backend/pending-import/validator');
const reconcileEngine = require('../../src/backend/pending-reconcile/engine');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

async function run() {
  console.log('==== Pending 数据核对 集成验证 ====');

  // ============================================================
  // Step 1: PENDING_COLUMNS 模板 31 列契约
  // ============================================================
  assertEq(PENDING_COLUMNS.length, 31, 'Step1.PENDING_COLUMNS = 31 列');
  assertEq(PENDING_COLUMNS[0], 'pending类型', 'Step1.第 1 列 = pending类型');
  assertEq(PENDING_COLUMNS[2], '账单类型', 'Step1.第 3 列 = 账单类型');
  assertEq(PENDING_COLUMNS[11], 'recon_id', 'Step1.第 12 列 = recon_id');
  assertEq(PENDING_COLUMNS[12], '金额', 'Step1.第 13 列 = 金额');
  assertEq(PENDING_COLUMNS[13], '币种', 'Step1.第 14 列 = 币种');
  assertEq(PENDING_COLUMNS[23], 'PendingBizId', 'Step1.第 24 列 = PendingBizId');
  assertEq(PENDING_COLUMNS[30], '主体（流水）', 'Step1.第 31 列 = 主体（流水）');

  // 不可变（Object.freeze）
  assertTrue(Object.isFrozen(PENDING_COLUMNS), 'Step1.PENDING_COLUMNS 被 freeze');

  // ============================================================
  // Step 2: validateHeaders 表头校验
  // ============================================================
  // 正常路径
  const r1 = validator.validateHeaders(PENDING_COLUMNS.slice());
  assertEq(r1.ok, true, 'Step2.精确表头 → ok=true');
  assertEq(r1.error, undefined, 'Step2.精确表头 → 无 error');

  // 列数不匹配（少 1 列）
  const r2 = validator.validateHeaders(PENDING_COLUMNS.slice(0, 30));
  assertEq(r2.ok, false, 'Step2.列数 30 → ok=false');
  assertTrue(/30/.test(r2.error) && /31/.test(r2.error), 'Step2.error 含列数信息');

  // 列数不匹配（多 1 列）
  const r3 = validator.validateHeaders([...PENDING_COLUMNS, '额外列']);
  assertEq(r3.ok, false, 'Step2.列数 32 → ok=false');

  // 列名不匹配（第 1 列改了）
  const wrongHeaders = PENDING_COLUMNS.slice();
  wrongHeaders[0] = 'wrong_first_col';
  const r4 = validator.validateHeaders(wrongHeaders);
  assertEq(r4.ok, false, 'Step2.列名错 → ok=false');
  assertTrue(/第 1 列/.test(r4.error), 'Step2.error 含错误列序号');
  assertTrue(/wrong_first_col/.test(r4.error), 'Step2.error 含错误列名');
  assertTrue(/pending类型/.test(r4.error), 'Step2.error 含预期列名');

  // 非数组
  const r5 = validator.validateHeaders(null);
  assertEq(r5.ok, false, 'Step2.null → ok=false');
  const r6 = validator.validateHeaders('not an array');
  assertEq(r6.ok, false, 'Step2.字符串 → ok=false');

  // ============================================================
  // Step 3: computeRowHash 行哈希
  //   关键：SOH 分隔符（）避免拼串歧义
  //   "AB" + "CD" 应 != "A" + "BCD"（合并后是 "ABCD" 字符串相同但应得不同 hash）
  // ============================================================
  const hash1 = validator.computeRowHash(['AB', 'CD']);
  const hash2 = validator.computeRowHash(['A', 'BCD']);
  assertTrue(typeof hash1 === 'string' && hash1.length === 40, 'Step3.computeRowHash 返回 40 位 hex（SHA-1）');
  assertTrue(hash1 !== hash2, 'Step3.拼串歧义防御：[AB,CD] != [A,BCD]');

  // 稳定性（同输入应得同 hash）
  const hashA = validator.computeRowHash(['v1', 'v2', 'v3']);
  const hashB = validator.computeRowHash(['v1', 'v2', 'v3']);
  assertEq(hashA, hashB, 'Step3.稳定性 — 同输入得同 hash');

  // null / undefined 兜底为空字符串
  const hashNull = validator.computeRowHash([null, undefined, '']);
  const hashEmpty = validator.computeRowHash(['', '', '']);
  assertEq(hashNull, hashEmpty, 'Step3.null/undefined 与空字符串等价');

  // 数字转字符串
  const hashNum = validator.computeRowHash([100, 200.5, '300']);
  const hashStr = validator.computeRowHash(['100', '200.5', '300']);
  assertEq(hashNum, hashStr, 'Step3.数字与字符串等价（String() 转换）');

  // ============================================================
  // Step 4: buildChangedClause SQL 字段变更条件
  // ============================================================
  const { buildChangedClause, makeFieldIndexName } = reconcileEngine.__internal;

  // 单字段
  const c1 = buildChangedClause(['金额'], 'a', 'b');
  assertEq(c1, '(a.`金额` IS NOT b.`金额`)', 'Step4.单字段 SQL 子句');

  // 多字段
  const c2 = buildChangedClause(['金额', '币种', 'recon_id'], 'u', 'l');
  assertEq(c2, '(u.`金额` IS NOT l.`金额`) OR (u.`币种` IS NOT l.`币种`) OR (u.`recon_id` IS NOT l.`recon_id`)',
    'Step4.多字段 OR 拼接');

  // 空数组
  assertEq(buildChangedClause([], 'a', 'b'), null, 'Step4.空数组 → null');
  assertEq(buildChangedClause(null, 'a', 'b'), null, 'Step4.null → null');

  // ============================================================
  // Step 5: makeFieldIndexName 索引名 hash
  //   稳定性 + 跨调用一致 + 含合法 SQL 字符
  // ============================================================
  const idx1 = makeFieldIndexName('金额');
  const idx2 = makeFieldIndexName('金额');
  assertEq(idx1, idx2, 'Step5.索引名稳定 — 同输入同结果');
  assertTrue(/^idx_pending_match_[a-f0-9]{12}$/.test(idx1), 'Step5.索引名格式 = idx_pending_match_<12 hex>');

  // 不同字段不同索引名
  const idxA = makeFieldIndexName('金额');
  const idxB = makeFieldIndexName('币种');
  assertTrue(idxA !== idxB, 'Step5.不同字段不同索引名');

  // 中文字段 hash 后是 ASCII 安全（防 SQL 注入 / 编码问题）
  const idxChinese = makeFieldIndexName('对账明细ID');
  assertTrue(/^[a-z_0-9]+$/.test(idxChinese), 'Step5.中文字段 hash 后全 ASCII 安全');

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
