"""核对 RR13 最终候选，生成可复核报告和相对接手状态的增量补丁。"""
from pathlib import Path
import difflib
import hashlib
import json
import re
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]
SOURCE = 'scripts/architecture/renderer-contracts.js'
TEST = 'tests/unit/architecture/release-rereview-r13.test.js'
REVIEW = ROOT / 'changes/v3.2.10/reviews/2026-09-28-release-rereview-r13/evidence'

def read(name):
    return json.loads((E / name).read_text())

def save(name, value):
    (E / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()

def differences(hashes):
    return [name for name, digest in hashes.items()
            if not (ROOT / name).is_file() or sha(ROOT / name) != digest]

def counts(name):
    content = (E / name).read_text()
    result = {}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        found = re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)\s*$', content, re.M)
        assert len(found) == 1, (name, key, found)
        result[key] = int(found[0])
    return result

def assert_pass(value, passed, skipped=0):
    assert value == dict(tests=passed+skipped, **{'pass': passed}, fail=0,
                         cancelled=0, skipped=skipped, todo=0), value

initial = read('input-manifest.json')
hashes = initial['sha256']
assert len(hashes) == 5074
assert initial['branch'] == git('branch', '--show-current') == 'release/v3.2.10'
assert initial['head'] == git('rev-parse', 'HEAD') == '9a38b96b1b8006c5851535d0c1e586bbaeb63f10'
allowed = {p.relative_to(E / 'before').as_posix() for p in (E / 'before').rglob('*') if p.is_file()}
assert len(allowed) == 7 and SOURCE in allowed
assert all(sha(E / 'before' / name) == hashes[name] for name in allowed)
assert set(differences(hashes)) == allowed

gate = read('release-check-result.json')
manifest = read('gate-input-manifest.json')
assert gate['exitCode'] == 0 and not gate['changedInputs'] and not gate.get('aborted'), gate
assert gate['head'] == gate['headAfter'] == initial['head'] and gate['cwd'] == str(ROOT)
assert gate['command'] == 'UNIT_TEST_CONCURRENCY=2 npm run release-check'
assert len(manifest['sha256']) == gate['inputFiles'] == 1710
assert manifest['head'] == initial['head'] and not differences(manifest['sha256'])
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
new_paths = {p for p in paths if p and (ROOT / p).is_file()} - hashes.keys()
assert all(p == TEST or p.startswith(E.relative_to(ROOT).as_posix() + '/') for p in new_paths), new_paths

new = counts('targeted-tests.log')
before = counts('regressions-before-final.log')
arch_tests = counts('architecture-tests-final.log')
unit = counts('release-check.log')
assert_pass(new, 32)
assert before == dict(tests=32, **{'pass': 16}, fail=16, cancelled=0, skipped=0, todo=0)
assert read('regressions-before-inputs.json')['testSha256'] == sha(ROOT / TEST)
assert_pass(arch_tests, 621)
assert_pass(unit, 9395, 4)
lint = read('tool-lint.json')
assert {x['filePath'] for x in lint} == {str(ROOT / SOURCE), str(ROOT / TEST)}
assert all(x['errorCount'] == x['warningCount'] == x['fatalErrorCount'] == 0 for x in lint)

actual = read('conditional-realconfig.json')
assert [(r['name'], len(r['probeViolations'])) for r in actual] == [('conditional-call-skipped', 1), ('direct-call-before-old-safe', 0)]
assert all(not r['scanError'] and r['boundaryCount'] == 20 and not r['baseViolations'] for r in actual)
assert actual[0]['runtime']['extraCallable'] and not actual[1]['runtime']['extraCallable']
arrays = [r for group in ['array-original.json', 'array-finite.json'] for r in read(group)['results']]
assert len(arrays) == 14
for row in arrays:
    assert not row.get('scanError'), row
    assert bool(row['violations']) == (not row['safe'] or row['name'] == 'overwritten-before-reorder-safe'), row
    assert row['runtime']['extraCallable'] == (not row['safe']), row
assert sum(not r['safe'] for r in arrays) == 7
assert sum(r['safe'] and not r['violations'] for r in arrays) == 6
preflight = read('preflight-verification.json')
assert preflight['sourceSha256'] == sha(ROOT / SOURCE) and preflight['testSha256'] == sha(ROOT / TEST)
shared = read('shared-verification.json')
assert shared['status'] == 'PASS' and shared['fixtures'] == 56
assert not shared['diagnosticChanges'] and not shared['scannerChanges']
bindings = read('bindings-probe.json')
old_bindings = json.loads((REVIEW / 'r13-bindings-probes.json').read_text())
assert len(bindings['rows']) == 6
for now, old in zip(bindings['rows'], old_bindings['rows']):
    assert now['current'] == old['current'] and now['scanner']['current'] == old['scanner']['current']
    assert now['runtime'] == old['runtime'] and bool(now['current']) == now['unsafe']

log = (E / 'release-check.log').read_text()
# 正式 CLI 是完整门禁的同一调用；从原始输出提取结果，避免重复运行。
cli = log.split('> node scripts/check-architecture.js\n', 1)[1].split('> bank-bill-excel-tool@', 1)[0]
assert '架构检查：通过；' in cli and 'active 31；pending 0；partial 0。' in cli
assert '[ARCH-' not in cli and '过期例外：' not in cli
(E / 'architecture-check.log').write_text(cli)
architecture = {'source': 'release-check.log / check:architecture', 'active': 31,
                'pending': 0, 'partial': 0, 'violations': 0, 'stale': 0}
save('architecture-check-summary.json', architecture)
skips = re.findall(r'^﹣.*$', log, re.M)
assert len(skips) == 4 and all('Windows' in line for line in skips)
integration = []
for match in re.finditer(r'^\[integration\] ▶ (.*?) \.\.\. PASS (?:(\d+)/(\d+)|\(no count\)) \((\d+)ms\)$', log, re.M):
    name, passed, total, duration = match.groups()
    integration.append({'name': name, 'passed': int(passed) if passed else None,
                        'total': int(total) if total else None, 'durationMs': int(duration)})
assert len(integration) == 68 and '全部 68 个集成脚本通过' in log
assert all(x['passed'] == x['total'] for x in integration)
assert next(x for x in integration if x['name'] == 'renderer-lifecycle')['passed'] == 233
result_line = '9395 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'

p = ROOT / 'changes/v3.2.10/README.md'
lines = p.read_text().splitlines()
lines = [f'| 交付状态 | 第十三轮 RR13-01 条件 helper 漏报已修复，新增 32/32 回归、架构 621/621 PASS；完整门禁重跑 PASS（{result_line}）。修复未提交，真实产品/平台验收未执行。见 [第十三轮修复报告](reviews/2026-09-28-release-r13-repair/repair.md) |' if x.startswith('| 交付状态 |') else x for x in lines]
p.write_text('\n'.join(lines) + '\n')
p = ROOT / 'changes/v3.2.10/release.md'
content = p.read_text().replace('最终候选完整门禁待运行。所有修复未提交', '完整门禁在 1710 个冻结输入上重跑 PASS。所有修复未提交')
marker = '## 2026-09-23 第十二轮独立审查修复（未提交）'
section = f'''## 2026-09-28 第十三轮独立审查修复（未提交）

RR13-01：唯一 helper 调用时点不证明必执行。成员快照沿调用链保留分支未进入时的旧来源；可证明晚于先前写入的后续确定覆盖才能清除旧候选。控制语句的必执行位置、共同分支、捕获旧别名及无条件替换均有安全对照。

新增 32 项回归，准确修复起点 16 FAIL / 16 PASS，最终 32 PASS；架构 621/621 PASS，正式 CLI 31 active、0 诊断、0 stale。实际 20 个 Renderer 边界配置下，原条件反例 1 条 scope 诊断，安全对照零诊断。RR12 的 14 个数组样例与 62 个共享/绑定用例保持原结果。

`{gate['command']}` 重跑 PASS：{result_line}。1710 个输入及 HEAD 未漂移。开始 {gate['startedAt']}，结束 {gate['finishedAt']}。

[修复报告](reviews/2026-09-28-release-r13-repair/repair.md)、[验证汇总](reviews/2026-09-28-release-r13-repair/verification.json)、[增量补丁](reviews/2026-09-28-release-r13-repair/incremental.patch)。本轮未修改生产业务源码，未提交、推送或发布；平台及人工验收不在此结论内。

'''
assert marker in content and '## 2026-09-28 第十三轮独立审查修复' not in content
p.write_text(content.replace(marker, section + marker, 1))
p = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
p.write_text(p.read_text().replace('最终候选完整门禁待运行。', f'最终架构 621/621 PASS，完整门禁在 1710 个冻结输入上重跑 PASS：{result_line}。'))
p = E / 'implementation-notes.md'
p.write_text(p.read_text().replace('最终架构全集、实际 20 边界配置、RR12 的 14 个数组样例及 62 个共享/绑定用例待本轮最终结果；完整门禁另行冻结重跑。',
  f'最终架构 621/621 PASS；实际 20 边界配置原反例拒绝、安全对照通过；RR12 的 14 个数组样例和 62 个共享/绑定用例保持原结果。完整门禁重跑 PASS：{result_line}；1710 个输入和 HEAD 未漂移。详见 [修复报告](repair.md)。'))

assert set(differences(hashes)) == allowed and not differences(manifest['sha256'])
preservation = {'frozenExisting': len(hashes), 'plannedChanged': sorted(allowed),
                'unchangedExisting': len(hashes)-len(allowed),
                'productionFilesUnchanged': sum(p.startswith('src/') for p in hashes),
                'historicalReviewFilesUnchanged': sum(p.startswith('changes/v3.2.10/reviews/') for p in hashes),
                'head': initial['head'], 'gateInputs': 1710}
save('preservation-final.json', preservation)
save('verification.json', {'result': 'PASS', 'scope': 'RR13-01 and listed controls; not all dynamic JavaScript or release acceptance',
     'gate': gate, 'newRegressions': new, 'beforeRegressions': before, 'architectureTests': arch_tests,
     'architecture': architecture, 'unit': unit, 'integration': integration, 'windowsSkips': skips,
     'actualConfig': {'boundaries': 20, 'cases': 2, 'scanErrors': 0, 'rr12Arrays': 14,
                      'knownConservative': ['overwritten-before-reorder-safe']},
     'sharedReplay': shared, 'bindingsReplay': {'cases': 6, 'changes': []}, 'preservation': preservation})
report = f'''# release/v3.2.10 第十三轮审查修复

**RR13-01 已修复；最终候选的完整 `release-check` 已重新运行并通过。** 条件 helper 未执行时的旧成员来源得到保留，原始反例产生 `ARCH-RENDERER-SCOPE` 诊断；无条件替换和提前捕获别名的安全对照继续通过。

## 修复与候选

分支 `release/v3.2.10`，HEAD `{initial['head']}` 加既有未提交修复。[第十三轮审查](../2026-09-28-release-rereview-r13/review.md)与 [G8 Spec](../../codex/v3.2.10-architecture-guardrails/spec.md) AC-05 为本次依据；[TechDoc](../../codex/v3.2.10-architecture-guardrails/techdoc.md) §4.4 已同步。

[Renderer 检查器](../../../../scripts/architecture/renderer-contracts.js)保留 RR12 的数组延迟求值和调用位置解析，调整成员替换判断：

1. 沿写入到读取的调用链核对条件性。if/else、三元、短路、可零次执行的循环或 catch 中的 helper 写入不再因“唯一调用位置”被认作确定发生；未执行路径仍保留旧来源。
2. 区分可能跳过的语句与必执行位置。读写共有的已进入分支、条件测试、for 初始化和迭代源、逻辑左侧、do 首轮及可证明选中的字面量分支保持精度。
3. 后续确定覆盖仅在可证明晚于先前写入时清除旧候选；不能排序的写入继续合并。避免把条件性永久附在对象上，误拒绝后续已经确定替换的合法代码。

新增 [32 项回归](../../../../tests/unit/architecture/release-rereview-r13.test.js)，每项同时用 VM 检查 false/true 两种输入和静态诊断。覆盖嵌套 helper、工厂调用帧、数组固定槽位及各项安全对照。公共 scan/contracts/rules/schema、机器边界及生产业务源码保持。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 准确修复起点 | 最终同一 32 项测试：**16 FAIL / 16 PASS**；使用 hash 匹配的旧检查器。[日志](regressions-before-final.log)、[输入](regressions-before-inputs.json) |
| 新增回归 | **32/32 PASS**。[日志](targeted-tests.log) |
| 全部架构单测 | **621/621 PASS**。[日志](architecture-tests-final.log) |
| 实际 Renderer 配置 | 保留全部 **20 个 active 边界**，原条件反例 1 条 scope 诊断，安全对照 0 条，基线 0 条，无扫描异常。[结果](conditional-realconfig.json) |
| RR12 数组回放 | **14 例无异常**：7 个违规正确拒绝、6 个安全通过、1 个既有保守拒绝单列。[原数组](array-original.json)、[对象/解构/嵌套 helper](array-finite.json) |
| 共享解析 / 参数绑定 | **56 + 6** 例与 R13 审查的诊断、scanner 结构及 evidenceId 保持一致。[共享汇总](shared-verification.json)、[绑定结果](bindings-probe.json) |
| 修改的 JS lint | **0 error / 0 warning**。[结果](tool-lint.json) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；来自本次完整门禁内同一 CLI 调用。[日志](architecture-check.log) |
| 完整门禁 | **PASS**：`{gate['command']}`。[完整日志](release-check.log)、[进程结果](release-check-result.json) |
| 全量单测 / 集成 | **{result_line}**；Renderer lifecycle 233/233 |
| 候选一致性 | **1710 个门禁输入与 HEAD 未漂移**。[冻结清单](gate-input-manifest.json)、[验证汇总](verification.json) |

完整门禁开始于 **{gate['startedAt']}**，结束于 **{gate['finishedAt']}**。本轮重新执行了完整门禁。实际配置实验只追加指定装配，不等于逐一执行 20 个控制器业务。中间候选结果已保留在 preliminary 目录，最终结论仅使用表内列出的最终输入与结果。

## 保全与限制

接手时冻结 **5074 个既有文件**，其中 **7 个计划内文件**变化：检查器、5 份架构/状态文档，以及门禁自动刷新的集成耗时策略表。其余 **5067 个**逐字节保持，包括 **{preservation['productionFilesUnchanged']} 个生产源码**和 **{preservation['historicalReviewFilesUnchanged']} 个历史审查/修复文件**。新增本轮测试与证据。HEAD 未变，未提交、推送、开 PR、升版或发布。[保全核对](preservation-final.json)。

[增量补丁](incremental.patch)相对于本次接手的未提交状态生成，反向适用只读预检与 `git diff --check` 通过。[交付核对](delivery-check.json)、[实施记录](implementation-notes.md)。

本轮的 `blindspot-pass` 聚焦写入条件与执行顺序，并将发现的必执行位置及后续确定覆盖问题纳入回归；列明范围内没有尚未处理的确认缺陷。既有“槽位先覆盖再重排”和不同纯字符串候选的保守拒绝继续保留，不计作合法通过。此次不声明任意 JavaScript 控制流、异常路径或整个 G8 的完备性。真实产品 Main 全流程、GUI、Windows 实机/安装包、Excel/WPS 和资金人工验收未执行，自动门禁不等于整个 release 已验收或可发布。
'''
(E / 'repair.md').write_text(report)
patch = []
for name in sorted(allowed):
    patch.extend(difflib.unified_diff((E / 'before' / name).read_text().splitlines(True), (ROOT / name).read_text().splitlines(True), fromfile='a/'+name, tofile='b/'+name))
patch.extend(difflib.unified_diff([], (ROOT / TEST).read_text().splitlines(True), fromfile='/dev/null', tofile='b/'+TEST))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E/'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
links = [x for x in re.findall(r'\]\(([^)]+)\)', report) if '://' not in x and not x.startswith('#')]
missing = [x for x in links if not (E / x.split('#')[0]).exists() and x != 'delivery-check.json']
assert not missing, missing
assert not differences(manifest['sha256']) and git('rev-parse', 'HEAD') == initial['head']
save('delivery-check.json', {'result': 'PASS', 'head': initial['head'], 'gateInputs': 1710,
     'checkerSha256': sha(ROOT/SOURCE), 'reversePatchCheck': 'PASS', 'gitDiffCheck': 'PASS',
     'localLinks': len(links), 'missingLinks': []})
print(json.dumps({'result': 'PASS', 'unit': unit, 'architectureTests': arch_tests, 'preservation': preservation}, ensure_ascii=False, indent=2))
