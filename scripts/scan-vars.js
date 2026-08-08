#!/usr/bin/env node
/* eslint-disable no-console */
// 扫描 src/ 下顶层变量引用统计，生成 docs/analysis/var-reference-stats.{md,json}
// 口径：
//   - 顶层声明 = 无缩进行的 const/let/var / function / class / module.exports.X / exports.X
//   - 引用次数 = 全项目 \bname\b 匹配数（已剥离注释/字符串；保留模板串 ${…} 内代码）
//   - 排除单字符名与 JS built-in
//
// 用法：node scripts/scan-vars.js [--root src] [--out-md <path>] [--out-json <path>] [--silent]

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = { root: 'src', outMd: null, outJson: null, silent: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') opt.root = argv[++i];
  else if (a === '--out-md') opt.outMd = argv[++i];
  else if (a === '--out-json') opt.outJson = argv[++i];
  else if (a === '--silent') opt.silent = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/scan-vars.js [--root src] [--out-md <path>] [--out-json <path>] [--silent]');
    process.exit(0);
  }
}

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = path.resolve(REPO_ROOT, opt.root);
const OUT_MD = path.resolve(REPO_ROOT, opt.outMd || 'docs/analysis/var-reference-stats.md');
const OUT_JSON = path.resolve(REPO_ROOT, opt.outJson || 'docs/analysis/var-reference-stats.json');

const pkg = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ---------- 扫描 ----------
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.name.endsWith('.js')) {
      yield full;
    }
  }
}

function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'") {
      out += ' '; i++;
      while (i < n && code[i] !== c) {
        if (code[i] === '\\') { i += 2; out += '  '; continue; }
        if (code[i] === '\n') { out += '\n'; i++; } else { out += ' '; i++; }
      }
      if (i < n) { out += ' '; i++; }
    } else if (c === '`') {
      out += ' '; i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          out += '  '; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') depth--;
            if (depth > 0) { out += code[i]; i++; }
          }
          if (i < n) { out += ' '; i++; }
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += ' '; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

function extractDecls(cleaned) {
  const names = new Set();
  const lines = cleaned.split('\n');
  const addFromDestructure = (s) => {
    s.split(',').forEach(part => {
      let t = part.trim();
      if (!t) return;
      t = t.replace(/^\.\.\./, '');
      const colon = t.indexOf(':');
      if (colon >= 0) t = t.slice(colon + 1).trim();
      const eq = t.indexOf('=');
      if (eq >= 0) t = t.slice(0, eq).trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(t)) names.add(t);
    });
  };
  for (const raw of lines) {
    if (/^\s/.test(raw)) continue;
    const line = raw;
    let m;
    m = line.match(/^(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/);
    if (m) names.add(m[1]);
    m = line.match(/^(?:const|let|var)\s+\{([^}]*)\}/);
    if (m) addFromDestructure(m[1]);
    m = line.match(/^(?:const|let|var)\s+\[([^\]]*)\]/);
    if (m) addFromDestructure(m[1]);
    m = line.match(/^(?:async\s+)?function\s*\*?\s+([a-zA-Z_$][\w$]*)/);
    if (m) names.add(m[1]);
    m = line.match(/^class\s+([a-zA-Z_$][\w$]*)/);
    if (m) names.add(m[1]);
    m = line.match(/^module\.exports\.([a-zA-Z_$][\w$]*)\s*=/);
    if (m) names.add(m[1]);
    m = line.match(/^exports\.([a-zA-Z_$][\w$]*)\s*=/);
    if (m) names.add(m[1]);
  }
  return names;
}

const BUILTINS = new Set([
  'console','process','require','module','exports','global','Buffer',
  '__dirname','__filename','setTimeout','setInterval','clearTimeout','clearInterval',
  'setImmediate','queueMicrotask','window','document','navigator','location',
  'localStorage','sessionStorage','history','alert','confirm','prompt','fetch','URL','URLSearchParams',
  'JSON','Math','Array','Object','String','Number','Boolean','Date','RegExp',
  'Error','TypeError','RangeError','SyntaxError','ReferenceError',
  'Promise','Map','Set','WeakMap','WeakSet','Symbol','Proxy','Reflect',
  'Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array',
  'Float32Array','Float64Array','Uint8ClampedArray','BigInt','ArrayBuffer','DataView',
  'NaN','Infinity','undefined','null','true','false',
  'arguments','this','super','Function',
]);

function rel(p) {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

const files = [...walk(ROOT)].sort();
const fileInfo = new Map();
for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  const cleaned = strip(code);
  const decls = extractDecls(cleaned);
  fileInfo.set(f, { cleaned, decls });
}

const allNames = new Set();
for (const { decls } of fileInfo.values()) for (const n of decls) allNames.add(n);

const result = [];
for (const name of allNames) {
  if (BUILTINS.has(name)) continue;
  if (name.length === 1) continue;
  const re = new RegExp(`\\b${name}\\b`, 'g');
  const defFiles = [];
  const refFiles = [];
  let total = 0;
  for (const [f, { cleaned, decls }] of fileInfo) {
    const m = cleaned.match(re);
    const count = m ? m.length : 0;
    if (count === 0) continue;
    total += count;
    refFiles.push({ file: rel(f), count });
    if (decls.has(name)) defFiles.push(rel(f));
  }
  result.push({ name, defFiles, refFiles, totalHits: total, fileSpan: refFiles.length });
}

// 分桶：仅对 totalHits >= 2 展示
const qualified = result.filter(r => r.totalHits >= 2);
const shared = qualified.filter(r => r.fileSpan >= 3).sort((a,b)=>b.fileSpan-a.fileSpan || b.totalHits-a.totalHits || a.name.localeCompare(b.name));
const paired = qualified.filter(r => r.fileSpan === 2).sort((a,b)=>b.totalHits-a.totalHits || a.name.localeCompare(b.name));
const local  = qualified.filter(r => r.fileSpan === 1).sort((a,b)=>b.totalHits-a.totalHits || a.name.localeCompare(b.name));
const crossFile = qualified.filter(r => r.fileSpan >= 2).sort((a,b)=>b.fileSpan-a.fileSpan || b.totalHits-a.totalHits || a.name.localeCompare(b.name));

// ---------- 输出 ----------
const now = new Date();
const tsLocal = now.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

const meta = {
  version: VERSION,
  scannedAt: now.toISOString(),
  root: path.relative(REPO_ROOT, ROOT).replace(/\\/g, '/'),
  totalFiles: files.length,
  totalTopLevelNames: allNames.size,
  buckets: {
    shared: shared.length,
    paired: paired.length,
    local: local.length,
    crossFile: crossFile.length,
  },
};

const jsonDoc = {
  meta,
  A: { shared, paired, local },
  B: crossFile,
};

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(jsonDoc, null, 2));

// Markdown 报告
let md = '';
md += '# 代码库变量引用统计（自动生成）\n\n';
md += '> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。\n\n';
md += `| 字段 | 值 |\n|---|---|\n`;
md += `| 版本 | v${VERSION} |\n`;
md += `| 扫描时间 | ${tsLocal} |\n`;
md += `| 扫描目录 | \`${meta.root}/\` |\n`;
md += `| JS 文件数 | ${meta.totalFiles} |\n`;
md += `| 顶层声明总数 | ${meta.totalTopLevelNames} |\n`;
md += `| ≥2 次引用 | ${shared.length + paired.length + local.length} |\n`;
md += `| 跨 ≥3 文件 (A-share) | ${shared.length} |\n`;
md += `| 跨 2 文件 (A-pair) | ${paired.length} |\n`;
md += `| 单文件 (A-local) | ${local.length} |\n`;
md += `| 跨文件合计 (B) | ${crossFile.length} |\n\n`;
md += '---\n\n';

md += '## A-share — 跨 ≥3 文件共享\n\n';
md += '| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |\n|---|---:|---:|---:|---|\n';
for (const r of shared) {
  md += `| \`${r.name}\` | ${r.fileSpan} | ${r.totalHits} | ${r.defFiles.length} | ${r.defFiles[0] || '(无声明，外部引用)'} |\n`;
}
md += '\n';

md += '## A-pair — 跨 2 文件\n\n';
md += '| 名字 | 总次数 | 声明位置（首个） |\n|---|---:|---|\n';
for (const r of paired) {
  md += `| \`${r.name}\` | ${r.totalHits} | ${r.defFiles[0] || '(无声明，外部引用)'} |\n`;
}
md += '\n';

md += '## A-local — 仅单文件（≥3 次引用部分）\n\n';
md += '按文件分组。仅保留 totalHits ≥ 3 的项。\n\n';
const byFile = new Map();
for (const r of local) {
  const f = r.defFiles[0] || (r.refFiles[0] && r.refFiles[0].file) || '(unknown)';
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(r);
}
for (const f of [...byFile.keys()].sort()) {
  const list = byFile.get(f).filter(r => r.totalHits >= 3).sort((a,b)=>b.totalHits-a.totalHits);
  if (!list.length) continue;
  md += `### \`${f}\`\n\n`;
  md += '| 名字 | 总次数 |\n|---|---:|\n';
  for (const r of list) md += `| \`${r.name}\` | ${r.totalHits} |\n`;
  md += '\n';
}

md += '## B — 跨文件引用完整表\n\n';
md += '| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |\n|---|---:|---:|---:|---|\n';
for (const r of crossFile) {
  const top = r.refFiles.slice().sort((a,b)=>b.count-a.count).slice(0,3).map(x=>`${x.file}(${x.count})`).join(', ');
  md += `| \`${r.name}\` | ${r.fileSpan} | ${r.totalHits} | ${r.defFiles.length} | ${top} |\n`;
}

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md);

if (!opt.silent) {
  console.log(`[scan-vars] v${VERSION} @ ${meta.root}/ — ${meta.totalFiles} files, ${meta.totalTopLevelNames} top-level names`);
  console.log(`[scan-vars]   A-share ${shared.length} / A-pair ${paired.length} / A-local ${local.length} / B ${crossFile.length}`);
  console.log(`[scan-vars] wrote ${path.relative(REPO_ROOT, OUT_MD)}`);
  console.log(`[scan-vars] wrote ${path.relative(REPO_ROOT, OUT_JSON)}`);
}
