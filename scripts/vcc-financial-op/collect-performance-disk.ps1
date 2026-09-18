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
function Read-CimUInt16Evidence($instance, [string]$name) {
  # Storage cmdlets expose display strings such as SAS/SSD through type data.
  # Read the underlying CIM value without parsing or guessing from that display.
  $property = $instance.CimInstanceProperties[$name]
  $rawValue = if ($null -ne $property) { $property.Value } else { $null }
  $cimType = if ($null -ne $property) { [string]$property.CimType } else { $null }
  $valueType = if ($null -ne $rawValue) { $rawValue.GetType().FullName } else { $null }
  $value = if ($cimType -eq 'UInt16' -and $rawValue -is [UInt16]) { [int]$rawValue } else { $null }
  [ordered]@{
    value = $value; rawValue = $rawValue; cimType = $cimType; valueType = $valueType
    present = ($null -ne $property); displayValue = [string]$instance.$name
  }
}
function Read-DiskEvidence($disk) {
  $enums = [ordered]@{
    BusType = Read-CimUInt16Evidence $disk 'BusType'
    PartitionStyle = Read-CimUInt16Evidence $disk 'PartitionStyle'
    UniqueIdFormat = Read-CimUInt16Evidence $disk 'UniqueIdFormat'
  }
  [ordered]@{
    ObjectId = $disk.ObjectId; Number = $disk.Number; Path = $disk.Path
    UniqueId = $disk.UniqueId; UniqueIdFormat = $enums.UniqueIdFormat.value
    SerialNumber = $disk.SerialNumber; Size = [string]$disk.Size
    BusType = $enums.BusType.value; Location = $disk.Location
    PartitionStyle = $enums.PartitionStyle.value; CimEnums = $enums
    Model = $disk.Model; Manufacturer = $disk.Manufacturer
    IsOffline = $disk.IsOffline; IsClustered = $disk.IsClustered
  }
}
try {
  $item = Get-Item -LiteralPath $ProbePath -Force
  if ($item -isnot [IO.FileInfo]) { throw 'PF disk probe must be the existing case config file.' }
  $evidence.probePath = $item.FullName
  while ($null -ne $item) {
    $evidence.pathAncestors += [ordered]@{
      path = $item.FullName
      reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    }
    # Directory/Parent return native DirectoryInfo without provider PSIsContainer.
    if ($item -is [IO.DirectoryInfo]) { $item = $item.Parent } else { $item = $item.Directory }
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
      $mbrType = Read-CimUInt16Evidence $partition 'MbrType'
      $evidence.partitions += [ordered]@{
        ObjectId = $partition.ObjectId; VolumeUniqueId = $volume.UniqueId
        DiskNumber = $partition.DiskNumber; PartitionNumber = $partition.PartitionNumber
        Type = [string]$partition.Type; AccessPaths = @($partition.AccessPaths)
        MbrType = $mbrType.value; GptType = $partition.GptType
        CimEnums = [ordered]@{ MbrType = $mbrType }
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
    $enums = [ordered]@{
      BusType = Read-CimUInt16Evidence $_ 'BusType'
      MediaType = Read-CimUInt16Evidence $_ 'MediaType'
      UniqueIdFormat = Read-CimUInt16Evidence $_ 'UniqueIdFormat'
    }
    [ordered]@{ ObjectId = $_.ObjectId; DeviceId = $_.DeviceId
      UniqueId = $_.UniqueId; UniqueIdFormat = $enums.UniqueIdFormat.value
      SerialNumber = $_.SerialNumber; Size = [string]$_.Size
      BusType = $enums.BusType.value; MediaType = $enums.MediaType.value; CimEnums = $enums
      Model = $_.Model; Manufacturer = $_.Manufacturer; PhysicalLocation = $_.PhysicalLocation
      IsPartial = $_.IsPartial; VirtualDiskFootprint = [string]$_.VirtualDiskFootprint }
  })
} catch {
  $evidence.error = $_.Exception.Message
}
$evidence | ConvertTo-Json -Depth 8 -Compress
