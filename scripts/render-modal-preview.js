const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronBinary = require('electron');

const modalName = String(process.argv[2] || '').trim();
const outputName = String(process.argv[3] || '').trim();

if (!modalName || !outputName) {
  console.error('Usage: node scripts/render-modal-preview.js <modal-name> <output-file-name>');
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const previewStyle = String(process.env.APP_PREVIEW_STYLE || '').trim().toLowerCase();
const previewDir = previewStyle === 'general'
  ? path.join(projectRoot, 'docs', 'previews', '_general')
  : path.join(projectRoot, 'docs', 'previews');
const previewPath = path.join(previewDir, outputName);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bank-bill-${modalName}-preview-`));

fs.mkdirSync(path.dirname(previewPath), { recursive: true });

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_CAPTURE_PATH: previewPath,
    APP_CAPTURE_DELAY_MS: '2400',
    APP_PREVIEW_MODAL: modalName,
    APP_USER_DATA_DIR: path.join(tempRoot, 'userData'),
    APP_DOCUMENTS_DIR: path.join(tempRoot, 'Documents')
  }
});

child.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code || 1);
  }

  console.log(`${modalName} preview saved to ${previewPath}`);
});
