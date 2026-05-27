// v2.1.9 SR-policy-1 (T32a)：integration-runner 末尾自动同步 rules/integration-test-policy.md §七 章节
//   spec.md §12.2 / tasks.md T32a
//
// 测试覆盖：
//   1. buildPolicyChecklistSection — 表格生成 + 合计行 + 时间戳注释
//   2. syncPolicyChecklist — in-place 替换 §七章节（保留其他章节）
//   3. 边界：policy 文件无 §七 → 跳过；内容一致 → 不写文件；写入失败容忍
//   4. formatChinaTimestamp — 东八区 + ISO 格式

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildPolicyChecklistSection,
  syncPolicyChecklist,
  formatChinaTimestamp,
} = require('../../../scripts/integration-runner');

function makeResults(rows) {
  return rows.map(([name, passedCount, elapsedMs]) => ({
    name,
    ok: true,
    summary: `${passedCount}/${passedCount}`,
    elapsedMs,
    passedCount,
    totalCount: passedCount,
  }));
}

function mkTempPolicy(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-sync-test-'));
  const filePath = path.join(dir, 'integration-test-policy.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return { dir, filePath };
}

describe('formatChinaTimestamp', () => {
  test('返回 ISO 格式 + +08:00 后缀', () => {
    const ts = formatChinaTimestamp(new Date(Date.UTC(2026, 4, 27, 6, 30, 18))); // UTC 06:30:18 → CN 14:30:18
    assert.strictEqual(ts, '2026-05-27T14:30:18+08:00');
  });

  test('零填充月日时分秒', () => {
    const ts = formatChinaTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))); // UTC 00:00:00 → CN 08:00:00
    assert.strictEqual(ts, '2026-01-01T08:00:00+08:00');
  });
});

describe('buildPolicyChecklistSection', () => {
  test('生成 markdown 表头 + 合计行', () => {
    const results = makeResults([
      ['acquiring-bill-currency-idle-cleanup', 38, 212],
      ['bank-statement-hit-scenario-report', 44, 210],
    ]);
    const md = buildPolicyChecklistSection(results, { timestamp: '2026-05-27T14:30:00+08:00' });

    assert.ok(md.includes('## 七、当前集成测试清单（自动同步）'), '应含 §七 章节标题');
    assert.ok(md.includes('| 脚本 | 用例数 | 断言数 | 耗时 (ms) |'), '应含表头');
    assert.ok(md.includes('|---|---|---|---|'), '应含表头分隔');
    assert.ok(md.includes('`acquiring-bill-currency-idle-cleanup.js`'), '应含脚本名（含 .js 后缀）');
    assert.ok(md.includes('| **合计** | **82** | **82** | **422** |'), '应含合计行（38+44=82, 212+210=422）');
  });

  test('包含时间戳注释 + DO NOT EDIT 警告', () => {
    const md = buildPolicyChecklistSection(makeResults([['x', 1, 10]]), {
      timestamp: '2026-05-27T14:30:00+08:00',
    });
    assert.ok(md.includes('last-updated: 2026-05-27T14:30:00+08:00'), '应含 last-updated 时间戳');
    assert.ok(md.includes('DO NOT EDIT MANUALLY'), '应含 DO NOT EDIT 警告');
    assert.ok(md.includes('scripts/integration/*.js'), '应提示用户改源脚本而非清单');
  });

  test('passedCount/totalCount 为 null 时显示 `-`', () => {
    const results = [{
      name: 'broken-script', ok: true, summary: '(no count)', elapsedMs: 50,
      passedCount: null, totalCount: null,
    }];
    const md = buildPolicyChecklistSection(results, { timestamp: 'TS' });
    assert.ok(md.includes('| `broken-script.js` | - | - | 50 |'), '空计数应回退 `-`');
  });

  test('空结果数组 → 合计行全 0', () => {
    const md = buildPolicyChecklistSection([], { timestamp: 'TS' });
    assert.ok(md.includes('| **合计** | **0** | **0** | **0** |'));
  });
});

describe('syncPolicyChecklist', () => {
  test('替换 §七 章节内容 + 保留其他章节', () => {
    const original = [
      '# 集成测试约定',
      '',
      '## 一、为什么有这层',
      '老内容',
      '',
      '## 七、当前清单（旧值）',
      '| 文件 | 用例数 |',
      '|---|---|',
      '| old | 99 |',
      '',
      '## 八、什么时候不写集成测试',
      '后续章节不动',
    ].join('\n');
    const { dir, filePath } = mkTempPolicy(original);
    try {
      const results = makeResults([['new-script', 5, 100]]);
      const r = syncPolicyChecklist(results, {
        policyPath: filePath,
        now: new Date(Date.UTC(2026, 4, 27, 6, 30, 18)),
      });
      assert.strictEqual(r.synced, true, 'syncResult.synced 应 true');
      const written = fs.readFileSync(filePath, 'utf8');
      assert.ok(written.includes('## 七、当前集成测试清单（自动同步）'), '应替换为新 §七 章节标题');
      assert.ok(written.includes('| `new-script.js` | 5 | 5 | 100 |'), '应含新行');
      assert.ok(!written.includes('| old | 99 |'), '旧表内容应被替换');
      assert.ok(written.includes('## 一、为什么有这层'), '其他章节标题保留');
      assert.ok(written.includes('## 八、什么时候不写集成测试'), '后续 §八 章节保留');
      assert.ok(written.includes('后续章节不动'), '后续章节正文保留');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('policy 文件不存在 → 跳过 + 返回 reason', () => {
    const r = syncPolicyChecklist(makeResults([['x', 1, 10]]), {
      policyPath: '/nonexistent/path/to/policy.md',
    });
    assert.strictEqual(r.synced, false);
    assert.strictEqual(r.reason, 'policy-not-exist');
  });

  test('policy 文件无 §七 章节 → 跳过', () => {
    const { dir, filePath } = mkTempPolicy('# 无章节七的文档\n\n## 一、xxx\n内容\n');
    try {
      const r = syncPolicyChecklist(makeResults([['x', 1, 10]]), { policyPath: filePath });
      assert.strictEqual(r.synced, false);
      assert.strictEqual(r.reason, 'no-section-seven');
      const after = fs.readFileSync(filePath, 'utf8');
      assert.ok(!after.includes('## 七、'), '不应硬塞 §七 章节进无该结构的文档');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('§七 是最后一个章节 → 替换到文件末（无 §八）', () => {
    const original = [
      '## 七、当前清单',
      '旧',
      '',
    ].join('\n');
    const { dir, filePath } = mkTempPolicy(original);
    try {
      const r = syncPolicyChecklist(makeResults([['only', 3, 50]]), { policyPath: filePath });
      assert.strictEqual(r.synced, true);
      const after = fs.readFileSync(filePath, 'utf8');
      assert.ok(after.includes('| `only.js` | 3 | 3 | 50 |'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
