$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DirectoryDurabilityProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FlushFileBuffers(SafeFileHandle handle);
}
'@
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('bizop-native-durability-' + [Guid]::NewGuid())
[IO.Directory]::CreateDirectory($probeRoot) | Out-Null
$records = @()
try {
  $accessModes = @(
    @{ name='GENERIC_READ'; value=[uint32]2147483648 },
    @{ name='GENERIC_WRITE'; value=[uint32]1073741824 },
    @{ name='GENERIC_READ_WRITE'; value=[uint32]3221225472 },
    @{ name='FILE_WRITE_DATA'; value=[uint32]2 },
    @{ name='FILE_WRITE_ATTRIBUTES'; value=[uint32]256 }
  )
  foreach ($mode in $accessModes) {
    foreach ($writeThrough in @($false,$true)) {
      $flags = [uint32]33554432
      if ($writeThrough) { $flags = [uint32]($flags -bor [uint32]2147483648) }
      $handle = [DirectoryDurabilityProbe]::CreateFileW($probeRoot, $mode.value, 7, [IntPtr]::Zero, 3, $flags, [IntPtr]::Zero)
      $openError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      try {
        if ($handle.IsInvalid) {
          $records += @{ access=$mode.name; writeThrough=$writeThrough; phase='open'; success=$false; error=$openError }
        } else {
          $success = [DirectoryDurabilityProbe]::FlushFileBuffers($handle)
          $flushError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          $records += @{ access=$mode.name; writeThrough=$writeThrough; phase='flush'; success=$success; error=$(if($success){0}else{$flushError}) }
        }
      } finally { $handle.Dispose() }
    }
  }
} finally { [IO.Directory]::Delete($probeRoot, $true) }
$output = @{ os=[Environment]::OSVersion.VersionString; records=$records }
$json = $output | ConvertTo-Json -Depth 10
New-Item -ItemType Directory -Force outputs/windows-durability-probe | Out-Null
$json | Set-Content -Encoding utf8 outputs/windows-durability-probe/native-probe.json
Write-Output $json
