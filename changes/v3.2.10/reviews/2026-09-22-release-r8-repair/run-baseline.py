"""用修复起点字节运行最终回归，不覆盖当前工作区。"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,tempfile
E=Path(__file__).resolve().parent
ROOT=E.parents[3]
initial=json.loads((E/'input-manifest.json').read_text())['sha256']
with tempfile.TemporaryDirectory(prefix='g8-r8-before-') as tmp:
    sandbox=Path(tmp)
    shutil.copytree(ROOT/'scripts/architecture',sandbox/'scripts/architecture')
    checked={}
    for file in (sandbox/'scripts/architecture').glob('*.js'):
        name=file.relative_to(sandbox).as_posix()
        backup=E/'before'/name
        if backup.exists(): shutil.copyfile(backup,file)
        digest=hashlib.sha256(file.read_bytes()).hexdigest()
        assert digest==initial[name],name
        checked[name]=digest
    (sandbox/'architecture').mkdir()
    for name in ['boundaries.json','legacy-allowlist.json']:
        shutil.copyfile(ROOT/'architecture'/name,sandbox/'architecture'/name)
        assert hashlib.sha256((sandbox/'architecture'/name).read_bytes()).hexdigest()==initial['architecture/'+name]
    test='tests/unit/architecture/release-rereview-r8.test.js'
    (sandbox/test).parent.mkdir(parents=True)
    shutil.copyfile(ROOT/test,sandbox/test)
    os.symlink(ROOT/'node_modules',sandbox/'node_modules')
    result=subprocess.run(['node','--test','--test-reporter=tap',test],cwd=sandbox,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (E/'regressions-before-final.log').write_bytes(result.stdout)
    (E/'regressions-before-inputs.json').write_text(json.dumps({'originalCheckers':checked,'exitCode':result.returncode,'testSha256':hashlib.sha256((ROOT/test).read_bytes()).hexdigest()},indent=2)+'\n')
    assert result.returncode==1
    print(result.stdout.decode().split('1..')[-1])
