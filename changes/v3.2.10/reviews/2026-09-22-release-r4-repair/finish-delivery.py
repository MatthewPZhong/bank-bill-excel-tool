"""仅在完整门禁成功后汇总证据和更新交付记录，不修改门禁输入。"""
from pathlib import Path
import datetime
import difflib
import hashlib
import importlib.util
import json
import re
import subprocess

E = Path(__file__).resolve().parent
ROOT = E.parents[3]

def replace(path, old, new):
    content = path.read_text()
    assert content.count(old) == 1, (path, old)
    path.write_text(content.replace(old, new))

subprocess.run(['python3', str(E / 'summarize-verification.py')], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
verification = json.loads((E / 'verification.json').read_text())
gate = verification['gate']
unit = verification['unit']
assert unit['pass'] == 9044 and unit['skipped'] == 4 and unit['fail'] == 0
assert verification['integration']['scripts'] == 68 and verification['integration']['countedPassed'] == 2901
start = datetime.datetime.fromisoformat(gate['startedAt'])
end = datetime.datetime.fromisoformat(gate['finishedAt'])
period = f'{start:%Y-%m-%d %H:%M:%S}–{end:%H:%M:%S}（Asia/Shanghai）'
summary = '9044 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过'
replace(E / 'repair.md', '完整 release-check 正在最终冻结输入上重跑。', '完整 release-check 已在最终冻结的 1701 个输入上重新运行并通过：' + summary + '。')
replace(E / 'repair.md', '| 完整 release-check | 首轮因 Electron 启动异常 FAIL；沙箱外按 UNIT_TEST_CONCURRENCY=2 完整重跑中，冻结同一候选。[输入](gate-input-manifest.json)、[日志](release-check.log) |', '| 完整 release-check | **PASS**；' + period + '，' + gate['command'] + '。[输入](gate-input-manifest.json)、[日志](release-check.log)、[结果](release-check-result.json) |\n| 全量单测 | **9044 PASS、0 FAIL、4 项 Windows 条件跳过**；9048 total、828 suites。 |\n| 全量集成 | **68/68 脚本 PASS**；有计数用例 2901/2901，另 1 个脚本无用例计数。Renderer lifecycle 233/233。[验证汇总](verification.json) |')
replace(E / 'repair.md', '探针 exit 0 只表示取证完成；', '[探针逐项断言汇总](probe-verification.json)确认违规路径拒绝及安全对照通过。探针 exit 0 只表示取证完成；')
replace(E / 'repair.md', '中途核对 792 个业务 src 文件、216 个既有审查/修复证据、2 个架构机器 JSON 及主工作区 865 个已有 dirty 文件均保持；[当前保护证据](preservation-progress.json)。最终保护核对待门禁结束补齐。', '最终核对确认：1701 个门禁输入及 HEAD 均未漂移；起始 4188 个已有文件中，仅计划内 10 个检查器/说明/集成策略文件变化。792 个业务 src 文件、216 个既有审查/修复证据、2 个架构机器 JSON 及主工作区 865 个已有 dirty 文件均保持；另新增本轮回归和证据。[最终保护证据](preservation-final.json)、[交付核对](delivery-check.json)。')
replace(E / 'repair.md', '按起始 dirty 状态生成，保留前三轮修复；', '按起始 dirty 状态生成，保留前三轮修复，反向应用预检通过；')
root_index = ROOT / 'changes/v3.2.10/README.md'
replace(root_index, '第四轮修复最终门禁待验证', '第四轮修复完整门禁 PASS')
replace(root_index, '新增 33 项回归，RR2–RR4 合计 100/100 PASS，最终门禁待验证。', '新增 33 项回归，架构 270/270 PASS；完整门禁重跑 PASS（9044 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。')
release = ROOT / 'changes/v3.2.10/release.md'
replace(release, '最终门禁待验证，所有修复未提交，', '完整门禁已在 1701 个冻结输入上重跑 PASS，所有修复未提交，')
replace(release, '## 2026-09-22 第三轮独立审查修复（未提交）', f'''## 2026-09-22 第四轮独立审查修复（未提交）

RR4-01～03 已补齐工厂组合身份、不同静态调用实例区分和 G1 已解释回调入口授权检查；真实共享对象继续追踪，未放宽机器授权配置。新增 33 项回归在起点工具上 21 FAIL / 12 PASS，修复后全部通过。原三个 Renderer 越权反例各报一条诊断，安全对照与独立多实例例均无诊断；真实源码副本中的 reduce 在 prepare 入口被拒绝，未执行真实恢复 IO。

| 验证 | 当前修复候选结果 |
| --- | --- |
| 完整门禁 | {gate['command']}：PASS，{period} |
| 架构专项 / CLI | 270/270 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9044 PASS、0 FAIL、4 项 Windows 条件跳过（9048 total、828 suites） |
| 全量集成 | 68/68 脚本 PASS；有计数用例 2901/2901，另 1 个脚本无用例计数 |
| 保护 | 1701 个门禁输入及 HEAD 无漂移；792 个 src、216 个历史证据、主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r4-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r4-repair/verification.json)、[本轮增量](reviews/2026-09-22-release-r4-repair/incremental.patch)。本轮是修复自检，独立复审及真实产品 Main、Windows/安装包、Excel/WPS、资金人工验收未执行；未提交或发布。

## 2026-09-22 第三轮独立审查修复（未提交）''')
notes = ROOT / 'changes/v3.2.10/codex/v3.2.10-architecture-guardrails/implementation-notes.md'
replace(notes, '实际 CLI 31 active、0 诊断；完整架构和最终门禁验证待汇总。', '全部架构 270/270 PASS，实际 CLI 31 active、0 诊断；完整 release-check 在 1701 个冻结输入上重跑 PASS：' + summary + '。输入及 HEAD 未漂移。')
replace(E / 'implementation-notes.md', '实现、修复前后回归、原始探针、架构专项与最终冻结候选完整门禁。修复后的独立复审及产品/平台人工验收不在本轮自动验证范围内。', '实现、前后回归、原始探针、270 项架构专项与最终完整门禁均已完成。修复后的独立复审及产品/平台人工验收不在本轮自动验证范围内。')
with (E / 'implementation-notes.md').open('a') as stream:
    stream.write('\n## 最终结果\n\n完整门禁 ' + period + ' PASS：' + summary + '，有计数集成用例 2901/2901。1701 个输入及 HEAD 保持；保护范围与回退补丁见 repair.md / verification.json / delivery-check.json。\n')

initial = json.loads((E / 'input-manifest.json').read_text())['sha256']
patch = []
for old in sorted((E / 'before').rglob('*')):
    if not old.is_file():
        continue
    name = old.relative_to(E / 'before').as_posix()
    assert hashlib.sha256(old.read_bytes()).hexdigest() == initial[name]
    patch.extend(difflib.unified_diff(old.read_text().splitlines(True), (ROOT / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
name = 'tests/unit/architecture/release-rereview-r4.test.js'
patch.extend(difflib.unified_diff([], (ROOT / name).read_text().splitlines(True), fromfile='/dev/null', tofile='b/' + name))
(E / 'incremental.patch').write_text(''.join(patch))
subprocess.run(['git', 'apply', '--reverse', '--check', str(E / 'incremental.patch')], cwd=ROOT, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=ROOT, check=True)
subprocess.run(['python3', str(E / 'summarize-verification.py')], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
spec = importlib.util.spec_from_file_location('r4_gate_snapshot', E / 'run-release-check.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = json.loads((E / 'gate-input-manifest.json').read_text())
assert manifest == json.loads((E / 'sandbox-gate/gate-input-manifest.json').read_text())
for name, digest in json.loads((E / 'sandbox-gate/archive-sha256.json').read_text()).items():
    assert hashlib.sha256((E / 'sandbox-gate' / name).read_bytes()).hexdigest() == digest
now = module.snapshot()
changed = [name for name in sorted(now.keys() | manifest['sha256'].keys()) if now.get(name) != manifest['sha256'].get(name)]
assert not changed, changed
branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip()
assert branch == 'release/v3.2.10'
result = {'result': 'PASS', 'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'branch': branch,
          'head': gate['head'], 'gateInputs': len(now), 'priorAttemptExitCode': 1, 'sameInputsAcrossAttempts': True, 'finalExecutionContext': 'outside filesystem sandbox', 'changedGateInputs': changed, 'gitDiffCheck': 'PASS', 'reversePatchCheck': 'PASS'}
(E / 'delivery-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
missing = []
links = []
for doc in [E / 'repair.md']:
    for target in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
        if '://' in target or target.startswith('#'):
            continue
        links.append(target)
        if not (doc.parent / target.split('#')[0]).exists():
            missing.append(target)
assert not missing, missing
result.update({'verifiedLocalLinks': len(links), 'missingLinks': missing})
(E / 'delivery-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
cache = E / '__pycache__'
if cache.exists():
    for compiled in cache.glob('run-release-check.cpython-*.pyc'):
        compiled.unlink()
    if not any(cache.iterdir()):
        cache.rmdir()
print(json.dumps({'gate': gate, 'unit': unit, 'integration': verification['integration']['scripts'], 'delivery': result}, ensure_ascii=False, indent=2))
