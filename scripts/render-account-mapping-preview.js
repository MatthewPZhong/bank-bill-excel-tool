const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronBinary = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const previewPath = path.join(projectRoot, 'docs', 'account-mapping-preview.png');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bill-account-preview-'));

fs.mkdirSync(path.dirname(previewPath), { recursive: true });

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_CAPTURE_PATH: previewPath,
    APP_CAPTURE_DELAY_MS: '2400',
    APP_PREVIEW_MODAL: 'account-mapping',
    APP_USER_DATA_DIR: path.join(tempRoot, 'userData'),
    APP_DOCUMENTS_DIR: path.join(tempRoot, 'Documents')
  }
});

child.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code || 1);
  }

  console.log(`account mapping preview saved to ${previewPath}`);
});
