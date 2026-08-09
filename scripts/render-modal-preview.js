const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronBinary = require('electron');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validateOptionalNumber(value, { label, min, max, integer = false }) {
  if (!value) return '';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return String(parsed);
}

function hasPngSignature(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return false;
    }
    let offset = PNG_SIGNATURE.length;
    let chunkIndex = 0;
    let sawIdat = false;
    while (offset + 12 <= bytes.length) {
      const dataLength = bytes.readUInt32BE(offset);
      const chunkEnd = offset + 12 + dataLength;
      if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) return false;
      const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
      if (chunkIndex === 0 && (chunkType !== 'IHDR' || dataLength !== 13)) return false;
      if (chunkType === 'IHDR' && chunkIndex !== 0) return false;
      if (chunkType === 'IHDR'
        && (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) {
        return false;
      }
      if (chunkType === 'IDAT') {
        if (dataLength === 0) return false;
        sawIdat = true;
      }
      if (chunkType === 'IEND') {
        return sawIdat && dataLength === 0 && chunkEnd === bytes.length;
      }
      offset = chunkEnd;
      chunkIndex += 1;
    }
    return false;
  } catch (_error) {
    return false;
  }
}

function promotePreview(stagedPath, previewPath) {
  if (!hasPngSignature(stagedPath)) {
    throw new Error(`preview capture did not produce a complete PNG: ${stagedPath}`);
  }
  fs.renameSync(stagedPath, previewPath);
}

function finalizePreviewCapture({
  stagedPath,
  previewPath,
  tempRoot,
  error = null,
  exitCode = 1,
  logger = console
}) {
  let finalError = null;
  let finalExitCode = 0;
  try {
    if (error) throw error;
    promotePreview(stagedPath, previewPath);
  } catch (cause) {
    finalError = cause;
    finalExitCode = exitCode || 1;
    logger.error(cause && cause.message ? cause.message : String(cause));
  } finally {
    fs.rmSync(stagedPath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return { error: finalError, exitCode: finalExitCode };
}

function run() {
  const modalName = String(process.argv[2] || '').trim();
  const outputName = String(process.argv[3] || '').trim();
  const zoomFactor = String(process.argv[4] || '').trim();
  const windowWidth = String(process.argv[5] || '').trim();
  const windowHeight = String(process.argv[6] || '').trim();

  if (!modalName || !outputName) {
    throw new Error('Usage: node scripts/render-modal-preview.js <modal-name> <output-file-name> [zoom-factor] [window-width] [window-height]');
  }

  const validatedZoomFactor = validateOptionalNumber(zoomFactor, {
    label: 'zoom-factor', min: 0.5, max: 2
  });
  const validatedWindowWidth = validateOptionalNumber(windowWidth, {
    label: 'window-width', min: 1080, max: 3840, integer: true
  });
  const validatedWindowHeight = validateOptionalNumber(windowHeight, {
    label: 'window-height', min: 760, max: 2160, integer: true
  });

  const projectRoot = path.resolve(__dirname, '..');
  const previewStyle = String(process.env.APP_PREVIEW_STYLE || '').trim().toLowerCase();
  const previewDir = previewStyle === 'general'
    ? path.join(projectRoot, 'docs', 'previews', '_general')
    : path.join(projectRoot, 'docs', 'previews');
  const previewPath = path.join(previewDir, outputName);
  const stagedPath = path.join(
    previewDir,
    `.${path.basename(outputName)}.part-${process.pid}-${Date.now()}`
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bank-bill-${modalName}-preview-`));

  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.rmSync(stagedPath, { force: true });

  const childEnv = {
    ...process.env,
    APP_CAPTURE_PATH: stagedPath,
    APP_CAPTURE_DELAY_MS: '2400',
    APP_PREVIEW_MODAL: modalName,
    APP_USER_DATA_DIR: path.join(tempRoot, 'userData'),
    APP_DOCUMENTS_DIR: path.join(tempRoot, 'Documents')
  };
  if (validatedZoomFactor) childEnv.APP_PREVIEW_ZOOM_FACTOR = validatedZoomFactor;
  if (validatedWindowWidth) childEnv.APP_CAPTURE_WINDOW_WIDTH = validatedWindowWidth;
  if (validatedWindowHeight) childEnv.APP_CAPTURE_WINDOW_HEIGHT = validatedWindowHeight;

  const child = spawn(electronBinary, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: childEnv
  });
  let finished = false;
  const finish = (error, exitCode = 1) => {
    if (finished) return;
    finished = true;
    const result = finalizePreviewCapture({
      stagedPath,
      previewPath,
      tempRoot,
      error,
      exitCode
    });
    if (!result.error) {
      console.log(`${modalName} preview saved to ${previewPath}`);
    } else {
      process.exitCode = result.exitCode;
    }
  };

  child.once('error', (error) => finish(error));
  child.once('exit', (code, signal) => {
    if (code !== 0) {
      finish(new Error(`preview Electron exited with ${signal ? `signal ${signal}` : `code ${code}`}`), code || 1);
      return;
    }
    finish(null, 0);
  });
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  finalizePreviewCapture,
  hasPngSignature,
  promotePreview,
  validateOptionalNumber
};
