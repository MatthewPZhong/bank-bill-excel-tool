param(
  [Parameter(Mandatory = $true)][string]$CollectorPath,
  [Parameter(Mandatory = $true)][string]$ProbePath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Controlled Storage cmdlet objects; Get-Item/DirectoryInfo use the real temp file.
# This exercises PowerShell serialization, not the host's native storage provider.
function New-EnumProperty($value, [string]$type = 'UInt16') {
  [pscustomobject]@{ Value = $value; CimType = $type }
}
function Get-CimInstance { param($ClassName)
  if ($ClassName -ne 'Win32_ComputerSystem') { throw 'Unexpected computer query.' }
  [pscustomobject]@{ Manufacturer = 'controlled'; Model = 'physical-test'; HypervisorPresent = $false }
}
function Get-Volume { param($FilePath)
  if ($FilePath -ne $ProbePath) { throw 'Collector did not query the actual config file.' }
  $fixtureVolume
}
function Get-Partition { param($Volume)
  if (-not [Object]::ReferenceEquals($Volume, $fixtureVolume)) { throw 'Volume association was lost.' }
  $fixturePartition
}
function Get-Disk { param($Partition)
  if ($null -ne $Partition -and -not [Object]::ReferenceEquals($Partition, $fixturePartition)) { throw 'Partition association was lost.' }
  $fixtureDisk
}
function Get-VirtualDisk { param($Disk)
  if (-not [Object]::ReferenceEquals($Disk, $fixtureDisk)) { throw 'Disk association was lost.' }
}
function Get-PhysicalDisk { $fixturePhysical }

$results = foreach ($case in @('sas-ssd', 'unknown-media', 'string-media', 'missing-media', 'null-mbr', 'wrong-runtime-type')) {
  $fixtureVolume = [pscustomobject]@{
    ObjectId = 'volume-object'; UniqueId = 'volume-a'; Path = '\\?\Volume{00000000-0000-0000-0000-000000000001}\'
    DriveType = 'Fixed'; FileSystem = 'NTFS'; Size = [UInt64]500000000000; SizeRemaining = [UInt64]400000000000
  }
  $fixturePartition = [pscustomobject]@{
    ObjectId = 'partition-object'; DiskNumber = 1; PartitionNumber = 1; Type = 'IFS'; MbrType = 7; GptType = $null
    AccessPaths = @([IO.Path]::GetPathRoot($ProbePath), $fixtureVolume.Path)
    Offset = [UInt64]1048576; Size = [UInt64]500000000000
    CimInstanceProperties = @{ MbrType = New-EnumProperty ([UInt16]7) }
  }
  $fixtureDisk = [pscustomobject]@{
    ObjectId = 'os-disk-object'; Number = 1; Path = '\\?\SCSI#DiskA'
    UniqueId = '5002538e00000001'; UniqueIdFormat = 'FCPH Name'; SerialNumber = 'serial-a'
    Size = [UInt64]512000000000; BusType = 'SAS'; PartitionStyle = 'MBR'
    Location = 'PCIROOT(0)#SAS(P00T00L00)'; Model = 'controlled'; Manufacturer = 'controlled'
    IsOffline = $false; IsClustered = $false
    CimInstanceProperties = @{
      BusType = New-EnumProperty ([UInt16]10)
      PartitionStyle = New-EnumProperty ([UInt16]1)
      UniqueIdFormat = New-EnumProperty ([UInt16]3)
    }
  }
  $fixturePhysical = [pscustomobject]@{
    ObjectId = 'physical-object'; DeviceId = '7'; UniqueId = $fixtureDisk.UniqueId
    UniqueIdFormat = 'FCPH Name'; SerialNumber = $fixtureDisk.SerialNumber; Size = $fixtureDisk.Size
    BusType = 'SAS'; MediaType = 'SSD'; Model = 'controlled'; Manufacturer = 'controlled'
    PhysicalLocation = 'controlled'; IsPartial = $null; VirtualDiskFootprint = $null
    CimInstanceProperties = @{
      BusType = New-EnumProperty ([UInt16]10)
      MediaType = New-EnumProperty ([UInt16]4)
      UniqueIdFormat = New-EnumProperty ([UInt16]3)
    }
  }
  switch ($case) {
    'unknown-media' { $fixturePhysical.CimInstanceProperties.MediaType = New-EnumProperty ([UInt16]0) }
    'string-media' { $fixturePhysical.CimInstanceProperties.MediaType = New-EnumProperty 'SSD' 'String' }
    'missing-media' { $fixturePhysical.CimInstanceProperties.Remove('MediaType') }
    'null-mbr' {
      $fixturePartition.CimInstanceProperties.MbrType = New-EnumProperty $null
      $fixturePartition.MbrType = $null
      $fixturePartition.GptType = '{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}'
      $fixtureDisk.CimInstanceProperties.PartitionStyle = New-EnumProperty ([UInt16]2)
      $fixtureDisk.PartitionStyle = 'GPT'
    }
    'wrong-runtime-type' { $fixturePhysical.CimInstanceProperties.MediaType = New-EnumProperty '4' }
  }
  $raw = & $CollectorPath -ProbePath $ProbePath
  [ordered]@{ case = $case; evidence = ($raw | ConvertFrom-Json) }
}
ConvertTo-Json -InputObject @($results) -Depth 12 -Compress
