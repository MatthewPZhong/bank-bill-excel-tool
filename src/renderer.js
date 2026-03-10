const DEFAULT_BACKGROUND_SETTINGS = Object.freeze({
  colorHex: '#efe8da',
  imageDataUrl: '',
  filePath: '',
  sourceFileName: '',
  sourcePath: ''
});
const DEFAULT_SPECTRUM_PICK_COLOR = '#ffffff';
const BACKGROUND_FILE_HINT = '支持 PNG/JPG/JPEG/WEBP，大小不超过 5MB，建议使用横版高清图片';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const MODULES = Object.freeze({
  statementGenerator: {
    id: 'statement-generator',
    name: '网银账单生成'
  },
  newAccountGenerator: {
    id: 'new-account-generator',
    name: '新开账户生成网银账单'
  }
});

const state = {
  templates: [],
  selectedTemplateId: '',
  canExportDetail: false,
  canExportBalance: false,
  canExportNewAccount: false,
  isMaximized: false,
  hasEnum: false,
  enumFileName: '',
  accountMappingCount: 0,
  hasErrorReport: false,
  newAccountHasErrorReport: false,
  backgroundSettings: { ...DEFAULT_BACKGROUND_SETTINGS },
  backgroundDraft: { ...DEFAULT_BACKGROUND_SETTINGS },
  isBackgroundPaletteOpen: false,
  currentModule: MODULES.statementGenerator.id,
  isModuleMenuOpen: false,
  isBackgroundSpectrumDragging: false,
  backgroundPicker: {
    hasSelection: false,
    x: 0,
    y: 0,
    colorHex: DEFAULT_SPECTRUM_PICK_COLOR
  }
};

const elements = {
  appShell: document.getElementById('appShell'),
  importFileBtn: document.getElementById('importFileBtn'),
  exportDetailBtn: document.getElementById('exportDetailBtn'),
  exportBalanceBtn: document.getElementById('exportBalanceBtn'),
  newAccountGenerateBtn: document.getElementById('newAccountGenerateBtn'),
  newAccountExportBtn: document.getElementById('newAccountExportBtn'),
  importTemplateBtn: document.getElementById('importTemplateBtn'),
  manageTemplateBtn: document.getElementById('manageTemplateBtn'),
  accountMappingBtn: document.getElementById('accountMappingBtn'),
  templateSelect: document.getElementById('templateSelect'),
  statusBox: document.getElementById('statusBox'),
  newAccountStatusBox: document.getElementById('newAccountStatusBox'),
  newAccountBankNameInput: document.getElementById('newAccountBankNameInput'),
  newAccountLocationInput: document.getElementById('newAccountLocationInput'),
  newAccountCurrencyInput: document.getElementById('newAccountCurrencyInput'),
  newAccountBankAccountInput: document.getElementById('newAccountBankAccountInput'),
  newAccountOpenDateInput: document.getElementById('newAccountOpenDateInput'),
  appVersion: document.getElementById('appVersion'),
  modalRoot: document.getElementById('modalRoot'),
  minimizeBtn: document.getElementById('minimizeBtn'),
  maximizeBtn: document.getElementById('maximizeBtn'),
  closeBtn: document.getElementById('closeBtn'),
  moduleSwitcherBtn: document.getElementById('moduleSwitcherBtn'),
  moduleSwitcherMenu: document.getElementById('moduleSwitcherMenu'),
  currentModuleName: document.getElementById('currentModuleName'),
  statementModulePanel: document.getElementById('statementModulePanel'),
  newAccountModulePanel: document.getElementById('newAccountModulePanel'),
  backgroundTool: document.getElementById('backgroundTool'),
  backgroundPaletteBtn: document.getElementById('backgroundPaletteBtn'),
  backgroundPalettePanel: document.getElementById('backgroundPalettePanel'),
  backgroundSpectrumArea: document.getElementById('backgroundSpectrumArea'),
  backgroundSpectrumCanvas: document.getElementById('backgroundSpectrumCanvas'),
  backgroundSpectrumCrosshair: document.getElementById('backgroundSpectrumCrosshair'),
  backgroundSelectedColorSwatch: document.getElementById('backgroundSelectedColorSwatch'),
  backgroundImportBtn: document.getElementById('backgroundImportBtn'),
  backgroundDoneBtn: document.getElementById('backgroundDoneBtn'),
  backgroundResetBtn: document.getElementById('backgroundResetBtn')
};

function updateStatusBox(box, message, tone = 'info', options = {}) {
  const {
    errorReportReady = false,
    idleTitle = ''
  } = options;

  box.textContent = message;
  box.dataset.tone = tone;
  box.dataset.errorReportReady = errorReportReady ? 'true' : 'false';
  box.classList.toggle('is-clickable', errorReportReady);
  box.title = errorReportReady ? '点击导出报错文件' : idleTitle;
}

function setStatus(message, tone = 'info', options = {}) {
  state.hasErrorReport = Boolean(options.errorReportReady);
  updateStatusBox(elements.statusBox, message, tone, {
    errorReportReady: state.hasErrorReport,
    idleTitle: options.idleTitle ?? getStatusBoxTitle(state.accountMappingCount)
  });
}

function setNewAccountStatus(message, tone = 'info', options = {}) {
  state.newAccountHasErrorReport = Boolean(options.errorReportReady);
  updateStatusBox(elements.newAccountStatusBox, message, tone, {
    errorReportReady: state.newAccountHasErrorReport,
    idleTitle: options.idleTitle ?? '请完整填写开户信息后点击生成'
  });
}

function getEnumStatusMessage() {
  return state.hasEnum
    ? `已加载内置枚举表：${state.enumFileName || 'COMMON枚举.xlsx'}`
    : '内置网银账单枚举表缺失，请检查安装包';
}

function getStatusBoxTitle(accountMappingCount) {
  const mappingSummary = accountMappingCount
    ? `当前账户映射条数：${accountMappingCount}`
    : '当前未设置账户映射';

  return `${mappingSummary}；应用已内置 COMMON 枚举表`;
}

function getNewAccountStatusTitle() {
  return state.canExportNewAccount
    ? '新开账户余额账单已生成，可点击导出'
    : '请完整填写开户信息后点击生成';
}

async function handleExportLastError(target = 'main') {
  const hasErrorReport = target === 'main' ? state.hasErrorReport : state.newAccountHasErrorReport;

  if (!hasErrorReport) {
    return;
  }

  const result = await window.desktopApi.errors.exportLast();

  if (result.status === 'cancelled' || result.status === 'empty') {
    return;
  }

  if (target === 'main') {
    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: result.status === 'success' ? true : Boolean(result.errorReportReady)
    });
    return;
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: result.status === 'success' ? true : Boolean(result.errorReportReady)
  });
}

function isNewAccountFormComplete() {
  return [
    elements.newAccountBankNameInput.value,
    elements.newAccountLocationInput.value,
    elements.newAccountCurrencyInput.value,
    elements.newAccountBankAccountInput.value,
    elements.newAccountOpenDateInput.value
  ].every((value) => String(value || '').trim() !== '');
}

function updateNewAccountGenerateAvailability() {
  const isComplete = isNewAccountFormComplete();
  elements.newAccountGenerateBtn.disabled = !isComplete;
}

function setExportAvailability({ detailEnabled = state.canExportDetail, balanceEnabled = state.canExportBalance }) {
  state.canExportDetail = detailEnabled;
  state.canExportBalance = balanceEnabled;
  elements.exportDetailBtn.disabled = !detailEnabled;
  elements.exportBalanceBtn.disabled = !balanceEnabled;
}

function setNewAccountExportAvailability(enabled = state.canExportNewAccount) {
  state.canExportNewAccount = enabled;
  elements.newAccountExportBtn.disabled = !enabled;
}

function setCurrentModule(moduleId) {
  state.currentModule = moduleId;
  const isStatementModule = moduleId === MODULES.statementGenerator.id;

  elements.currentModuleName.textContent = isStatementModule
    ? MODULES.statementGenerator.name
    : MODULES.newAccountGenerator.name;
  elements.statementModulePanel.hidden = !isStatementModule;
  elements.newAccountModulePanel.hidden = isStatementModule;

  Array.from(elements.moduleSwitcherMenu.querySelectorAll('.module-option')).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.module === moduleId);
  });
}

function openModuleMenu() {
  state.isModuleMenuOpen = true;
  elements.moduleSwitcherMenu.hidden = false;
  elements.moduleSwitcherBtn.setAttribute('aria-expanded', 'true');
}

function closeModuleMenu() {
  state.isModuleMenuOpen = false;
  elements.moduleSwitcherMenu.hidden = true;
  elements.moduleSwitcherBtn.setAttribute('aria-expanded', 'false');
}

function normalizeColorHex(colorHex) {
  const normalized = String(colorHex || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_BACKGROUND_SETTINGS.colorHex;
}

function cloneBackgroundSettings(backgroundSettings = DEFAULT_BACKGROUND_SETTINGS) {
  return {
    colorHex: normalizeColorHex(backgroundSettings.colorHex),
    imageDataUrl: String(backgroundSettings.imageDataUrl || ''),
    filePath: String(backgroundSettings.filePath || ''),
    sourceFileName: String(backgroundSettings.sourceFileName || ''),
    sourcePath: String(backgroundSettings.sourcePath || '')
  };
}

function clampColorChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixRgb(fromRgb, toRgb, ratio) {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  return {
    r: clampColorChannel(fromRgb.r + (toRgb.r - fromRgb.r) * safeRatio),
    g: clampColorChannel(fromRgb.g + (toRgb.g - fromRgb.g) * safeRatio),
    b: clampColorChannel(fromRgb.b + (toRgb.b - fromRgb.b) * safeRatio)
  };
}

function hexToRgb(colorHex) {
  const normalized = normalizeColorHex(colorHex);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function mixColor(fromHex, toHex, ratio) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  return mixRgb(from, to, ratio);
}

function rgbToCss(rgb, alpha) {
  if (alpha === undefined) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function rgbToHex(rgb) {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => clampColorChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const second = chroma * (1 - Math.abs((segment % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment >= 0 && segment < 1) {
    red = chroma;
    green = second;
  } else if (segment < 2) {
    red = second;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = second;
  } else if (segment < 4) {
    green = second;
    blue = chroma;
  } else if (segment < 5) {
    red = second;
    blue = chroma;
  } else {
    red = chroma;
    blue = second;
  }

  const match = l - chroma / 2;

  return {
    r: clampColorChannel((red + match) * 255),
    g: clampColorChannel((green + match) * 255),
    b: clampColorChannel((blue + match) * 255)
  };
}

function getSpectrumColorAtPosition(x, y, width, height) {
  const safeWidth = Math.max(width - 1, 1);
  const safeHeight = Math.max(height - 1, 1);
  const hue = (x / safeWidth) * 360;
  const baseColor = hslToRgb(hue, 1, 0.5);
  const middleY = safeHeight / 2;

  if (y <= middleY) {
    return mixRgb({ r: 255, g: 255, b: 255 }, baseColor, y / Math.max(middleY, 1));
  }

  return mixRgb(
    baseColor,
    { r: 0, g: 0, b: 0 },
    (y - middleY) / Math.max(safeHeight - middleY, 1)
  );
}

function drawBackgroundSpectrum() {
  const canvas = elements.backgroundSpectrumCanvas;
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = getSpectrumColorAtPosition(x, y, width, height);
      const offset = (y * width + x) * 4;

      imageData.data[offset] = rgb.r;
      imageData.data[offset + 1] = rgb.g;
      imageData.data[offset + 2] = rgb.b;
      imageData.data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function updateSelectedColorSwatch(colorHex = DEFAULT_SPECTRUM_PICK_COLOR) {
  elements.backgroundSelectedColorSwatch.style.background = normalizeColorHex(colorHex);
}

function resetBackgroundPickerSelection() {
  state.backgroundPicker = {
    hasSelection: false,
    x: 0,
    y: 0,
    colorHex: DEFAULT_SPECTRUM_PICK_COLOR
  };
  elements.backgroundSpectrumCrosshair.hidden = true;
  updateSelectedColorSwatch(DEFAULT_SPECTRUM_PICK_COLOR);
}

function setBackgroundSpectrumSelection(x, y, colorHex) {
  state.backgroundPicker = {
    hasSelection: true,
    x,
    y,
    colorHex
  };
  elements.backgroundSpectrumCrosshair.hidden = false;
  elements.backgroundSpectrumCrosshair.style.left = `${x}px`;
  elements.backgroundSpectrumCrosshair.style.top = `${y}px`;
  updateSelectedColorSwatch(colorHex);
}

function pickBackgroundColorFromClientPoint(clientX, clientY) {
  const rect = elements.backgroundSpectrumArea.getBoundingClientRect();

  if (!rect.width || !rect.height) {
    return;
  }

  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  const canvasX = Math.round((x / rect.width) * (elements.backgroundSpectrumCanvas.width - 1));
  const canvasY = Math.round((y / rect.height) * (elements.backgroundSpectrumCanvas.height - 1));
  const colorHex = rgbToHex(
    getSpectrumColorAtPosition(
      canvasX,
      canvasY,
      elements.backgroundSpectrumCanvas.width,
      elements.backgroundSpectrumCanvas.height
    )
  );

  setBackgroundSpectrumSelection(x, y, colorHex);
  state.backgroundDraft.colorHex = colorHex;
  applyBackgroundSettings(state.backgroundDraft);
}

function buildBackgroundStyle(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const baseColor = hexToRgb(normalized.colorHex);

  if (normalized.imageDataUrl) {
    return {
      backgroundColor: rgbToCss(mixColor(normalized.colorHex, '#fff8ec', 0.3)),
      backgroundImage: [
        'radial-gradient(circle at top left, rgba(255, 255, 255, 0.72), transparent 30%)',
        `radial-gradient(circle at bottom right, ${rgbToCss(baseColor, 0.24)} 0%, transparent 34%)`,
        `linear-gradient(180deg, ${rgbToCss(baseColor, 0.18)} 0%, ${rgbToCss(baseColor, 0.3)} 100%)`,
        `url("${normalized.imageDataUrl}")`
      ].join(', '),
      backgroundSize: 'auto, auto, auto, cover',
      backgroundPosition: 'center, center, center, center',
      backgroundRepeat: 'no-repeat, no-repeat, no-repeat, no-repeat'
    };
  }

  return {
    backgroundColor: rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.66)),
    backgroundImage: [
      'radial-gradient(circle at top left, rgba(255, 255, 255, 0.75), transparent 30%)',
      `radial-gradient(circle at bottom right, ${rgbToCss(baseColor, 0.18)} 0%, transparent 30%)`,
      `linear-gradient(160deg, ${rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.56))} 0%, ${rgbToCss(baseColor)} 48%, ${rgbToCss(mixColor(normalized.colorHex, '#fffaf2', 0.74))} 100%)`
    ].join(', '),
    backgroundSize: 'auto, auto, auto',
    backgroundPosition: 'center, center, center',
    backgroundRepeat: 'no-repeat, no-repeat, no-repeat'
  };
}

function updateBackgroundControls(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const triggerFill = normalized.imageDataUrl
    ? `linear-gradient(135deg, ${rgbToCss(hexToRgb(normalized.colorHex), 0.72)} 0%, rgba(255, 255, 255, 0.92) 100%)`
    : normalized.colorHex;
  const importTitle = normalized.sourceFileName
    ? `${BACKGROUND_FILE_HINT}\n当前背景：${normalized.sourceFileName}`
    : BACKGROUND_FILE_HINT;

  elements.backgroundPaletteBtn.style.setProperty('--palette-trigger-fill', triggerFill);
  elements.backgroundImportBtn.title = importTitle;
}

function applyBackgroundSettings(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const style = buildBackgroundStyle(normalized);

  elements.appShell.style.backgroundColor = style.backgroundColor;
  elements.appShell.style.backgroundImage = style.backgroundImage;
  elements.appShell.style.backgroundSize = style.backgroundSize;
  elements.appShell.style.backgroundPosition = style.backgroundPosition;
  elements.appShell.style.backgroundRepeat = style.backgroundRepeat;
  document.body.style.background = rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.74));
  updateBackgroundControls(normalized);
}

function openBackgroundPalette() {
  state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
  state.isBackgroundPaletteOpen = true;
  elements.backgroundPalettePanel.hidden = false;
  elements.backgroundPaletteBtn.classList.add('is-active');
  resetBackgroundPickerSelection();
  applyBackgroundSettings(state.backgroundDraft);
}

function closeBackgroundPalette({ revert = true } = {}) {
  if (!state.isBackgroundPaletteOpen) {
    return;
  }

  state.isBackgroundPaletteOpen = false;
  elements.backgroundPalettePanel.hidden = true;
  elements.backgroundPaletteBtn.classList.remove('is-active');
  state.isBackgroundSpectrumDragging = false;
  resetBackgroundPickerSelection();

  if (revert) {
    state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
    applyBackgroundSettings(state.backgroundSettings);
    return;
  }

  state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
}

async function handleBackgroundImportFile() {
  const result = await window.desktopApi.background.selectFile();

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  state.backgroundDraft = cloneBackgroundSettings({
    ...state.backgroundDraft,
    imageDataUrl: result.background.imageDataUrl,
    filePath: '',
    sourceFileName: result.background.sourceFileName,
    sourcePath: result.background.sourcePath
  });

  applyBackgroundSettings(state.backgroundDraft);
  setStatus(`已选择背景文件：${result.background.sourceFileName}`, 'success');
}

async function handleBackgroundSave() {
  const result = await window.desktopApi.background.save({
    colorHex: state.backgroundDraft.colorHex,
    imageSourcePath: state.backgroundDraft.sourcePath,
    keepExistingImage: !state.backgroundDraft.sourcePath && Boolean(state.backgroundDraft.filePath)
  });

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  closeBackgroundPalette({ revert: false });
  setStatus(result.message, 'success');
}

function handleBackgroundReset() {
  openModal(
    createConfirmDialog({
      message: '确认恢复默认背景？当前自定义颜色和背景图会被清除。',
      confirmText: '确认重置',
      cancelText: '取消',
      onConfirm: async () => {
        const result = await window.desktopApi.background.reset();

        closeModal();

        if (result.status !== 'success') {
          setStatus(result.message, 'error', {
            errorReportReady: Boolean(result.errorReportReady)
          });
          openModal(createAlertDialog(result.message));
          return;
        }

        state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
        applyBackgroundSettings(state.backgroundSettings);
        closeBackgroundPalette({ revert: false });
        setStatus(result.message, 'success');
      }
    })
  );
}

function closeModal() {
  elements.modalRoot.innerHTML = '';
}

function openModal(modalElement) {
  elements.modalRoot.innerHTML = '';
  elements.modalRoot.appendChild(modalElement);
}

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  return overlay;
}

function createAlertDialog(message) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card alert-card';
  dialog.innerHTML = `
    <div class="alert-message">${message}</div>
    <div class="dialog-actions center">
      <button class="primary-btn small" type="button">确认</button>
    </div>
  `;
  dialog.querySelector('button').addEventListener('click', closeModal);
  overlay.appendChild(dialog);
  return overlay;
}

function createConfirmDialog({ message, confirmText, cancelText, onConfirm }) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card alert-card';
  dialog.innerHTML = `
    <div class="alert-message">${message}</div>
    <div class="dialog-actions center">
      <button class="danger-btn small" type="button" data-action="confirm">${confirmText}</button>
      <button class="secondary-btn small" type="button" data-action="cancel">${cancelText}</button>
    </div>
  `;
  dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    await onConfirm();
  });
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
  overlay.appendChild(dialog);
  return overlay;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function updateTemplateSelect() {
  const previous = state.selectedTemplateId;
  elements.templateSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.templates.length ? '请选择模版' : '暂无模版';
  elements.templateSelect.appendChild(placeholder);

  state.templates.forEach((template) => {
    const option = document.createElement('option');
    option.value = String(template.id);
    option.textContent = template.name;
    elements.templateSelect.appendChild(option);
  });

  const preserved = state.templates.find((template) => String(template.id) === previous);
  const fallback = state.templates[0];
  state.selectedTemplateId = preserved
    ? String(preserved.id)
    : fallback
      ? String(fallback.id)
      : '';
  elements.templateSelect.value = state.selectedTemplateId || '';
}

async function refreshTemplates() {
  state.templates = await window.desktopApi.templates.list();
  updateTemplateSelect();
}

function renderTemplateTableRows(tableBody) {
  tableBody.innerHTML = '';

  if (!state.templates.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td class="empty-cell">暂无模版</td>
      <td class="empty-cell">-</td>
    `;
    tableBody.appendChild(emptyRow);
    return;
  }

  state.templates.forEach((template) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${template.name}</td>
      <td class="action-cell">
        <button class="text-action" type="button" data-action="manage">修改</button>
        <button class="text-action danger" type="button" data-action="delete">删除</button>
      </td>
    `;

    row.querySelector('[data-action="manage"]').addEventListener('click', async () => {
      const result = await window.desktopApi.templates.getMappings(template.id);

      if (result.status !== 'success') {
        setStatus(result.message, 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });
        openModal(createAlertDialog(result.message));
        return;
      }

      openModal(createMappingDialog(result));
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      openModal(
        createConfirmDialog({
          message: '确认删除',
          confirmText: '确认删除',
          cancelText: '否',
          onConfirm: async () => {
            await window.desktopApi.templates.deleteTemplate(template.id);
            await refreshTemplates();
            openModal(createTemplateManagerDialog());
          }
        })
      );
    });

    tableBody.appendChild(row);
  });
}

function createTemplateManagerDialog() {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card';
  dialog.innerHTML = `
    <div class="dialog-header compact">
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>模版名称</th>
            <th>执行操作</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  renderTemplateTableRows(dialog.querySelector('tbody'));
  overlay.appendChild(dialog);
  return overlay;
}

function createMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card mapping-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">映射关系设置</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper mapping-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>模版字段</th>
            <th>映射字段</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');
  const savedMap = new Map(payload.mappings.map((item) => [item.templateField, item]));
  const headerOptions = payload.template.headers.map((header) => {
    const escapedHeader = escapeHtml(header || '(空白字段)');
    const value = escapeHtml(header);
    return `<option value="${value}">${escapedHeader}</option>`;
  });

  payload.targetFields.forEach((fieldName) => {
    const row = document.createElement('tr');
    row.dataset.templateField = fieldName;
    const isBalanceField = fieldName === 'Balance';
    const isMerchantIdField = fieldName === 'MerchantId';
    const savedMapping = savedMap.get(fieldName) || {
      mappedField: isBalanceField ? '无' : '',
      customValue: ''
    };
    const selectOptions = [isBalanceField ? '<option value="无">无</option>' : '<option value=""></option>']
      .concat(isMerchantIdField ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
      .concat(headerOptions)
      .join('');
    row.innerHTML = `
      <td>${escapeHtml(fieldName)}</td>
      <td>
        <div class="mapping-field-editor">
          <select class="mapping-select">${selectOptions}</select>
          ${isMerchantIdField ? '<input class="mapping-text-input mapping-custom-input" type="text" spellcheck="false" placeholder="请输入固定 MerchantId" />' : ''}
        </div>
      </td>
    `;

    const select = row.querySelector('select');
    const customInput = row.querySelector('.mapping-custom-input');
    select.value = savedMapping.mappedField || (isBalanceField ? '无' : '');

    if (customInput) {
      customInput.value = savedMapping.customValue || '';
      customInput.hidden = select.value !== MERCHANT_ID_SELF_INPUT_OPTION;
      select.addEventListener('change', () => {
        customInput.hidden = select.value !== MERCHANT_ID_SELF_INPUT_OPTION;
      });
    }

    tbody.appendChild(row);
  });

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = Array.from(tbody.querySelectorAll('tr')).map((row) => {
      const select = row.querySelector('.mapping-select');
      const customInput = row.querySelector('.mapping-custom-input');

      return {
        templateField: row.dataset.templateField,
        mappedField: select.value,
        customValue: customInput ? customInput.value : ''
      };
    });
    const result = await window.desktopApi.templates.saveMappings({
      templateId: payload.template.id,
      mappings
    });

    openModal(createAlertDialog(result.message));
    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

function createAccountMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card account-card';
  dialog.innerHTML = `
    <div class="dialog-header compact">
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>网银大账户ID</th>
            <th>清结算系统大账户ID</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');

  function createInputRow(bankAccountId = '', clearingAccountId = '') {
    const row = document.createElement('tr');
    const bankCell = document.createElement('td');
    const clearingCell = document.createElement('td');
    const bankInput = document.createElement('input');
    const clearingInput = document.createElement('input');

    bankInput.className = 'mapping-text-input';
    bankInput.type = 'text';
    bankInput.spellcheck = false;
    bankInput.value = bankAccountId;

    clearingInput.className = 'mapping-text-input';
    clearingInput.type = 'text';
    clearingInput.spellcheck = false;
    clearingInput.value = clearingAccountId;

    bankCell.appendChild(bankInput);
    clearingCell.appendChild(clearingInput);
    row.appendChild(bankCell);
    row.appendChild(clearingCell);
    return row;
  }

  function createAddRow() {
    const row = document.createElement('tr');
    row.className = 'add-row';
    row.innerHTML = `
      <td><button class="text-action" type="button" data-action="add">新增</button></td>
      <td></td>
    `;

    row.querySelector('[data-action="add"]').addEventListener('click', () => {
      tbody.insertBefore(createInputRow('', ''), row);
    });

    return row;
  }

  payload.mappings.forEach((mapping) => {
    tbody.appendChild(createInputRow(mapping.bankAccountId, mapping.clearingAccountId));
  });
  tbody.appendChild(createAddRow());

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = Array.from(dialog.querySelectorAll('.mapping-text-input'))
      .reduce((accumulator, input, index) => {
        const rowIndex = Math.floor(index / 2);

        if (!accumulator[rowIndex]) {
          accumulator[rowIndex] = {
            bankAccountId: '',
            clearingAccountId: ''
          };
        }

        if (index % 2 === 0) {
          accumulator[rowIndex].bankAccountId = input.value;
        } else {
          accumulator[rowIndex].clearingAccountId = input.value;
        }

        return accumulator;
      }, []);

    const result = await window.desktopApi.accountMappings.save(mappings);

    openModal(createAlertDialog(result.message));
    if (result.status === 'success') {
      const info = await window.desktopApi.app.getInfo();
      state.accountMappingCount = info.accountMappingCount;
      setStatus(result.message, 'success');
    } else {
      setStatus(result.message, 'error', {
        errorReportReady: Boolean(result.errorReportReady)
      });
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

async function handleImportTemplate() {
  const result = await window.desktopApi.templates.importTemplate();

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });

  if (result.status === 'success') {
    await refreshTemplates();
  }
}

async function handleOpenAccountMappings() {
  const result = await window.desktopApi.accountMappings.list();

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  openModal(createAccountMappingDialog(result));
}

async function handleImportFile() {
  if (!state.hasEnum) {
    setStatus(getEnumStatusMessage(), 'error');
    return;
  }

  const templateId = Number(state.selectedTemplateId);
  const result = await window.desktopApi.files.importFile(templateId);

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });

  if (result.status === 'success' || result.status === 'warning') {
    setExportAvailability({
      detailEnabled: Boolean(result.detailReady),
      balanceEnabled: Boolean(result.balanceReady)
    });
    return;
  }

  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
}

async function handleExportDetail() {
  const result = await window.desktopApi.files.exportDetail();

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });
}

async function handleExportBalance() {
  const result = await window.desktopApi.files.exportBalance();

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });
}

function getNewAccountPayload() {
  return {
    bankName: elements.newAccountBankNameInput.value,
    location: elements.newAccountLocationInput.value,
    currency: elements.newAccountCurrencyInput.value,
    bankAccount: elements.newAccountBankAccountInput.value,
    openingDate: elements.newAccountOpenDateInput.value
  };
}

function applyNewAccountPreviewState() {
  setCurrentModule(MODULES.newAccountGenerator.id);
  elements.newAccountBankNameInput.value = '中国银行';
  elements.newAccountLocationInput.value = '香港';
  elements.newAccountCurrencyInput.value = 'USD';
  elements.newAccountBankAccountInput.value = '6222000000000001';
  elements.newAccountOpenDateInput.value = '2026-01-01';
  updateNewAccountGenerateAvailability();
  setNewAccountExportAvailability(true);
  setNewAccountStatus('新开账户余额账单可导出', 'success', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });
}

async function handleNewAccountGenerate() {
  const result = await window.desktopApi.newAccount.generate(getNewAccountPayload());

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'success') {
    setNewAccountExportAvailability(Boolean(result.exportReady));
  } else {
    setNewAccountExportAvailability(false);
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady),
    idleTitle: getNewAccountStatusTitle()
  });
}

async function handleNewAccountExport() {
  const result = await window.desktopApi.newAccount.exportFile();

  if (result.status === 'cancelled') {
    return;
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady),
    idleTitle: getNewAccountStatusTitle()
  });
}

async function initialize() {
  const info = await window.desktopApi.app.getInfo();
  drawBackgroundSpectrum();
  resetBackgroundPickerSelection();
  elements.appVersion.textContent = info.version;
  state.hasEnum = info.hasEnum;
  state.enumFileName = info.enumFileName || '';
  state.accountMappingCount = info.accountMappingCount || 0;
  state.hasErrorReport = Boolean(info.hasErrorReport);
  state.backgroundSettings = cloneBackgroundSettings(info.backgroundConfig);
  state.backgroundDraft = cloneBackgroundSettings(info.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  await refreshTemplates();
  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
  setNewAccountExportAvailability(false);
  updateNewAccountGenerateAvailability();
  setCurrentModule(MODULES.statementGenerator.id);
  closeModuleMenu();
  setStatus(getEnumStatusMessage(), state.hasEnum ? 'info' : 'error', {
    errorReportReady: false
  });
  setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });

  elements.importTemplateBtn.addEventListener('click', handleImportTemplate);
  elements.manageTemplateBtn.addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });
  elements.accountMappingBtn.addEventListener('click', handleOpenAccountMappings);
  elements.importFileBtn.addEventListener('click', handleImportFile);
  elements.exportDetailBtn.addEventListener('click', handleExportDetail);
  elements.exportBalanceBtn.addEventListener('click', handleExportBalance);
  elements.newAccountGenerateBtn.addEventListener('click', handleNewAccountGenerate);
  elements.newAccountExportBtn.addEventListener('click', handleNewAccountExport);
  elements.statusBox.addEventListener('click', () => {
    handleExportLastError('main').catch((error) => {
      console.error(error);
      setStatus('报错文件导出失败，请查看控制台', 'error');
    });
  });
  elements.newAccountStatusBox.addEventListener('click', () => {
    handleExportLastError('new-account').catch((error) => {
      console.error(error);
      setNewAccountStatus('报错文件导出失败，请查看控制台', 'error');
    });
  });
  elements.templateSelect.addEventListener('change', (event) => {
    state.selectedTemplateId = event.target.value;
    setExportAvailability({
      detailEnabled: false,
      balanceEnabled: false
    });
  });
  [
    elements.newAccountBankNameInput,
    elements.newAccountLocationInput,
    elements.newAccountCurrencyInput,
    elements.newAccountBankAccountInput,
    elements.newAccountOpenDateInput
  ].forEach((input) => {
    input.addEventListener('input', () => {
      updateNewAccountGenerateAvailability();
      setNewAccountExportAvailability(false);
      setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
        errorReportReady: false,
        idleTitle: getNewAccountStatusTitle()
      });
    });
  });
  elements.moduleSwitcherBtn.addEventListener('click', () => {
    if (state.isModuleMenuOpen) {
      closeModuleMenu();
      return;
    }

    openModuleMenu();
  });
  Array.from(elements.moduleSwitcherMenu.querySelectorAll('.module-option')).forEach((button) => {
    button.addEventListener('click', () => {
      setCurrentModule(button.dataset.module);
      closeModuleMenu();
    });
  });
  elements.backgroundPaletteBtn.addEventListener('click', () => {
    if (state.isBackgroundPaletteOpen) {
      closeBackgroundPalette();
      return;
    }

    openBackgroundPalette();
  });
  elements.backgroundSpectrumArea.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    state.isBackgroundSpectrumDragging = true;
    elements.backgroundSpectrumArea.setPointerCapture?.(event.pointerId);
    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  });
  elements.backgroundSpectrumArea.addEventListener('pointermove', (event) => {
    if (!state.isBackgroundSpectrumDragging) {
      return;
    }

    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  });
  elements.backgroundSpectrumArea.addEventListener('pointerup', (event) => {
    state.isBackgroundSpectrumDragging = false;
    elements.backgroundSpectrumArea.releasePointerCapture?.(event.pointerId);
  });
  elements.backgroundSpectrumArea.addEventListener('pointercancel', () => {
    state.isBackgroundSpectrumDragging = false;
  });
  elements.backgroundSpectrumArea.addEventListener('lostpointercapture', () => {
    state.isBackgroundSpectrumDragging = false;
  });
  elements.backgroundImportBtn.addEventListener('click', () => {
    handleBackgroundImportFile().catch((error) => {
      console.error(error);
      setStatus('背景导入失败，请查看控制台', 'error');
    });
  });
  elements.backgroundDoneBtn.addEventListener('click', () => {
    handleBackgroundSave().catch((error) => {
      console.error(error);
      setStatus('背景保存失败，请查看控制台', 'error');
    });
  });
  elements.backgroundResetBtn.addEventListener('click', handleBackgroundReset);

  elements.minimizeBtn.addEventListener('click', () => window.desktopApi.window.minimize());
  elements.maximizeBtn.addEventListener('click', async () => {
    const result = await window.desktopApi.window.toggleMaximize();
    state.isMaximized = result.isMaximized;
    elements.maximizeBtn.textContent = state.isMaximized ? '❐' : '□';
  });
  elements.closeBtn.addEventListener('click', () => window.desktopApi.window.close());

  window.desktopApi.window.onMaximizedState((value) => {
    state.isMaximized = value;
    elements.maximizeBtn.textContent = value ? '❐' : '□';
  });

  document.addEventListener('pointerdown', (event) => {
    if (
      state.isModuleMenuOpen &&
      !elements.moduleSwitcherBtn.contains(event.target) &&
      !elements.moduleSwitcherMenu.contains(event.target)
    ) {
      closeModuleMenu();
    }

    if (state.isBackgroundPaletteOpen) {
      if (
        elements.backgroundTool.contains(event.target) ||
        elements.modalRoot.contains(event.target)
      ) {
        return;
      }

      closeBackgroundPalette();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.isModuleMenuOpen) {
        closeModuleMenu();
      }

      if (state.isBackgroundPaletteOpen) {
        closeBackgroundPalette();
      }
    }
  });

  if (info.previewModal === 'account-mapping') {
    setTimeout(() => {
      handleOpenAccountMappings().catch((error) => {
        console.error(error);
      });
    }, 120);
  } else if (info.previewModal === 'new-account') {
    setTimeout(() => {
      applyNewAccountPreviewState();
    }, 120);
  } else if (info.previewModal === 'background-palette') {
    setTimeout(() => {
      openBackgroundPalette();
    }, 120);
  }
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
});
