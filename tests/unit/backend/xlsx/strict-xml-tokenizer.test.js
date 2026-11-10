'use strict';

// strict-xml-tokenizer 替换了工作表与共享字符串热路径上的 sax(strict + xmlns)。
// 这里用 sax 本身作对照：同一输入、多种切块方式下，事件序列（节点形状、命名空间、文本、
// 位置字段）与首个错误的完整文案必须一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sax = require('sax');

const ROOT = path.resolve(__dirname, '../../../..');
const {
  StrictXmlSyntaxError,
  createStrictXmlTokenizer
} = require(path.join(ROOT, 'src/backend/xlsx/strict-xml-tokenizer'));

function nodeRecord(node) {
  return ['open', node.name, node.prefix, node.local, String(node.uri), node.isSelfClosing,
    Object.entries(node.attributes).map(([key, attribute]) => [
      key, attribute.name, attribute.value, attribute.prefix, attribute.local, String(attribute.uri)
    ])];
}

// 文本可能被分段吐出，消费方均做拼接；比较时合并相邻同类文本事件。
function push(log, event) {
  const last = log[log.length - 1];
  if ((event[0] === 'text' || event[0] === 'cdata') && last && last[0] === event[0]) {
    last[1] += event[1];
    return;
  }
  log.push(event);
}

function runSax(chunks) {
  const log = [];
  let failed = false;
  const stream = sax.createStream(true, { trim: false, normalize: false, xmlns: true });
  stream.on('opentag', (node) => {
    if (failed) return;
    push(log, nodeRecord(node));
    log.push(['position', stream._parser.position]);
  });
  stream.on('closetag', (name) => {
    if (failed) return;
    push(log, ['close', name]);
    log.push(['startTagPosition', stream._parser.startTagPosition]);
  });
  stream.on('text', (text) => { if (!failed) push(log, ['text', text]); });
  stream.on('cdata', (text) => { if (!failed) push(log, ['cdata', text]); });
  stream.on('error', (error) => {
    if (failed) return;
    failed = true;
    log.push(['error', error.message]);
  });
  for (const chunk of chunks) {
    stream.write(chunk);
    if (failed) return log;
  }
  stream.end();
  return log;
}

function runTokenizer(chunks) {
  const log = [];
  const tokenizer = createStrictXmlTokenizer({
    onOpenTag: (node) => {
      push(log, nodeRecord(node));
      log.push(['position', tokenizer.position]);
    },
    onCloseTag: (name) => {
      push(log, ['close', name]);
      log.push(['startTagPosition', tokenizer.startTagPosition]);
    },
    onText: (text) => push(log, ['text', text]),
    onCdata: (text) => push(log, ['cdata', text])
  });
  try {
    for (const chunk of chunks) tokenizer.write(chunk);
    tokenizer.end();
  } catch (error) {
    assert.ok(error instanceof StrictXmlSyntaxError, `非语法错误：${error && error.stack}`);
    log.push(['error', error.message]);
  }
  return log;
}

function split(data, size) {
  const chunks = [];
  for (let index = 0; index < data.length; index += size) chunks.push(data.slice(index, index + size));
  return chunks;
}

function assertSameAsSax(xml, label) {
  const inputs = [
    ['string', xml],
    ['utf8', Buffer.from(xml, 'utf8')],
    ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])]
  ];
  for (const [encoding, data] of inputs) {
    for (const size of [1, 3, 17, Number.MAX_SAFE_INTEGER]) {
      const chunks = split(data, size);
      assert.deepEqual(runTokenizer(chunks), runSax(chunks), `${label} / ${encoding} / chunk ${size}`);
    }
  }
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const LONG = 'y'.repeat(70000);

test('严格词法扫描器：正常工作表与边界构造的事件、位置与 sax 一致', () => {
  const cases = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${NS}" xmlns:r="http://r"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/></row></sheetData></worksheet>`,
    `﻿<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t xml:space="preserve"> a&amp;b&nbsp;&#x4E2D;&#25991; </x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
    '<w><v><![CDATA[a]]]]><![CDATA[<b>]]></v><!-- c --><?pi x?></w>\n',
    '<w a="1" a="2" xmlns:p="u" xmlns:p="v" p:b="3"/>',
    '<w xmlns="d"><v xmlns=""><t/></v></w>',
    '< w>a</ w >',
    '<w>&constructor;&AMP;&#00065;&#X41;&#xD800;</w>',
    '<!DOCTYPE w [<!ENTITY a "b"><!-- c -->]><w/>',
    '<w>😀\r\n</w>',
    `<w>${LONG}&amp;${LONG}</w>`,
    `<w><![CDATA[${LONG}]]></w>`,
    '',
    '  '
  ];
  cases.forEach((xml, index) => assertSameAsSax(xml, `case ${index}`));
});

test('严格词法扫描器：非法与截断输入的首个错误文案（含行列字符）与 sax 一致', () => {
  const cases = [
    '<w><a></b></w>', '</w>', '<w></>', '<w>< 1</w>', 'x<w/>', '<w>x</w>y', '<w/><w/>',
    '<w a=1/>', '<w a/>', '<w a="1"b="2"/>', '<w / >', '<w a="&x y"/>', '<w>&a b;</w>', '<w>&;</w>',
    '<w>&#0;</w>', '<w>&#x110000;</w>', '<w>&amp</w>', '<p:w/>', '<w p:a="1"/>', '<w xmlns:xml="bad"/>',
    '<w xmlns:xmlns="x"/>', '<w>a<!-- b -- c --></w>', '<w/><!DOCTYPE w>', '<!DOCTYPE w [<?pi?>]><w/>',
    '<w><!"abc</w>', '<?xml version="1.0" encoding="GBK"?><w/>', '<w>', '<w', '<w a="1', '<w><![CDATA[x',
    '<!DOCTYPE w', '<?xml', `<w a="${LONG}"/>`, `<w><!--${LONG}--></w>`
  ];
  cases.forEach((xml, index) => assertSameAsSax(xml, `invalid ${index}`));
});

test('严格词法扫描器：固定种子的随机变异样本与 sax 一致', () => {
  let seed = 20261109;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const alphabet = ['<', '>', '/', '=', '"', "'", '&', ';', '!', '?', '-', '[', ']', ' ', '\n', ':', '#',
    'x', '1', '中', '&amp;', '<!--', '-->', '<![CDATA[', ']]>', '</', '/>', 'xmlns:q="u"', 'q:'];
  const template = `<?xml version="1.0"?><worksheet xmlns="${NS}" xmlns:x="${NS}"><sheetData>` +
    '<row r="1"><c r="A1" t="s"><v>1</v></c><x:c r="B1" t="inlineStr"><x:is><x:t>a&amp;b</x:t></x:is></x:c></row>' +
    '<row r="2"><c r="A2"><f>SUM(A1)</f><v><![CDATA[2]]></v></c><c r="B2"/><!-- n --></row>' +
    '</sheetData></worksheet>';
  for (let iteration = 0; iteration < 1500; iteration += 1) {
    let xml = template;
    const edits = 1 + Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit += 1) {
      const index = Math.floor(random() * (xml.length + 1));
      const operation = Math.floor(random() * 3);
      if (operation === 0) xml = xml.slice(0, index) + pick(alphabet) + xml.slice(index);
      else if (operation === 1) xml = xml.slice(0, index) + xml.slice(index + 1 + Math.floor(random() * 3));
      else xml = xml.slice(0, index) + pick(alphabet) + xml.slice(index + 1);
    }
    const size = pick([1, 2, 7, 64, Number.MAX_SAFE_INTEGER]);
    const data = random() < 0.5 ? xml : Buffer.from(xml, 'utf8');
    const chunks = split(data, size);
    assert.deepEqual(runTokenizer(chunks), runSax(chunks), `mutation ${iteration}: ${JSON.stringify(xml)}`);
  }
});

test('快路径钩子：命中时先吐出文本再整段跳过；仍打开的元素按通用路径压栈并由通用路径闭合', () => {
  const log = [];
  const fastPath = {
    leadCodes: [99, 114],
    lastTagStart: -1,
    openTagName: null,
    match(buf, lt, len, nsScope) {
      log.push(['match', buf.charAt(lt + 1), nsScope[''] || '']);
      if (buf.startsWith('<c/>', lt)) {
        fastPath.lastTagStart = lt;
        fastPath.openTagName = null;
        return lt + 4;
      }
      if (buf.startsWith('<r a="1">', lt)) {
        fastPath.lastTagStart = lt;
        fastPath.openTagName = 'r';
        return lt + 9;
      }
      return -1;
    },
    apply() { log.push(['fast', tokenizer.position, tokenizer.startTagPosition]); }
  };
  const tokenizer = createStrictXmlTokenizer({
    onOpenTag: (node) => log.push(['open', node.name]),
    onCloseTag: (name) => log.push(['close', name]),
    onText: (text) => log.push(['text', text]),
    fastPath
  });
  tokenizer.write('<w xmlns="u">t<c/><cx/><r a="1"><c/></r></w>');
  tokenizer.end();
  assert.deepEqual(log, [
    ['open', 'w'],
    ['match', 'c', 'u'], ['text', 't'], ['fast', 18, 15],
    ['match', 'c', 'u'], ['open', 'cx'], ['close', 'cx'],
    ['match', 'r', 'u'], ['fast', 32, 24],
    ['match', 'c', 'u'], ['fast', 36, 33],
    ['close', 'r'], ['close', 'w']
  ]);
  assert.throws(() => createStrictXmlTokenizer({ fastPath: { leadCodes: [300], match() {}, apply() {} } }), TypeError);
});
