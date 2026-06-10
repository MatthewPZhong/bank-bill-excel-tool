// v3.0.4 块 A · A1 单测：入口尺寸预检 assertXlsxEntriesUnderLimit 四态。
//   正常 / ≥2^31 构造样本 / 损坏 zip（fail-open）/ zip64。
//
// fixture 方案（不留巨型文件在仓库，全部测试内临时生成、跑完清理）：
//   - 正常：yazl 生成几十字节的小 xlsx（worksheet + sharedStrings）。
//   - ≥2^31：yazl 生成小 zip 后，脚本直改「中央目录」里目标 entry 的 uncompressedSize 4 字节字段
//     为 SIZE_LIMIT_BYTES（2^31），不实际写 2GB 数据 → 验证预检按中央目录无符号尺寸拦截。
//   - 损坏 zip：写随机字节（非合法 zip）→ yauzl 打不开 → 预检 fail-open 放行（不抛）。
//   - zip64：yazl forceZip64Format 生成小 zip，把目标 entry 的 32 位 uncompressedSize 改成 0xffffffff
//     并在其 zip64 extra field（id 0x0001）首 8 字节写入 ≥2^31 的真值 → 验证预检走 zip64 64 位真值拦截。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');

const {
  assertXlsxEntriesUnderLimit,
  SIZE_LIMIT_BYTES,
  collectEntrySizes
} = require('../../../../src/backend/pending-import/xlsx-size-preflight');

// 临时目录管理（跑完清理）。
const tmpDirs = [];
function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-preflight-'));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

const MIN_SHEET_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>';
const MIN_SST_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">'
  + '<si><t>x</t></si></sst>';

// yazl 生成最小 xlsx（仅 worksheet + sharedStrings，足够预检枚举）。
function buildMinXlsx({ forceZip64 = false } = {}) {
  const fp = path.join(mkTmpDir(), 'fixture.xlsx');
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(MIN_SHEET_XML, 'utf8'), 'xl/worksheets/sheet1.xml', { forceZip64Format: forceZip64 });
    zf.addBuffer(Buffer.from(MIN_SST_XML, 'utf8'), 'xl/sharedStrings.xml', { forceZip64Format: forceZip64 });
    zf.outputStream.pipe(fs.createWriteStream(fp))
      .on('close', () => resolve(fp))
      .on('error', reject);
    zf.end({ forceZip64Format: forceZip64 });
  });
}

// 中央目录记录签名 0x02014b50（小端 50 4b 01 02）。返回该签名在 buffer 中的所有起始偏移。
function findCentralDirRecords(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) offsets.push(i);
  }
  return offsets;
}

// 在中央目录里定位 fileName 匹配的记录，回调拿到记录起始偏移 + 文件名长度/extra 长度，由 caller patch。
function patchCentralDir(buf, targetName, mutate) {
  const records = findCentralDirRecords(buf);
  for (const off of records) {
    const fileNameLength = buf.readUInt16LE(off + 28);
    const extraFieldLength = buf.readUInt16LE(off + 30);
    const nameStart = off + 46;
    const name = buf.toString('utf8', nameStart, nameStart + fileNameLength);
    if (name === targetName) {
      mutate(buf, off, { fileNameLength, extraFieldLength, nameStart });
      return true;
    }
  }
  return false;
}

test('正常文件：所有 entry 在限内 → 不抛', async () => {
  const fp = await buildMinXlsx();
  await assert.doesNotReject(() => assertXlsxEntriesUnderLimit(fp));
  // 顺带断言 collectEntrySizes 能读到两个 entry。
  const sizes = await collectEntrySizes(fp);
  assert.ok(sizes.has('xl/worksheets/sheet1.xml'));
  assert.ok(sizes.has('xl/sharedStrings.xml'));
  assert.ok(sizes.get('xl/worksheets/sheet1.xml') < SIZE_LIMIT_BYTES);
});

test('≥2^31：中央目录 uncompressedSize 改成 2^31 → 抛 FileValidationError 含中文指引', async () => {
  const fp = await buildMinXlsx();
  const buf = fs.readFileSync(fp);
  // 中央目录 uncompressedSize 在记录起始 +24 偏移（4 字节，小端无符号）。改成 SIZE_LIMIT_BYTES。
  const patched = patchCentralDir(buf, 'xl/worksheets/sheet1.xml', (b, off) => {
    b.writeUInt32LE(SIZE_LIMIT_BYTES >>> 0, off + 24);
  });
  assert.ok(patched, '应能在中央目录定位 sheet1.xml 记录');
  fs.writeFileSync(fp, buf);

  await assert.rejects(
    () => assertXlsxEntriesUnderLimit(fp),
    (err) => {
      assert.strictEqual(err.name, 'FileValidationError');
      assert.match(err.message, /文件数据量过大/);
      assert.match(err.message, /2GB/);
      assert.ok(err.detailLines.some((l) => /拆分为多个较小文件/.test(l)), 'detailLines 含拆分指引');
      assert.ok(err.detailLines.some((l) => /sheet1\.xml/.test(l)), 'detailLines 带 entry 名');
      assert.strictEqual(err.context.limitBytes, SIZE_LIMIT_BYTES);
      assert.ok(err.context.uncompressedSize >= SIZE_LIMIT_BYTES);
      return true;
    }
  );
});

test('损坏 zip：非合法 zip → fail-open 放行（不抛）', async () => {
  const fp = path.join(mkTmpDir(), 'corrupt.xlsx');
  fs.writeFileSync(fp, Buffer.from('this is not a zip file at all 不是 zip', 'utf8'));
  // 预检自身打不开 zip → 静默 return，不抛（让原链路报原错）。
  await assert.doesNotReject(() => assertXlsxEntriesUnderLimit(fp));
});

test('zip64：32 位字段 0xffffffff + zip64 extra field 真值 ≥2^31 → 抛（走 64 位无符号正解）', async () => {
  const fp = await buildMinXlsx({ forceZip64: true });
  const buf = fs.readFileSync(fp);
  // forceZip64 下 yazl 已为每个 entry 写 zip64 extra field（id 0x0001），其内含 64 位 uncompressedSize。
  //   把中央目录 32 位 uncompressedSize 置 0xffffffff（zip64 哨兵），再把 extra field 里的 64 位 uncompressedSize
  //   首 8 字节改成 ≥2^31 的真值，验证预检对 zip64 取 64 位无符号真值拦截。
  const big = BigInt(SIZE_LIMIT_BYTES) + 1024n; // 2^31 + 一点
  const patched = patchCentralDir(buf, 'xl/worksheets/sheet1.xml', (b, off, meta) => {
    b.writeUInt32LE(0xffffffff, off + 24); // 32 位 uncompressedSize 哨兵
    // 在 extra field 区找 id=0x0001 的 zip64 块；其 data 首 8 字节为 Original Size（uncompressedSize）。
    const extraStart = meta.nameStart + meta.fileNameLength;
    const extraEnd = extraStart + meta.extraFieldLength;
    let p = extraStart;
    while (p + 4 <= extraEnd) {
      const id = b.readUInt16LE(p);
      const dataSize = b.readUInt16LE(p + 2);
      if (id === 0x0001) {
        // zip64 块 data 起始 = p+4；Original Size 为首 8 字节（小端 64 位）。
        b.writeBigUInt64LE(big, p + 4);
        break;
      }
      p += 4 + dataSize;
    }
  });
  assert.ok(patched, '应能在中央目录定位 sheet1.xml 记录');
  fs.writeFileSync(fp, buf);

  // 先确认 collectEntrySizes 读出 zip64 64 位真值（≥2^31）。
  const sizes = await collectEntrySizes(fp);
  assert.ok(sizes.get('xl/worksheets/sheet1.xml') >= SIZE_LIMIT_BYTES, 'zip64 64 位真值应 ≥ 上限');

  await assert.rejects(
    () => assertXlsxEntriesUnderLimit(fp),
    (err) => {
      assert.strictEqual(err.name, 'FileValidationError');
      assert.match(err.message, /文件数据量过大/);
      return true;
    }
  );
});
