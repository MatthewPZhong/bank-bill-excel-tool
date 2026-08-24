'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Windows PR 对任意目标分支跑 release-check、x64 完整构建与 check-dist', () => {
  const workflow = read('.github/workflows/build-windows.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\n\s*- '\*\*'/);
  const smokeJob = workflow.slice(workflow.indexOf('\n  smoke-test:'), workflow.indexOf('\n  build:'));
  assert.match(smokeJob, /uses: actions\/checkout@v6\s*\n\s*with:\s*\n\s*fetch-depth: 0/);
  assert.match(workflow, /Run release checks\s*\n\s*run: npm run release-check/);
  assert.match(workflow, /Verify Windows startup process adapter semantics\s*\n\s*env:\s*\n\s*WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST: '1'\s*\n\s*run: node --test tests\/unit\/scripts\/startup-process-adapter\.test\.js/);
  assert.ok(
    workflow.indexOf('Run release checks')
      < workflow.indexOf('Verify Windows startup process adapter semantics'),
    '真实 Windows 进程探针必须在全量 release-check 之后独立串行运行'
  );
  assert.doesNotMatch(workflow, /if:\s*github\.event_name\s*!=\s*'pull_request'/);

  const buildJob = workflow.slice(workflow.indexOf('\n  build:'));
  assert.match(buildJob, /npm run prepare:dist\s*\n\s*npx electron-builder/);
  assert.match(buildJob, /npx electron-builder --win --x64 --publish never/);
  assert.match(buildJob, /node scripts\/check-dist-size\.js/);
  assert.match(buildJob, /Run packaged background execution canary\s*\n\s*shell: pwsh\s*\n\s*run: \.\/scripts\/run-windows-packaged-background-canary\.ps1 -DistDirectory \.\/dist/);
  assert.ok(
    buildJob.indexOf('npx electron-builder --win --x64 --publish never')
      < buildJob.indexOf('Run packaged background execution canary'),
    'packaged canary 必须在真实 Windows 构建完成后执行'
  );
  assert.ok(
    buildJob.indexOf('Run packaged background execution canary')
      < buildJob.indexOf('Stage updater-compatible assets'),
    'packaged canary 必须在 stage 复制出同版本别名之前锁定唯一原始产物'
  );
  assert.match(buildJob, /dist\/bank-bill-excel-tool-setup-\*\.exe/);
  assert.match(buildJob, /dist\/bank-bill-excel-tool-portable-\*\.exe/);
});

test('Windows 本地与发布构建全部锁定 x64，避免检查陈旧 win-unpacked', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(
    packageJson.scripts['prepare:dist'],
    'npm run check:packaged-inputs && npm run prebuild:meta'
  );
  for (const scriptName of ['dist:win', 'dist:win:setup', 'dist:win:portable']) {
    assert.match(packageJson.scripts[scriptName], /^npm run prepare:dist &&/);
    assert.match(packageJson.scripts[scriptName], /electron-builder --win(?:\s+(?:nsis|portable))? --x64 --publish never/);
  }
  const releaseWorkflow = read('.github/workflows/release-windows.yml');
  assert.match(releaseWorkflow, /electron-builder --win --x64 --publish never/);
  assert.match(releaseWorkflow, /Run packaged background execution canary\s*\n\s*shell: pwsh\s*\n\s*run: \.\/scripts\/run-windows-packaged-background-canary\.ps1 -DistDirectory \.\/dist/);
  assert.ok(
    releaseWorkflow.indexOf('Build Windows packages')
      < releaseWorkflow.indexOf('Run packaged background execution canary'),
    '发布工作流必须在真实 Windows 构建完成后执行 packaged canary'
  );
  assert.ok(
    releaseWorkflow.indexOf('Run packaged background execution canary')
      < releaseWorkflow.indexOf('Stage updater-compatible assets'),
    '发布 packaged canary 必须在 stage 复制出同版本别名之前锁定唯一原始产物'
  );
  assert.match(releaseWorkflow, /Verify Windows startup process adapter semantics\s*\n\s*env:\s*\n\s*WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST: '1'\s*\n\s*run: node --test tests\/unit\/scripts\/startup-process-adapter\.test\.js/);
  assert.ok(
    releaseWorkflow.indexOf('Run release checks')
      < releaseWorkflow.indexOf('Verify Windows startup process adapter semantics'),
    '发布工作流同样必须先跑全量门禁，再串行执行真实 Windows 进程探针'
  );
  assert.match(read('scripts/check-dist-size.js'), /断言④包内版本不匹配/);
  assert.match(read('scripts/check-dist-size.js'), /断言⑤包内构建提交不匹配/);
  for (const requiredCanaryFile of [
    'packaged-runtime-runner.js',
    'packaged-runtime-request.js',
    'durable-worker.js',
    'pure-compute-worker.js',
    'canary-schema.js',
    'pure-compute-policy.json',
    'durable-policy.json'
  ]) {
    assert.match(read('scripts/check-dist-size.js'), new RegExp(requiredCanaryFile.replace('.', '\\.')));
  }
});

test('packaged background canary 仅在 GitHub-hosted Windows 的 RUNNER_TEMP 写入，并审计 exact 产品身份', () => {
  const harness = read('scripts/run-windows-packaged-background-canary.ps1');
  const manifest = JSON.parse(read('package.json'));
  const { UUID } = require('builder-util-runtime');
  const nsisTarget = read('node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
  const electronBuilderNamespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3');
  const expectedUninstallRegistryKey = UUID.v5(manifest.build.appId, electronBuilderNamespace);
  const effectiveUninstallDisplayName = `${manifest.build.productName} ${manifest.version}`;
  assert.ok(
    manifest.build.nsis.uninstallDisplayName === undefined
      || manifest.build.nsis.uninstallDisplayName === ''
  );
  assert.ok(manifest.build.nsis.guid === undefined || manifest.build.nsis.guid === '');
  assert.match(
    nsisTarget,
    /options\.uninstallDisplayName \|\| "\$\{productName\} \$\{version\}"/
  );
  assert.equal(expectedUninstallRegistryKey, '50f6da90-399e-54aa-af01-0403fbb5f1e8');
  assert.notEqual(effectiveUninstallDisplayName, manifest.build.productName);
  assert.ok(effectiveUninstallDisplayName.endsWith(` ${manifest.version}`));
  assert.match(harness, /\$env:GITHUB_ACTIONS -cne 'true'[\s\S]*GITHUB_ACTIONS_REQUIRED/);
  assert.match(harness, /\$env:RUNNER_ENVIRONMENT -cne 'github-hosted'[\s\S]*GITHUB_HOSTED_RUNNER_REQUIRED/);
  assert.match(harness, /\$env:RUNNER_OS -cne 'Windows'[\s\S]*GITHUB_WINDOWS_RUNNER_REQUIRED/);
  assert.match(harness, /Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
  assert.match(harness, /Registry::HKEY_CURRENT_USER\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
  assert.match(harness, /Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
  assert.match(harness, /Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
  assert.match(harness, new RegExp(`\\$expectedAppId = '${manifest.build.appId.replaceAll('.', '\\.')}'`));
  assert.match(harness, new RegExp(`\\$expectedUninstallRegistryKey = '${expectedUninstallRegistryKey}'`));
  assert.match(harness, /\$versionProperty\.Value -isnot \[string\]/);
  assert.match(harness, /\$appIdProperty\.Value -isnot \[string\]/);
  assert.match(harness, /\$productNameProperty\.Value -isnot \[string\]/);
  assert.match(harness, /PACKAGE_APP_ID_CONTRACT_UNSUPPORTED/);
  assert.match(harness, /\$productNameProperty = \$buildProperty\.Value\.PSObject\.Properties\['productName'\]/);
  assert.match(harness, /\$effectiveUninstallDisplayName = "\$productName \$version"/);
  assert.match(harness, /\$entry\.PSChildName, \$UninstallRegistryKey, \[StringComparison\]::OrdinalIgnoreCase/);
  assert.match(harness, /\$displayNameProperty\.Value,[\s\S]*\$EffectiveUninstallDisplayName,[\s\S]*\[StringComparison\]::Ordinal/);
  assert.match(harness, /CUSTOM_NSIS_UNINSTALL_DISPLAY_NAME_UNSUPPORTED/);
  assert.match(harness, /CUSTOM_NSIS_GUID_UNSUPPORTED/);
  assert.match(harness, /SpecialFolder\]::Programs/);
  assert.match(harness, /SpecialFolder\]::CommonPrograms/);
  assert.match(harness, /\$shortcutName = "\$ProductName\.lnk"/);
  assert.match(harness, /StringComparison\]::OrdinalIgnoreCase\)\) \{[\s\S]*return \$true/);
  assert.match(harness, /PRODUCT_IDENTITY_AUDIT_FAILED/);
  const preinstallAuditPattern = /Assert-ProductIdentityAbsent -ProductName \$productName -EffectiveUninstallDisplayName \$effectiveUninstallDisplayName -UninstallRegistryKey \$expectedUninstallRegistryKey -FailureCode 'PRODUCT_IDENTITY_PREEXISTING'/g;
  const postUninstallAuditPattern = /Assert-ProductIdentityAbsent -ProductName \$productName -EffectiveUninstallDisplayName \$effectiveUninstallDisplayName -UninstallRegistryKey \$expectedUninstallRegistryKey -FailureCode 'PRODUCT_IDENTITY_REMAINS_AFTER_UNINSTALL'/g;
  assert.equal((harness.match(preinstallAuditPattern) || []).length, 1);
  assert.equal((harness.match(postUninstallAuditPattern) || []).length, 2);
  assert.ok(
    harness.indexOf("FailureCode 'PRODUCT_IDENTITY_PREEXISTING'")
      < harness.indexOf('Invoke-SilentInstaller -SetupPath $setupFrozen'),
    '必须在调用 Setup 前拒绝已存在的精确产品身份'
  );
  assert.ok(
    harness.indexOf('Invoke-SilentUninstaller -InstallRoot $installRoot')
      < harness.indexOf("FailureCode 'PRODUCT_IDENTITY_REMAINS_AFTER_UNINSTALL'"),
    '必须在卸载后复查 Registry 与 Start Menu 产品身份'
  );
  assert.doesNotMatch(harness, /Remove-Item[^\n]*(?:Registry::|CurrentVersion\\Uninstall|CommonPrograms|SpecialFolder)/);
  assert.match(harness, /BACKGROUND_EXECUTION_PACKAGED_CANARY = '1'/);
  assert.match(harness, /BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH = \$ReportPath/);
  assert.match(harness, /Invoke-SilentInstaller[\s\S]*'\/S',[\s\S]*'\/currentuser',[\s\S]*'--no-desktop-shortcut',[\s\S]*"\/D=\$InstallRoot"/);
  assert.match(harness, /SETUP_FREEZE_IDENTITY_MISMATCH/);
  assert.match(harness, /Invoke-SilentInstaller -SetupPath \$setupFrozen/);
  assert.match(harness, /Select-InstalledExecutable[\s\S]*Invoke-PackagedCanaryVariant -Executable \$installedExecutable/);
  assert.match(harness, /PORTABLE_FREEZE_IDENTITY_MISMATCH/);
  assert.match(harness, /Invoke-PackagedCanaryVariant -Executable \$portableFrozen/);
  assert.match(harness, /REPORT_NOT_RUNNER_TEMP_DIRECT_CHILD/);
  assert.match(harness, /background-execution-packaged-canary-setup-\$runId\.json/);
  assert.match(harness, /background-execution-packaged-canary-portable-\$runId\.json/);
  assert.match(harness, /CANARY_REPORT_TOP_LEVEL_SHAPE_INVALID/);
  assert.match(harness, /CANARY_REPORT_CHECK_SHAPE_INVALID/);
  assert.match(harness, /CANARY_REPORT_UNSAFE_(?:KEY|VALUE)/);
  assert.match(harness, /Length -gt 16384/);
  const waitFunction = harness.slice(
    harness.indexOf('function Wait-CanaryProcess'),
    harness.indexOf('function Assert-SafeJsonNode')
  );
  assert.match(
    waitFunction,
    /\$Process\.Refresh\(\)[\s\S]*\$Process\.HasExited[\s\S]*CANARY_PROCESS_EXITED_BEFORE_REPORT[\s\S]*Start-Sleep/
  );
  assert.ok(
    waitFunction.indexOf('CANARY_PROCESS_EXITED_BEFORE_REPORT')
      < waitFunction.indexOf('CANARY_REPORT_TIMEOUT'),
    '报告前进程退出必须先于统一报告超时快速失败'
  );
  assert.match(harness, /\$env:TEMP = \$runtimeTemp/);
  assert.match(harness, /\$env:TEMP = \$installerTemp/);
  assert.doesNotMatch(harness, /GetTempPath|\$env:(?:USERPROFILE|HOME)|Documents/);
  for (const checkName of [
    'durableCrashAfterCommit',
    'productionPoliciesDisabled',
    'quickCheck',
    'shutdownNoLeak',
    'startupExactlyOnce',
    'workerComplete'
  ]) {
    assert.match(harness, new RegExp(`'${checkName}'`));
  }
  assert.equal((harness.match(/Invoke-PackagedCanaryVariant -Executable \$installedExecutable/g) || []).length, 1);
  assert.equal((harness.match(/Invoke-PackagedCanaryVariant -Executable \$portableFrozen/g) || []).length, 1);
});

test('Windows packaged canary 对报告前已退出进程快速返回专用 safe code', {
  skip: process.platform !== 'win32'
}, (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-canary-early-exit-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const probe = String.raw`
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $env:CANARY_HARNESS_PATH -Raw
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'CANARY_HARNESS_PARSE_FAILED' }
$definitions = $ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)
foreach ($name in @('Throw-SafeFailure', 'Wait-CanaryProcess')) {
  $definition = $definitions | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($null -eq $definition) { throw "CANARY_FUNCTION_NOT_FOUND:$name" }
  Invoke-Expression ([string]$definition.Extent.Text)
}
$process = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'exit 7' -PassThru -WindowStyle Hidden
$process.WaitForExit()
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
try {
  Wait-CanaryProcess -Process $process -ReportPath $env:CANARY_REPORT_PATH -TimeoutSeconds 5 | Out-Null
  throw 'EXPECTED_CANARY_PROCESS_EXIT_FAILURE'
} catch {
  $stopwatch.Stop()
  if ($_.Exception.Data['safeCode'] -ne 'CANARY_PROCESS_EXITED_BEFORE_REPORT') {
    throw "UNEXPECTED_SAFE_CODE:$($_.Exception.Data['safeCode'])"
  }
  if ($stopwatch.Elapsed.TotalSeconds -ge 2) {
    throw "CANARY_EARLY_EXIT_TOO_SLOW:$($stopwatch.Elapsed.TotalSeconds)"
  }
}
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CANARY_HARNESS_PATH: path.join(ROOT, 'scripts/run-windows-packaged-background-canary.ps1'),
      CANARY_REPORT_PATH: path.join(tempDir, 'missing-report.json')
    },
    timeout: 15000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('真实 Windows 进程探针不与全量单测并发，只由专用工作流环境显式开启', () => {
  const adapterTest = read('tests/unit/scripts/startup-process-adapter.test.js');
  assert.match(
    adapterTest,
    /process\.env\.WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST !== '1'/
  );
});
