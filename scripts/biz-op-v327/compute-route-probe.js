'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSynchronousCandidateWriter } = require('../../src/backend/sqlite-candidate-writer');
const { addCanonicalDecimals } = require('../../src/main-process/financial-decimal');

const ORDER = 'bu,account,currency,ordinal';
const TABLE = 'CREATE TABLE rows(bu TEXT COLLATE BINARY,account TEXT COLLATE BINARY,currency TEXT COLLATE BINARY,ordinal INTEGER,direction TEXT,amount TEXT)';
function configure(db) { db.exec('PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL'); }
function compare(a, b) {
  for (const key of ['bu', 'account', 'currency']) {
    const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key]));
    if (order) return order;
  }
  return a.ordinal - b.ordinal;
}
function aggregate(rows) {
  const hasher = createHash('sha256');
  let current = null;
  let incoming = '0'; let outgoing = '0'; let rowCount = 0; let groups = 0;
  let peakRss = process.memoryUsage().rss;
  function flush() {
    if (!current) return;
    hasher.update(JSON.stringify([current, incoming, outgoing])); groups += 1;
  }
  for (const row of rows) {
    const key = [row.bu, row.account, row.currency];
    if (!current || key.some((value, index) => value !== current[index])) {
      flush(); current = key; incoming = '0'; outgoing = '0';
    }
    if (row.direction === '入') incoming = addCanonicalDecimals(incoming, row.amount);
    else outgoing = addCanonicalDecimals(outgoing, row.amount);
    rowCount += 1;
    if (rowCount % 1024 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  flush(); return { rowCount, groups, digest: hasher.digest('hex'), peakRss };
}
function* mergeParts(databases) {
  // 可丢弃的有序多路归并探针；每个打开的 part 占一个真实只读连接。
  const iterators = databases.map((db) => db.prepare(`SELECT * FROM rows ORDER BY ${ORDER}`).iterate());
  const heap = [];
  function push(item) {
    heap.push(item);
    let index = heap.length - 1;
    while (index) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent].row, item.row) <= 0) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = item;
  }
  function pop() {
    const first = heap[0]; const last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1].row, heap[child].row) < 0) child += 1;
        if (compare(last.row, heap[child].row) <= 0) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    return first;
  }
  for (const iterator of iterators) { const next = iterator.next(); if (!next.done) push({ row: next.value, iterator }); }
  while (heap.length) {
    const item = pop(); yield item.row;
    const next = item.iterator.next(); if (!next.done) push({ row: next.value, iterator: item.iterator });
  }
}
function measure(method, root, parts) {
  const started = Date.now();
  const databases = [];
  let copiedMs = 0; let indexMs = 0; let result; let workBytes = 0;
  try {
    if (method === 'merge') {
      for (let i = 0; i < parts; i += 1) {
        const db = new DatabaseSync(path.join(root, `${i}.sqlite`), { readOnly: true }); db.exec('PRAGMA cache_size=-16384'); databases.push(db);
      }
      result = aggregate(mergeParts(databases));
    } else {
      const target = new DatabaseSync(path.join(root, 'work.sqlite')); databases.push(target); configure(target); target.exec(TABLE);
      const writer = createSynchronousCandidateWriter({ db: target, insertSql: 'INSERT INTO rows VALUES (?,?,?,?,?,?)' });
      try {
        for (let i = 0; i < parts; i += 1) {
          const source = new DatabaseSync(path.join(root, `${i}.sqlite`), { readOnly: true }); source.exec('PRAGMA cache_size=-16384');
          try { for (const row of source.prepare('SELECT * FROM rows').iterate()) writer.append([row.bu, row.account, row.currency, row.ordinal, row.direction, row.amount]); }
          finally { source.close(); }
        }
        writer.finish();
      } finally { writer.close(); }
      copiedMs = Date.now() - started;
      const indexing = Date.now(); target.exec(`CREATE INDEX ordered ON rows(${ORDER})`); indexMs = Date.now() - indexing;
      result = aggregate(target.prepare(`SELECT * FROM rows ORDER BY ${ORDER}`).iterate());
      workBytes = fs.statSync(path.join(root, 'work.sqlite')).size;
    }
  } finally { for (const db of databases.reverse()) db.close(); }
  return { method, elapsedMs: Date.now() - started, copiedMs, indexMs, workBytes,
    peakReadConnections: method === 'merge' ? parts : 1, peakWriteConnections: method === 'merge' ? 0 : 1, ...result };
}
if (process.argv[2] === '--child') {
  process.stdout.write(`${JSON.stringify(measure(process.argv[3], process.argv[4], Number(process.argv[5])))}\n`);
} else {
  const rows = Number(process.argv[2] || 100000); const parts = Number(process.argv[3] || 8);
  if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(parts) || parts < 1 || parts > 64) throw new Error('参数：正整数行数、1..64 分片数');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-t01-'));
  try {
    for (let part = 0; part < parts; part += 1) {
      const db = new DatabaseSync(path.join(root, `${part}.sqlite`)); configure(db); db.exec(TABLE);
      const writer = createSynchronousCandidateWriter({ db, insertSql: 'INSERT INTO rows VALUES (?,?,?,?,?,?)' });
      try {
        for (let i = part; i < rows; i += parts) {
          const key = Math.floor(i / 4);
          writer.append([`bu-${key % 3}`, `${key % 2 ? '\uE000' : '😀'}-${key % 7001}`, key % 5 ? 'USD' : 'CNY', i,
            i % 2 ? '入' : '出', i % 3 ? '1234567890123456789.123456789' : '-0.123456789']);
        }
        writer.finish(); db.exec(`CREATE INDEX ordered ON rows(${ORDER})`);
      } finally { writer.close(); db.close(); }
    }
    const results = ['merge', 'sqlite'].map((method) => {
      const child = spawnSync(process.execPath, [__filename, '--child', method, root, String(parts)],
        { encoding: 'utf8', timeout: 300000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      if (child.status !== 0) throw new Error(child.stderr || child.error?.message || `child=${child.status}`);
      return JSON.parse(child.stdout.trim());
    });
    if (results[0].digest !== results[1].digest || results.some((value) => value.rowCount !== rows)) throw new Error('两个路线的精确结果不一致');
    process.stdout.write(`${JSON.stringify({ rows, parts, sameExactResult: true, node: process.versions.node, results })}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
