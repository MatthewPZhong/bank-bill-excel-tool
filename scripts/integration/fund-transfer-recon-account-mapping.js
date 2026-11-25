// v3.0.12 功能2（批B）集成测试：账户映射回流派生 → R5s2-recon 端到端（🔴 资金红线）。
//
// 验证「映射回流」这条跨文件接缝：账户映射（中台调拨账户号 → 清结算银行账号）在调拨对账单派生时
//   套用到 big_account，使原本与银行 MerchantId 对不上的调拨行，经映射后能在 R5s2-recon 命中并回填 ReconciliationId。
//
// 串起的真实代码（端到端，无 mock）：
//   1. 临时 DB → AppDatabase().init()（自动建 fund_transfer_account_mappings + linked_fund_transfer_recon 表）。
//   2. saveFundTransferAccountMappings 写映射（批A facade）。
//   3. replaceLinkedTable('mid-allocation', …) 落中台调拨订单。
//   4. rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows })
//        —— 🔴 这是 buildFundTransferReconRows 的【唯一】生产调用处；run 入口（main.js:3830）与
//           导入入口（main.js:11861）两条派生链都经它，内部从 database.getFundTransferAccountMappingMap() 取 map 注入。
//           直调本漏斗 = 镜像两条链的同款行为（run handler / import handler 均 IPC 绑定，无法在脚本里直接触发）。
//   5. readFundTransferReconRows() 读回派生表 → runRound5FundTransferReconBackfill(reconRows, bankRows)（真实 R5s2-recon 引擎）。
//   6. 断言：无映射 → big_account=原始账号 → 不命中（ReconciliationId 不回填）；
//           有映射 → big_account=清结算账号 → 命中（ReconciliationId 回填为调拨 ReconID）。in/out 两方向都覆盖。
//
// v3.2.22 追加（Case D-F）：网关来源（场景取消勾选「对账数据来源为中台调拨单表」，reconSourceMid:false）共用同一张映射表。
//   真实链路：saveFundTransferAccountMappings → 网关账单 upsert 落 linked_gateway_bill → readGatewayBillRowPoolsByChannels
//   → runReconciliation（fundTransferAccountMappingMap 取自 getFundTransferAccountMappingMap，与 bank-statement:run 注入一致）
//   → R5s2 网关引擎 merchantid 先映射再匹配；断言无映射不命中、有映射两方向回填、清空映射复原，且调拨来源 big_account 与 Case B 同口径。
//   Case G：混合渠道批次，映射命中的网关行只回填同 Channel 银行行。
//   Case H：本批银行行都有 Channel 时，渠道为空的映射网关行不进可写池；R5s2 另读诊断行，只告警缺渠道、不回填。
//   Case I：本批有空渠道银行行时，银行侧未出现的渠道（CITI）的映射网关行在池外；与空渠道银行行相符时告警银行渠道为空、不回填。
//   Case J：在 Electron 自带运行时（node:sqlite 读 TEXT 遇 NUL 会截断）保存含 NUL 的映射目标账号，读回无损，网关对账ID
//           只回填到完整账号的银行行，不串到截断前缀账号；经生产导出入口写出主文件后回读，含 NUL 的账号与 `AB` 仍可区分。
//   release/v3.2.22 合入 fix/statement-xlsx-io-boundary（B113 D4b）后，单工作表流式导入按 SheetJS 同一口径还原 `_xHHHH_`，
//   空字符与无法确认原值的转义整批拒绝；K–O 按这一口径验证，「旧记录」指 v3.2.22 之前按转义原文落库的数据（直接写库模拟）。
//   Case K：含 NUL 的账号（Excel 写法 `A_x0000_B`）经生产流式导入入口整批拒绝、不落库；字面 `A_x0000_B`（Excel 写法
//           `A_x005F_x0000_B`）按字面落库，映射非空时含 `_xHHHH_` 写法的账号无法确定真实账户号（可能是旧记录的转义原文），
//           转义护栏不回填，逐条告警人工核对（告警里的转义片段按 ⟨U+HHHH⟩ 显示）。
//   Case L：富文本账号的转义由相邻片段拼成（`MID_x00` + `41__x0042_`）→ 流式导入整批拒绝；旧记录的拼接串
//           `MID_x0041__x0042_` 映射时原样映射与整串解码碰巧一致，也不回填，告警人工核对。
//   Case M：源表字面对账ID `RID_x0041_` 经流式导入按字面落库，空映射下 R5s2 回填后经生产导出入口
//           writeBankStatementMainOutput 写出，ExcelJS 与 SheetJS 读回源表字面值；旧记录的转义原文读回显示为转义写法。
//   Case N：网关渠道 `BANK\rUS` 经流式导入还原为回车，映射命中的网关行只回填渠道相同的银行行（字面 `BANK_x000D_US` 是另一渠道）；
//           旧记录渠道为 `BANK_x000D_US` 时无法确认真实渠道，回车版与字面版银行行都不回填，告警人工核对（不任选一行）。
//   Case N2：银行批次只有 `CITI\rHK`，旧记录网关渠道为 `CITI_x000D_HK`、按渠道读池时在池外；账号、币种、金额相符时经真实
//           读池暂存与按 id 回读的池外诊断告警渠道转义（不回填）。
//   Case O：同一格既有 XML 字符引用（`&#13;`）又有 Excel 写法的字面 `_x0041_`（`_x005F_x0041_`）的网关对账ID，流式导入
//           落库为 `RID\rX_x0041_`；回填后经生产导出入口写出，ExcelJS 与 SheetJS 读回源对账ID。
//   Case P：网关账号按数值存放（`<v>9007199254740993</v>`）经流式导入落库为舍入值，按数值对得上映射键时不回填、告警。
//   Case Q：银行对账单 MerchantId 按数值存放（`<v>9007199254740993</v>`）经生产读取入口读成舍入后的数值，按数值与映射
//     目标账号相同时该银行行不参与网关调拨回填、告警；同批文本单元格的同形账号照常回填。
//   Case R：银行对账单里的字面 `ID_x0041_`（Excel 存为 `ID_x005F_x0041_`）经生产读取入口读成字面值，C1 复制进对账ID、
//     C3 自定义值写入字面 `NOTE_x0041_`、C3 按网关字段写入链接表落库值 `RAW_x0041_`（v3.2.22 起各导入路径落库已解码文本）；
//     经生产导出后三者都读回字面值（一律按已解码文本编码）。
//
// 用法：node scripts/integration/fund-transfer-recon-account-mapping.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { AppDatabase } = require('../../src/backend/database');
const { buildFundTransferReconRows } = require('../../src/main-process/fund-transfer-recon-builder');
const { rebuildFundTransferReconDerivation } = require('../../src/main-process/linked-derive-rebuild');
const {
  runRound5FundTransferReconBackfill
} = require('../../src/main-process/scenario-engines/r5-fund-transfer-recon-backfill');
const { runReconciliation } = require('../../src/main-process/reconciliation-orchestrator');
const {
  buildR5ChannelMissingDiagnosticPrefilter,
  createR5ChannelMissingDiagnosticSource
} = require('../../src/main-process/scenario-engines/r5-fund-transfer-backfill');
const ExcelJS = require('exceljs');
const { LINKED_IMPORT_SIGNATURES } = require('../../src/constants/table-signatures');
const { streamLinkedRowsToInsert } = require('../../src/main-process/linked-table-stream-source');
// 夹具按 Excel 的写法编码单元格文本（控制字符写成 `_xHHHH_`，字面 `_xHHHH_` 前加 `_x005F_`）。
const { encodeExcelStXstring } = require('../../src/backend/xlsx/excel-text');
const { readBankStatement, writeBankStatementMainOutput } = require('../../src/main-process/bank-statement-io');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const {
  FT_RECON_FIELD_MAP,
  MID_ALLOCATION_SUCCESS_STATUS
} = require('../../src/constants/fund-transfer-recon-fields');

const M = FT_RECON_FIELD_MAP.mid;
const R = FT_RECON_FIELD_MAP.recon;

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

// 一行中台调拨订单：收款账户 = MID-RECV-001（in big_account 源）、付款账户 = MID-PAY-002（out big_account 源）。
//   原始账号刻意与银行 MerchantId（CLR-*）对不上 → 必须经映射回流才能命中。
function midRow() {
  return {
    [M.allocationNo]: 'ALLOC-1',
    [M.status]: MID_ALLOCATION_SUCCESS_STATUS,
    [M.txTime]: '2026-05-04', // → BillDate（与银行同日 → R5s2-recon Phase1 命中）
    [M.channelSerial]: 'RECON-1', // → ReconID（in/out 共用，回填来源）
    [M.payCard]: 'MID-PAY-002', // out big_account 源（原始付款账号）
    [M.payeeCard]: 'MID-RECV-001', // in big_account 源（原始收款账号）
    [M.receiveChannel]: 'DBS',
    [M.receiveAmount]: '2100000',
    [M.receiveCurrency]: 'USD',
    [M.payChannel]: 'CITI',
    [M.payAmount]: '900000',
    [M.payCurrency]: 'HKD'
  };
}

// 银行对账单两行：MerchantId 用「清结算账号」（CLR-*），仅当 big_account 被映射成 CLR-* 才会命中。
//   每个 case 用一份全新副本（R5s2-recon 引擎会原地改写 ReconciliationId）。
function freshBankRows() {
  return [
    {
      _rowId: 'BIN',
      FundType: 'FundTransfer-in',
      MerchantId: 'CLR-RECV-999', // 清结算账号（in）
      Currency: 'USD',
      'Credit Amount': 2100000,
      'Debit Amount': 0, // bankAmountAbs = 2100000
      BillDate: '2026-05-04', // 同日 → Phase1
      ReconciliationId: ''
    },
    {
      _rowId: 'BOUT',
      FundType: 'FundTransfer-out',
      MerchantId: 'CLR-PAY-888', // 清结算账号（out）
      Currency: 'HKD',
      'Credit Amount': 0,
      'Debit Amount': 900000, // bankAmountAbs = 900000
      BillDate: '2026-05-04',
      ReconciliationId: ''
    }
  ];
}

// 走生产唯一漏斗 rebuildFundTransferReconDerivation：内部取 getFundTransferAccountMappingMap 注入 builder。
function deriveReconRows(appDb) {
  const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
    database: appDb,
    buildFundTransferReconRows
  });
  return { derive: fundTransferReconDerive, reconRows: appDb.readFundTransferReconRows() };
}

// v3.2.22：网关账单两行（真实小写表头）；merchantid 用网关账户号（与中台调拨单原始账号同一份映射键）。
function gatewayRows() {
  return [
    {
      Channel: 'JPM', TradeType: 'FundTransfer-in', merchantid: 'MID-RECV-001', currency: 'USD',
      amount: '2100000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-IN', ReconBillBizId: 'GB-IN', orderid: 'GW-1'
    },
    {
      Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'MID-PAY-002', currency: 'HKD',
      amount: '-900000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-OUT', ReconBillBizId: 'GB-OUT', orderid: 'GW-2'
    }
  ];
}

// R5s2 场景：取消勾选 → 网关来源。
function gatewaySourceScenario() {
  return {
    id: 9001,
    name: '中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      roundPhase: 5,
      directions: [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
        { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
      ],
      dateToleranceDays: 1,
      reconSourceMid: false
    }
  };
}

// 镜像 bank-statement:run：映射从 facade 实时取，再按银行 Channel 读网关池；网关来源在同一次扫描暂存池外诊断候选
//   （读池的补集，只存 id 与键摘要），R5 运行时按 id 回读摘要对得上的候选再裁决。
async function runGatewaySource(appDb, channelOf = () => 'JPM', bankRowsOverride = null) {
  const bankRows = bankRowsOverride || freshBankRows().map((row) => ({ ...row, Channel: channelOf(row) }));
  const bankChannels = bankRows.map((row) => row.Channel);
  const accountMappingMap = appDb.getFundTransferAccountMappingMap();
  const prefilter = buildR5ChannelMissingDiagnosticPrefilter(accountMappingMap);
  const pools = appDb.readGatewayBillRowPoolsByChannels(bankChannels, prefilter ? { outOfPoolDiagnostic: prefilter } : undefined);
  const gwRows = pools.exactRows;
  const diagnosticSource = prefilter
    ? createR5ChannelMissingDiagnosticSource({
      accountMappingMap,
      bankChannels,
      prefilter,
      readRowsByIds: (ids, onRow) => appDb.readGatewayBillRowsByIds(ids, onRow)
    })
    : null;
  let diagnosticRows = [];
  const result = await runReconciliation({
    bankRows,
    gwRows,
    scenarios: [gatewaySourceScenario()],
    fundTransferAccountMappingMap: accountMappingMap,
    fundTransferChannelMissingDiagnosticSource: diagnosticSource
      ? (context) => {
        diagnosticRows = diagnosticSource(context);
        return diagnosticRows;
      }
      : null
  });
  return { result, bankRows, gwRows, diagnosticRows };
}

// Case J 子进程：Electron 以 Node 模式运行，使用生产同一 node:sqlite。
function runMappingNulCaseInElectron(dbPath, mainFilePath) {
  const root = path.resolve(__dirname, '..', '..');
  const code = `
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const { AppDatabase } = require(path.join(root, 'src/backend/database'));
    const { runReconciliation } = require(path.join(root, 'src/main-process/reconciliation-orchestrator'));
    const { writeBankStatementMainOutput } = require(path.join(root, 'src/main-process/bank-statement-io'));
    const ExcelJS = require(path.join(root, 'node_modules/exceljs'));
    (async () => {
      const appDb = new AppDatabase(${JSON.stringify(dbPath)});
      appDb.init();
      try {
        appDb.saveFundTransferAccountMappings([{ midAccountId: 'ALIAS', clearingAccountId: 'A\\u0000B' }]);
        const list = appDb.listFundTransferAccountMappings();
        const map = appDb.getFundTransferAccountMappingMap();
        const bank = (rowId, merchantId) => ({
          _rowId: rowId, Channel: 'JPM', FundType: 'FundTransfer-out', MerchantId: merchantId, Currency: 'USD',
          'Credit Amount': 0, 'Debit Amount': 100, BillDate: '2026-05-04', ReconciliationId: ''
        });
        const bankRows = [bank('BA', 'A'), bank('BPLAIN', 'AB'), bank('BAB', 'A\\u0000B')];
        const gwRows = [{ Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'ALIAS', currency: 'USD', amount: '-100',
          Billdate: '2026-05-04', reconciliationid: 'GW-NUL', ReconBillBizId: 'GB-NUL' }];
        const result = await runReconciliation({
          bankRows, gwRows, fundTransferAccountMappingMap: map,
          scenarios: [{ id: 9101, name: '中台调拨订单对账ID回填', category: 'builtin-fixed', priority: 0, enabled: true,
            config: { funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill', roundPhase: 5,
              directions: [{ gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
                { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }],
              dateToleranceDays: 1, reconSourceMid: false } }]
        });
        await writeBankStatementMainOutput({
          modifiedRows: result.modifiedRows, unmatchedRows: result.unmatchedRows, modifications: result.modifications,
          headers: ['MerchantId', 'ReconciliationId'], mainFilePath: ${JSON.stringify(mainFilePath)}
        });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(${JSON.stringify(mainFilePath)});
        const hitSheet = workbook.getWorksheet('命中场景');
        const unmatchedSheet = workbook.worksheets.find((sheet) => sheet.name !== '命中场景');
        const exportedHit = [];
        hitSheet.eachRow((row, rowNumber) => { if (rowNumber > 1) exportedHit.push([row.getCell(3).value, row.getCell(4).value]); });
        const exportedUnmatched = [];
        unmatchedSheet.eachRow((row, rowNumber) => { if (rowNumber > 1) exportedUnmatched.push(row.getCell(2).value); });
        console.log(JSON.stringify({
          exportedHit, exportedUnmatched,
          electron: process.versions.electron,
          list: list.map((r) => [r.midAccountId, r.clearingAccountId]),
          map: Array.from(map.entries()),
          recon: bankRows.map((r) => [r._rowId, r.ReconciliationId])
        }));
      } finally {
        if (appDb.db) appDb.db.close();
      }
    })().catch((error) => { console.log(JSON.stringify({ error: String(error && error.stack || error) })); });
  `;
  const output = execFileSync(require('electron'), ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

function bigAccountOf(reconRows, fundType) {
  const row = reconRows.find((r) => r[R.fundType] === fundType);
  return row ? row[R.bigAccount] : undefined;
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-acct-map-'));
  let appDb;
  try {
    appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
    appDb.init();
    appDb.replaceLinkedTable('mid-allocation', [midRow()]);

    // ===== Case A：无映射 → big_account=原始账号 → R5s2-recon 不命中 =====
    {
      appDb.saveFundTransferAccountMappings([]); // 确保映射表空
      const { derive, reconRows } = deriveReconRows(appDb);
      assertTrue(derive && derive.created === true, 'A: 派生成功（created:true）');
      assertEq(reconRows.length, 2, 'A: 一行 mid → in/out 两行调拨对账单');
      // 🔴 接缝定位：无映射时 big_account = 原始账号（passthrough）。
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'MID-RECV-001', 'A: in big_account=原始收款账号（未映射）');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'MID-PAY-002', 'A: out big_account=原始付款账号（未映射）');

      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 0, '🔴 A: 无映射 → big_account 对不上银行 MerchantId → 0 回填');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, '', 'A: 银行 in 行 ReconciliationId 仍空');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, '', 'A: 银行 out 行 ReconciliationId 仍空');
    }

    // ===== Case B：配映射 → big_account=清结算账号 → R5s2-recon 命中回填 =====
    {
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { derive, reconRows } = deriveReconRows(appDb);
      assertTrue(derive && derive.created === true, 'B: 派生成功（created:true）');
      // 🔴 接缝定位：有映射时 big_account 被替换成清结算账号。
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'CLR-RECV-999', '🔴 B: in big_account 映射回流为清结算账号');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'CLR-PAY-888', '🔴 B: out big_account 映射回流为清结算账号');
      // 🔴 展示字段不被翻译（付款账号 / 收款账号保持原值）。
      assertEq(reconRows[0][R.payeeAccount], 'MID-RECV-001', 'B: 收款账号（展示字段）保持原值');
      assertEq(reconRows[0][R.payAccount], 'MID-PAY-002', 'B: 付款账号（展示字段）保持原值');

      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 2, '🔴 B: 有映射 → in/out 两行均命中 → 2 行 ReconciliationId 回填');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, 'RECON-1', '🔴 B: 银行 in 行回填调拨 ReconID');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'RECON-1', '🔴 B: 银行 out 行回填调拨 ReconID');
      assertTrue(modifications.every((mod) => mod.column === 'ReconciliationId'), 'B: 改写列均为 ReconciliationId');
    }

    // ===== Case C：映射改回空 → 回到 passthrough（可逆，映射表空＝字节级零变化）=====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { reconRows } = deriveReconRows(appDb);
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'MID-RECV-001', 'C: 清空映射后 in big_account 回到原始账号');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'MID-PAY-002', 'C: 清空映射后 out big_account 回到原始账号');
      const bankRows = freshBankRows();
      const { modifications } = runRound5FundTransferReconBackfill(reconRows, bankRows);
      assertEq(modifications.length, 0, '🔴 C: 清空映射 → 不再命中（映射表空＝零变化）');
    }

    // ===== v3.2.22 网关来源：同一张映射表作用于网关 merchantid =====
    appDb.upsertLinkedGatewayBill(gatewayRows(), { sourceFileName: 'gateway.xlsx', legacySource: true });

    // ===== Case D：无映射 → 网关账户号对不上银行 MerchantId → 不回填 =====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { result, bankRows, gwRows } = await runGatewaySource(appDb);
      assertEq(gwRows.length, 2, 'D: 网关账单经链接表按 Channel 读回 2 行');
      assertEq(result.stats.r5s2BackfilledCount, 0, '🔴 D: 无映射 → 网关来源 0 回填');
      assertEq(bankRows.map((b) => b.ReconciliationId), ['', ''], 'D: 银行行 ReconciliationId 仍空');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'D: 行数守恒');
    }

    // ===== Case E：配映射 → 网关 merchantid 换成清结算账号 → in/out 两方向回填网关 reconciliationid =====
    {
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { result, bankRows, gwRows } = await runGatewaySource(appDb);
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, 'GW-RECON-IN', '🔴 E: 银行 in 行回填网关 reconciliationid');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'GW-RECON-OUT', '🔴 E: 银行 out 行回填网关 reconciliationid');
      const rounds = result.modifications.filter((m) => m.column === 'ReconciliationId').map((m) => m._round);
      assertEq(rounds, ['R5s2', 'R5s2'], 'E: 两条改写均来自 R5s2 网关来源');
      assertEq(gwRows.map((g) => g.merchantid), ['MID-RECV-001', 'MID-PAY-002'], 'E: 网关行 merchantid 不被改写');
      assertEq(result.manyToManyReviewRows.length, 0, 'E: 1:1 命中，不产生多对多异常说明');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'E: 行数守恒');

      // 同一份映射下调拨来源口径一致（共用一张表）：派生 big_account 同样是清结算账号。
      const { reconRows } = deriveReconRows(appDb);
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_IN), 'CLR-RECV-999', 'E: 调拨来源 in big_account 同表映射');
      assertEq(bigAccountOf(reconRows, FT_RECON_FIELD_MAP.FUND_TYPE_OUT), 'CLR-PAY-888', 'E: 调拨来源 out big_account 同表映射');
    }

    // ===== Case F：清空映射 → 网关来源回到未映射口径 =====
    {
      appDb.saveFundTransferAccountMappings([]);
      const { result, bankRows } = await runGatewaySource(appDb);
      assertEq(result.stats.r5s2BackfilledCount, 0, '🔴 F: 清空映射 → 网关来源不再回填（映射表空＝零变化）');
      assertEq(bankRows.map((b) => b.ReconciliationId), ['', ''], 'F: 银行行 ReconciliationId 仍空');
    }

    // ===== Case G：混合渠道批次 → 映射命中的 JPM 网关行不回填到 DBS 银行行（对账永远同 Channel）=====
    {
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { result, bankRows, gwRows } = await runGatewaySource(appDb, (row) => (row._rowId === 'BIN' ? 'DBS' : 'JPM'));
      assertEq(gwRows.length, 2, 'G: 按本批渠道并集读回 JPM 网关行');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, '', '🔴 G: DBS 银行 in 行不被 JPM 网关映射行回填');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'GW-RECON-OUT', 'G: 同渠道 JPM 银行 out 行照常回填');
      assertEq(result.stats.r5s2BackfilledCount, 1, 'G: 只回填同渠道一行');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'G: 行数守恒');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case H：渠道为空的映射网关行在池外 → 不回填，R5s2 只读诊断告警缺渠道 =====
    {
      appDb.upsertLinkedGatewayBill([
        {
          Channel: '', TradeType: 'FundTransfer-out', merchantid: 'MID-PAY-002', currency: 'HKD',
          amount: '-900000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-OUT-BLANK', ReconBillBizId: 'GB-OUT-BLANK', orderid: 'GW-3'
        },
        {
          Channel: '', TradeType: 'FundTransfer-out', merchantid: 'MID-PAY-002', currency: 'HKD',
          amount: '-1', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-OUT-NOAMT', ReconBillBizId: 'GB-OUT-NOAMT', orderid: 'GW-4'
        }
      ], { sourceFileName: 'gateway-blank.xlsx', legacySource: true });
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' }]);
      const missingOf = (result) => result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-missing');

      // 只映射 in 方向账号：out 方向的空渠道行原账号既不是映射键也不是映射值 → 不读、不告警（零变化）。
      const unmapped = await runGatewaySource(appDb);
      assertEq(unmapped.diagnosticRows.length, 0, 'H: 空渠道行账号不在映射表 → 不读诊断行');
      assertEq(missingOf(unmapped.result).length, 0, 'H: 不在映射表 → 无缺渠道告警');

      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { result, bankRows, gwRows, diagnosticRows } = await runGatewaySource(appDb);
      assertEq(gwRows.map((g) => g.reconciliationid), ['GW-RECON-IN', 'GW-RECON-OUT'], '🔴 H: 空渠道网关行不进按渠道读的可写池');
      assertEq(diagnosticRows.map((g) => g.reconciliationid), ['GW-RECON-OUT-BLANK'], 'H: 真实仓储读回池外空渠道诊断行；金额对不上任何银行行的不保留');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'GW-RECON-OUT', '🔴 H: out 行只由同渠道网关行回填');
      assertEq(result.stats.r5s2BackfilledCount, 2, 'H: 回填数与 Case E 相同（诊断行不参与匹配）');
      const missing = missingOf(result);
      assertEq(missing.map((w) => w.rowId), ['BOUT'], 'H: 空渠道映射网关行告警一次，指向账号币种金额相符的银行行');
      assertEq(/GB-OUT-BLANK（对账ID GW-RECON-OUT-BLANK）.*网关渠道为空/.test(missing[0] && missing[0].message), true, 'H: 告警写明网关业务键与对账ID');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'H: 行数守恒');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case I：银行 in 行渠道为空，池外 CITI 映射网关行 → 不回填，告警银行渠道为空 =====
    {
      appDb.upsertLinkedGatewayBill([
        {
          Channel: 'CITI', TradeType: 'FundTransfer-in', merchantid: 'MID-RECV-001', currency: 'USD',
          amount: '2100000', Billdate: '2026-05-04', reconciliationid: 'GW-RECON-IN-CITI', ReconBillBizId: 'GB-IN-CITI', orderid: 'GW-5'
        }
      ], { sourceFileName: 'gateway-citi.xlsx', legacySource: true });
      appDb.saveFundTransferAccountMappings([
        { midAccountId: 'MID-RECV-001', clearingAccountId: 'CLR-RECV-999' },
        { midAccountId: 'MID-PAY-002', clearingAccountId: 'CLR-PAY-888' }
      ]);
      const { result, bankRows, gwRows, diagnosticRows } = await runGatewaySource(appDb, (row) => (row._rowId === 'BIN' ? '' : 'JPM'));
      assertEq(gwRows.some((g) => g.reconciliationid === 'GW-RECON-IN-CITI'), false, '🔴 I: 银行侧未出现的渠道不进可写池');
      assertEq(diagnosticRows.map((g) => g.reconciliationid), ['GW-RECON-IN-CITI'], 'I: 真实仓储读回池外有渠道的映射行（池内行不重复读）');
      assertEq(bankRows.find((b) => b._rowId === 'BIN').ReconciliationId, '', '🔴 I: 空渠道银行 in 行不被任何映射网关行回填');
      assertEq(bankRows.find((b) => b._rowId === 'BOUT').ReconciliationId, 'GW-RECON-OUT', 'I: 同渠道 out 行照常回填');
      const citi = result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-missing' && /GW-RECON-IN-CITI/.test(w.message));
      assertEq(citi.map((w) => w.rowId), ['BIN'], 'I: 池外 CITI 行告警一次，指向空渠道银行行');
      assertEq(/GB-IN-CITI（对账ID GW-RECON-IN-CITI）.*银行渠道为空/.test(citi[0] && citi[0].message), true, 'I: 告警写明银行渠道为空');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 2, 'I: 行数守恒');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case J：Electron 运行时含 NUL 的映射目标账号读回无损，回填不串到截断前缀账号 =====
    {
      const electronResult = runMappingNulCaseInElectron(
        path.join(tmpDir, 'electron-nul.sqlite'), path.join(tmpDir, 'electron-nul-output.xlsx')
      );
      assertEq(electronResult.error, undefined, 'J: Electron 子进程无异常');
      assertTrue(typeof electronResult.electron === 'string' && electronResult.electron.length > 0, 'J: 在 Electron 自带运行时执行');
      assertEq(electronResult.list, [['ALIAS', 'A\u0000B']], '🔴 J: 列表读回完整账号（不截断 NUL 之后部分）');
      assertEq(electronResult.map, [['ALIAS', 'A\u0000B']], '🔴 J: 映射 Map 读回完整账号');
      assertEq(electronResult.recon, [['BA', ''], ['BPLAIN', ''], ['BAB', 'GW-NUL']], '🔴 J: 网关对账ID 只回填到完整账号银行行');
      assertEq(electronResult.exportedHit, [['A\u0000B', 'GW-NUL']], '🔴 J: 导出文件回读，命中行仍是含 NUL 的完整账号');
      assertEq(electronResult.exportedUnmatched.slice().sort(), ['A', 'AB'], '🔴 J: 导出文件回读，未命中账号 A、AB 不被混同');
    }

    // ===== Case K：含 NUL 的账号经流式导入整批拒绝；字面 `A_x0000_B` 按字面落库，映射非空时转义护栏不回填、告警 =====
    {
      const signature = LINKED_IMPORT_SIGNATURES.find((sig) => sig.tableKey === 'gateway-recon');
      const headers = signature.expectedHeaders;
      const writeGatewayWorkbook = async (fileName, specs) => {
        const file = path.join(tmpDir, fileName);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet1');
        sheet.addRow(headers);
        for (const [merchantid, reconId, bizId] of specs) {
          sheet.addRow(headers.map((header) => encodeExcelStXstring(({
            Billdate: '2026-05-04', Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid, currency: 'USD',
            amount: '-777', reconciliationid: reconId, ReconBillBizId: bizId, orderid: `O-${bizId}`
          })[header] ?? '')));
        }
        await workbook.xlsx.writeFile(file);
        return file;
      };
      const importFile = (file) => appDb.upsertLinkedGatewayBillStreaming(async (writeOne) => {
        const { matched } = await streamLinkedRowsToInsert(file, signature, writeOne, (row) => row, { keyField: 'ReconBillBizId' });
        assertTrue(matched, `K: ${path.basename(file)} 流内定位到网关表头`);
      }, { sourceFileName: path.basename(file), legacySource: true });
      const kRows = () => appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => /^GW-K-/.test(g.reconciliationid));

      // 有效行在前（读到含 NUL 的行之前已交给写入），含 NUL 的行在后：整批拒绝时已写入的有效行随事务回滚。
      const nulFile = await writeGatewayWorkbook('gateway-ooxml-nul.xlsx', [
        ['K-OK', 'GW-K-OK', 'GB-K-OK'], ['A\u0000B', 'GW-K-NUL', 'GB-K-NUL']
      ]);
      let nulError = null;
      try { await importFile(nulFile); } catch (error) { nulError = error; }
      assertTrue(!!nulError && /第 3 行「merchantid」列的文本含空字符（U\+0000）/.test(nulError.message),
        '🔴 K: 含 NUL 的账号整批拒绝，报行号与列名');
      assertEq(kRows().length, 0, '🔴 K: 拒绝后同批已写入的有效行也回滚、不落库');

      await importFile(await writeGatewayWorkbook('gateway-ooxml-literal.xlsx', [['A_x0000_B', 'GW-K-LIT', 'GB-K-LIT']]));
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'A_x0000_B', clearingAccountId: 'CLR-K-LIT' }]);
      const bankRows = [
        { _rowId: 'BK-LIT', Channel: 'JPM', FundType: 'FundTransfer-out', MerchantId: 'CLR-K-LIT', Currency: 'USD',
          'Credit Amount': 0, 'Debit Amount': 777, BillDate: '2026-05-04', ReconciliationId: '' }
      ];
      const gwRows = kRows();
      assertEq(gwRows.map((g) => [g.reconciliationid, g.merchantid]), [['GW-K-LIT', 'A_x0000_B']],
        'K: 字面 `A_x0000_B` 经流式导入按字面落库（B113 D4b）');
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows.map((b) => [b._rowId, b.ReconciliationId]), [['BK-LIT', '']],
        '🔴 K: 映射非空时含转义写法的账号无法确定真实账户号（可能是旧记录的转义原文），不回填');
      const ambiguous = result.errorReport.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous');
      assertEq(ambiguous.map((w) => w.reconId), ['GW-K-LIT'], '🔴 K: 告警一次，提示人工核对');
      assertTrue(ambiguous.every((w) => !w.message.includes('A_x0000_B')), 'K: 告警不写完整账户号');
      assertTrue(ambiguous.every((w) => !/_x[0-9A-Fa-f]{4}_/i.test(w.message) && /⟨U\+0000⟩/.test(w.message)),
        'K: 告警里的转义片段按 ⟨U+HHHH⟩ 显示，错误报告读回不被解码');
      appDb.saveFundTransferAccountMappings([]);
    }

    // 真实工作簿 → 生产流式导入入口落库（Case L / M / N / N2 / O / P 共用）。值为对象（富文本）或数值时原样写入；
    //   patchSharedStrings 改写共享字符串 XML（写入 ExcelJS 不会产生的字符引用），patchSheet 改写工作表 XML（如超出 JS 精度的 `<v>`）。
    const importGatewayWorkbook = async (fileName, rowsSpec, { patchSharedStrings, patchSheet } = {}) => {
      const signature = LINKED_IMPORT_SIGNATURES.find((sig) => sig.tableKey === 'gateway-recon');
      const headers = signature.expectedHeaders;
      const file = path.join(tmpDir, fileName);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.addRow(headers);
      for (const [index, spec] of rowsSpec.entries()) {
        // 业务键（幂等键）与订单号按文件名与行序生成，不含转义写法：与生产入口一样按 ReconBillBizId 校验（见下）。
        const businessKey = `${path.basename(fileName, '.xlsx')}-${index + 1}`;
        sheet.addRow(headers.map((header) => {
          const value = ({
            Billdate: '2026-05-04', TradeType: 'FundTransfer-out', currency: 'USD', orderid: `O-${businessKey}`,
            ReconBillBizId: `GB-${businessKey}`, ...spec
          })[header] ?? '';
          return (value && typeof value === 'object') || typeof value === 'number' ? value : encodeExcelStXstring(value);
        }));
      }
      await workbook.xlsx.writeFile(file);
      if (patchSharedStrings || patchSheet) {
        const zip = await JSZip.loadAsync(fs.readFileSync(file));
        if (patchSharedStrings) {
          const xml = await zip.file('xl/sharedStrings.xml').async('string');
          zip.file('xl/sharedStrings.xml', patchSharedStrings(xml));
        }
        if (patchSheet) {
          const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
          zip.file('xl/worksheets/sheet1.xml', patchSheet(xml));
        }
        fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
      }
      await appDb.upsertLinkedGatewayBillStreaming(async (writeOne) => {
        const { matched } = await streamLinkedRowsToInsert(file, signature, writeOne, (row) => row, { keyField: 'ReconBillBizId' });
        assertTrue(matched, `${fileName}: 流内定位到网关表头`);
      }, { sourceFileName: path.basename(file), legacySource: true });
    };
    const transferBank = (rowId, merchantId, channel, debit) => ({
      _rowId: rowId, Channel: channel, FundType: 'FundTransfer-out', MerchantId: merchantId, Currency: 'USD',
      'Credit Amount': 0, 'Debit Amount': debit, BillDate: '2026-05-04', ReconciliationId: ''
    });

    // ===== Case L：富文本账号的转义由相邻片段拼成 → 流式导入整批拒绝；旧记录的拼接串映射非空时不回填、告警 =====
    {
      let richError = null;
      try {
        await importGatewayWorkbook('gateway-rich-account.xlsx', [{
          reconciliationid: 'GW-L0', merchantid: { richText: [{ text: 'MID_x00' }, { text: '41__x0042_' }] }, amount: '-888', Channel: 'JPM'
        }]);
      } catch (error) {
        richError = error;
      }
      assertTrue(!!richError && /第 2 行「merchantid」列的文本含无法确认原值的 Excel 文本转义/.test(richError.message),
        '🔴 L: 跨富文本片段拼成的转义无法确认原值，整批拒绝');
      assertEq(appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => g.reconciliationid === 'GW-L0').length, 0,
        '🔴 L: 拒绝后不落库');
      // v3.2.22 之前流式导入把各片段直接拼接落库（逐段解码应为 MID_x0041_B，片段边界已丢失）
      appDb.upsertLinkedGatewayBill([{
        Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'MID_x0041__x0042_', currency: 'USD', amount: '-888',
        Billdate: '2026-05-04', reconciliationid: 'GW-L', ReconBillBizId: 'GB-GW-L', orderid: 'O-GW-L'
      }], { sourceFileName: 'gateway-rich-account-legacy.xlsx', legacySource: true });
      const gwRows = appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => g.reconciliationid === 'GW-L');
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'MID_x0041__x0042_', clearingAccountId: 'MIDAB' }]);
      const bankRows = [transferBank('BL-AB', 'MIDAB', 'JPM', 888)];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows.map((b) => [b._rowId, b.ReconciliationId]), [['BL-AB', '']],
        '🔴 L: 旧记录原样映射与整串解码碰巧一致也不回填（真实账户号无法确定）');
      const ambiguous = result.errorReport.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous');
      assertEq(ambiguous.map((w) => w.reconId), ['GW-L'], '🔴 L: 告警一次，提示人工核对账户号');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case M：源表字面对账ID 经流式导入按字面落库，回填与生产导出后读回源表字面值；旧记录读回转义写法 =====
    {
      await importGatewayWorkbook('gateway-literal-recon-id.xlsx', [
        { reconciliationid: 'RID_x0041_', merchantid: 'GW-M', amount: '-999', Channel: 'JPM' }
      ]);
      // v3.2.22 之前流式导入按转义原文落库的旧记录（源表字面 `RID_x0041_` 存为 `RID_x005F_x0041_`）
      appDb.upsertLinkedGatewayBill([{
        Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'GW-M2', currency: 'USD', amount: '-998',
        Billdate: '2026-05-04', reconciliationid: 'RID_x005F_x0041_', ReconBillBizId: 'GB-GW-M2', orderid: 'O-GW-M2'
      }], { sourceFileName: 'gateway-literal-recon-id-legacy.xlsx', legacySource: true });
      assertEq(appDb.getFundTransferAccountMappingMap().size, 0, 'M: 空映射');
      const gwRows = appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => /^GW-M2?$/.test(g.merchantid));
      assertEq(gwRows.filter((g) => g.merchantid === 'GW-M').map((g) => g.reconciliationid), ['RID_x0041_'],
        'M: 流式导入按 SheetJS 同一口径还原，落库为源表字面值（B113 D4b）');
      const bankRows = [transferBank('BM', 'GW-M', 'JPM', 999), transferBank('BM2', 'GW-M2', 'JPM', 998)];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows.map((b) => b.ReconciliationId), ['RID_x0041_', 'RID_x005F_x0041_'], 'M: 回填的是落库值');
      const mainFilePath = path.join(tmpDir, 'literal-recon-id-output.xlsx');
      await writeBankStatementMainOutput({
        modifiedRows: result.modifiedRows, unmatchedRows: result.unmatchedRows, modifications: result.modifications,
        headers: ['MerchantId', 'ReconciliationId'], mainFilePath
      });
      const expected = [['GW-M', 'RID_x0041_'], ['GW-M2', 'RID_x005F_x0041_']];
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(mainFilePath);
      const hitSheet = workbook.getWorksheet('命中场景');
      assertEq([2, 3].map((r) => [hitSheet.getCell(r, 3).value, hitSheet.getCell(r, 4).value]).sort(), expected,
        '🔴 M: ExcelJS 读回源表字面对账ID；旧记录读回显示为转义写法（需人工核对，见 knowledge/backlog.md B134）');
      const sheetRows = XLSX.utils.sheet_to_json(XLSX.readFile(mainFilePath).Sheets['命中场景'], { header: 1, raw: true });
      assertEq(sheetRows.slice(1).map((row) => [row[2], row[3]]).sort(), expected, '🔴 M: SheetJS 读回与 ExcelJS 一致');
    }

    // ===== Case N：网关渠道含回车 → 流式导入还原，只回填渠道相同的银行行；旧记录渠道为转义写法时不回填、告警 =====
    {
      await importGatewayWorkbook('gateway-escaped-channel.xlsx', [
        { reconciliationid: 'GW-N', merchantid: 'ALIAS-N', amount: '-777', Channel: 'BANK\rUS' }
      ]);
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'ALIAS-N', clearingAccountId: 'CLR-N' }]);
      const readN = (reconId) => appDb.readGatewayBillRowPoolsByChannels(['BANK\rUS', 'BANK_x000D_US']).exactRows
        .filter((g) => g.reconciliationid === reconId);
      const gwRows = readN('GW-N');
      assertEq(gwRows.map((g) => g.Channel), ['BANK\rUS'], 'N: 流式导入还原渠道里的回车（B113 D4b）');
      const bankRows = [transferBank('BN-CR', 'CLR-N', 'BANK\rUS', 777), transferBank('BN-LIT', 'CLR-N', 'BANK_x000D_US', 777)];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows.map((b) => [b._rowId, b.ReconciliationId]), [['BN-CR', 'GW-N'], ['BN-LIT', '']],
        '🔴 N: 映射命中的网关行只回填渠道相同的银行行（字面 BANK_x000D_US 是另一渠道）');
      assertEq(result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous').length, 0,
        'N: 渠道已还原、可以确认，不告警');

      // 旧记录：渠道按转义原文落库为 `BANK_x000D_US`，无法确认是回车还是字面写法
      appDb.upsertLinkedGatewayBill([{
        Channel: 'BANK_x000D_US', TradeType: 'FundTransfer-out', merchantid: 'ALIAS-N', currency: 'USD', amount: '-776',
        Billdate: '2026-05-04', reconciliationid: 'GW-N-OLD', ReconBillBizId: 'GB-GW-N-OLD', orderid: 'O-GW-N-OLD'
      }], { sourceFileName: 'gateway-escaped-channel-legacy.xlsx', legacySource: true });
      const oldBankRows = [transferBank('BN-CR2', 'CLR-N', 'BANK\rUS', 776), transferBank('BN-LIT2', 'CLR-N', 'BANK_x000D_US', 776)];
      const oldResult = await runReconciliation({
        bankRows: oldBankRows,
        gwRows: readN('GW-N-OLD'),
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(oldBankRows.map((b) => [b._rowId, b.ReconciliationId]), [['BN-CR2', ''], ['BN-LIT2', '']],
        '🔴 N: 旧记录渠道无法确认，回车版与字面版银行行都不回填');
      assertEq(oldResult.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous').map((w) => w.reconId),
        ['GW-N-OLD'], '🔴 N: 告警一次，提示人工核对渠道');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case N2：旧记录池外映射网关行的渠道只在解码后与银行渠道相符 → 池外诊断告警渠道转义，不回填 =====
    {
      appDb.upsertLinkedGatewayBill([{
        Channel: 'CITI_x000D_HK', TradeType: 'FundTransfer-out', merchantid: 'ALIAS-N2', currency: 'USD', amount: '-555',
        Billdate: '2026-05-04', reconciliationid: 'GW-N2', ReconBillBizId: 'GB-GW-N2', orderid: 'O-GW-N2'
      }], { sourceFileName: 'gateway-escaped-channel-out-of-pool-legacy.xlsx', legacySource: true });
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'ALIAS-N2', clearingAccountId: 'CLR-N2' }]);
      const { result, bankRows, gwRows, diagnosticRows } = await runGatewaySource(appDb, undefined,
        [transferBank('BN2', 'CLR-N2', 'CITI\rHK', 555)]);
      assertEq(gwRows.filter((g) => g.reconciliationid === 'GW-N2').length, 0, 'N2: 旧记录渠道 CITI_x000D_HK 不在按银行渠道读的池里');
      assertEq(diagnosticRows.map((g) => g.reconciliationid), ['GW-N2'], 'N2: 真实读池暂存、按 id 回读池外诊断行');
      assertEq(bankRows[0].ReconciliationId, '', '🔴 N2: 池外行只读诊断，不回填');
      const warned = result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous');
      assertEq(warned.map((w) => w.rowId), ['BN2'], '🔴 N2: 告警一次，指向账号币种金额相符的银行行');
      assertTrue(warned.every((w) => w.message.includes('CITI⟨U+000D⟩HK') && !/_x[0-9A-Fa-f]{4}_/i.test(w.message)),
        'N2: 渠道里的转义写法按 ⟨U+HHHH⟩ 显示');
      assertEq(result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-missing').length, 0, 'N2: 不另报缺渠道');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case O：同一格既有 XML 字符引用又有 Excel 写法的字面 `_x0041_` 的对账ID → 回填并导出后读回源对账ID =====
    {
      await importGatewayWorkbook('gateway-mixed-recon-id.xlsx', [
        { reconciliationid: 'RIDCRMARKX_x0041_', merchantid: 'GW-O', amount: '-444', Channel: 'JPM' }
      ], { patchSharedStrings: (xml) => xml.split('CRMARK').join('&#13;') });
      const gwRows = appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => g.merchantid === 'GW-O');
      assertEq(gwRows.map((g) => g.reconciliationid), ['RID\rX_x0041_'],
        'O: 流式导入还原 XML 字符引用与 `_x005F_` 保护的字面 `_x0041_`，落库为源对账ID');
      const bankRows = [transferBank('BO', 'GW-O', 'JPM', 444)];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows[0].ReconciliationId, 'RID\rX_x0041_', 'O: 回填的是落库值');
      const mainFilePath = path.join(tmpDir, 'mixed-recon-id-output.xlsx');
      await writeBankStatementMainOutput({
        modifiedRows: result.modifiedRows, unmatchedRows: result.unmatchedRows, modifications: result.modifications,
        headers: ['MerchantId', 'ReconciliationId'], mainFilePath
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(mainFilePath);
      assertEq(workbook.getWorksheet('命中场景').getCell(2, 4).value, 'RID\rX_x0041_', '🔴 O: ExcelJS 读回源对账ID');
      const sheetRows = XLSX.utils.sheet_to_json(XLSX.readFile(mainFilePath).Sheets['命中场景'], { header: 1, raw: true });
      assertEq(sheetRows[1][3], 'RID\rX_x0041_', '🔴 O: SheetJS 读回源对账ID');
    }

    // ===== Case P：网关账号按数值存放、超出 JS 精度 → 流式导入落库即被舍入；舍入写法按数值对得上映射键时不回填、告警 =====
    {
      await importGatewayWorkbook('gateway-long-numeric-account.xlsx', [
        { reconciliationid: 'GW-P', merchantid: 9007199254740992, amount: '-321', Channel: 'JPM' }
      ], { patchSheet: (xml) => {
        assertEq(xml.split('<v>9007199254740992</v>').length, 2, 'P: 工作表里正好一个数值账号单元格');
        return xml.replace('<v>9007199254740992</v>', '<v>9007199254740993</v>');
      } });
      const gwRows = appDb.readGatewayBillRowPoolsByChannels(['JPM']).exactRows.filter((g) => g.reconciliationid === 'GW-P');
      assertEq(gwRows.map((g) => String(g.merchantid)), ['9007199254740992'],
        'P: 源单元格 <v>9007199254740993</v> 落库为舍入值（现状，见 B136）');
      for (const [label, key] of [['舍入值正好是另一账号的映射键', '9007199254740992'], ['文本映射键按数值与舍入值相同', '9007199254740993']]) {
        appDb.saveFundTransferAccountMappings([{ midAccountId: key, clearingAccountId: 'CLR-P' }]);
        const bankRows = [transferBank('BP', 'CLR-P', 'JPM', 321)];
        const result = await runReconciliation({
          bankRows,
          gwRows,
          scenarios: [gatewaySourceScenario()],
          fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
        });
        assertEq(bankRows[0].ReconciliationId, '', `🔴 P（${label}）: 不按舍入值回填到映射的清结算账号`);
        const warned = result.errorReport.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous');
        assertEq(warned.map((w) => w.reconId), ['GW-P'], `🔴 P（${label}）: 告警一次，提示人工核对账户号`);
        assertTrue(warned.every((w) => !w.message.includes('9007199254740992')), `P（${label}）: 告警不写完整账户号`);
      }
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case Q：银行 MerchantId 按数值存放、超出 JS 精度 → 读入即被舍入；按数值与映射目标账号相同时不回填到这一行 =====
    {
      const bankFile = path.join(tmpDir, 'bank-long-numeric-merchant.xlsx');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('渠道对账单');
      sheet.addRow(BANK_STATEMENT_FIELDS);
      const bankSpec = (merchantId) => ({
        Channel: 'JPM', FundType: 'FundTransfer-out', MerchantId: merchantId, Currency: 'USD',
        'Credit Amount': 0, 'Debit Amount': 321, BillDate: '2026-05-04', ReconciliationId: ''
      });
      // 第 1 行数值单元格（写盘后改成超出精度的原文），第 2 行同形的文本单元格。
      for (const spec of [bankSpec(9007199254740992), bankSpec('9007199254740992')]) {
        sheet.addRow(BANK_STATEMENT_FIELDS.map((header) => spec[header] ?? ''));
      }
      await workbook.xlsx.writeFile(bankFile);
      const zip = await JSZip.loadAsync(fs.readFileSync(bankFile));
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
      assertEq(sheetXml.split('<v>9007199254740992</v>').length, 2, 'Q: 工作表里正好一个数值账号单元格');
      zip.file('xl/worksheets/sheet1.xml', sheetXml.replace('<v>9007199254740992</v>', '<v>9007199254740993</v>'));
      fs.writeFileSync(bankFile, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

      const bankRows = readBankStatement(bankFile).rows;
      assertEq(bankRows.map((row) => typeof row.MerchantId), ['number', 'string'],
        'Q: 生产读取入口按数值读入数值单元格（现状，见 B136）');
      assertEq(String(bankRows[0].MerchantId), '9007199254740992', 'Q: 源单元格 <v>9007199254740993</v> 读入即为舍入值');
      appDb.saveFundTransferAccountMappings([{ midAccountId: 'GW-Q', clearingAccountId: '9007199254740992' }]);
      const gwRows = [{
        Channel: 'JPM', TradeType: 'FundTransfer-out', merchantid: 'GW-Q', currency: 'USD', amount: '-321',
        Billdate: '2026-05-04', reconciliationid: 'GW-Q-RID', ReconBillBizId: 'GB-Q', orderid: 'GW-Q'
      }];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [gatewaySourceScenario()],
        fundTransferAccountMappingMap: appDb.getFundTransferAccountMappingMap()
      });
      assertEq(bankRows[0].ReconciliationId, '', '🔴 Q: 舍入后的数值银行账号不按映射目标回填');
      assertEq(bankRows[1].ReconciliationId, 'GW-Q-RID', 'Q: 文本单元格的同形账号照常回填');
      const warned = result.errorReport.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
      assertEq(warned.length, 1, '🔴 Q: 舍入歧义的银行行告警一次，提示人工核对');
      assertTrue(warned.every((w) => !w.message.includes('9007199254740992')), 'Q: 告警不写完整账户号');
      appDb.saveFundTransferAccountMappings([]);
    }

    // ===== Case R：C1、C3 自定义值与 C3 按网关字段写入的值经生产导出都读回字面值 =====
    {
      const bankFile = path.join(tmpDir, 'bank-decoded-scenario-values.xlsx');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('渠道对账单');
      sheet.addRow(BANK_STATEMENT_FIELDS);
      const bankSpec = (overrides) => ({
        Channel: 'JPM', FundType: 'FundTransfer-out', MerchantId: 'M-R', Currency: 'USD', 'Credit Amount': 0, 'Debit Amount': 10,
        BillDate: '2026-05-05', ReconciliationId: '', 'Payment Detail': '', CustomerRef: '', 'Account Reference': '', ...overrides
      });
      // Excel 把单元格里的字面 `_x0041_` 存成 `_x005F_x0041_`；ExcelJS 原样写出，读取端解码后即字面 `ID_x0041_`。
      for (const spec of [
        bankSpec({ 'Payment Detail': 'ID_x005F_x0041_', CustomerRef: 'C-1', 'Account Reference': 'A-1' }),
        bankSpec({ CustomerRef: 'CR-2', 'Account Reference': 'A-2' }),
        bankSpec({ CustomerRef: 'C-3', 'Account Reference': 'AR-3' })
      ]) {
        sheet.addRow(BANK_STATEMENT_FIELDS.map((header) => spec[header] ?? ''));
      }
      await workbook.xlsx.writeFile(bankFile);
      const bankRows = readBankStatement(bankFile).rows;
      assertEq(bankRows.map((row) => row['Payment Detail']), ['ID_x0041_', '', ''], 'R: 生产读取入口把字面写法读成字面值');
      const c3 = (id, reconFields, assign) => ({
        id, name: `C3-${id}`, category: 'gateway-recon-join', priority: id, enabled: true, config: { reconFields, assign }
      });
      const result = await runReconciliation({
        bankRows,
        gwRows: [],
        c3GwRows: [
          { orderid: 'CR-2', orderid2: 'none-1', remark: '' },
          { orderid: 'none-2', orderid2: 'AR-3', remark: 'RAW_x0041_' }
        ],
        scenarios: [
          { id: 1, name: 'C1 复制对账ID', category: 'extract-recon-id', priority: 1, enabled: true,
            config: { conditions: [{ field: 'Payment Detail', op: '非空值', value: '' }], extractByOtherField: { field: 'Payment Detail' } } },
          c3(2, [{ seq: 1, gwField: 'orderid', bankField: 'CustomerRef' }],
            { gwField: '__CUSTOM__', bankField: 'Remark-description', mode: 'custom', customValue: 'NOTE_x0041_' }),
          c3(3, [{ seq: 1, gwField: 'orderid2', bankField: 'Account Reference' }],
            { gwField: 'remark', bankField: 'Datasource', mode: 'direct' })
        ]
      });
      assertEq([bankRows[0].ReconciliationId, bankRows[1]['Remark-description'], bankRows[2].Datasource],
        ['ID_x0041_', 'NOTE_x0041_', 'RAW_x0041_'], 'R: 三个场景各自写入');
      const decodedOf = (rowId) => {
        const row = result.modifiedRows.find((r) => r._rowId === rowId);
        return row && row._decodedModifiedColumns ? Array.from(row._decodedModifiedColumns) : [];
      };
      assertEq(bankRows.map((row) => decodedOf(row._rowId)), [['ReconciliationId'], ['Remark-description'], []],
        'R: 编排器按场景标注值的来源');
      const mainFilePath = path.join(tmpDir, 'decoded-scenario-values-output.xlsx');
      const headers = ['ReconciliationId', 'Remark-description', 'Datasource'];
      await writeBankStatementMainOutput({
        modifiedRows: result.modifiedRows, unmatchedRows: result.unmatchedRows, modifications: result.modifications,
        headers, mainFilePath
      });
      const expected = [['ID_x0041_', '', ''], ['', 'NOTE_x0041_', ''], ['', '', 'RAW_x0041_']];
      const sheetRows = XLSX.utils.sheet_to_json(XLSX.readFile(mainFilePath).Sheets['命中场景'], { header: 1, raw: true, defval: '' });
      const columnOf = (name) => sheetRows[0].indexOf(name);
      assertEq(sheetRows.slice(1).map((row) => headers.map((h) => row[columnOf(h)])), expected,
        '🔴 R: SheetJS 读回字面值');
      assertTrue(String(sheetRows[1][0]).includes('ID_x0041_') && !String(sheetRows[1][0]).includes('IDA'),
        'R: 命中明细里的新值与结果列一致');
      const readBack = new ExcelJS.Workbook();
      await readBack.xlsx.readFile(mainFilePath);
      const hitSheet = readBack.getWorksheet('命中场景');
      const text = (cell) => (cell.value && cell.value.richText ? cell.value.richText.map((run) => run.text).join('') : (cell.value ?? ''));
      assertEq([2, 3, 4].map((r) => headers.map((h) => text(hitSheet.getCell(r, columnOf(h) + 1)))), expected, '🔴 R: ExcelJS 读回');
    }
  } catch (err) {
    failed += 1;
    failures.push({ label: '运行抛错', actual: String(err && err.stack ? err.stack : err), expected: '无异常' });
  } finally {
    try { if (appDb && appDb.db) appDb.db.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

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

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
