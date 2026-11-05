'use strict';

// v3.2.15 B43：Windows CI smoke-test 的「Run release checks」步骤。release-check 拆成并行 job 后，
//   在这里核对各 job 全部成功；matrix job（单测、集成测试分片）只有全部分片成功时 result 才是 success。
//   RELEASE_CHECK_JOBS 记录各 job 承担的 release-check 组成部分，单测核对它们合起来恰好是 package.json 的 release-check，
//   且与 .github/workflows/build-windows.yml 中各 job 的运行命令一致。
// 用法（CI）：RELEASE_CHECK_JOB_RESULTS='${{ toJSON(needs) }}' node scripts/ci/verify-release-check-jobs.js
// 退出码：0 = 全部成功；1 = 有 job 未成功、缺失或输入无效。

const RELEASE_CHECK_JOBS = Object.freeze({
  'release-check-static': Object.freeze(['npm run lint', 'npm run check:architecture', 'npm run smoke']),
  'release-check-unit': Object.freeze(['npm run test:unit']),
  'release-check-integration': Object.freeze(['npm run test:integration'])
});

// raw：toJSON(needs) 的文本。返回 { ok, lines }，lines 逐个 job 说明结果。
function verifyReleaseCheckJobs(raw) {
  let needs;
  try {
    needs = JSON.parse(raw || '');
  } catch (_error) {
    return { ok: false, lines: ['RELEASE_CHECK_JOB_RESULTS 不是有效的 JSON'] };
  }
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    return { ok: false, lines: ['RELEASE_CHECK_JOB_RESULTS 须为 needs 对象'] };
  }
  const lines = [];
  let ok = true;
  for (const [job, commands] of Object.entries(RELEASE_CHECK_JOBS)) {
    const result = needs[job] && needs[job].result;
    const passed = result === 'success';
    if (!passed) ok = false;
    lines.push(`${passed ? 'PASS' : 'FAIL'} ${job}：${result || '缺失'}（${commands.join(' && ')}）`);
  }
  return { ok, lines };
}

function main() {
  const { ok, lines } = verifyReleaseCheckJobs(process.env.RELEASE_CHECK_JOB_RESULTS);
  for (const line of lines) console.log(line);
  if (!ok) {
    console.error('release-check 并行 job 未全部成功，门禁不通过');
    process.exit(1);
  }
  console.log('release-check 并行 job 全部成功');
}

if (require.main === module) main();

module.exports = { RELEASE_CHECK_JOBS, verifyReleaseCheckJobs };
