'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// MSFT_Disk / MSFT_PhysicalDisk document VPD page 0x83 identity formats.
// Only a conservative direct-device subset is supported; no number/name fallback.
const METHOD = 'CIM file-volume-partition-disk; unique standard VPD + serial/size/bus';
const text = (value) => typeof value === 'string' ? value.trim() : '';
const identifier = (value) => {
  const id = text(value);
  return id && /[\p{L}\p{N}]/u.test(id) && !/^(unknown|unspecified|none|null|n\/?a)$/i.test(id)
    && !/^0+$/.test(id.replace(/[^a-z0-9]/gi, '')) ? id : null;
};
const positiveBytes = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

function evaluateDiskEvidence(evidence, probePath) {
  const proof = { status: 'NOT_RUN', method: METHOD, reason: '', targetUniqueId: null, matchedPhysicalUniqueId: null };
  const reject = (reason) => ({ ...proof, reason });
  if (!evidence || evidence.schemaVersion !== 1 || evidence.error) return reject('磁盘查询失败或证据版本不支持');
  if (!identifier(evidence.instance?.computerName) || !Number.isFinite(Date.parse(evidence.collectedAt))) {
    return reject('缺少同实例采集身份或时间');
  }
  if (!/^[a-z]:\\/i.test(probePath) || !samePath(evidence.probePath, probePath)) return reject('实际测试文件路径未绑定');
  for (const key of ['pathAncestors', 'volumes', 'partitions', 'disks', 'osDiskInventory', 'physicalDisks', 'virtualDisks']) {
    if (!Array.isArray(evidence[key]) || evidence[key].some((item) => !item || typeof item !== 'object')) {
      return reject('磁盘关联清单缺失或无效：' + key);
    }
  }
  const ancestors = [];
  for (let current = path.win32.normalize(probePath);;) {
    ancestors.push(current);
    const parent = path.win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (evidence.pathAncestors.length !== ancestors.length || ancestors.some((value, index) =>
    !samePath(evidence.pathAncestors[index]?.path, value) || evidence.pathAncestors[index]?.reparsePoint !== false)) {
    return reject('测试文件或祖先路径含重解析点，或路径证据不完整');
  }
  if (evidence.volumes.length !== 1 || evidence.partitions.length !== 1 || evidence.disks.length !== 1) {
    return reject('不支持未知、多分区或多盘卷关联');
  }
  const [volume] = evidence.volumes, [partition] = evidence.partitions, [disk] = evidence.disks;
  const basicPartition = (disk.PartitionStyle === 1 && [1, 4, 6, 7, 11, 12, 14].includes(partition.MbrType))
    || (disk.PartitionStyle === 2 && text(partition.GptType).replace(/[{}]/g, '').toLowerCase() === 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7');
  if (volume.DriveType !== 'Fixed' || !identifier(volume.UniqueId) || !identifier(volume.Path)
      || partition.VolumeUniqueId !== volume.UniqueId || !basicPartition
      || !Number.isSafeInteger(disk.Number) || disk.Number < 0 || partition.DiskNumber !== disk.Number
      || !positiveBytes(volume.Size) || !positiveBytes(partition.Size) || !positiveBytes(disk.Size)
      || typeof partition.Offset !== 'string' || !/^(0|[1-9][0-9]*)$/.test(partition.Offset)
      || !Array.isArray(partition.AccessPaths) || !partition.AccessPaths.some((value) => samePath(value, volume.Path))) {
    return reject('本地基本卷到 OS 磁盘的关联证据不完整');
  }
  if (BigInt(volume.Size) > BigInt(partition.Size)
      || BigInt(partition.Offset) + BigInt(partition.Size) > BigInt(disk.Size)) return reject('卷或分区范围与磁盘容量冲突');
  // Guest/virtual/pool topology needs separate provider evidence; none is inferred here.
  const machine = [evidence.computer?.Manufacturer, evidence.computer?.Model].map(text).join(' ');
  if (/virtual machine|vmware|virtualbox|kvm|qemu|xen|hvm domu|parallels|bochs|bhyve|openstack|google compute engine|amazon ec2/i.test(machine)) {
    return reject('已标识虚拟机，缺少绑定目标存储的宿主介质证明');
  }
  if (evidence.virtualDisks.length || ![3, 10, 11, 17].includes(disk.BusType) || !identifier(disk.Location)
      || disk.IsOffline !== false || disk.IsClustered !== false) return reject('虚拟层或非受支持的直接磁盘拓扑');
  const targetId = identifier(disk.UniqueId);
  proof.targetUniqueId = disk.UniqueId ?? null;
  if (!targetId || ![2, 3, 8].includes(disk.UniqueIdFormat) || !identifier(disk.SerialNumber)
      || !positiveBytes(disk.Size) || !identifier(disk.Path)) return reject('OS 磁盘缺少可靠标准设备身份');
  const osMatches = evidence.osDiskInventory.filter((item) => identifier(item.UniqueId) === targetId);
  if (osMatches.length !== 1 || osMatches[0].UniqueIdFormat !== disk.UniqueIdFormat
      || osMatches[0].Number !== disk.Number
      || osMatches[0].Path !== disk.Path || osMatches[0].SerialNumber !== disk.SerialNumber
      || osMatches[0].Size !== disk.Size || osMatches[0].BusType !== disk.BusType
      || osMatches[0].PartitionStyle !== disk.PartitionStyle) return reject('OS 磁盘身份重复或冲突');
  const matches = evidence.physicalDisks.filter((item) => identifier(item.UniqueId) === targetId);
  if (matches.length !== 1) return reject('标准设备身份没有唯一的物理磁盘对应');
  const [physical] = matches;
  proof.matchedPhysicalUniqueId = physical.UniqueId;
  if (physical.UniqueIdFormat !== disk.UniqueIdFormat || identifier(physical.SerialNumber) !== identifier(disk.SerialNumber)
      || physical.Size !== disk.Size || physical.BusType !== disk.BusType) return reject('物理设备身份冲突');
  if (physical.MediaType !== 4) return reject('对应物理设备未明确报告 SSD');
  return { ...proof, status: 'PASS', reason: '同实例直接卷关联及唯一标准设备身份一致，介质明确为 SSD' };
}

function collectDiskBaseline(directory, { execute = execFileSync } = {}) {
  const probePath = path.win32.join(directory, 'config.json');
  let evidence = null, error = null;
  try {
    const output = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'collect-performance-disk.ps1'), '-ProbePath', probePath],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    evidence = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
    error = evidence.error || null;
  } catch (caught) { error = caught.message; }
  return { evidence, error, identityProof: evaluateDiskEvidence(evidence, probePath) };
}

module.exports = { collectDiskBaseline, evaluateDiskEvidence };
