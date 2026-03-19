const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { createWorker } = require('tesseract.js');
const englishData = require('@tesseract.js-data/eng');
const chineseData = require('@tesseract.js-data/chi_sim');

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function buildOcrLangPath() {
  const targetDir = path.join(os.tmpdir(), 'bank-bill-excel-tool-tessdata');
  fs.mkdirSync(targetDir, { recursive: true });
  const sources = [
    {
      code: 'eng',
      filePath: path.join(englishData.langPath, 'eng.traineddata.gz')
    },
    {
      code: 'chi_sim',
      filePath: path.join(chineseData.langPath, 'chi_sim.traineddata.gz')
    }
  ];

  sources.forEach(({ code, filePath }) => {
    const targetFilePath = path.join(targetDir, `${code}.traineddata.gz`);

    if (!fs.existsSync(targetFilePath)) {
      fs.copyFileSync(filePath, targetFilePath);
      return;
    }

    const sourceSize = fs.statSync(filePath).size;
    const targetSize = fs.statSync(targetFilePath).size;

    if (sourceSize !== targetSize) {
      fs.copyFileSync(filePath, targetFilePath);
    }
  });

  return targetDir;
}

function groupItemsByLine(items) {
  const normalizedItems = items
    .map((item) => ({
      text: normalizeCell(item.text || item.str),
      x: Number(item.x ?? item.transform?.[4] ?? 0),
      y: Number(item.y ?? item.transform?.[5] ?? 0),
      width: Number(item.width ?? 0),
      height: Number(item.height ?? 0)
    }))
    .filter((item) => item.text !== '');

  if (!normalizedItems.length) {
    return [];
  }

  normalizedItems.sort((left, right) => {
    if (Math.abs(right.y - left.y) > 2) {
      return right.y - left.y;
    }

    return left.x - right.x;
  });

  const lines = [];

  normalizedItems.forEach((item) => {
    const existingLine = lines.find((line) => Math.abs(line.y - item.y) <= Math.max(2, item.height * 0.45 || 2));

    if (existingLine) {
      existingLine.items.push(item);
      existingLine.y = (existingLine.y + item.y) / 2;
      return;
    }

    lines.push({
      y: item.y,
      items: [item]
    });
  });

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => line.items.sort((left, right) => left.x - right.x));
}

function lineItemsToCells(items) {
  if (!items.length) {
    return [];
  }

  const cells = [];
  let currentCell = normalizeCell(items[0].text);
  let previousRightEdge = items[0].x + items[0].width;

  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    const estimatedCharWidth = Math.max(6, items[index - 1].width / Math.max(items[index - 1].text.length, 1));
    const splitThreshold = Math.max(18, estimatedCharWidth * 2.4);
    const appendSpaceThreshold = Math.max(4, estimatedCharWidth * 0.6);
    const gap = item.x - previousRightEdge;

    if (gap > splitThreshold) {
      cells.push(currentCell);
      currentCell = normalizeCell(item.text);
    } else {
      currentCell += gap > appendSpaceThreshold ? ` ${normalizeCell(item.text)}` : normalizeCell(item.text);
    }

    previousRightEdge = item.x + item.width;
  }

  cells.push(currentCell);
  return cells.map((cell) => cell.replace(/\s+/g, ' ').trim()).filter((cell) => cell !== '');
}

async function createOcrWorker() {
  const worker = await createWorker(['eng', 'chi_sim'], 1, {
    langPath: buildOcrLangPath(),
    gzip: true
  });
  return worker;
}

async function readPageRowsWithOcr(page, worker) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({
    canvasContext: context,
    viewport
  }).promise;
  const { data } = await worker.recognize(canvas.toBuffer('image/png'));
  const lines = groupItemsByLine(
    (Array.isArray(data?.words) ? data.words : []).map((word) => ({
      text: word.text,
      x: word.bbox?.x0 ?? 0,
      y: word.bbox?.y0 ?? 0,
      width: Math.max(0, (word.bbox?.x1 ?? 0) - (word.bbox?.x0 ?? 0)),
      height: Math.max(0, (word.bbox?.y1 ?? 0) - (word.bbox?.y0 ?? 0))
    }))
  );

  return lines
    .map((line) => lineItemsToCells(line))
    .filter((cells) => cells.length > 0);
}

async function readPageRows(page, workerRef) {
  const textContent = await page.getTextContent();
  const textItems = Array.isArray(textContent?.items) ? textContent.items : [];
  const hasMeaningfulText = textItems
    .map((item) => normalizeCell(item.str))
    .filter((text) => text !== '')
    .join('')
    .length >= 12;

  if (hasMeaningfulText) {
    const lines = groupItemsByLine(textItems);
    const rows = lines
      .map((line) => lineItemsToCells(line))
      .filter((cells) => cells.length > 0);

    if (rows.length) {
      return rows;
    }
  }

  if (!workerRef.current) {
    workerRef.current = await createOcrWorker();
  }

  return readPageRowsWithOcr(page, workerRef.current);
}

async function extractPdfRows(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const documentData = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument({
    data: documentData,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true
  });
  const pdf = await loadingTask.promise;
  const workerRef = { current: null };
  const rows = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const pageRows = await readPageRows(page, workerRef);
      pageRows.forEach((cells) => {
        if (cells.length) {
          rows.push(cells);
        }
      });
    }
  } finally {
    await workerRef.current?.terminate();
    await loadingTask.destroy();
  }

  return rows;
}

async function main() {
  try {
    const filePath = process.argv[2];

    if (!filePath) {
      throw new Error('Missing PDF path');
    }

    const rows = await extractPdfRows(filePath);
    process.stdout.write(`${JSON.stringify({ rows })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

main();
