import datetime, hashlib, json, re, subprocess
from pathlib import Path
r = Path.cwd(); e = Path(__file__).resolve().parent; d = e.parent
read = lambda name: json.loads((e/name).read_text())
write = lambda name, value: (e/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
git = lambda *args: subprocess.check_output(['git', *args], cwd=r)
sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
frozen = read('input-manifest.json')
changed = [name for name,digest in frozen['sha256'].items() if not (r/name).is_file() or sha(r/name)!=digest]
files = [name.decode() for name in git('ls-files','--cached','--others','--exclude-standard','-z').split(b'\0') if name]
prefix = str(d.relative_to(r))+'/'
extra = sorted(set(name for name in files if name not in frozen['sha256'] and not name.startswith(prefix)))
preservation = {'checkedAt':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'cwd':str(r),'frozenFilesCompared':len(frozen['sha256']),'changedFrozenFiles':changed,'newFilesOutsideReviewDirectory':extra,'headUnchanged':git('rev-parse','HEAD').decode().strip()==frozen['head'],'statusUnchanged':git('status','--short').decode()==frozen['gitStatus'],'trackedDiffUnchanged':git('diff','--binary')==(e/'input-diff.patch').read_bytes(),'scope':'Git cached/untracked nonignored files; current R14 review artifact excluded from new-file check.'}
assert not changed and not extra and all(preservation[k] for k in ['headUnchanged','statusUnchanged','trackedDiffUnchanged']), preservation
preservation['status']='PASS'; write('preservation-final.json',preservation)
def write_hashes():
    target=e/'artifact-sha256.json'
    write('artifact-sha256.json', {'algorithm':'sha256','base':str(d),'files':{str(p.relative_to(d)):sha(p) for p in sorted(d.rglob('*')) if p.is_file() and p!=target}})
write_hashes()
# 文档可链接本检查的输出；先标为待检查，所有断言通过后才覆盖为 PASS。
write('artifact-validation.json', {'status':'PENDING'})
links=[]; json_files=0; jsonl_rows=0
for file in d.rglob('*'):
    if file.suffix=='.json': json.loads(file.read_text()); json_files+=1
    if file.suffix=='.jsonl':
        for row in file.read_text().splitlines(): json.loads(row); jsonl_rows+=1
    if file.suffix=='.md':
        text=re.sub(r'```[\s\S]*?```','',file.read_text()); text=re.sub(r'`[^`]*`','',text)
        for match in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',text):
            raw=match.group(1).strip('<>'); raw=re.sub(r':\d+$','',raw)
            path=Path(raw) if raw.startswith('/') else file.parent/raw
            assert path.exists(),(str(file),raw)
            links.append({'file':str(file.relative_to(d)),'target':raw})
write('artifact-validation.json',{'status':'PASS','markdownLinksChecked':len(links),'jsonFilesParsed':json_files,'jsonlRowsParsed':jsonl_rows,'links':links})
write_hashes()
print(json.dumps({'preservation':preservation,'markdownLinksChecked':len(links),'jsonFilesParsed':json_files,'jsonlRowsParsed':jsonl_rows,'archivedFiles':len(read('artifact-sha256.json')['files'])},ensure_ascii=False,indent=2))
