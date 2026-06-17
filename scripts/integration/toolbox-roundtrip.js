// 工具箱🧰「合表 / 拆表」端到端集成测试（v3.0.8 需求1）
//   覆盖：
//     ① 多文件同表头合并 → 合并行数 = 各文件数据行之和、表头唯一、内容逐行命中、readback 一致
//     ② 表头不一致 → ToolboxHeaderMismatchError（前端口径 status:'failed'），不产文件
//     ③ 拆表选某字段某值（含多选值）→ 输出仅含命中行，readback 一致
//     ④ 文件名模板匹配 ^合并-\d{12}\.xlsx$ / ^拆分-.+-\d{12}\.xlsx$
//
// 为什么 e2e：3 个 IPC（toolbox:merge / toolbox:split:read / toolbox:split:export）的入参/返回
//   是跨接缝契约（renderer↔preload↔main↔file-service）。本脚本绕过 Electron dialog，直接复刻 handler
//   的「file-service facade（extractHeaders/readRows/writeWorkbookRows）+ toolbox 纯变换」组合，
//   用真实 xlsx 文件读→变换→写→readback 验证整条数据链路契约（feedback_multiagent_seam_gap）。
//
// 用法：node scripts/integration/toolbox-roundtrip.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const XLSX = require('xlsx');

// 与 main.js handler 同源：file-service facade（main.js require 入口）+ toolbox 纯逻辑模块
const fileService = require('../../src/backend/file-service');
const { extractHeaders, readRows, writeWorkbookRows } = fileService;
const {
  ToolboxHeaderMismatchError,
  assertHeadersIdentical,
  mergeAoaRows,
  computeValuesByField,
  filterRowsByFieldValues,
  buildMergeFileName,
  buildSplitFileName
} = require('../../src/main-process/toolbox');

// 复刻 main.js sanitizeFileName（src/main.js:456）
function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual: cond, expected: true });
}

function writeXlsx(filePath, aoa) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'COMMON');
  XLSX.writeFile(wb, filePath);
}

// 复刻 toolbox:merge handler 的「校验 + 合并 + 写」核心（去掉 dialog / copyFileSync）
function runMergeCore(filePaths, outputFilePath) {
  const fileNames = filePaths.map((p) => path.basename(p));
  const headersList = filePaths.map((p) => extractHeaders(p));
  assertHeadersIdentical(headersList, fileNames); // 不一致即抛
  const aoaList = filePaths.map((p) => readRows(p));
  const mergedRows = mergeAoaRows(aoaList);
  writeWorkbookRows({ rows: mergedRows, outputFilePath, sheetName: 'COMMON' });
  return { mergedRows, outputFilePath };
}

// 复刻 toolbox:split:read + toolbox:split:export handler 核心
function runSplitReadCore(sourceFilePath) {
  const headers = extractHeaders(sourceFilePath);
  const aoa = readRows(sourceFilePath);
  const valuesByField = computeValuesByField(headers, aoa);
  return { sourceFilePath, headers, valuesByField };
}
function runSplitExportCore(sourceFilePath, field, values, outputFilePath) {
  const aoa = readRows(sourceFilePath);
  const filtered = filterRowsByFieldValues(aoa, field, values);
  if (!filtered.fieldFound) {
    return { status: 'failed', message: `源文件中找不到字段「${field}」` };
  }
  if (filtered.matchedCount === 0) {
    return { status: 'failed', message: '所选值在源文件中无匹配行' };
  }
  writeWorkbookRows({ rows: filtered.rows, outputFilePath, sheetName: 'COMMON' });
  return { status: 'ok', outputFilePath, matchedCount: filtered.matchedCount };
}

async function run() {
  console.log('==== 工具箱🧰 合表/拆表 端到端集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-roundtrip-'));

  try {
    const HEADERS = ['订单号', '渠道', '金额'];

    // ===== Step ①：多文件同表头合并 =====
    const fileA = path.join(tmpDir, 'a.xlsx');
    const fileB = path.join(tmpDir, 'b.xlsx');
    const fileC = path.join(tmpDir, 'c.xlsx');
    writeXlsx(fileA, [HEADERS, ['o1', '微信', '100'], ['o2', '支付宝', '200']]); // 2 数据行
    writeXlsx(fileB, [HEADERS, ['o3', '微信', '300']]);                          // 1 数据行
    writeXlsx(fileC, [HEADERS, ['o4', '银联', '400'], ['o5', '微信', '500'], ['o6', '支付宝', '600']]); // 3 数据行

    const mergeOut = path.join(tmpDir, buildMergeFileName());
    const mergeRes = runMergeCore([fileA, fileB, fileC], mergeOut);

    // 合并行数 = 各文件数据行之和（2+1+3=6） + 1 表头行
    assertEq(mergeRes.mergedRows.length, 1 + 6, '①合并 aoa 行数 = 表头1 + 数据行6');
    assertEq(mergeRes.mergedRows.length - 1, 6, '①合并数据行 = 2+1+3');

    // 表头唯一：只在第 0 行出现一次
    const mergedHeaderOccurrences = mergeRes.mergedRows.filter(
      (r) => Array.isArray(r) && r[0] === '订单号' && r[1] === '渠道' && r[2] === '金额'
    ).length;
    assertEq(mergedHeaderOccurrences, 1, '①表头唯一（合并后只出现一次）');

    // readback：写出的文件读回，验证表头 + 数据行内容完全一致
    const mergedReadback = readRows(mergeOut);
    assertEq(mergedReadback[0].map(String), HEADERS, '①readback 表头一致');
    assertEq(mergedReadback.length - 1, 6, '①readback 数据行数 = 6');
    // 逐行命中（按订单号集合）
    const mergedOrderIds = mergedReadback.slice(1).map((r) => String(r[0])).sort();
    assertEq(mergedOrderIds, ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'], '①readback 6 行订单号全保留（追加不覆盖）');
    // 内容逐行：某行金额随订单号保留
    const o5Row = mergedReadback.slice(1).find((r) => String(r[0]) === 'o5');
    assertEq([String(o5Row[1]), String(o5Row[2])], ['微信', '500'], '①readback o5 行内容（渠道/金额）保留');

    // extractHeaders 对合并产物 = 原表头（口径自洽）
    assertEq(extractHeaders(mergeOut), HEADERS, '①extractHeaders(合并产物) = 原表头');

    // ===== Step ②：表头不一致 → failed（ToolboxHeaderMismatchError），不产文件 =====
    const fileBad = path.join(tmpDir, 'bad.xlsx');
    writeXlsx(fileBad, [['订单号', '渠道', 'AMOUNT'], ['x1', '微信', '1']]); // 第 3 列名不同
    const mismatchOut = path.join(tmpDir, 'should-not-exist.xlsx');
    let mismatchThrew = false;
    let mismatchErr = null;
    try {
      runMergeCore([fileA, fileBad], mismatchOut);
    } catch (err) {
      mismatchThrew = true;
      mismatchErr = err;
    }
    assertTrue(mismatchThrew, '②表头不一致 → 抛错（不静默合并）');
    assertTrue(mismatchErr instanceof ToolboxHeaderMismatchError, '②抛 ToolboxHeaderMismatchError（handler 归一为 status:failed）');
    assertTrue(mismatchErr && /bad\.xlsx/.test(mismatchErr.message), '②报错文案含不一致文件名 bad.xlsx');
    assertTrue(
      mismatchErr && Array.isArray(mismatchErr.detailLines) && mismatchErr.detailLines.length >= 2,
      '②携带 detailLines（前端 alert 用）'
    );
    assertTrue(!fs.existsSync(mismatchOut), '②表头不一致不产文件');

    // 列序不同也拦截
    const fileReorder = path.join(tmpDir, 'reorder.xlsx');
    writeXlsx(fileReorder, [['渠道', '订单号', '金额'], ['微信', 'r1', '9']]); // 列序换
    let reorderThrew = false;
    try { runMergeCore([fileA, fileReorder], path.join(tmpDir, 'x.xlsx')); } catch (_e) { reorderThrew = true; }
    assertTrue(reorderThrew, '②列序不同 → 拦截（顺序敏感）');

    // ===== Step ③：拆表选某字段某值（单值 + 多选值）=====
    const splitSource = path.join(tmpDir, 'source.xlsx');
    writeXlsx(splitSource, [
      HEADERS,
      ['o1', '微信', '100'],
      ['o2', '支付宝', '200'],
      ['o3', '微信', '300'],
      ['o4', '银联', '400'],
      ['o5', '支付宝', '500']
    ]);

    // split:read → 表头 + 各字段去重值
    const readRes = runSplitReadCore(splitSource);
    assertEq(readRes.headers, HEADERS, '③split:read 表头');
    assertEq(readRes.valuesByField['渠道'], ['微信', '支付宝', '银联'], '③渠道字段去重值（首现序）');
    assertEq(readRes.valuesByField['订单号'].length, 5, '③订单号字段 5 个去重值');

    // 单值拆分：渠道 = 微信 → 仅 2 行（o1/o3）
    const splitOut1 = path.join(tmpDir, buildSplitFileName(['微信'], sanitizeFileName));
    const exp1 = runSplitExportCore(splitSource, '渠道', ['微信'], splitOut1);
    assertEq(exp1.status, 'ok', '③单值拆分 status ok');
    assertEq(exp1.matchedCount, 2, '③渠道=微信 命中 2 行');
    const rb1 = readRows(splitOut1);
    assertEq(rb1[0].map(String), HEADERS, '③单值拆分 readback 表头');
    assertEq(rb1.slice(1).map((r) => String(r[0])).sort(), ['o1', 'o3'], '③readback 仅含微信行 o1/o3');
    assertTrue(rb1.slice(1).every((r) => String(r[1]) === '微信'), '③readback 所有行渠道均为微信（仅含该值行）');

    // 多选值：渠道 ∈ {微信, 银联} → 单文件含 3 行（o1/o3/o4）
    const splitOut2 = path.join(tmpDir, buildSplitFileName(['微信', '银联'], sanitizeFileName));
    const exp2 = runSplitExportCore(splitSource, '渠道', ['微信', '银联'], splitOut2);
    assertEq(exp2.matchedCount, 3, '③多选值 {微信,银联} 命中 3 行');
    const rb2 = readRows(splitOut2);
    assertEq(rb2.slice(1).map((r) => String(r[0])).sort(), ['o1', 'o3', 'o4'], '③多选值 readback 含 o1/o3/o4（单文件含全部选中值的行）');
    assertTrue(
      rb2.slice(1).every((r) => ['微信', '银联'].includes(String(r[1]))),
      '③多选值 readback 行渠道仅属选中集合'
    );

    // 字段缺失 → failed
    const expBadField = runSplitExportCore(splitSource, '不存在字段', ['x'], path.join(tmpDir, 'nf.xlsx'));
    assertEq(expBadField.status, 'failed', '③字段缺失 → status failed');

    // ===== Step ④：文件名模板匹配 =====
    const mergeName = buildMergeFileName();
    assertTrue(/^合并-\d{12}\.xlsx$/.test(mergeName), '④合并文件名匹配 ^合并-\\d{12}\\.xlsx$');
    const splitName = buildSplitFileName(['微信', '银联'], sanitizeFileName);
    assertTrue(/^拆分-.+-\d{12}\.xlsx$/.test(splitName), '④拆分文件名匹配 ^拆分-.+-\\d{12}\\.xlsx$');
    // 拆分文件名含非法字符时仍匹配模板（sanitize 后无 / : * 等）
    const splitNameSanitized = buildSplitFileName(['a/b:c*d'], sanitizeFileName);
    assertTrue(/^拆分-.+-\d{12}\.xlsx$/.test(splitNameSanitized), '④含非法字符拆分名 sanitize 后仍匹配模板');
    assertTrue(!/[/:*]/.test(splitNameSanitized.replace(/\.xlsx$/, '')), '④拆分名值段不含非法字符 / : *');

    const total = passed + failed;
    console.log(`\n==== ${passed}/${total} PASS ====`);
    if (failed > 0) {
      console.error('\nFAILURES:');
      failures.forEach((f) => {
        console.error(`  - ${f.label}`);
        console.error(`      actual:   ${JSON.stringify(f.actual)}`);
        console.error(`      expected: ${JSON.stringify(f.expected)}`);
      });
      process.exit(1);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
