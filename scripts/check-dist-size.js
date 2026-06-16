// 打包产物体积/内容守卫脚本（size-startup-optimization Part A，A-F3）
//   背景：v3.0.0 app.asar 膨胀到 101MB（开发文档/测试脚本/开发依赖误入包）。
//   本脚本对构建产物 app.asar 做三类断言，防止瘦身后再次复发：
//     断言①：asar 文件体积 ≤ 70MB（阈值常量 MAX_ASAR_BYTES，v3.0.7 按实测校准）。
//     断言②：禁止路径不得出现在包内（开发文档/脚本/开发依赖/CHANGELOG/README）。
//     断言③：反向保护——若干运行时必需文件必须存在（防白名单漏列导致打包版缺文件）。
//   任一断言失败 → 打印逐条明细并 exit 1；全过 → 打印 PASS 摘要（含实测体积）。
//
// 用法：
//   node scripts/check-dist-size.js                       # 默认检查 dist/win-unpacked/resources/app.asar
//   node scripts/check-dist-size.js <path/to/app.asar>    # 指定 asar 路径
//
// 挂载：dist:win / dist:win:setup / dist:win:portable 命令链尾自动执行；
//       亦可经 npm run check:dist 单独运行。
//
// 退出码：0=全部断言通过 / 1=asar 缺失或任一断言失败

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

// asar 体积上限：70MB（v3.0.7 按实测校准）。
//   原 25MB 阈值（A-D2）为瘦身预期值，但三大 Excel 库 exceljs(22M)/xlsx(7.2M)/xlsx-js-style(9.5M)
//   均运行时在用、无法删除，实测 asar ~57.5MB，导致 v3.0.5 起 main 构建长期 FAIL（PR 不跑 build job 故未暴露）。
//   按实测 ~57.5MB 留约 22% 模板/字体/依赖增长余量定为 70MB；若后续完成 dist/sourcemap 排除瘦身，应再下调。
const MAX_ASAR_BYTES = 70 * 1024 * 1024;

// 默认 asar 路径（可经 argv[2] 覆盖）
const DEFAULT_ASAR_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'win-unpacked',
  'resources',
  'app.asar'
);

// 禁止出现的目录前缀（listPackage 返回 POSIX 风格、带前导斜杠的路径）
//   用前缀匹配：命中该目录本身或其下任意条目即视为违规。
const FORBIDDEN_DIR_PREFIXES = [
  '/docs/previews',
  '/docs/iterations',
  '/docs/analysis',
  '/docs/prs',
  '/scripts/',
  '/node_modules/@napi-rs',
];

// 禁止出现的根级文件（精确匹配，避免误伤子目录下的同名 README 等）
const FORBIDDEN_EXACT_FILES = ['/CHANGELOG.md', '/README.md'];

// 反向保护：运行时必需、必须存在于包内的文件（精确匹配）
const REQUIRED_FILES = [
  '/docs/USER_GUIDE.md',
  '/assets/币种映射表.xlsx',
  '/COMMON枚举.xlsx',
  '/src/main.js',
];

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + 'MB';
}

function main() {
  const asarPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_ASAR_PATH;

  // 前置检查：asar 文件存在性
  if (!fs.existsSync(asarPath)) {
    console.error('[check-dist-size] 错误：未找到 asar 文件');
    console.error('  期望路径：' + asarPath);
    console.error('  请先执行构建（npm run dist:win 等），或通过参数指定 asar 路径。');
    process.exit(1);
  }

  const failures = [];

  // 断言①：体积 ≤ MAX_ASAR_BYTES（70MB，见上方常量注释）
  const asarBytes = fs.statSync(asarPath).size;
  if (asarBytes > MAX_ASAR_BYTES) {
    failures.push(
      '断言①体积超标：app.asar = ' +
        formatMB(asarBytes) +
        '，上限 ' +
        formatMB(MAX_ASAR_BYTES)
    );
  }

  // 列出包内全部路径，并归一化分隔符为 POSIX 斜杠。
  //   @electron/asar 的 listFiles 用 path.join 拼路径（filesystem.js），在 Windows
  //   上返回反斜杠形态（如 \docs\USER_GUIDE.md）；CI 构建跑在 windows-latest。
  //   不归一化则断言②禁止路径在 Windows 永远匹配不上（守卫静默失效）、断言③必需
  //   文件全量误报（每次构建必 FAIL）。归一化后下方断言逻辑三平台一致。
  const entries = asar.listPackage(asarPath).map((p) => p.split('\\').join('/'));

  // 断言②：禁止路径
  const forbiddenHits = [];
  for (const prefix of FORBIDDEN_DIR_PREFIXES) {
    if (entries.some((p) => p === prefix || p.startsWith(prefix))) {
      forbiddenHits.push(prefix);
    }
  }
  for (const file of FORBIDDEN_EXACT_FILES) {
    if (entries.includes(file)) {
      forbiddenHits.push(file);
    }
  }
  if (forbiddenHits.length > 0) {
    failures.push('断言②出现禁止路径：' + forbiddenHits.join('、'));
  }

  // 断言③：反向保护——必需文件必须存在
  const missingRequired = REQUIRED_FILES.filter((f) => !entries.includes(f));
  if (missingRequired.length > 0) {
    failures.push('断言③缺失必需文件：' + missingRequired.join('、'));
  }

  // 输出结论
  if (failures.length > 0) {
    console.error('==== check-dist-size FAIL ====');
    console.error('  asar 路径：' + asarPath);
    console.error('  asar 体积：' + formatMB(asarBytes) + '（上限 ' + formatMB(MAX_ASAR_BYTES) + '）');
    console.error('  包内条目数：' + entries.length);
    console.error('  失败明细：');
    for (const f of failures) {
      console.error('    - ' + f);
    }
    process.exit(1);
  }

  console.log('==== check-dist-size PASS ====');
  console.log('  asar 路径：' + asarPath);
  console.log('  asar 体积：' + formatMB(asarBytes) + '（上限 ' + formatMB(MAX_ASAR_BYTES) + '）');
  console.log('  包内条目数：' + entries.length);
  console.log('  禁止路径：0 命中；必需文件：' + REQUIRED_FILES.length + '/' + REQUIRED_FILES.length + ' 齐全');
}

main();
