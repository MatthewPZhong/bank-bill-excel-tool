[CmdletBinding()]
param(
  [string] $DistDirectory = (Join-Path $PSScriptRoot '..\dist')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Throw-SafeFailure {
  param([Parameter(Mandatory = $true)][string] $Code)
  $errorObject = [InvalidOperationException]::new($Code)
  $errorObject.Data['safeCode'] = $Code
  throw $errorObject
}

function Assert-RunnerTempChild {
  param(
    [Parameter(Mandatory = $true)][string] $RunnerTemp,
    [Parameter(Mandatory = $true)][string] $Candidate,
    [Parameter(Mandatory = $true)][bool] $DirectChild
  )
  $resolvedRunnerTemp = [IO.Path]::GetFullPath($RunnerTemp).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $relative = [IO.Path]::GetRelativePath($resolvedRunnerTemp, $resolvedCandidate)
  if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")) {
    Throw-SafeFailure 'RUNNER_TEMP_BOUNDARY_INVALID'
  }
  if ($DirectChild -and [IO.Path]::GetDirectoryName($resolvedCandidate) -ne $resolvedRunnerTemp) {
    Throw-SafeFailure 'REPORT_NOT_RUNNER_TEMP_DIRECT_CHILD'
  }
  return $resolvedCandidate
}

function Select-SingleArtifact {
  param(
    [Parameter(Mandatory = $true)][string] $Directory,
    [Parameter(Mandatory = $true)][string] $Suffix,
    [Parameter(Mandatory = $true)][string] $FailureCode
  )
  $candidates = @(
    Get-ChildItem -LiteralPath $Directory -File |
      Where-Object { $_.Name.EndsWith($Suffix, [StringComparison]::OrdinalIgnoreCase) }
  )
  if ($candidates.Count -ne 1) {
    Throw-SafeFailure $FailureCode
  }
  return $candidates[0]
}

function Test-ExactRegistryProductIdentity {
  param(
    [Parameter(Mandatory = $true)][string] $EffectiveUninstallDisplayName,
    [Parameter(Mandatory = $true)][string] $UninstallRegistryKey
  )
  $uninstallRoots = @(
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($uninstallRoot in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $uninstallRoot -PathType Container)) {
      continue
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction Stop)) {
      if ([string]::Equals([string]$entry.PSChildName, $UninstallRegistryKey, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
      $properties = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction Stop
      $displayNameProperty = $properties.PSObject.Properties['DisplayName']
      if ($null -ne $displayNameProperty -and
          [string]::Equals(
            [string]$displayNameProperty.Value,
            $EffectiveUninstallDisplayName,
            [StringComparison]::Ordinal
          )) {
        return $true
      }
    }
  }
  return $false
}

function Test-ExactStartMenuShortcut {
  param([Parameter(Mandatory = $true)][string] $ProductName)
  $shortcutName = "$ProductName.lnk"
  $programRoots = @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
  ) | Select-Object -Unique
  foreach ($programRoot in $programRoots) {
    if ([string]::IsNullOrWhiteSpace($programRoot) -or
        -not (Test-Path -LiteralPath $programRoot -PathType Container)) {
      continue
    }
    foreach ($shortcut in @(Get-ChildItem -LiteralPath $programRoot -File -Recurse -Force -ErrorAction Stop)) {
      if ([string]::Equals($shortcut.Name, $shortcutName, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }
  return $false
}

function Assert-ProductIdentityAbsent {
  param(
    [Parameter(Mandatory = $true)][string] $ProductName,
    [Parameter(Mandatory = $true)][string] $EffectiveUninstallDisplayName,
    [Parameter(Mandatory = $true)][string] $UninstallRegistryKey,
    [Parameter(Mandatory = $true)][string] $FailureCode
  )
  try {
    $identityPresent = (Test-ExactRegistryProductIdentity `
      -EffectiveUninstallDisplayName $EffectiveUninstallDisplayName `
      -UninstallRegistryKey $UninstallRegistryKey) -or
      (Test-ExactStartMenuShortcut -ProductName $ProductName)
  } catch {
    Throw-SafeFailure 'PRODUCT_IDENTITY_AUDIT_FAILED'
  }
  if ($identityPresent) {
    Throw-SafeFailure $FailureCode
  }
}

function Wait-CanaryProcess {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)][string] $ReportPath,
    [int] $TimeoutSeconds = 180
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        Throw-SafeFailure 'CANARY_PROCESS_EXITED_BEFORE_REPORT'
      }
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
    $Process.Refresh()
    if ($Process.HasExited) {
      Throw-SafeFailure 'CANARY_PROCESS_EXITED_BEFORE_REPORT'
    }
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Throw-SafeFailure 'CANARY_REPORT_TIMEOUT'
  }
  while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $Process.Refresh()
  }
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Throw-SafeFailure 'CANARY_PROCESS_TIMEOUT'
  }
  return $Process.ExitCode
}

function Assert-SafeJsonNode {
  param(
    [Parameter(Mandatory = $false)] $Value,
    [int] $Depth = 0
  )
  if ($Depth -gt 8) {
    Throw-SafeFailure 'CANARY_REPORT_DEPTH_INVALID'
  }
  if ($null -eq $Value -or $Value -is [bool] -or $Value -is [ValueType]) {
    return
  }
  if ($Value -is [string]) {
    if ($Value.Length -gt 256 -or $Value -match '(?i)(?:[a-z]:[\\/]|\\\\|file:|/users/|/home/|user[_-]?data)') {
      Throw-SafeFailure 'CANARY_REPORT_UNSAFE_VALUE'
    }
    return
  }
  if ($Value -is [Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      if ([string]$key -match '(?i)(?:path|file|directory|user[_-]?data)') {
        Throw-SafeFailure 'CANARY_REPORT_UNSAFE_KEY'
      }
      Assert-SafeJsonNode -Value $Value[$key] -Depth ($Depth + 1)
    }
    return
  }
  if ($Value -is [Collections.IEnumerable] -and $Value -isnot [pscustomobject]) {
    foreach ($item in $Value) {
      Assert-SafeJsonNode -Value $item -Depth ($Depth + 1)
    }
    return
  }
  foreach ($property in $Value.PSObject.Properties) {
    if ($property.Name -match '(?i)(?:path|file|directory|user[_-]?data)') {
      Throw-SafeFailure 'CANARY_REPORT_UNSAFE_KEY'
    }
    Assert-SafeJsonNode -Value $property.Value -Depth ($Depth + 1)
  }
}

function Read-CanaryReport {
  param([Parameter(Mandatory = $true)][string] $ReportPath)
  $reportFile = Get-Item -LiteralPath $ReportPath -Force
  if (($reportFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $reportFile.Length -le 0 -or $reportFile.Length -gt 16384) {
    Throw-SafeFailure 'CANARY_REPORT_FILE_INVALID'
  }
  try {
    $report = Get-Content -LiteralPath $ReportPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    Throw-SafeFailure 'CANARY_REPORT_JSON_INVALID'
  }
  Assert-SafeJsonNode -Value $report

  $expectedTopLevel = @('appAsar', 'checks', 'mode', 'packaged', 'schemaVersion', 'status')
  $actualTopLevel = @($report.PSObject.Properties.Name | Sort-Object)
  $topLevelDifferences = @(Compare-Object $expectedTopLevel $actualTopLevel)
  if ($topLevelDifferences.Count -ne 0) {
    Throw-SafeFailure 'CANARY_REPORT_TOP_LEVEL_SHAPE_INVALID'
  }
  if ($report.schemaVersion -ne 1 -or $report.mode -ne 'packaged-background-execution-canary' -or
      $report.status -ne 'PASS' -or $report.packaged -isnot [bool] -or $report.packaged -ne $true -or
      $report.appAsar -isnot [bool] -or $report.appAsar -ne $true) {
    Throw-SafeFailure 'CANARY_REPORT_OUTCOME_INVALID'
  }
  $expectedChecks = @(
    'durableCrashAfterCommit',
    'productionPoliciesDisabled',
    'quickCheck',
    'shutdownNoLeak',
    'startupExactlyOnce',
    'workerComplete'
  )
  $actualChecks = @($report.checks.PSObject.Properties.Name | Sort-Object)
  $checkDifferences = @(Compare-Object $expectedChecks $actualChecks)
  if ($checkDifferences.Count -ne 0) {
    Throw-SafeFailure 'CANARY_REPORT_CHECK_SHAPE_INVALID'
  }
  foreach ($checkName in $expectedChecks) {
    if ($report.checks.$checkName -isnot [bool] -or $report.checks.$checkName -ne $true) {
      Throw-SafeFailure 'CANARY_REPORT_CHECK_FAILED'
    }
  }
  return $report
}

function Invoke-PackagedCanaryVariant {
  param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string] $ReportPath,
    [Parameter(Mandatory = $true)][string] $VariantRoot
  )
  if (Test-Path -LiteralPath $ReportPath) {
    Throw-SafeFailure 'CANARY_REPORT_PREEXISTING'
  }
  $userDataRoot = Join-Path $VariantRoot 'user-data'
  $runtimeTemp = Join-Path $VariantRoot 'runtime-temp'
  $appDataRoot = Join-Path $VariantRoot 'app-data'
  $localAppDataRoot = Join-Path $VariantRoot 'local-app-data'
  foreach ($directory in @($userDataRoot, $runtimeTemp, $appDataRoot, $localAppDataRoot)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }

  $savedEnvironment = @{}
  foreach ($name in @(
    'BACKGROUND_EXECUTION_PACKAGED_CANARY',
    'BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA'
  )) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:BACKGROUND_EXECUTION_PACKAGED_CANARY = '1'
    $env:BACKGROUND_EXECUTION_PACKAGED_CANARY_REPORT_PATH = $ReportPath
    $env:TEMP = $runtimeTemp
    $env:TMP = $runtimeTemp
    $env:APPDATA = $appDataRoot
    $env:LOCALAPPDATA = $localAppDataRoot
    $process = Start-Process -FilePath $Executable -ArgumentList @("--user-data-dir=`"$userDataRoot`"") -PassThru -WindowStyle Hidden
    $exitCode = Wait-CanaryProcess -Process $process -ReportPath $ReportPath
  } finally {
    foreach ($name in $savedEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
  }
  $report = Read-CanaryReport -ReportPath $ReportPath
  if ($exitCode -ne 0) {
    Throw-SafeFailure 'CANARY_PROCESS_NONZERO_EXIT'
  }
  return $report
}

function Invoke-SilentInstaller {
  param(
    [Parameter(Mandatory = $true)][string] $SetupPath,
    [Parameter(Mandatory = $true)][string] $InstallRoot,
    [Parameter(Mandatory = $true)][string] $EnvironmentRoot
  )
  New-Item -ItemType Directory -Path $InstallRoot | Out-Null
  $installerTemp = Join-Path $EnvironmentRoot 'temp'
  $installerAppData = Join-Path $EnvironmentRoot 'app-data'
  $installerLocalAppData = Join-Path $EnvironmentRoot 'local-app-data'
  foreach ($directory in @($installerTemp, $installerAppData, $installerLocalAppData)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $savedEnvironment = @{}
  foreach ($name in @('TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:TEMP = $installerTemp
    $env:TMP = $installerTemp
    $env:APPDATA = $installerAppData
    $env:LOCALAPPDATA = $installerLocalAppData
    $process = Start-Process -FilePath $SetupPath -ArgumentList @(
      '/S',
      '/currentuser',
      '--no-desktop-shortcut',
      "/D=$InstallRoot"
    ) -PassThru -Wait -WindowStyle Hidden
  } finally {
    foreach ($name in $savedEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
  }
  if ($process.ExitCode -ne 0) {
    Throw-SafeFailure 'SETUP_NONZERO_EXIT'
  }
}

function Select-InstalledExecutable {
  param([Parameter(Mandatory = $true)][string] $InstallRoot)
  $candidates = @(
    Get-ChildItem -LiteralPath $InstallRoot -File -Filter '*.exe' |
      Where-Object { $_.Name -notmatch '^(?:uninstall|unins)' }
  )
  if ($candidates.Count -ne 1) {
    Throw-SafeFailure 'INSTALLED_EXECUTABLE_AMBIGUOUS'
  }
  return $candidates[0].FullName
}

function Invoke-SilentUninstaller {
  param(
    [Parameter(Mandatory = $true)][string] $InstallRoot,
    [Parameter(Mandatory = $true)][string] $EnvironmentRoot
  )
  if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    return
  }
  $candidates = @(
    Get-ChildItem -LiteralPath $InstallRoot -File -Filter '*.exe' |
      Where-Object { $_.Name -match '^(?:uninstall|unins)' }
  )
  if ($candidates.Count -ne 1) {
    Throw-SafeFailure 'UNINSTALLER_AMBIGUOUS'
  }
  $installerTemp = Join-Path $EnvironmentRoot 'temp'
  $installerAppData = Join-Path $EnvironmentRoot 'app-data'
  $installerLocalAppData = Join-Path $EnvironmentRoot 'local-app-data'
  $savedEnvironment = @{}
  foreach ($name in @('TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:TEMP = $installerTemp
    $env:TMP = $installerTemp
    $env:APPDATA = $installerAppData
    $env:LOCALAPPDATA = $installerLocalAppData
    $process = Start-Process -FilePath $candidates[0].FullName -ArgumentList @('/S') -PassThru -Wait -WindowStyle Hidden
  } finally {
    foreach ($name in $savedEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
  }
  if ($process.ExitCode -ne 0) {
    Throw-SafeFailure 'UNINSTALLER_NONZERO_EXIT'
  }
}

function Invoke-WindowsPackagedBackgroundCanary {
  if (-not $IsWindows) {
    Throw-SafeFailure 'WINDOWS_REQUIRED'
  }
  if ($env:GITHUB_ACTIONS -cne 'true') {
    Throw-SafeFailure 'GITHUB_ACTIONS_REQUIRED'
  }
  if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    Throw-SafeFailure 'GITHUB_HOSTED_RUNNER_REQUIRED'
  }
  if ($env:RUNNER_OS -cne 'Windows') {
    Throw-SafeFailure 'GITHUB_WINDOWS_RUNNER_REQUIRED'
  }
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    Throw-SafeFailure 'RUNNER_TEMP_REQUIRED'
  }
  $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $runnerTempEntry = Get-Item -LiteralPath $runnerTemp -Force
  if (($runnerTempEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-SafeFailure 'RUNNER_TEMP_REPARSE_POINT_REFUSED'
  }
  $resolvedDist = [IO.Path]::GetFullPath($DistDirectory)
  if (-not (Test-Path -LiteralPath $resolvedDist -PathType Container)) {
    Throw-SafeFailure 'DIST_DIRECTORY_MISSING'
  }
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $versionProperty = $manifest.PSObject.Properties['version']
  if ($null -eq $versionProperty -or $versionProperty.Value -isnot [string]) {
    Throw-SafeFailure 'PACKAGE_VERSION_INVALID'
  }
  $version = [string]$versionProperty.Value
  if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Throw-SafeFailure 'PACKAGE_VERSION_INVALID'
  }
  $buildProperty = $manifest.PSObject.Properties['build']
  if ($null -eq $buildProperty -or $buildProperty.Value -isnot [pscustomobject]) {
    Throw-SafeFailure 'PACKAGE_BUILD_INVALID'
  }
  $appIdProperty = $buildProperty.Value.PSObject.Properties['appId']
  if ($null -eq $appIdProperty -or $appIdProperty.Value -isnot [string]) {
    Throw-SafeFailure 'PACKAGE_APP_ID_INVALID'
  }
  $appId = [string]$appIdProperty.Value
  if ([string]::IsNullOrWhiteSpace($appId) -or $appId.Length -gt 255 -or
      $appId -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$') {
    Throw-SafeFailure 'PACKAGE_APP_ID_INVALID'
  }
  $expectedAppId = 'com.openai.bankbillexceltool'
  $expectedUninstallRegistryKey = '50f6da90-399e-54aa-af01-0403fbb5f1e8'
  if ($appId -cne $expectedAppId) {
    Throw-SafeFailure 'PACKAGE_APP_ID_CONTRACT_UNSUPPORTED'
  }
  $productNameProperty = $buildProperty.Value.PSObject.Properties['productName']
  if ($null -eq $productNameProperty -or $productNameProperty.Value -isnot [string]) {
    Throw-SafeFailure 'PACKAGE_PRODUCT_NAME_INVALID'
  }
  $productName = [string]$productNameProperty.Value
  if ([string]::IsNullOrWhiteSpace($productName) -or $productName.Length -gt 128 -or
      $productName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    Throw-SafeFailure 'PACKAGE_PRODUCT_NAME_INVALID'
  }
  $nsisProperty = $buildProperty.Value.PSObject.Properties['nsis']
  if ($null -ne $nsisProperty -and $null -ne $nsisProperty.Value) {
    $customUninstallDisplayNameProperty = $nsisProperty.Value.PSObject.Properties['uninstallDisplayName']
    if ($null -ne $customUninstallDisplayNameProperty -and
        $null -ne $customUninstallDisplayNameProperty.Value -and
        ([string]$customUninstallDisplayNameProperty.Value).Length -gt 0) {
      Throw-SafeFailure 'CUSTOM_NSIS_UNINSTALL_DISPLAY_NAME_UNSUPPORTED'
    }
    $customGuidProperty = $nsisProperty.Value.PSObject.Properties['guid']
    if ($null -ne $customGuidProperty -and $null -ne $customGuidProperty.Value -and
        ([string]$customGuidProperty.Value).Length -gt 0) {
      Throw-SafeFailure 'CUSTOM_NSIS_GUID_UNSUPPORTED'
    }
  }
  $effectiveUninstallDisplayName = "$productName $version"
  $setup = Select-SingleArtifact -Directory $resolvedDist -Suffix "-$version-setup.exe" -FailureCode 'SETUP_ARTIFACT_AMBIGUOUS'
  $portable = Select-SingleArtifact -Directory $resolvedDist -Suffix "-$version-portable.exe" -FailureCode 'PORTABLE_ARTIFACT_AMBIGUOUS'

  $runId = [Guid]::NewGuid().ToString('N')
  $workRoot = Assert-RunnerTempChild -RunnerTemp $runnerTemp -Candidate (Join-Path $runnerTemp "background-execution-packaged-canary-$runId") -DirectChild $true
  $setupReportPath = Assert-RunnerTempChild -RunnerTemp $runnerTemp -Candidate (Join-Path $runnerTemp "background-execution-packaged-canary-setup-$runId.json") -DirectChild $true
  $portableReportPath = Assert-RunnerTempChild -RunnerTemp $runnerTemp -Candidate (Join-Path $runnerTemp "background-execution-packaged-canary-portable-$runId.json") -DirectChild $true
  New-Item -ItemType Directory -Path $workRoot | Out-Null
  if (((Get-Item -LiteralPath $workRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-SafeFailure 'WORK_ROOT_REPARSE_POINT_REFUSED'
  }
  Set-Content -LiteralPath (Join-Path $workRoot '.owned-by-packaged-background-canary') -Value $runId -Encoding ascii -NoNewline

  $installRoot = Join-Path $workRoot 'installed'
  $installerEnvironmentRoot = Join-Path $workRoot 'installer-environment'
  $artifactRoot = Join-Path $workRoot 'artifacts'
  $installedExecutable = $null
  $uninstallCompleted = $false
  $cleanupFailed = $false
  try {
    New-Item -ItemType Directory -Path $artifactRoot | Out-Null
    $setupFrozen = Join-Path $artifactRoot 'setup.exe'
    Copy-Item -LiteralPath $setup.FullName -Destination $setupFrozen
    if ((Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $setupFrozen -Algorithm SHA256).Hash) {
      Throw-SafeFailure 'SETUP_FREEZE_IDENTITY_MISMATCH'
    }
    Assert-ProductIdentityAbsent -ProductName $productName -EffectiveUninstallDisplayName $effectiveUninstallDisplayName -UninstallRegistryKey $expectedUninstallRegistryKey -FailureCode 'PRODUCT_IDENTITY_PREEXISTING'
    Invoke-SilentInstaller -SetupPath $setupFrozen -InstallRoot $installRoot -EnvironmentRoot $installerEnvironmentRoot
    $installedExecutable = Select-InstalledExecutable -InstallRoot $installRoot
    $setupVariantRoot = Join-Path $workRoot 'setup-runtime'
    New-Item -ItemType Directory -Path $setupVariantRoot | Out-Null
    $null = Invoke-PackagedCanaryVariant -Executable $installedExecutable -ReportPath $setupReportPath -VariantRoot $setupVariantRoot

    # 复用仓库既有 Windows acceptance 的 portable-frozen-copy 机制：先做字节身份冻结，再只启动冻结副本一次。
    $portableRoot = Join-Path $workRoot 'portable-runtime'
    New-Item -ItemType Directory -Path $portableRoot | Out-Null
    $portableFrozen = Join-Path $portableRoot 'portable.exe'
    Copy-Item -LiteralPath $portable.FullName -Destination $portableFrozen
    if ((Get-FileHash -LiteralPath $portable.FullName -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $portableFrozen -Algorithm SHA256).Hash) {
      Throw-SafeFailure 'PORTABLE_FREEZE_IDENTITY_MISMATCH'
    }
    $null = Invoke-PackagedCanaryVariant -Executable $portableFrozen -ReportPath $portableReportPath -VariantRoot $portableRoot

    Invoke-SilentUninstaller -InstallRoot $installRoot -EnvironmentRoot $installerEnvironmentRoot
    $uninstallCompleted = $true
    Assert-ProductIdentityAbsent -ProductName $productName -EffectiveUninstallDisplayName $effectiveUninstallDisplayName -UninstallRegistryKey $expectedUninstallRegistryKey -FailureCode 'PRODUCT_IDENTITY_REMAINS_AFTER_UNINSTALL'
    if ($null -ne $installedExecutable -and (Test-Path -LiteralPath $installedExecutable)) {
      Throw-SafeFailure 'UNINSTALL_NOT_VERIFIED'
    }
    return [ordered]@{
      schemaVersion = 1
      mode = 'windows-packaged-background-execution-canary'
      status = 'PASS'
      variants = [ordered]@{ setup = 'PASS'; portable = 'PASS' }
    }
  } finally {
    if (-not $uninstallCompleted -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
      try {
        Invoke-SilentUninstaller -InstallRoot $installRoot -EnvironmentRoot $installerEnvironmentRoot
        $uninstallCompleted = $true
        Assert-ProductIdentityAbsent -ProductName $productName -EffectiveUninstallDisplayName $effectiveUninstallDisplayName -UninstallRegistryKey $expectedUninstallRegistryKey -FailureCode 'PRODUCT_IDENTITY_REMAINS_AFTER_UNINSTALL'
      } catch {
        $cleanupFailed = $true
      }
    }
    foreach ($reportPath in @($setupReportPath, $portableReportPath)) {
      if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
        Remove-Item -LiteralPath $reportPath -Force
      }
    }
    $markerPath = Join-Path $workRoot '.owned-by-packaged-background-canary'
    if ((Test-Path -LiteralPath $markerPath -PathType Leaf) -and
        (Get-Content -LiteralPath $markerPath -Raw -Encoding ascii) -eq $runId) {
      Remove-Item -LiteralPath $workRoot -Recurse -Force
    } else {
      Throw-SafeFailure 'WORK_ROOT_OWNERSHIP_INVALID'
    }
    if ($cleanupFailed) {
      Throw-SafeFailure 'UNINSTALL_CLEANUP_FAILED'
    }
  }
}

try {
  $summary = Invoke-WindowsPackagedBackgroundCanary
  [Console]::Out.WriteLine(($summary | ConvertTo-Json -Compress -Depth 4))
} catch {
  $safeCode = if ($_.Exception.Data.Contains('safeCode')) {
    [string]$_.Exception.Data['safeCode']
  } else {
    'CANARY_HARNESS_FAILED'
  }
  $failure = [ordered]@{
    schemaVersion = 1
    mode = 'windows-packaged-background-execution-canary'
    status = 'FAIL'
    code = $safeCode
  }
  [Console]::Error.WriteLine(($failure | ConvertTo-Json -Compress))
  exit 1
}
