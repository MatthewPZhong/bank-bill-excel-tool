param([Parameter(Mandatory = $true)][string]$ProbePath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Read-only, one local process/session. Number and DeviceId are evidence, never a join.
$evidence = [ordered]@{
  schemaVersion = 1
  collectedAt = [DateTime]::UtcNow.ToString('o')
  instance = [ordered]@{
    computerName = $env:COMPUTERNAME; runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT; runnerName = $env:RUNNER_NAME
    imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
  }
  probePath = $ProbePath; pathAncestors = @(); computer = $null
  volumes = @(); partitions = @(); disks = @(); osDiskInventory = @()
  physicalDisks = @(); virtualDisks = @(); error = $null
}
function Read-DiskEvidence($disk) {
  [ordered]@{
    ObjectId = $disk.ObjectId; Number = $disk.Number; Path = $disk.Path
    UniqueId = $disk.UniqueId; UniqueIdFormat = $disk.UniqueIdFormat
    SerialNumber = $disk.SerialNumber; Size = [string]$disk.Size
    BusType = [int]$disk.BusType; Location = $disk.Location
    PartitionStyle = [int]$disk.PartitionStyle
    Model = $disk.Model; Manufacturer = $disk.Manufacturer
    IsOffline = $disk.IsOffline; IsClustered = $disk.IsClustered
  }
}
try {
  $item = Get-Item -LiteralPath $ProbePath -Force
  if ($item.PSIsContainer) { throw 'PF disk probe must be the existing case config file.' }
  $evidence.probePath = $item.FullName
  while ($null -ne $item) {
    $evidence.pathAncestors += [ordered]@{
      path = $item.FullName
      reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    }
    if ($item.PSIsContainer) { $item = $item.Parent } else { $item = $item.Directory }
  }
  try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $evidence.computer = [ordered]@{
      Manufacturer = $computer.Manufacturer; Model = $computer.Model
      HypervisorPresent = $computer.HypervisorPresent
    }
  } catch { $evidence.computer = [ordered]@{ error = $_.Exception.Message } }
  # These parameters follow CIM object associations, not separately numbered classes.
  $volumes = @(Get-Volume -FilePath $evidence.probePath)
  $evidence.volumes = @($volumes | ForEach-Object {
    [ordered]@{ ObjectId = $_.ObjectId; UniqueId = $_.UniqueId; Path = $_.Path
      DriveType = [string]$_.DriveType; FileSystem = $_.FileSystem
      Size = [string]$_.Size; SizeRemaining = [string]$_.SizeRemaining }
  })
  foreach ($volume in $volumes) {
    $partitions = @(Get-Partition -Volume $volume)
    foreach ($partition in $partitions) {
      $evidence.partitions += [ordered]@{
        ObjectId = $partition.ObjectId; VolumeUniqueId = $volume.UniqueId
        DiskNumber = $partition.DiskNumber; PartitionNumber = $partition.PartitionNumber
        Type = [string]$partition.Type; AccessPaths = @($partition.AccessPaths)
        MbrType = [int]$partition.MbrType; GptType = $partition.GptType
        Offset = [string]$partition.Offset; Size = [string]$partition.Size
      }
      foreach ($disk in @(Get-Disk -Partition $partition)) {
        $evidence.disks += (Read-DiskEvidence $disk)
        $evidence.virtualDisks += @(Get-VirtualDisk -Disk $disk | Select-Object ObjectId, UniqueId, FriendlyName, Size)
      }
    }
  }
  $evidence.osDiskInventory = @(Get-Disk | ForEach-Object { Read-DiskEvidence $_ })
  $evidence.physicalDisks = @(Get-PhysicalDisk | ForEach-Object {
    [ordered]@{ ObjectId = $_.ObjectId; DeviceId = $_.DeviceId
      UniqueId = $_.UniqueId; UniqueIdFormat = $_.UniqueIdFormat
      SerialNumber = $_.SerialNumber; Size = [string]$_.Size
      BusType = [int]$_.BusType; MediaType = [int]$_.MediaType
      Model = $_.Model; Manufacturer = $_.Manufacturer; PhysicalLocation = $_.PhysicalLocation
      IsPartial = $_.IsPartial; VirtualDiskFootprint = [string]$_.VirtualDiskFootprint }
  })
} catch {
  $evidence.error = $_.Exception.Message
}
$evidence | ConvertTo-Json -Depth 8 -Compress
