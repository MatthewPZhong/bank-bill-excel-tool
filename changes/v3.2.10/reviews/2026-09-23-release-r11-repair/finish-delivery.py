"""核对 RR11 最终候选并生成修复报告与相对接手状态的增量补丁。"""
from pathlib import Path
import datetime
import difflib
import hashlib
import json
import re
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
SOURCE = 'scripts/architecture/renderer-contracts.js'
TEST = 'tests/unit/architecture/release-rereview-r11.test.js'


def read(name):
    return json.loads((E / name).read_text())


def save(name, value):
    (E / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def check_hashes(root, hashes):
    return [name for name, digest in hashes.items()
            if not (root / name).is_file() or sha(root / name) != digest]


def counts(name):
    content = (E / name).read_text()
    result = {}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        found = re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)\s*$', content, re.M)
        assert len(found) == 1, (name, key, found)
        result[key] = int(found[0])
    return result


def assert_pass(result, passed, skipped=0):
    assert result['tests'] == passed + skipped and result['pass'] == passed and result['skipped'] == skipped, result
    assert result['fail'] == result['cancelled'] == result['todo'] == 0, result


initial = read('input-manifest.json')
assert initial['branch'] == git('branch', '--show-current') == 'release/v3.2.10'
assert initial['head'] == git('rev-parse', 'HEAD') == '9a38b96b1b8006c5851535d0c1e586bbaeb63f10'
hashes = initial['sha256']
assert len(hashes) == 4866
allowed = {p.relative_to(E / 'before').as_posix() for p in (E / 'before').rglob('*') if p.is_file()}
assert len(allowed) == 7 and SOURCE in allowed
assert all(sha(E / 'before' / name) == hashes[name] for name in allowed)
changed = check_hashes(ROOT, hashes)
assert set(changed) == allowed, (changed, allowed)
assert not check_hashes(ROOT, {name: digest for name, digest in hashes.items() if name.startswith('src/')})
assert not check_hashes(ROOT, {name: digest for name, digest in hashes.items()
                               if name.startswith('changes/v3.2.10/reviews/')})
assert not check_hashes(ROOT, {name: digest for name, digest in hashes.items()
                               if name in ['architecture/boundaries.json', 'architecture/legacy-allowlist.json',
                                           'scripts/architecture/scan.js', 'scripts/architecture/contracts.js',
                                           'scripts/architecture/rules.js', 'scripts/architecture/schema.js']})
source_sha = sha(ROOT / SOURCE)
assert source_sha != hashes[SOURCE]

gate = read('release-check-result.json')
assert gate['exitCode'] == 0 and not gate['changedInputs'] and not gate.get('aborted'), gate
assert gate['head'] == gate['headAfter'] == initial['head'] and gate['cwd'] == str(ROOT)
assert gate['command'] == 'UNIT_TEST_CONCURRENCY=2 npm run release-check'
manifest = read('gate-input-manifest.json')
assert len(manifest['sha256']) == gate['inputFiles'] == 1708
assert manifest['head'] == initial['head'] and manifest['sha256'][SOURCE] == source_sha
assert not check_hashes(ROOT, manifest['sha256'])
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
                                 'src', 'scripts', 'tests', 'architecture', 'index.html', 'package.json',
                                 'package-lock.json', 'eslint.config.*', '.github/workflows'], cwd=ROOT).decode().split('\0')
assert set(manifest['sha256']) == {p for p in paths if p and (ROOT / p).is_file()}

new = counts('regressions-current.log')
before = counts('regressions-before.log')
architecture_tests = counts('architecture-tests.log')
unit = counts('release-check.log')
assert_pass(new, 11)
assert before['tests'] == 11 and before['pass'] == 6 and before['fail'] == 5 and before['skipped'] == 0
assert_pass(architecture_tests, 577)
assert_pass(unit, 9351, 4)

arch = read('architecture-check.json')
assert len(arch['activeBoundaries']) == 31 and not arch['violations'] and not arch['staleExceptions']
assert not arch['coverage']['pendingBoundaries'] and not arch['coverage']['partialBoundaries']
lint = read('tool-lint.json')
assert {item['filePath'] for item in lint} == {str(ROOT / SOURCE), str(ROOT / TEST)}
assert all(item['errorCount'] == item['warningCount'] == item['fatalErrorCount'] == 0 for item in lint)

member = read('renderer-member-realconfig.json')
assert [(item['name'], len(item['probeViolations'])) for item in member] == [
    ('or-parent-member-default', 1), ('or-member-fallback-safe', 0)]
assert all(item['boundaryCount'] == 20 and item['baseViolations'] == 0 for item in member)
assert member[0]['runtime']['same'] and member[0]['runtime']['extraCallable'] and member[0]['runtime']['extraResult']
assert not member[1]['runtime']['same'] and not member[1]['runtime']['extraCallable']
array = read('array-neighbor-realconfig.json')
assert array['boundaryCount'] == 20 and not array['baseline']['violations']
assert [(item['name'], len(item['violations'])) for item in array['results']] == [
    ('uncertain-copy-fixed-slot', 1), ('uncertain-copy-slot-reverse', 1), ('uncertain-copy-independent-safe', 0)]
assert all(item['runtime']['same'] and item['runtime']['extraCallable'] for item in array['results'][:2])
assert not array['results'][2]['runtime']['same'] and not array['results'][2]['runtime']['extraCallable']
member_neighbors = [json.loads(line) for line in (E / 'renderer-member-minimal.jsonl').read_text().splitlines()]
assert len(member_neighbors) == 6
assert all((not item['violations']) == item['safe'] for item in member_neighbors)
array_neighbors = read('array-neighbor-minimal.json')['results']
assert len(array_neighbors) == 8
assert all((not item['violations']) == item['safe'] for item in array_neighbors)
shared = read('shared-verification.json')
assert shared['status'] == 'PASS' and shared['fixtures'] == 56
assert shared['renderer'] == 38 and shared['query'] == 18
assert not shared['diagnosticChanges'] and not shared['scannerChanges']

log = (E / 'release-check.log').read_text()
skips = re.findall(r'^﹣.*$', log, re.M)
assert len(skips) == 4 and all('Windows' in line for line in skips)
integration = []
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$', log, re.M):
    name, passed, total, duration = match.groups()
    integration.append({'name': name, 'passed': int(passed) if passed else None,
                        'total': int(total) if total else None, 'durationMs': int(duration)})
assert len(integration) == 68 and '全部 68 个集成脚本通过' in log
assert all(item['passed'] == item['total'] for item in integration)
assert next(item for item in integration if item['name'] == 'renderer-lifecycle')['passed'] == 233

period = (f"{datetime.datetime.fromisoformat(gate['startedAt']):%Y-%m-%d %H:%M:%S}–"
          f"{datetime.datetime.fromisoformat(gate['finishedAt']):%H:%M:%S}（Asia/Shanghai）")
result_line = f"{unit['pass']} 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过"

path = ROOT / 'changes/v3.2.10/README.md'
content = path.read_text().replace('第十一轮修复验证中', '第十一轮修复完整门禁 PASS')
old = '| 交付状态 | 第十轮 RR10-01/02 已修复并通过当轮完整门禁；第十一轮 RR11-01/02 已实现，新增 11 项回归，最终组合验证中。修复未提交，真实产品/平台验收未执行。见 [第十一轮修复报告](reviews/2026-09-23-release-r11-repair/repair.md) |'
new_status = f'| 交付状态 | 第十一轮 RR11-01/02 已修复，新增 11/11 回归、架构 577/577 PASS；完整门禁重跑 PASS（{result_line}）。修复未提交，真实产品/平台验收未执行。见 [第十一轮修复报告](reviews/2026-09-23-release-r11-repair/repair.md) |'
assert old in content
path.write_text(content.replace(old, new_status))

path = ROOT / 'changes/v3.2.10/release.md'
content = path.read_text().replace('最终组合门禁验证中。所有修复未提交',
                                   '完整门禁已在 1708 个冻结输入上重跑 PASS。所有修复未提交')
marker = '## 2026-09-23 第十轮独立审查修复（未提交）'
assert marker in content
section = f'''## 2026-09-23 第十一轮独立审查修复（未提交）

RR11-01/02 已修复父对象的非空证明误传给 IPC 子成员，以及数组重排遗漏其他固定槽位已知写入来源。新增 11 项回归，修复起点 5 FAIL / 6 PASS，最终全部通过。

| 验证 | 当前候选结果 |
| --- | --- |
| 完整门禁 | `{gate['command']}`：PASS，{period} |
| 架构专项 / CLI | 577/577 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 / 集成 | {result_line} |
| 实际配置 | 20 个 Renderer 边界配置下的父成员及数组重排正反例符合预期 |
| 输入 | 1708 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-23-release-r11-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r11-repair/verification.json)、[增量补丁](reviews/2026-09-23-release-r11-repair/incremental.patch)。本轮修复仅涉及 G8 Renderer 检查器、测试与说明；生产源码、机器配置、历史材料保持。没有提交、推送或发布。

'''
assert '## 2026-09-23 第十一轮独立审查修复（未提交）' not in content
path.write_text(content.replace(marker, section + marker, 1))

path = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
content = path.read_text()
old = '- 新增 11 项正反回归，修复起点 5 FAIL / 6 PASS；最终架构、实际配置及完整门禁结果见 [本轮修复报告](../../reviews/2026-09-23-release-r11-repair/repair.md)。'
new_line = f'- 新增 11 项正反回归，修复起点 5 FAIL / 6 PASS，最终全部通过；架构 577/577 PASS，实际配置正反例通过；完整门禁在 1708 个冻结输入上重跑 PASS：{result_line}。HEAD 未漂移。证据见 [本轮修复报告](../../reviews/2026-09-23-release-r11-repair/repair.md)。'
assert old in content
path.write_text(content.replace(old, new_line))

path = E / 'implementation-notes.md'
content = path.read_text()
old = '架构全套、真实配置探针、共享解析与完整门禁在最终冻结候选上核对，结果见 [修复报告](repair.md)。'
new_line = f'架构 577/577 PASS；真实配置正反例通过；完整门禁 {period} PASS：{result_line}，1708 个输入及 HEAD 未漂移。结果见 [修复报告](repair.md)。'
assert old in content
path.write_text(content.replace(old, new_line))

assert not check_hashes(ROOT, manifest['sha256'])
changed = check_hashes(ROOT, hashes)
assert set(changed) == allowed
preservation = {'frozenExisting': len(hashes), 'plannedChanged': sorted(changed),
                'productionFilesUnchanged': len([name for name in hashes if name.startswith('src/')]),
                'historicalReviewFilesUnchanged': len([name for name in hashes if name.startswith('changes/v3.2.10/reviews/')]),
                'head': gate['head'], 'gateInputs': len(manifest['sha256'])}
save('preservation-final.json', preservation)
verification = {'result': 'PASS', 'scope': 'RR11-01/02 and listed adjacent controls only',
                'gate': gate, 'newRegressions': new, 'beforeRegressions': before,
                'architectureTests': architecture_tests,
                'architecture': {'active': 31, 'violations': 0, 'stale': 0},
                'unit': unit, 'integration': integration, 'windowsSkips': skips,
                'realConfig': {'rendererBoundaries': 20, 'memberCases': 2, 'arrayCases': 3},
                'reviewNeighborProbes': {'memberCases': len(member_neighbors), 'arrayCases': len(array_neighbors),
                                         'allExpectedResultsMatched': True},
                'sharedReplay': shared,
                'preservation': preservation}
save('verification.json', verification)

report = f'''# release/v3.2.10 第十一轮审查修复

**RR11-01、RR11-02 已修复，最终冻结候选的完整 `release-check` 通过。** 第十轮原始反例继续由 577 项架构测试覆盖；本轮新增 11 项运行时与静态正反回归。

## 候选和修复

分支 `release/v3.2.10`，HEAD `{gate['head']}` 加此前未提交修复。本轮依据：[第十一轮审查](../2026-09-23-release-rereview-r11/review.md)、[G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05、[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4。[接手清单](input-manifest.json)和[原 tracked 差异](input-diff.patch)保存起点。

1. [Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)在 IPC 成员投影时不继承父值的真值/非空证明。`(info || fallback).api` 在 `info` 存在但缺少 `api` 时，重新保留默认对象来源；成员自身的 `||` 或 `??` 仍能证明选中值。
2. 对 `reverse`、`shift`、`splice` 等可见数组重排，检查器在读取某一槽位时，保留重排前同一数组其他固定数字槽位的赋值来源。它继续排除无关数组、重排后才发生的写入，不声称精确模拟动态数组索引。

新增[11 项回归](../../../../tests/unit/architecture/release-rereview-r11.test.js)，同步架构说明、TechDoc、实施记录与 release 状态。生产业务源码、共享 scanner/contracts/rules/schema、机器边界与历史审查材料保持。集成耗时策略表由正式门禁刷新。本轮没有提交、推送、合并、PR、升版、标签或发布。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 新增回归 | **11/11 PASS**；修复起点 **5 FAIL / 6 PASS**。[起点日志](regressions-before.log)、[最终日志](regressions-current.log) |
| 全部架构测试 | **577/577 PASS**。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**，{arch['coverage']['parsedFiles']}/{arch['coverage']['scannedFiles']} 文件解析。[JSON](architecture-check.json) |
| 实际配置 | 保留全部 **20 个 active Renderer 边界**；父成员违规 1 条诊断、安全例 0；数组重排违规 1、安全例 0。[成员结果](renderer-member-realconfig.json)、[数组结果](array-neighbor-realconfig.json) |
| 审查邻近探针 | **成员 6/6、数组 8/8** 正反结果符合预期。[成员结果](renderer-member-minimal.jsonl)、[数组结果](array-neighbor-minimal.json) |
| 共享解析重放 | **56/56**，38 个 Renderer 与 18 个 query 用例相对第十一轮审查均无诊断或 scanner 结构漂移。[汇总](shared-verification.json) |
| 两个 JS 文件 lint | 0 error / 0 warning。[JSON](tool-lint.json) |
| 完整门禁 | **PASS**；`{gate['command']}`，{period}。[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **{unit['pass']} PASS、0 FAIL、4 项 Windows 条件跳过** |
| 全量集成 | **68/68 个脚本 PASS**；Renderer lifecycle 233/233 |
| 输入一致性 | **1708 个门禁输入和 HEAD 未漂移**。[清单](gate-input-manifest.json)、[汇总](verification.json) |

两个真实配置探针仅在完整边界配置中追加指定装配，未逐一运行 20 个控制器。回归测试同时用 VM 核对别名与注入对象是否相同、额外方法是否可调用。第十一轮独立审查已经复核 6 个参数绑定例；本轮源代码修复后重新执行了 56 个共享解析用例。

## 保全与边界

冻结的 **{len(hashes)} 个既有文件**中，只有 **{len(changed)} 个计划内文件**变化；其中 `rules/integration-test-policy.md` 的耗时计数由门禁刷新。**{preservation['productionFilesUnchanged']} 个生产源码和 {preservation['historicalReviewFilesUnchanged']} 个历史审查/修复文件逐字节保持**，机器配置与共享检查器保持。HEAD 未漂移。[保全核对](preservation-final.json)。

[本轮增量补丁](incremental.patch)相对于本轮接手时的未提交状态生成；反向适用只读预检、`git diff --check` 与文档链接检查通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

结论限定于列明的 G8 静态漏报及自动验证。真实产品 Main、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行；自动门禁通过不等于整个 release 可以发布。
'''
(E / 'repair.md').write_text(report)

patch = []
for name in sorted(allowed):
    patch.extend(difflib.unified_diff((E / 'before' / name).read_text().splitlines(True),
                                     (ROOT / name).read_text().splitlines(True),
                                     fromfile='a/' + name, tofile='b/' + name))
patch.extend(difflib.unified_diff([], (ROOT / TEST).read_text().splitlines(True),
                                 fromfile='/dev/null', tofile='b/' + TEST))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E / 'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
links = [value for value in re.findall(r'\]\(([^)]+)\)', report) if '://' not in value and not value.startswith('#')]
missing = [value for value in links if not (E / value.split('#')[0]).exists() and value != 'delivery-check.json']
assert not missing, missing
assert not check_hashes(ROOT, manifest['sha256']) and git('rev-parse', 'HEAD') == gate['head']
save('delivery-check.json', {'result': 'PASS', 'head': gate['head'], 'gateInputs': 1708,
                             'checkerSha256': source_sha, 'reversePatchCheck': 'PASS',
                             'gitDiffCheck': 'PASS', 'localLinks': len(links), 'missingLinks': []})
print(json.dumps({'result': 'PASS', 'unit': unit, 'architectureTests': architecture_tests,
                  'integrationScripts': len(integration), 'preservation': preservation}, ensure_ascii=False, indent=2))
