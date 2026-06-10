// v3.0.4 块 E 需求3 集成测试：BOC 调拨订单修复引擎端到端契约（spec §9.2）。
//   仿 v3.0.1-linked-gateway-upsert 自跑断言范式，串起真实代码：
//     1. 临时 DB → AppDatabase().init()（自动跑 BOC 场景种子 ensureBocDispatchOrderScenarioSeed + BOC 表 DDL）。
//     2. 经仓储 replaceBocFxLink 写入 BOC链接表 fixture（2 组：组1 双行可全配 / 组2 单行链接ID 空必整组失败）。
//     3. XLSX 现造 4 sheet「资金对账导出不平」工作簿（对账结果/网关账单/渠道账单/订单修复 严格列名）。
//     4. readReconIdFixFile(file,'gateway') → runReconIdFix(scenario, sheets, { bocLinkRows: readBocFxLinkRows() })。
//     5. 断言 fixedRows / stats / warnings（组1 产 2 行修复，组2 整组失败）。
//     6. writeReconIdFixOutput({subMode:'gateway'}) 写临时 xlsx → XLSX 读回断言 14 列表头 + Type=2 + Reference/Amount 行级值。
//
//   注：run handler 是 IPC+dialog 绑定无法直接调；本测试镜像 handler 的 runOpts 注入（isBocScenario → bocLinkRows），
//     readReconIdFixFile / runReconIdFix / writeReconIdFixOutput / 仓储 facade / 种子均调真实实现。
//
// 用法：node scripts/integration/v3.0.4-boc-dispatch-order-fix.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const { readReconIdFixFile, writeReconIdFixOutput } = require('../../src/main-process/recon-id-fix-io');
const { runReconIdFix } = require('../../src/main-process/recon-id-fix-engine');
const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../src/constants/gateway-bill-recon-fields');

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label, actual: cond, expected: true });
}

// 按字段常量造一行对象 → 转 aoa 行（未填字段留空字符串；数字原样保留）。
function rowAoa(fields, data) {
  return fields.map((h) => {
    const v = data[h];
    if (v === undefined || v === null) return '';
    return v;
  });
}

// 造 4 sheet「资金对账导出不平」工作簿（严格列名 = 字段常量）。
function writeReconWorkbook(filePath, { gatewayRows, channelRows }) {
  const wb = XLSX.utils.book_new();
  // 对账结果 sheet：当前迭代不消费数据，只需表头存在（写 1 行表头即可通过校验）。
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([RECON_RESULT_FIELDS_GATEWAY.slice()]),
    RECON_RESULT_SHEET_NAME_GATEWAY
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([GATEWAY_BILL_FIELDS.slice(), ...gatewayRows.map((r) => rowAoa(GATEWAY_BILL_FIELDS, r))]),
    GATEWAY_BILL_SHEET_NAME
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([CHANNEL_BILL_FIELDS.slice(), ...channelRows.map((r) => rowAoa(CHANNEL_BILL_FIELDS, r))]),
    CHANNEL_BILL_SHEET_NAME
  );
  // 订单修复 sheet：仅校验表头（reader 取 headers，rows 丢弃）。
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([ORDER_REPAIR_FIELDS_GATEWAY.slice()]),
    ORDER_REPAIR_SHEET_NAME_GATEWAY
  );
  XLSX.writeFile(wb, filePath);
}

// 造 BOC链接表业务行（raw_json 存全字段；replaceBocFxLink 从中取热列）。
//   仅填引擎/回写所需字段：交易编号 / 到期日 / 货币1金额 / 分组 / 调拨单号 / 资金对账不平表链接ID。
function linkRow({ txnNo, maturity, ccy1Amount, group, allocationNo, reconLinkId }) {
  return {
    交易编号: txnNo,
    到期日: maturity,
    货币1金额: ccy1Amount,
    货币2金额: ccy1Amount,
    分组: group,
    调拨单号: allocationNo,
    资金对账不平表链接ID: reconLinkId
  };
}

function findBocScenario(appDb) {
  // BOC 场景默认 enabled=0；listScenarios 返元数据，再 getScenario 取完整 config。
  const list = appDb.listScenarios();
  const meta = list.find((s) => s.category === 'gateway-recon-id-fix' && s.name === 'BOC调拨订单修复');
  if (!meta) return null;
  return appDb.getScenario(meta.id);
}

function run() {
  console.log('==== v3.0.4 块 E 需求3 BOC 调拨订单修复引擎集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v304-boc-fix-'));
  const dbPath = path.join(tmpDir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();

  try {
    // —— 步骤1：BOC 内置场景种子已随 init 写入（默认休眠）——
    const scenario = findBocScenario(appDb);
    assertTrue(!!scenario, '种子：BOC调拨订单修复场景已随 init 写入');
    assertEq(scenario && scenario.category, 'gateway-recon-id-fix', '种子：category=gateway-recon-id-fix');
    assertEq(scenario && scenario.config && scenario.config.subCategory, 'boc-dispatch-order-fix', '种子：config.subCategory=boc-dispatch-order-fix');
    assertEq(scenario && scenario.config && scenario.config.channelName, 'BOC', '种子：config.channelName=BOC');

    // —— 步骤2：经仓储写 BOC链接表 fixture ——
    //   组1（'1'）= 2 行，调拨单号 A001 一致，链接ID R1/R2，货币1金额 100/200 → 可全配产 2 行修复。
    //   组2（'2'）= 2 行，调拨单号 A002 一致，链接ID R3（非空，供渠道行命中触达本组）+ ''（空）→ 进组后
    //     step5 逐行 1v1 试配遇空链接ID → group-link-id-empty 整组失败（D2/D3：整组失败不产出、不消耗）。
    const fxFixture = [
      linkRow({ txnNo: '1001', maturity: '2026-06-10', ccy1Amount: 100, group: '1', allocationNo: 'A001', reconLinkId: 'R1' }),
      linkRow({ txnNo: '1002', maturity: '2026-06-10', ccy1Amount: 200, group: '1', allocationNo: 'A001', reconLinkId: 'R2' }),
      linkRow({ txnNo: '2001', maturity: '2026-06-11', ccy1Amount: 300, group: '2', allocationNo: 'A002', reconLinkId: 'R3' }),
      linkRow({ txnNo: '2002', maturity: '2026-06-11', ccy1Amount: 400, group: '2', allocationNo: 'A002', reconLinkId: '' })
    ];
    const fxRet = appDb.replaceBocFxLink(fxFixture);
    assertEq(fxRet.rowCount, 4, '仓储：BOC链接表写入 4 行');
    const bocLinkRows = appDb.readBocFxLinkRows();
    assertEq(bocLinkRows.length, 4, '仓储：readBocFxLinkRows 读回 4 行');

    // —— 步骤3：XLSX 现造 4 sheet 不平表 ——
    //   渠道账单：channelName=BOC 行 reconciliationId=R1/R2 各 1 行（组1 全配）+ R3 1 行（命中触达组2，
    //     使组2 进入组级处理后在 step5 因组内空链接ID 整组失败）。
    //   网关账单：OrderId=A001 唯一行（组1 命中网关）；组2 在 step5 先于网关查询失败，故 OrderId=A002 是否存在不影响。
    const channelRows = [
      { channelName: 'BOC', merchantId: 'M1', reconciliationId: 'R1', requestAmount: 100, receiveAmount: 100 },
      { channelName: 'BOC', merchantId: 'M1', reconciliationId: 'R2', requestAmount: 200, receiveAmount: 200 },
      { channelName: 'BOC', merchantId: 'M1', reconciliationId: 'R3', requestAmount: 300, receiveAmount: 300 },
      // 非 BOC 渠道行（D5 trim 精确等值，不参与；验证 channelBocTotal 过滤）。
      { channelName: 'OTHER', merchantId: 'M1', reconciliationId: 'RX', requestAmount: 1, receiveAmount: 1 }
    ];
    const gatewayRows = [
      {
        BillDate: '2026-06-10', Bank: 'BOC-BANK', MerchantId: 'M1', OrderId: 'A001',
        DataSource: 'DS1', OppBu: 'BU1', OriginBillSource: 'OBS1', BillType: 'BT1',
        Currency: 'USD', OriginBillBizId: 'OBZ1', ReconBillBizId: 'RBZ1',
        Amount: 999 // 源行 Amount，应被 override 成链接表「货币1金额」覆盖
      }
    ];
    const reconFile = path.join(tmpDir, '资金对账导出不平.xlsx');
    writeReconWorkbook(reconFile, { gatewayRows, channelRows });

    // —— 步骤4：readReconIdFixFile + runReconIdFix（注入 bocLinkRows，镜像 handler 的 isBocScenario 路径）——
    const parsed = readReconIdFixFile(reconFile, 'gateway');
    const result = runReconIdFix(scenario, parsed.sheets, { bocLinkRows });

    // —— 步骤5：断言 fixedRows / stats / warnings ——
    const fixedRows = Array.isArray(result.fixedRows) ? result.fixedRows : [];
    assertEq(fixedRows.length, 2, '引擎：组1 全配 → 产出 2 行修复（N=组行数）');

    const st = result.stats || {};
    assertEq(st.channelBocTotal, 3, 'stats.channelBocTotal=3（OTHER 渠道行被排除）');
    assertEq(st.linkGroupTotal, 2, 'stats.linkGroupTotal=2（组1+组2）');
    assertEq(st.groupMatched, 1, 'stats.groupMatched=1（组1）');
    assertEq(st.groupFailed, 1, 'stats.groupFailed=1（组2 链接ID 空）');
    assertEq(st.fixedRowCount, 2, 'stats.fixedRowCount=2');

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const emptyLinkWarn = warnings.find((w) => w && w.code === 'group-link-id-empty');
    assertTrue(!!emptyLinkWarn, 'warnings 含 group-link-id-empty（组2 整组失败）');
    assertTrue(!!(emptyLinkWarn && emptyLinkWarn.message), 'warning 带中文 message（前端直显）');

    // Type/Reference/Amount 行级注入断言（引擎产物，写盘前）。
    const sortedByRef = [...fixedRows].sort((a, b) => String(a.Reference).localeCompare(String(b.Reference)));
    assertEq(sortedByRef[0].Type, 2, '修复行 Type=2（number）');
    assertEq(sortedByRef[0].Reference, 'R1', '修复行 Reference=链接ID R1');
    assertEq(sortedByRef[0].Amount, 100, '修复行 Amount=货币1金额 100（原值透传，覆盖源行 999）');
    assertEq(sortedByRef[1].Reference, 'R2', '修复行 Reference=链接ID R2');
    assertEq(sortedByRef[1].Amount, 200, '修复行 Amount=货币1金额 200');
    // 其余 11 列从网关源行同名复制。
    assertEq(sortedByRef[0].OrderId, 'A001', '修复行 OrderId 从网关源行复制');
    assertEq(sortedByRef[0].MerchantId, 'M1', '修复行 MerchantId 从网关源行复制');
    assertEq(sortedByRef[0].Bank, 'BOC-BANK', '修复行 Bank 从网关源行复制');

    // —— 步骤6：writeReconIdFixOutput 写临时 xlsx → 读回断言 14 列表头 + Type=2 + Reference/Amount 行级值 ——
    const outPath = path.join(tmpDir, '网关对账修复-BOC.xlsx');
    return writeReconIdFixOutput({ fixedRows, savePath: outPath, subMode: 'gateway' }).then(() => {
      assertTrue(fs.existsSync(outPath), '写盘：输出文件存在');
      const wb = XLSX.readFile(outPath);
      const ws = wb.Sheets[ORDER_REPAIR_SHEET_NAME_GATEWAY];
      assertTrue(!!ws, `写盘：含「${ORDER_REPAIR_SHEET_NAME_GATEWAY}」sheet`);
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      // 表头 14 列 byte-for-byte。
      assertEq(aoa[0], ORDER_REPAIR_FIELDS_GATEWAY.slice(), '写盘：14 列表头一致');
      // 数据 2 行；列下标定位 Type/Reference/Amount。
      assertEq(aoa.length, 3, '写盘：表头 + 2 数据行');
      const typeIdx = ORDER_REPAIR_FIELDS_GATEWAY.indexOf('Type');
      const refIdx = ORDER_REPAIR_FIELDS_GATEWAY.indexOf('Reference');
      const amtIdx = ORDER_REPAIR_FIELDS_GATEWAY.indexOf('Amount');
      const dataRows = aoa.slice(1).sort((a, b) => String(a[refIdx]).localeCompare(String(b[refIdx])));
      assertEq(dataRows[0][typeIdx], 2, '写盘：Type 单元格=2（数值格）');
      assertEq(dataRows[0][refIdx], 'R1', '写盘：Reference=R1 行级值');
      assertEq(dataRows[0][amtIdx], 100, '写盘：Amount=100 行级值');
      assertEq(dataRows[1][refIdx], 'R2', '写盘：Reference=R2 行级值');
      assertEq(dataRows[1][amtIdx], 200, '写盘：Amount=200 行级值');

      finish(appDb, tmpDir);
    });
  } catch (err) {
    failed += 1;
    failures.push({ label: '运行抛错', actual: String(err && err.stack ? err.stack : err), expected: '无异常' });
    finish(appDb, tmpDir);
    return Promise.resolve();
  }
}

function finish(appDb, tmpDir) {
  try { if (appDb && appDb.db) appDb.db.close(); } catch (_e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  console.log(`\n断言：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）`);
  if (failed > 0) {
    console.error('\n失败明细：');
    for (const f of failures) {
      console.error(`  ✗ ${f.label}\n    actual=${JSON.stringify(f.actual)}\n    expected=${JSON.stringify(f.expected)}`);
    }
    // integration-runner 抓「N/N PASS」做计数；失败时输出实际通过/总数。
    console.log(`${passed}/${passed + failed} PASS`);
    process.exitCode = 1;
  } else {
    console.log(`${passed}/${passed} PASS`);
    console.log('✓ 全部断言通过');
  }
}

run();
