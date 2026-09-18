'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { collectDiskBaseline, evaluateDiskEvidence } = require('../../../scripts/vcc-financial-op/performance-disk-baseline');

const directory = 'D:\\case data\\pf04', probePath = path.win32.join(directory, 'config.json');
function evidence(mediaType = 4) {
  const disk = { ObjectId: 'os-disk-a', Number: 1, Path: '\\\\?\\SCSI#DiskA', UniqueId: '5002538e00000001',
    UniqueIdFormat: 3, SerialNumber: 'serial-A', Size: '512000000000', BusType: 11,
    Location: 'PCIROOT(0)#PCI(1700)#ATA(C00T00L00)', IsOffline: false, IsClustered: false, PartitionStyle: 2 };
  return { schemaVersion: 1, collectedAt: '2026-09-19T00:00:00.000Z', instance: { computerName: 'test-host', runId: '123', runAttempt: '1' },
    probePath, pathAncestors: [probePath, directory, 'D:\\case data', 'D:\\'].map((value) => ({ path: value, reparsePoint: false })),
    computer: { Manufacturer: 'example', Model: 'physical-test', HypervisorPresent: false },
    volumes: [{ UniqueId: 'volume-A', Path: '\\\\?\\Volume{00000000-0000-0000-0000-000000000001}\\', DriveType: 'Fixed', Size: '500000000000' }],
    partitions: [{ VolumeUniqueId: 'volume-A', DiskNumber: 1, PartitionNumber: 1, Type: 'Basic',
      MbrType: 0, GptType: '{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}',
      AccessPaths: ['D:\\', '\\\\?\\Volume{00000000-0000-0000-0000-000000000001}\\'], Offset: '1048576', Size: '500000000000' }],
    disks: [disk], osDiskInventory: [structuredClone(disk)], virtualDisks: [],
    physicalDisks: [{ ObjectId: 'physical-a', DeviceId: '0', UniqueId: disk.UniqueId, UniqueIdFormat: 3,
      SerialNumber: 'serial-A', Size: disk.Size, BusType: 11, MediaType: mediaType, IsPartial: false, VirtualDiskFootprint: '0' }], error: null };
}
function withUnrelatedSsd(actualMedia) {
  const raw = evidence(actualMedia);
  raw.physicalDisks.push({ ...raw.physicalDisks[0], ObjectId: 'physical-b', DeviceId: '1',
    UniqueId: '5002538e00000002', SerialNumber: 'serial-B', MediaType: 4 });
  return raw;
}
function controlledBaseline(raw) {
  const filename = path.resolve(__dirname, '../../../scripts/vcc-financial-op/verify-review-performance.js');
  const nativeRequire = createRequire(filename), module = { exports: {} };
  const controlledRequire = (name) => {
    if (name === './performance-disk-baseline') return {
      collectDiskBaseline: (value) => collectDiskBaseline(value, { execute: () => JSON.stringify(raw) })
    };
    if (name === 'node:os') return { totalmem: () => 16 * 1024 ** 3, release: () => 'controlled', cpus: () => [{ model: 'controlled' }] };
    return nativeRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: controlledRequire, module,
    __dirname: path.dirname(filename), process: { platform: 'win32', arch: 'x64', versions: { electron: '36.9.5' }, version: 'v24.13.0', argv: [] } });
  return module.exports.baseline(directory);
}

for (const [label, media] of [['HDD', 3], ['Unspecified', 0]]) {
  test('实际 ' + label + ' 与无关 SSD 编号碰巧相同，真实 baseline 仍拒绝准入并保留原始身份', () => {
    const raw = withUnrelatedSsd(media);
    const oldMatch = raw.physicalDisks.find((item) => item.DeviceId === String(raw.disks[0].Number));
    assert.equal(oldMatch.MediaType, 4); assert.notEqual(oldMatch.UniqueId, raw.disks[0].UniqueId);
    const result = controlledBaseline(raw);
    assert.equal(result.status, 'NOT_RUN'); assert.equal(result.checks.localSsd, false);
    assert.equal(result.disk.identityProof.targetUniqueId, raw.disks[0].UniqueId);
    assert.equal(result.disk.identityProof.matchedPhysicalUniqueId, raw.physicalDisks[0].UniqueId);
    assert.equal(result.disk.evidence.physicalDisks.length, 2);
    assert.equal(result.disk.identityProof.reason, '对应物理设备未明确报告 SSD');
  });
}
test('强身份确认实际 SSD，即使 OS Number 与 PhysicalDisk.DeviceId 不同仍支持简单直接盘', () => {
  const raw = withUnrelatedSsd(4); raw.physicalDisks[1].MediaType = 3;
  const result = controlledBaseline(raw);
  assert.equal(result.status, 'PASS'); assert.equal(result.checks.localSsd, true);
  assert.equal(result.disk.identityProof.matchedPhysicalUniqueId, raw.disks[0].UniqueId);
  assert.equal(result.disk.evidence.instance.runId, '123');
});
test('已证明目标直接 SSD 时，整机 Hypervisor 标记及无关未知设备不代替目标拓扑', () => {
  const raw = evidence(); raw.computer.HypervisorPresent = true;
  raw.physicalDisks.push({ DeviceId: '1', UniqueId: null, MediaType: 0 });
  assert.equal(controlledBaseline(raw).status, 'PASS');
  delete raw.computer.HypervisorPresent;
  assert.equal(controlledBaseline(raw).status, 'PASS');
});
test('同一物理盘的其他用途不替代目标卷的实际关联', () => {
  const raw = evidence();
  raw.physicalDisks[0].IsPartial = true; raw.physicalDisks[0].VirtualDiskFootprint = '1048576';
  assert.equal(controlledBaseline(raw).status, 'PASS');
  raw.physicalDisks[0].IsPartial = null; raw.physicalDisks[0].VirtualDiskFootprint = null;
  assert.equal(controlledBaseline(raw).status, 'PASS');
});
test('普通 MBR/IFS 和 FAT32 直接 SSD 可准入，不以 GPT 显示名限制合同', () => {
  const raw = evidence(); raw.disks[0].PartitionStyle = 1; raw.osDiskInventory[0].PartitionStyle = 1;
  raw.partitions[0].Type = 'IFS'; raw.partitions[0].GptType = null; raw.partitions[0].MbrType = 7;
  assert.equal(controlledBaseline(raw).status, 'PASS');
  raw.partitions[0].Type = 'FAT32'; raw.partitions[0].MbrType = 12;
  assert.equal(controlledBaseline(raw).status, 'PASS');
});
test('中文实例名和实际测试路径不被占位符检查误拒', () => {
  const raw = evidence(), chinesePath = 'D:\\测试数据\\config.json';
  raw.instance.computerName = '测试电脑'; raw.probePath = chinesePath;
  raw.pathAncestors = [chinesePath, 'D:\\测试数据', 'D:\\'].map((value) => ({ path: value, reparsePoint: false }));
  assert.equal(evaluateDiskEvidence(raw, chinesePath).status, 'PASS');
});
for (const placeholder of ['---', '???']) test('所有设备都返回全标点占位 ID ' + placeholder + ' 仍不能证明身份', () => {
  const raw = evidence();
  for (const item of [...raw.disks, ...raw.osDiskInventory, ...raw.physicalDisks]) item.UniqueId = placeholder;
  const result = controlledBaseline(raw);
  assert.equal(result.status, 'NOT_RUN'); assert.equal(result.checks.localSsd, false);
  assert.equal(result.disk.identityProof.reason, 'OS 磁盘缺少可靠标准设备身份');
});

const refused = [
  ['目标 ID 空', (raw) => { raw.disks[0].UniqueId = ''; }],
  ['目标 ID 全零', (raw) => { raw.disks[0].UniqueId = '0000-0000'; }],
  ['厂商自定义格式未支持', (raw) => { raw.disks[0].UniqueIdFormat = 0; }],
  ['物理身份缺失', (raw) => { raw.physicalDisks[0].UniqueId = ''; }],
  ['物理身份重复', (raw) => { raw.physicalDisks.push(structuredClone(raw.physicalDisks[0])); }],
  ['OS 身份重复', (raw) => { raw.osDiskInventory.push(structuredClone(raw.disks[0])); }],
  ['OS 同身份编号冲突', (raw) => { raw.osDiskInventory[0].Number = 0; }],
  ['相同字符串不同 VPD 格式', (raw) => { raw.physicalDisks[0].UniqueIdFormat = 2; }],
  ['序列号冲突', (raw) => { raw.physicalDisks[0].SerialNumber = 'another'; }],
  ['序列号为空', (raw) => { raw.physicalDisks[0].SerialNumber = ''; }],
  ['容量冲突', (raw) => { raw.physicalDisks[0].Size = '999'; }],
  ['总线冲突', (raw) => { raw.physicalDisks[0].BusType = 17; }],
  ['未知 Location', (raw) => { raw.disks[0].Location = ''; }],
  ['OS 对象与清单矛盾', (raw) => { raw.osDiskInventory[0].Path = 'another'; }],
  ['多盘关联', (raw) => { raw.disks.push(structuredClone(raw.disks[0])); }],
  ['多分区卷', (raw) => { raw.partitions.push(structuredClone(raw.partitions[0])); }],
  ['LDM 动态分区', (raw) => {
    raw.disks[0].PartitionStyle = 1; raw.osDiskInventory[0].PartitionStyle = 1; raw.partitions[0].MbrType = 0x42;
  }],
  ['卷关联冲突', (raw) => { raw.partitions[0].VolumeUniqueId = 'other'; }],
  ['分区范围超出磁盘', (raw) => { raw.partitions[0].Offset = raw.disks[0].Size; }],
  ['已知虚拟盘关联', (raw) => { raw.virtualDisks.push({ UniqueId: 'virtual' }); }],
  ['虚拟机的 NVMe 外观不能证明宿主介质', (raw) => {
    raw.computer.Model = 'Virtual Machine'; raw.disks[0].BusType = 17;
    raw.osDiskInventory[0].BusType = 17; raw.physicalDisks[0].BusType = 17;
  }],
  ['祖先 junction', (raw) => { raw.pathAncestors[2].reparsePoint = true; }],
  ['祖先证据不完整', (raw) => { raw.pathAncestors.pop(); }],
  ['其他 case 的证据', (raw) => { raw.probePath = 'C:\\unrelated\\config.json'; }],
  ['查询失败', (raw) => { raw.error = 'Access denied'; }],
  ['旧三字段证据不能升级', (raw) => { delete raw.physicalDisks; raw.DriveType = 'Fixed'; raw.MediaType = 'SSD'; }]
];
for (const [label, change] of refused) test(label + ' 保持 NOT_RUN', () => {
  const raw = evidence(); change(raw);
  const result = evaluateDiskEvidence(raw, probePath);
  assert.equal(result.status, 'NOT_RUN'); assert.ok(result.reason);
});
for (const bus of [0, 1, 7, 8, 9, 14, 15, 16]) test('未支持总线 ' + bus + ' 不认定物理 SSD', () => {
  const raw = evidence(); raw.disks[0].BusType = bus; raw.physicalDisks[0].BusType = bus;
  assert.equal(evaluateDiskEvidence(raw, probePath).status, 'NOT_RUN');
});
test('PowerShell 以独立 argv 接收现有 config 路径，失败和无效 JSON 不得准入', () => {
  const strangeDirectory = "D:\\case '$(not-code); data";
  let observed;
  const result = collectDiskBaseline(strangeDirectory, { execute(command, args, options) {
    observed = { command, args, options }; throw new Error('query unavailable');
  } });
  assert.equal(observed.command, 'powershell.exe');
  assert.equal(observed.args.at(-1), path.win32.join(strangeDirectory, 'config.json'));
  assert.equal(observed.args.includes('-Command'), false); assert.equal(observed.options.timeout, 30000);
  assert.equal(result.error, 'query unavailable'); assert.equal(result.identityProof.status, 'NOT_RUN');
  assert.equal(collectDiskBaseline(directory, { execute: () => '{broken' }).identityProof.status, 'NOT_RUN');
});

test('Windows PowerShell 采集器使用原始 CIM 枚举并完整遍历真实文件祖先', {
  skip: process.platform !== 'win32' && '需要 Windows PowerShell；受控 Storage 对象不代替真实 CIM 查询', timeout: 30000
}, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-disk-collector-')));
  try {
    const nested = path.join(root, 'nested', 'case'); fs.mkdirSync(nested, { recursive: true });
    const config = path.join(nested, 'config.json'); fs.writeFileSync(config, '{}');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.resolve(__dirname, '../../fixtures/vcc-disk-collector-contract.ps1'), '-CollectorPath',
      path.resolve(__dirname, '../../../scripts/vcc-financial-op/collect-performance-disk.ps1'), '-ProbePath', config
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    const cases = JSON.parse(output.replace(/^\uFEFF/, ''));
    assert.deepEqual(cases.map((item) => item.case), ['sas-ssd', 'unknown-media', 'string-media', 'missing-media', 'null-mbr', 'wrong-runtime-type']);
    const expectedAncestors = [];
    for (let current = config; ; current = path.dirname(current)) {
      expectedAncestors.push(current); if (path.dirname(current) === current) break;
    }
    for (const { evidence: raw } of cases) {
      assert.equal(raw.error, null); assert.equal(raw.probePath, config);
      assert.deepEqual(raw.pathAncestors, expectedAncestors.map((value) => ({ path: value, reparsePoint: false })));
      assert.equal(raw.disks[0].BusType, 10); assert.equal(raw.osDiskInventory[0].BusType, 10);
      assert.equal(raw.disks[0].UniqueIdFormat, 3); assert.equal(raw.physicalDisks[0].UniqueIdFormat, 3);
      assert.deepEqual(raw.disks[0].CimEnums.BusType, { value: 10, rawValue: 10, cimType: 'UInt16',
        valueType: 'System.UInt16', present: true, displayValue: 'SAS' });
      assert.equal(raw.disks[0].UniqueId, raw.physicalDisks[0].UniqueId);
      assert.equal(raw.physicalDisks[0].DeviceId, '7'); assert.equal(raw.disks[0].Number, 1);
    }
    const byCase = Object.fromEntries(cases.map((item) => [item.case, item.evidence]));
    assert.equal(evaluateDiskEvidence(byCase['sas-ssd'], config).status, 'PASS');
    assert.equal(byCase['sas-ssd'].physicalDisks[0].MediaType, 4);
    assert.equal(byCase['unknown-media'].physicalDisks[0].MediaType, 0);
    for (const label of ['unknown-media', 'string-media', 'missing-media', 'wrong-runtime-type']) {
      assert.equal(evaluateDiskEvidence(byCase[label], config).status, 'NOT_RUN', label);
      if (label !== 'unknown-media') assert.equal(byCase[label].physicalDisks[0].MediaType, null, label);
    }
    assert.equal(byCase['string-media'].physicalDisks[0].CimEnums.MediaType.rawValue, 'SSD');
    assert.equal(byCase['missing-media'].physicalDisks[0].CimEnums.MediaType.present, false);
    assert.equal(byCase['wrong-runtime-type'].physicalDisks[0].CimEnums.MediaType.valueType, 'System.String');
    assert.equal(byCase['null-mbr'].partitions[0].MbrType, null);
    assert.equal(byCase['null-mbr'].partitions[0].CimEnums.MbrType.rawValue, null);
    assert.equal(evaluateDiskEvidence(byCase['null-mbr'], config).status, 'PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
