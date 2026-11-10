'use strict';

// openZipEntryReadStream 只把解压输出分块调大；与 yauzl openReadStream 的读出内容、解压字节数
// 断言的报错文案（含「got at least」数值）及报错前已交付的数据必须一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '../../../..');
const { openZipEntryReadStream } = require(path.join(ROOT, 'src/backend/xlsx/zip-reader'));

async function writeZip(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-entry-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zip = new JSZip();
  for (const [name, content, compression] of files) zip.file(name, content, { compression });
  const file = path.join(root, 'a.zip');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

// 改写中央目录里某条目声明的解压大小。
function patchDeclaredSize(file, name, size) {
  const buf = fs.readFileSync(file);
  for (let index = buf.length - 22; index >= 0; index -= 1) {
    if (buf.readUInt32LE(index) !== 0x02014b50) continue;
    const nameLength = buf.readUInt16LE(index + 28);
    if (buf.slice(index + 46, index + 46 + nameLength).toString('utf8') === name) {
      buf.writeUInt32LE(size, index + 24);
      fs.writeFileSync(file, buf);
      return;
    }
  }
  throw new Error(`未找到条目 ${name}`);
}

function readAll(file, name, open) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: false, autoClose: false }, (openError, zip) => {
      if (openError) return reject(openError);
      zip.on('entry', (entry) => {
        if (entry.fileName !== name) return;
        open(zip, entry, (error, stream) => {
          if (error) {
            zip.close();
            resolve({ error: error.message });
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => { zip.close(); resolve({ sha: crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex') }); });
          stream.on('error', (error) => {
            zip.close();
            resolve({ error: error.message, delivered: Buffer.concat(chunks).length });
          });
        });
      });
      return undefined;
    });
  });
}

const viaYauzl = (zip, entry, callback) => zip.openReadStream(entry, callback);

test('普通 deflate / stored 条目读出内容与 yauzl 相同', async (t) => {
  const big = crypto.randomBytes(300000).toString('hex');
  const file = await writeZip(t, [['big.xml', big, 'DEFLATE'], ['small.xml', '<a/>', 'DEFLATE'], ['raw.xml', big, 'STORE']]);
  for (const name of ['big.xml', 'small.xml', 'raw.xml']) {
    assert.deepEqual(await readAll(file, name, openZipEntryReadStream), await readAll(file, name, viaYauzl), name);
  }
});

test('声明解压大小不符时报错文案与报错前已交付数据与 yauzl 相同', async (t) => {
  const content = crypto.randomBytes(250000).toString('base64');
  const actual = Buffer.byteLength(content);
  for (const declared of [0, 1, 16383, 16384, 16385, 100000, 200000, actual - 1, actual + 1, actual + 70000]) {
    const file = await writeZip(t, [['x.xml', content, 'DEFLATE']]);
    patchDeclaredSize(file, 'x.xml', declared);
    const expected = await readAll(file, 'x.xml', viaYauzl);
    assert.ok(expected.error, `declared ${declared}`);
    assert.deepEqual(await readAll(file, 'x.xml', openZipEntryReadStream), expected, `declared ${declared}`);
  }
});

test('非 yauzl 的 zip 对象沿用其 openReadStream', () => {
  const calls = [];
  const fake = { openReadStream(entry, callback) { calls.push(entry); callback(null, 'stream'); } };
  openZipEntryReadStream(fake, { fileName: 'x' }, (error, stream) => {
    assert.equal(error, null);
    assert.equal(stream, 'stream');
  });
  assert.deepEqual(calls, [{ fileName: 'x' }]);
});
