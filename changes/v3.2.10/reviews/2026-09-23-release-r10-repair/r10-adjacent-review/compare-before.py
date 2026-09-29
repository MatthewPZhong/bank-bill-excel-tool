"""仅在隔离临时目录复原修复起点工具，校验后运行同一组 6 例。"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile
evidence = Path(__file__).resolve().parent
repo = evidence.parents[4]
repair = evidence.parent
expected = json.loads((repair / 'input-manifest.json').read_text())['sha256']
with tempfile.TemporaryDirectory(prefix='g8-r10-adjacent-before-') as temp:
    target = Path(temp)
    shutil.copytree(repo / 'scripts/architecture', target / 'scripts/architecture')
    for file in (target / 'scripts/architecture').glob('*.js'):
        name = file.relative_to(target).as_posix()
        backup = repair / 'before' / name
        if backup.exists():
            shutil.copyfile(backup, file)
        assert hashlib.sha256(file.read_bytes()).hexdigest() == expected[name], name
    os.symlink(repo / 'node_modules', target / 'node_modules')
    env = dict(os.environ, R10_ADJACENT_TOOLS_ROOT=str(target))
    result = subprocess.run(['node', str(evidence / 'probe.cjs')], cwd=repo, env=env, capture_output=True, check=True)
    (evidence / 'before.json').write_bytes(result.stdout)
    report = json.loads(result.stdout)
    print(json.dumps({'pass': report['pass'], 'total': report['total'], 'cases': [{'name': c['name'], 'passed': c['passed'], 'rejected': c['rejected']} for c in report['results']]}))
