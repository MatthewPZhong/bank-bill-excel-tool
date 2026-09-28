#!/usr/bin/env python3
from pathlib import Path
import subprocess
DATA = Path(__file__).resolve().parent
REPO = Path('/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10')
NAMES = ['shared-probes', 'destructure-probes', 'localenv-probes', 'default-combinations', 'async-array-combinations', 'logical-combinations', 'bindings-probes']
for name in NAMES:
    stem = 'r14-shared-' + name
    with (DATA / (stem + '.json')).open('w') as output:
        subprocess.run(['node', str(DATA / (stem + '.cjs'))], cwd=REPO, stdout=output, check=True)
subprocess.run(['python3', str(DATA / 'r14-shared-verify.py')], cwd=REPO, check=True)
