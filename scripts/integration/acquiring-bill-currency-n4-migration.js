// v2.1.8 N4 端到端集成验证脚本
//   目标：模拟"老库升级"完整路径 → migration → writer → readback 12 列输出 + 9 字段 raw_json + 备份文件
//   覆盖：caseN4（migration 单元）+ caseA（writer 输出列）+ 未覆盖的 e2e 联合
//
// 用法：node scripts/test-v2.1.8-n4-e2e.js
//
// v2.1.9 N4 重构 (T32f, D22=a)：ensureBillRawJsonV2Slim 签名加 createBackupFn 第三参
//   旧调用形态：migrations.ensureBillRawJsonV2Slim(db.db, dbPath)
//   新调用形态：migrations.ensureBillRawJsonV2Slim(db.db, dbPath, (label) => appDb.createBackup(label))
//   集成测试直接调底层 migration 函数（绕过 AppDatabase wrapper），需要自己注入 createBackupFn

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const writer = require('../../src/main-process/acquiring-bill-currency-writer');
const migrations = require('../../src/backend/database/migrations');
const {
  FLOW_HEADERS,
  BILL_HEADERS,
  WRITER_OUTPUT_HEADERS_V2,
  TEMPLATE_BILL_HEADERS
} = require('../../src/backend/acquiring-bill-currency-db/columns');

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

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-e2e-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();
  const cleanup = () => {
    try { db.db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  };
  return { tmpdir, dbPath, db, cleanup };
}

async function run() {
  console.log('==== v2.1.8 N4 e2e 集成验证 ====');

  const { tmpdir, dbPath, db, cleanup } = setupTmpDb();

  try {
    // ============================================================
    // Step 1：模拟 v2.1.7 老库导入数据 — bill_imports.raw_json 含全 26 字段
    // ============================================================
    // 用真实 import-repository 路径写入（保证 raw_json 含 26 字段而非空）
    const date = '2026-04-15';
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    const billFile = path.join(tmpdir, 'bill.xlsx');

    // 构造 5 行真实 bill（含 26 字段全量值），3 行流水（用于差异判定）
    function makeFullBill(id) {
      const r = new Array(26).fill('');
      // BILL_HEADERS 26 字段：填 + 注入真实业务值
      r[0] = date;                          // 账单日期 (模版#1)
      r[1] = `ORIGIN-${id}`;               // originBillBizId (模版#2)
      r[2] = `RECON-${id}`;                // ReconBillBizId (非模版-1)
      r[3] = 'COMPANY-A';                  // 公司主体 (非模版-2)
      r[4] = 'DEPT-X';                     // 业务部门 (非模版-3)
      r[5] = 'DEPT-Y';                     // 对手部门 (非模版-4)
      r[6] = 'SRC';                        // 订单创建来源 (非模版-5)
      r[7] = 'BU-1';                       // 财务BU (非模版-6)
      r[8] = 'BILL-TYPE';                  // 账单类型 (非模版-7)
      r[9] = `BILL-${id}`;                 // 单据类型 (模版#3)
      r[10] = 'SUB-TYPE';                  // 业务子类型 (非模版-8)
      r[11] = 'TRADE';                     // 交易类型 (非模版-9)
      r[12] = 'RECON-SUB';                 // 对账子类型 (非模版-10)
      r[13] = 'PAID';                      // 单据状态 (非模版-11)
      r[14] = id;                          // 主对账Id (模版#4)
      r[15] = `ORDER-${id}`;               // 业务订单号 (模版#5)
      r[16] = `USER-${id}`;                // 用户编号 (非模版-12)
      r[17] = `ACC-${id}`;                 // 账户号 (非模版-13)
      r[18] = '100';                       // 对账金额 (模版#6)
      r[19] = 'USD';                       // 对账币种 (模版#7)
      r[20] = 'ACC-TYPE';                  // 账户类型 (非模版-14)
      r[21] = '2026-04-16';                // valueDate (模版#8)
      r[22] = `CH-${id}`;                  // channel (模版#9)
      r[23] = 'NOTE';                      // remark (非模版-15)
      r[24] = '2026-04-15 10:00';          // 创建时间 (非模版-16)
      r[25] = '2026-04-15 11:00';          // 完成时间 (非模版-17)
      return r;
    }

    await writeXlsx(flowFile, FLOW_HEADERS, [
      (() => { const r = new Array(48).fill(''); r[0]=date; r[6]='E1'; r[12]='100'; r[13]='USD'; r[28]='100'; r[29]='USD'; return r; })(),
      (() => { const r = new Array(48).fill(''); r[0]=date; r[6]='E2'; r[12]='100'; r[13]='USD'; r[28]='100'; r[29]='EUR'; return r; })(),
      (() => { const r = new Array(48).fill(''); r[0]=date; r[6]='E3'; r[12]='100'; r[13]='USD'; r[28]='100'; r[29]='USD'; return r; })()
    ]);
    await writeXlsx(billFile, BILL_HEADERS, [
      makeFullBill('E1'), makeFullBill('E2'), makeFullBill('E3'), makeFullBill('E4'), makeFullBill('E5')
    ]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [flowFile] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [billFile] });

    // v2.1.8 SR7（PR #52 Finding 1）反向同步：import-repository 改用 TEMPLATE_BILL_HEADERS 后
    //   新 import 的 raw_json 已经是 9 字段，无须 migration → 本测试 Step 1 已不能"通过 import 模拟 v2.1.7 老库"
    //   改为直接 UPDATE raw_json 注入 26 字段模拟"v2.1.7 老库数据"，然后跑 migration 验证瘦身
    const fullRawSample = (() => {
      const r = makeFullBill('E1');
      const obj = {};
      for (let i = 0; i < BILL_HEADERS.length; i++) obj[BILL_HEADERS[i]] = r[i] === undefined ? '' : String(r[i]);
      return JSON.stringify(obj);
    })();
    const updateStmt = db.db.prepare(`UPDATE acquiring_bill_currency_bill_imports SET raw_json = ? WHERE month_key = '2026-04'`);
    updateStmt.run(fullRawSample);

    // 验证现在 raw_json 已经被注入 26 字段（模拟 v2.1.7 老库残留）
    const billBefore = db.db.prepare(`SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id = 'E1'`).get();
    const billObjBefore = JSON.parse(billBefore.raw_json);
    assertEq(Object.keys(billObjBefore).length, 26, 'Step1.手工注入 26 字段（模拟 v2.1.7 老库）');
    assertEq(billObjBefore['公司主体'], 'COMPANY-A', 'Step1.非模版字段「公司主体」存在');
    assertEq(billObjBefore['remark'], 'NOTE', 'Step1.非模版字段「remark」存在');

    // ============================================================
    // Step 2：重置 marker 模拟"v2.1.7 老库首次升级 v2.1.8"
    //   AppDatabase.init() 链已经跑过 N4 migration（首次时 bill 表空 → migrated-empty）
    //   现在 bill 表有 5 行 + marker 已写 → 删 marker 重跑模拟老库升级路径
    // ============================================================
    db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated'").run();

    // v2.1.9 N4 重构 (T32e)：注入 createBackupFn（与 AppDatabase.ensureBillRawJsonV2Slim wrapper 同模式）
    const result1 = migrations.ensureBillRawJsonV2Slim(db.db, dbPath, (label) => db.createBackup(label));
    assertEq(result1.status, 'migrated', 'Step2.first migration status=migrated');
    assertEq(result1.rowsAffected, 5, 'Step2.rowsAffected=5');
    assertTrue(result1.backupPath && fs.existsSync(result1.backupPath), 'Step2.backup file exists');

    // v2.1.9 N4 重构 (T32e)：备份路径仍是 <dbDir>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite（v2.1.8 契约保留）
    assertTrue(
      /tool-data-bak-pre-N4-\d{8}T\d{6}\.sqlite$/.test(result1.backupPath),
      `Step2.backup path 路径格式仍是 tool-data-bak-pre-N4-{timestamp}.sqlite (actual=${result1.backupPath})`
    );

    // 验证 backup 文件大小 > 0
    const backupSize = fs.statSync(result1.backupPath).size;
    assertTrue(backupSize > 1024, `Step2.backup size > 1KB (actual=${backupSize})`);

    // ============================================================
    // Step 3：验证 5 行 raw_json 都瘦身到 9 字段
    // ============================================================
    const billsAfter = db.db.prepare(`SELECT recon_main_id, raw_json FROM acquiring_bill_currency_bill_imports ORDER BY recon_main_id`).all();
    assertEq(billsAfter.length, 5, 'Step3.5 行 bill 全部保留');
    for (const row of billsAfter) {
      const obj = JSON.parse(row.raw_json);
      const keys = Object.keys(obj).sort();
      assertEq(keys.length, 9, `Step3.${row.recon_main_id} raw_json 字段数=9`);
      // 必须包含模版 9 字段
      const expectedKeys = TEMPLATE_BILL_HEADERS.slice().sort();
      assertEq(keys, expectedKeys, `Step3.${row.recon_main_id} keys 严格匹配模版`);
      // 17 字段必须不存在
      const removedKeys = ['ReconBillBizId', '公司主体', '业务部门', '对手部门', '订单创建来源', '财务BU',
        '账单类型', '业务子类型', '交易类型', '对账子类型', '单据状态', '用户编号',
        '账户号', '账户类型', 'remark', '创建时间', '完成时间'];
      for (const k of removedKeys) {
        assertTrue(!(k in obj), `Step3.${row.recon_main_id} 17 字段「${k}」已删除`);
      }
    }

    // ============================================================
    // Step 4：跑 runCheck + writeRunOutputs 完整 pipeline
    //   验证 writer 用瘦身后的 raw_json 仍能输出正确 12 列
    // ============================================================
    const r = await session.runCheck({ db: db.db, monthKey: '2026-04', storageRoot: tmpdir });
    assertTrue(r.diffFilePath && fs.existsSync(r.diffFilePath), 'Step4.diff xlsx 文件存在');
    // 跑 runCheck 会写新差异 → 期望至少 1 行差异（E2 币种 USD vs EUR）
    const diffCount = db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows`).get().c;
    assertTrue(diffCount > 0, `Step4.diff_rows count > 0 (actual=${diffCount})`);

    // ============================================================
    // Step 5：readback xlsx 验证 12 列结构 + 数据
    // ============================================================
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.diffFilePath);
    const ws = wb.worksheets[0];
    assertEq(ws.columnCount, 12, 'Step5.差异表 sheet 1 列数=12');
    assertEq(ws.getRow(1).getCell(1).value, '账单日期', 'Step5.列 1=账单日期');
    assertEq(ws.getRow(1).getCell(2).value, 'originBillBizId', 'Step5.列 2=originBillBizId');
    assertEq(ws.getRow(1).getCell(7).value, '对账币种', 'Step5.列 7=对账币种');
    assertEq(ws.getRow(1).getCell(10).value, '单据_对账币种', 'Step5.列 10=单据_对账币种');
    assertEq(ws.getRow(1).getCell(11).value, '流水_通道清算币种', 'Step5.列 11=流水_通道清算币种');
    assertEq(ws.getRow(1).getCell(12).value, '流水_通道清算金额', 'Step5.列 12=流水_通道清算金额');

    // 第 2 行（第一条差异数据）— 验证模版字段值（来自瘦身后 raw_json）
    const row2 = ws.getRow(2);
    assertEq(row2.getCell(1).value, date, 'Step5.row2 列 1 账单日期值');
    assertEq(row2.getCell(7).value, 'USD', 'Step5.row2 列 7 对账币种值（来自瘦身后 raw_json）');

    // ============================================================
    // Step 6：第二次跑 migration → 幂等跳过
    // ============================================================
    const result2 = migrations.ensureBillRawJsonV2Slim(db.db, dbPath, (label) => db.createBackup(label));
    assertEq(result2.status, 'already-migrated', 'Step6.second run = already-migrated');
  } finally {
    cleanup();
  }

  // ============================================================
  // Step 7（SR2 强化）：fault injection — 备份失败路径
  //   构造非法 dbPath 让 fs.copyFileSync 失败 → 验证 backup-failed + marker 不写 + 数据未变
  // ============================================================
  const { tmpdir: f1tmpdir, dbPath: f1dbPath, db: f1db, cleanup: f1cleanup } = setupTmpDb();
  try {
    f1db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated'").run();
    // 插一行让 billCount > 0（触发完整备份分支）
    f1db.db.prepare(`
      INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
      VALUES ('2026-05', 'fake.xlsx', 2, 'F1-1', 'USD', 'usd', ?, ?)
    `).run(JSON.stringify({ '账单日期': '2026-05-01', 'remark': 'test' }), new Date().toISOString());

    // v2.1.9 N4 重构 (T32e)：fault injection — 给 createBackupFn 注入抛错的 fake，模拟备份失败
    //   原 v2.1.8 路径：构造非法 dbPath 让 fs.copyFileSync 失败
    //   新 v2.1.9 路径：注入 fake createBackupFn 直接 throw → 走相同 backup-failed 分支
    const failingBackupFn = (_label) => { throw new Error('injected backup failure'); };
    const r1 = migrations.ensureBillRawJsonV2Slim(f1db.db, f1dbPath, failingBackupFn);
    assertEq(r1.status, 'backup-failed', 'Step7.backup-failed 路径');
    assertTrue(typeof r1.error === 'string' && r1.error.length > 0, 'Step7.error 信息存在');
    // 验证 marker 未写
    const markerAfterFail = f1db.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated'").get();
    assertTrue(!markerAfterFail || markerAfterFail.setting_value !== 'true', 'Step7.marker 未写（下次启动可重试）');
    // 验证数据未动（仍 2 字段 raw_json）
    const dataAfterFail = JSON.parse(f1db.db.prepare("SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id = 'F1-1'").get().raw_json);
    assertEq(Object.keys(dataAfterFail).length, 2, 'Step7.数据未瘦身（事务未启动）');
    assertTrue('remark' in dataAfterFail, 'Step7.被删字段 remark 仍在（migration 未执行）');
  } finally {
    f1cleanup();
  }

  // ============================================================
  // Step 8（SR2 强化）：fault injection — batch UPDATE 失败路径
  //   注入一个 db.prepare proxy 让 update 在第 1 次后抛错 → 验证 batch-failed + ROLLBACK + marker 不写
  // ============================================================
  const { tmpdir: f2tmpdir, dbPath: f2dbPath, db: f2db, cleanup: f2cleanup } = setupTmpDb();
  try {
    f2db.db.prepare("DELETE FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated'").run();
    // 插 3 行
    const insertStmt = f2db.db.prepare(`
      INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
      VALUES ('2026-05', 'fake.xlsx', ?, ?, 'USD', 'usd', ?, ?)
    `);
    for (let i = 1; i <= 3; i++) {
      insertStmt.run(i, `F2-${i}`, JSON.stringify({ '账单日期': '2026-05-01', 'remark': `keep-${i}` }), new Date().toISOString());
    }

    // proxy db.prepare：让 UPDATE 语句在 run 时抛错
    const originalPrepare = f2db.db.prepare.bind(f2db.db);
    let updateCallCount = 0;
    f2db.db.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (sql.startsWith('UPDATE acquiring_bill_currency_bill_imports')) {
        return {
          run: (...args) => {
            updateCallCount++;
            if (updateCallCount >= 2) {
              throw new Error('injected fault: simulated UPDATE failure');
            }
            return stmt.run(...args);
          }
        };
      }
      return stmt;
    };

    const r2 = migrations.ensureBillRawJsonV2Slim(f2db.db, f2dbPath, (label) => f2db.createBackup(label));
    // 恢复 prepare（避免后续清理出错）
    f2db.db.prepare = originalPrepare;

    assertEq(r2.status, 'batch-failed', 'Step8.batch-failed 路径');
    assertTrue(r2.error && /injected fault/.test(r2.error), 'Step8.error 含注入消息');
    // 验证 marker 未写
    const markerF2 = f2db.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'acquiring_bill_raw_json_v2_migrated'").get();
    assertTrue(!markerF2 || markerF2.setting_value !== 'true', 'Step8.marker 未写');
    // 验证 ROLLBACK：3 行数据应该都未瘦身（事务整体回滚）
    const rowsF2 = f2db.db.prepare("SELECT recon_main_id, raw_json FROM acquiring_bill_currency_bill_imports ORDER BY recon_main_id").all();
    assertEq(rowsF2.length, 3, 'Step8.3 行保留');
    for (const row of rowsF2) {
      const obj = JSON.parse(row.raw_json);
      assertTrue('remark' in obj, `Step8.${row.recon_main_id} remark 仍在（ROLLBACK 生效）`);
    }
  } finally {
    f2cleanup();
  }

  // 汇报
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
