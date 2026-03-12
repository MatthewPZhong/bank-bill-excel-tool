const DEFAULT_BACKGROUND_SETTINGS = Object.freeze({
  colorHex: '#efe8da',
  imageDataUrl: '',
  filePath: '',
  sourceFileName: '',
  sourcePath: ''
});
const DEFAULT_SPECTRUM_PICK_COLOR = '#ffffff';
const BACKGROUND_FILE_HINT = '支持 PNG/JPG/JPEG/WEBP，大小不超过 5MB，建议使用横版高清图片';
const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const SIGNED_AMOUNT_MAPPING_FIELD = '按正负号拆分的发生额';
const AMOUNT_BASED_NAME_MAPPING_FIELD = '根据发生额做映射的户名';
const AMOUNT_BASED_ACCOUNT_MAPPING_FIELD = '根据发生额做映射的账户号';
const ADVANCED_MAPPING_FIELDS = [
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
];
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
  currencyOptions: [],
  manualBalancePromptReady: false,
  manualBalancePrompt: null,
  selectedNewAccountCurrencies: [],
  isNewAccountCurrencyDropdownOpen: false,
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
  newAccountCurrencyDropdownWrap: document.getElementById('newAccountCurrencyDropdownWrap'),
  newAccountCurrencyDropdownBtn: document.getElementById('newAccountCurrencyDropdownBtn'),
  newAccountCurrencyDropdownPanel: document.getElementById('newAccountCurrencyDropdownPanel'),
  newAccountMultiCurrencyCheckbox: document.getElementById('newAccountMultiCurrencyCheckbox'),
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
    manualBalancePromptReady = false,
    idleTitle = ''
  } = options;

  box.textContent = message;
  box.dataset.tone = tone;
  box.dataset.errorReportReady = errorReportReady ? 'true' : 'false';
  box.dataset.manualBalancePromptReady = manualBalancePromptReady ? 'true' : 'false';
  box.classList.toggle('is-clickable', errorReportReady || manualBalancePromptReady);
  box.title = manualBalancePromptReady
    ? '点击补录上一账单日余额'
    : errorReportReady
      ? '点击导出报错文件'
      : idleTitle;
}

function setStatus(message, tone = 'info', options = {}) {
  state.hasErrorReport = Boolean(options.errorReportReady);
  state.manualBalancePromptReady = Boolean(options.manualBalancePromptReady);
  state.manualBalancePrompt = state.manualBalancePromptReady && options.manualBalancePrompt
    ? { ...options.manualBalancePrompt }
    : null;
  updateStatusBox(elements.statusBox, message, tone, {
    errorReportReady: state.hasErrorReport,
    manualBalancePromptReady: state.manualBalancePromptReady,
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

function applyStatementResult(result) {
  if (result.status === 'cancelled') {
    return false;
  }

  const tone = result.status === 'success'
    ? 'success'
    : result.manualBalancePromptReady
      ? 'info'
      : 'error';

  setStatus(result.message, tone, {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null
  });

  if (
    result.status === 'success' ||
    result.status === 'warning' ||
    result.status === 'manual-balance-required' ||
    result.status === 'manual-balance-invalid'
  ) {
    setExportAvailability({
      detailEnabled: Boolean(result.detailReady),
      balanceEnabled: Boolean(result.balanceReady)
    });
    return true;
  }

  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
  return true;
}

function isNewAccountFormComplete() {
  const currencyReady = isNewAccountMultiCurrencyMode()
    ? state.selectedNewAccountCurrencies.length > 0
    : String(elements.newAccountCurrencyInput.value || '').trim() !== '';

  return [
    elements.newAccountBankNameInput.value,
    elements.newAccountLocationInput.value,
    elements.newAccountBankAccountInput.value,
    elements.newAccountOpenDateInput.value
  ].every((value) => String(value || '').trim() !== '') && currencyReady;
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

function isNewAccountMultiCurrencyMode() {
  return elements.newAccountMultiCurrencyCheckbox.checked;
}

function formatSelectedCurrencySummary(currencies) {
  if (!currencies.length) {
    return '\u00A0';
  }

  if (currencies.length === 1) {
    return currencies[0];
  }

  return `已选${currencies.length}项`;
}

function updateNewAccountCurrencyDropdownLabel() {
  const selectedCurrencies = state.selectedNewAccountCurrencies.slice();
  elements.newAccountCurrencyDropdownBtn.textContent = formatSelectedCurrencySummary(selectedCurrencies);
  elements.newAccountCurrencyDropdownBtn.title = selectedCurrencies.join('、');
  elements.newAccountCurrencyDropdownBtn.disabled = state.currencyOptions.length === 0;
}

function closeNewAccountCurrencyDropdown() {
  state.isNewAccountCurrencyDropdownOpen = false;
  elements.newAccountCurrencyDropdownPanel.hidden = true;
  elements.newAccountCurrencyDropdownBtn.classList.remove('is-open');
  elements.newAccountCurrencyDropdownBtn.setAttribute('aria-expanded', 'false');
}

function openNewAccountCurrencyDropdown() {
  if (!isNewAccountMultiCurrencyMode() || state.currencyOptions.length === 0) {
    return;
  }

  state.isNewAccountCurrencyDropdownOpen = true;
  elements.newAccountCurrencyDropdownPanel.hidden = false;
  elements.newAccountCurrencyDropdownBtn.classList.add('is-open');
  elements.newAccountCurrencyDropdownBtn.setAttribute('aria-expanded', 'true');
}

function toggleNewAccountCurrencyDropdown() {
  if (state.isNewAccountCurrencyDropdownOpen) {
    closeNewAccountCurrencyDropdown();
    return;
  }

  openNewAccountCurrencyDropdown();
}

function handleNewAccountFormMutation() {
  updateNewAccountGenerateAvailability();
  setNewAccountExportAvailability(false);
  setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });
}

function renderNewAccountCurrencyOptions() {
  elements.newAccountCurrencyDropdownPanel.replaceChildren();
  state.selectedNewAccountCurrencies = state.selectedNewAccountCurrencies.filter((currency) => {
    return state.currencyOptions.includes(currency);
  });

  if (!state.currencyOptions.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'new-account-currency-option';
    emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
    elements.newAccountCurrencyDropdownPanel.appendChild(emptyState);
    updateNewAccountCurrencyDropdownLabel();
    return;
  }

  state.currencyOptions.forEach((currencyCode) => {
    const option = document.createElement('label');
    option.className = 'new-account-currency-option';

    const text = document.createElement('span');
    text.className = 'new-account-currency-option-text';
    text.textContent = currencyCode;

    const checkbox = document.createElement('input');
    checkbox.className = 'new-account-checkbox';
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedNewAccountCurrencies.includes(currencyCode);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selectedNewAccountCurrencies = Array.from(new Set([...state.selectedNewAccountCurrencies, currencyCode]));
      } else {
        state.selectedNewAccountCurrencies = state.selectedNewAccountCurrencies.filter((value) => value !== currencyCode);
      }

      updateNewAccountCurrencyDropdownLabel();
      handleNewAccountFormMutation();
    });

    option.append(text, checkbox);
    elements.newAccountCurrencyDropdownPanel.appendChild(option);
  });

  updateNewAccountCurrencyDropdownLabel();
}

function syncNewAccountCurrencyMode() {
  const isMultiCurrency = isNewAccountMultiCurrencyMode();
  elements.newAccountCurrencyInput.hidden = isMultiCurrency;
  elements.newAccountCurrencyDropdownWrap.hidden = !isMultiCurrency;

  if (!isMultiCurrency) {
    closeNewAccountCurrencyDropdown();
    return;
  }

  updateNewAccountCurrencyDropdownLabel();
}

function syncNewAccountOpenDateInputType() {
  elements.newAccountOpenDateInput.type = elements.newAccountOpenDateInput.value ? 'date' : 'text';
}

function setNewAccountOpenDateValue(value) {
  elements.newAccountOpenDateInput.type = value ? 'date' : 'text';
  elements.newAccountOpenDateInput.value = value;
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

function createAlertDialog(message, options = {}) {
  const { onConfirm = null } = options;
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card alert-card';
  dialog.innerHTML = `
    <div class="alert-message">${message}</div>
    <div class="dialog-actions center">
      <button class="primary-btn small" type="button">确认</button>
    </div>
  `;
  dialog.querySelector('button').addEventListener('click', () => {
    closeModal();
    onConfirm?.();
  });
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

function createManualBalanceSeedDialog(prompt, draft = {}) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">补录上一账单日余额</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="manual-balance-form">
      <label class="manual-balance-row">
        <span class="manual-balance-label">请选择上一账单日日期</span>
        <input class="mapping-text-input manual-balance-input manual-balance-date-input" type="text" value="" />
      </label>
      <label class="manual-balance-row">
        <span class="manual-balance-label">请输入上一账单日余额</span>
        <input class="mapping-text-input manual-balance-input manual-balance-amount-input" type="text" spellcheck="false" value="" />
      </label>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const dateInput = dialog.querySelector('.manual-balance-date-input');
  const amountInput = dialog.querySelector('.manual-balance-amount-input');
  dateInput.value = draft.billDate || '';
  dateInput.type = dateInput.value ? 'date' : 'text';
  amountInput.value = draft.endBalance || '';

  dateInput.addEventListener('focus', () => {
    if (dateInput.type !== 'date') {
      dateInput.type = 'date';
    }

    dateInput.showPicker?.();
  });
  dateInput.addEventListener('blur', () => {
    if (!dateInput.value) {
      dateInput.type = 'text';
    }
  });
  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const payload = {
      billDate: dateInput.value,
      endBalance: amountInput.value
    };
    const result = await window.desktopApi.files.saveBalanceSeed(payload);

    if (result.status === 'confirm-overwrite') {
      openModal(
        createConfirmDialog({
          message: '该日期的余额已存在，确认覆盖吗？',
          confirmText: '确认覆盖',
          cancelText: '取消',
          onConfirm: async () => {
            const overwriteResult = await window.desktopApi.files.saveBalanceSeed({
              ...payload,
              overwrite: true
            });
            closeModal();
            applyStatementResult(overwriteResult);
          }
        })
      );
      return;
    }

    closeModal();
    applyStatementResult(result);

    if (result.status === 'error' && !result.manualBalancePromptReady) {
      openModal(createAlertDialog(result.message));
    }
  });

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
  placeholder.textContent = state.templates.length ? '请选择模板' : '暂无模板';
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

function cloneBigAccountItems(bigAccounts = []) {
  return bigAccounts.map((item) => ({
    merchantId: String(item.merchantId || ''),
    currencies: Array.isArray(item.currencies) ? item.currencies.slice() : [],
    isMultiCurrency: Boolean(item.isMultiCurrency)
  }));
}

function formatBigAccountCurrencySummary(currencies) {
  const uniqueCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));

  if (!uniqueCurrencies.length) {
    return '';
  }

  if (uniqueCurrencies.length === 1) {
    return uniqueCurrencies[0];
  }

  if (uniqueCurrencies.length <= 3) {
    return uniqueCurrencies.join('、');
  }

  return `${uniqueCurrencies.length}个币种`;
}

function getBigAccountCurrencyTitle(currencies) {
  return Array.from(new Set((currencies || []).filter((value) => value))).join('、');
}

function collectMappingDraftFromTable(tableBody) {
  return Array.from(tableBody.querySelectorAll('tr[data-template-field]')).map((row) => {
    const select = row.querySelector('.mapping-select');
    const customInput = row.querySelector('.mapping-custom-input');
    const bigAccountToggle = row.querySelector('.mapping-big-account-toggle');

    return {
      templateField: row.dataset.templateField,
      mappedField: select ? select.value : '',
      customValue: customInput ? customInput.value : '',
      isMultiBigAccount: bigAccountToggle ? bigAccountToggle.checked : false
    };
  });
}

function createTemplateRenameDialog(template) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">重命名模板</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="manual-balance-form">
      <label class="manual-balance-row">
        <span class="manual-balance-label">当前模板名称</span>
        <input class="mapping-text-input manual-balance-input" type="text" value="${escapeHtml(template.name)}" disabled />
      </label>
      <label class="manual-balance-row">
        <span class="manual-balance-label">新模板名称</span>
        <input class="mapping-text-input manual-balance-input rename-template-input" type="text" spellcheck="false" value="${escapeHtml(template.name)}" />
      </label>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const input = dialog.querySelector('.rename-template-input');
  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.rename({
      templateId: template.id,
      name: input.value
    });

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message));
  });

  overlay.appendChild(dialog);
  return overlay;
}

function createBigAccountSelectionDialog(options) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="big-account-selection-list"></div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const list = dialog.querySelector('.big-account-selection-list');
  const radioName = `big-account-selection-${Date.now()}`;

  options.forEach((option, index) => {
    const label = document.createElement('label');
    label.className = 'big-account-selection-item';
    label.innerHTML = `
      <input class="new-account-checkbox" type="radio" name="${radioName}" value="${index}" />
      <span>${escapeHtml(option.label)}</span>
    `;
    list.appendChild(label);
  });

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const checked = list.querySelector(`input[name="${radioName}"]:checked`);

    if (!checked) {
      setStatus('请选择本次使用的大账号 / 币种', 'error');
      return;
    }

    const selectedOption = options[Number(checked.value)];
    const result = await window.desktopApi.files.completeBigAccountSelection({
      merchantId: selectedOption.merchantId,
      currency: selectedOption.currency
    });

    closeModal();
    applyStatementResult(result);

    if (result.status === 'error' && !result.manualBalancePromptReady) {
      openModal(createAlertDialog(result.message));
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

function createBigAccountManagerDialog({ bigAccounts, onDone, onCancel }) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card big-account-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">维护大账号</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>大账号</th>
            <th>币种</th>
            <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions split big-account-footer-actions">
      <button class="secondary-btn small" type="button" data-action="add">新增</button>
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');
  const tableWrapper = dialog.querySelector('.table-wrapper');
  const floatingPanel = document.createElement('div');
  floatingPanel.className = 'new-account-currency-dropdown-panel big-account-currency-floating-panel';
  floatingPanel.hidden = true;
  const currencySelectOptions = [
    '<option value=""></option>',
    ...state.currencyOptions.map((currencyCode) => `<option value="${escapeHtml(currencyCode)}">${escapeHtml(currencyCode)}</option>`)
  ].join('');
  let activeFloatingDropdown = null;

  function cleanupFloatingDropdown() {
    if (activeFloatingDropdown?.button) {
      activeFloatingDropdown.button.classList.remove('is-open');
      activeFloatingDropdown.button.setAttribute('aria-expanded', 'false');
    }

    activeFloatingDropdown = null;
    floatingPanel.hidden = true;
    floatingPanel.replaceChildren();
  }

  function updateCurrencyDropdownLabel(button, currencies) {
    const selectedCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));
    button.textContent = formatBigAccountCurrencySummary(selectedCurrencies) || '\u00A0';
    button.title = getBigAccountCurrencyTitle(selectedCurrencies);
    button.disabled = state.currencyOptions.length === 0;
  }

  function renderCurrencyDropdownOptions(selectedCurrencies, onChange) {
    floatingPanel.replaceChildren();
    if (!state.currencyOptions.length) {
      const emptyState = document.createElement('div');
      emptyState.className = 'new-account-currency-option';
      emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
      floatingPanel.appendChild(emptyState);
      return;
    }

    state.currencyOptions.forEach((currencyCode) => {
      const option = document.createElement('label');
      option.className = 'new-account-currency-option';

      const text = document.createElement('span');
      text.className = 'new-account-currency-option-text';
      text.textContent = currencyCode;

      const checkbox = document.createElement('input');
      checkbox.className = 'new-account-checkbox';
      checkbox.type = 'checkbox';
      checkbox.value = currencyCode;
      checkbox.checked = selectedCurrencies.includes(currencyCode);
      checkbox.addEventListener('change', () => {
        onChange(
          Array.from(floatingPanel.querySelectorAll('input[type="checkbox"]:checked')).map((selectedCheckbox) => selectedCheckbox.value)
        );
      });

      option.append(text, checkbox);
      floatingPanel.appendChild(option);
    });
  }

  function positionFloatingDropdown(button) {
    const buttonRect = button.getBoundingClientRect();
    const margin = 12;
    const availableWidth = Math.max(220, Math.min(260, window.innerWidth - margin * 2));

    floatingPanel.style.position = 'fixed';
    floatingPanel.style.minWidth = `${Math.max(buttonRect.width, 188)}px`;
    floatingPanel.style.maxWidth = `${availableWidth}px`;
    floatingPanel.style.visibility = 'hidden';
    floatingPanel.hidden = false;

    const panelWidth = floatingPanel.offsetWidth || Math.max(buttonRect.width, 188);
    const panelHeight = floatingPanel.offsetHeight || 216;
    const left = Math.min(
      Math.max(margin, buttonRect.left),
      Math.max(margin, window.innerWidth - panelWidth - margin)
    );
    const top = buttonRect.bottom + 6 + panelHeight > window.innerHeight - margin
      ? Math.max(margin, buttonRect.top - panelHeight - 6)
      : buttonRect.bottom + 6;

    floatingPanel.style.left = `${left}px`;
    floatingPanel.style.top = `${top}px`;
    floatingPanel.style.visibility = 'visible';
  }

  function openFloatingDropdown({ button, selectedCurrencies, onChange }) {
    const sameButton = activeFloatingDropdown?.button === button;
    cleanupFloatingDropdown();

    if (sameButton) {
      return;
    }

    renderCurrencyDropdownOptions(selectedCurrencies, onChange);
    activeFloatingDropdown = { button };
    button.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    positionFloatingDropdown(button);
  }

  function createBigAccountRow(item = {}, initialMode = 'view') {
    const row = document.createElement('tr');
    row.dataset.bigAccountRow = 'true';
    row.dataset.mode = initialMode;
    row.innerHTML = `
      <td>
        <input class="mapping-text-input big-account-merchant-input" type="text" spellcheck="false" value="${escapeHtml(item.merchantId || '')}" />
        <span class="big-account-view-text big-account-merchant-view" hidden></span>
      </td>
      <td>
        <div class="big-account-currency-editor">
          <select class="mapping-select big-account-currency-select">${currencySelectOptions}</select>
          <div class="new-account-currency-dropdown-wrap big-account-currency-dropdown-wrap" hidden>
            <button class="new-account-input new-account-currency-dropdown-btn big-account-currency-dropdown-btn" type="button" aria-expanded="false"></button>
          </div>
          <label class="new-account-checkbox-label big-account-multi-label">
            <input class="new-account-checkbox big-account-multi-checkbox" type="checkbox" />
            <span>多币种</span>
          </label>
        </div>
        <span class="big-account-view-text big-account-currency-view" hidden></span>
      </td>
      <td class="manager-action-cell big-account-action-cell">
        <div class="big-account-row-actions">
          <button class="text-action" type="button" data-action="toggle-complete"></button>
          <button class="text-action danger" type="button" data-action="delete">删除</button>
        </div>
      </td>
    `;

    const merchantInput = row.querySelector('.big-account-merchant-input');
    const merchantView = row.querySelector('.big-account-merchant-view');
    const select = row.querySelector('.big-account-currency-select');
    const dropdownWrap = row.querySelector('.big-account-currency-dropdown-wrap');
    const dropdownButton = row.querySelector('.big-account-currency-dropdown-btn');
    const multiCheckbox = row.querySelector('.big-account-multi-checkbox');
    const currencyEditor = row.querySelector('.big-account-currency-editor');
    const currencyView = row.querySelector('.big-account-currency-view');
    const toggleCompleteBtn = row.querySelector('[data-action="toggle-complete"]');
    let selectedCurrencies = Array.isArray(item.currencies) ? item.currencies.slice() : [];

    multiCheckbox.checked = Boolean(item.isMultiCurrency);
    if (!multiCheckbox.checked) {
      select.value = selectedCurrencies[0] || '';
    }

    function getRowDraft() {
      return {
        merchantId: merchantInput.value.trim(),
        isMultiCurrency: multiCheckbox.checked,
        currencies: multiCheckbox.checked
          ? Array.from(new Set(selectedCurrencies.filter((value) => value)))
          : [select.value].filter((value) => value !== '')
      };
    }

    function validateRowDraft() {
      const draft = getRowDraft();

      if (!draft.merchantId) {
        return '请填写大账号';
      }

      if (!draft.currencies.length) {
        return '请选择币种';
      }

      return '';
    }

    function syncCurrencyMode() {
      const isMultiCurrency = multiCheckbox.checked;
      select.hidden = isMultiCurrency;
      dropdownWrap.hidden = !isMultiCurrency;

      if (!isMultiCurrency) {
        if (activeFloatingDropdown?.button === dropdownButton) {
          cleanupFloatingDropdown();
        }
        return;
      }

      updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
    }

    dropdownButton.addEventListener('click', () => {
      if (dropdownWrap.hidden) {
        return;
      }

      openFloatingDropdown({
        button: dropdownButton,
        selectedCurrencies,
        onChange: (nextSelectedCurrencies) => {
          selectedCurrencies = nextSelectedCurrencies;
          updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
        }
      });
    });
    multiCheckbox.addEventListener('change', syncCurrencyMode);
    select.addEventListener('change', () => {
      if (row.dataset.mode === 'view') {
        return;
      }

      currencyView.textContent = select.value;
      currencyView.title = select.value;
    });
    merchantInput.addEventListener('input', () => {
      if (row.dataset.mode === 'view') {
        return;
      }

      merchantView.textContent = merchantInput.value.trim();
      merchantView.title = merchantInput.value.trim();
    });
    toggleCompleteBtn.addEventListener('click', () => {
      if (row.dataset.mode === 'edit') {
        const validationMessage = validateRowDraft();

        if (validationMessage) {
          setStatus(validationMessage, 'error');
          return;
        }

        const draft = getRowDraft();
        merchantView.textContent = draft.merchantId;
        merchantView.title = draft.merchantId;
        currencyView.textContent = formatBigAccountCurrencySummary(draft.currencies);
        currencyView.title = getBigAccountCurrencyTitle(draft.currencies);
        merchantInput.hidden = true;
        currencyEditor.hidden = true;
        merchantView.hidden = false;
        currencyView.hidden = false;
        row.dataset.mode = 'view';
        toggleCompleteBtn.textContent = '修改';
        if (activeFloatingDropdown?.button === dropdownButton) {
          cleanupFloatingDropdown();
        }
        return;
      }

      row.dataset.mode = 'edit';
      merchantInput.hidden = false;
      currencyEditor.hidden = false;
      merchantView.hidden = true;
      currencyView.hidden = true;
      toggleCompleteBtn.textContent = '完成';
      syncCurrencyMode();
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (activeFloatingDropdown?.button === dropdownButton) {
        cleanupFloatingDropdown();
      }
      row.remove();
    });

    syncCurrencyMode();

    if (initialMode === 'view') {
      const initialDraft = getRowDraft();
      merchantView.textContent = initialDraft.merchantId;
      merchantView.title = initialDraft.merchantId;
      currencyView.textContent = formatBigAccountCurrencySummary(initialDraft.currencies);
      currencyView.title = getBigAccountCurrencyTitle(initialDraft.currencies);
      merchantInput.hidden = true;
      currencyEditor.hidden = true;
      merchantView.hidden = false;
      currencyView.hidden = false;
      toggleCompleteBtn.textContent = '修改';
    } else {
      merchantInput.hidden = false;
      currencyEditor.hidden = false;
      merchantView.hidden = true;
      currencyView.hidden = true;
      toggleCompleteBtn.textContent = '完成';
    }

    return row;
  }

  const initialBigAccounts = bigAccounts.length
    ? bigAccounts
    : [{ merchantId: '', currencies: [], isMultiCurrency: false }];
  initialBigAccounts.forEach((item) => {
    tbody.appendChild(createBigAccountRow(item, bigAccounts.length ? 'view' : 'edit'));
  });

  const handleKeydown = (event) => {
    if (event.key === 'Escape' && !floatingPanel.hidden) {
      cleanupFloatingDropdown();
    }
  };

  document.addEventListener('keydown', handleKeydown);
  overlay.addEventListener('mousedown', (event) => {
    if (
      activeFloatingDropdown &&
      !floatingPanel.contains(event.target) &&
      !activeFloatingDropdown.button.contains(event.target)
    ) {
      cleanupFloatingDropdown();
    }
  });
  tableWrapper.addEventListener('scroll', cleanupFloatingDropdown);

  function cleanupAndCancel() {
    cleanupFloatingDropdown();
    document.removeEventListener('keydown', handleKeydown);
    onCancel();
  }

  dialog.querySelector('.icon-close').addEventListener('click', cleanupAndCancel);
  dialog.querySelector('[data-action="add"]').addEventListener('click', () => {
    cleanupFloatingDropdown();
    tbody.appendChild(createBigAccountRow({}, 'edit'));
  });
  dialog.querySelector('[data-action="done"]').addEventListener('click', () => {
    const rows = Array.from(tbody.querySelectorAll('tr[data-big-account-row]'));

    if (rows.some((row) => row.dataset.mode === 'edit')) {
      setStatus('请先完成或删除当前编辑行', 'error');
      return;
    }

    const nextBigAccounts = rows.map((row) => {
      const merchantId = row.querySelector('.big-account-merchant-input').value.trim();
      const isMultiCurrency = row.querySelector('.big-account-multi-checkbox').checked;
      const currencies = isMultiCurrency
        ? Array.from(new Set(row.querySelector('.big-account-currency-view').title.split('、').filter((value) => value)))
        : [row.querySelector('.big-account-currency-select').value].filter((value) => value !== '');

      return {
        merchantId,
        currencies,
        isMultiCurrency
      };
    }).filter((item) => item.merchantId !== '' && item.currencies.length > 0);

    cleanupFloatingDropdown();
    document.removeEventListener('keydown', handleKeydown);
    onDone(nextBigAccounts);
  });

  overlay.appendChild(dialog);
  overlay.appendChild(floatingPanel);
  return overlay;
}

function renderTemplateTableRows(tableBody) {
  tableBody.innerHTML = '';

  if (!state.templates.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td class="empty-cell">暂无模板</td>
      <td class="empty-cell">-</td>
      <td class="empty-cell">-</td>
    `;
    tableBody.appendChild(emptyRow);
    return;
  }

  state.templates.forEach((template) => {
    const bigAccountSummary = template.bigAccountSummary || '未设置';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${template.name}</td>
      <td class="manager-big-account-cell">
        <span class="manager-big-account-summary" title="${escapeHtml(bigAccountSummary)}">${escapeHtml(bigAccountSummary)}</span>
      </td>
      <td class="manager-action-cell">
        <div class="manager-row-actions">
          <button class="text-action" type="button" data-action="manage">修改</button>
          <button class="text-action" type="button" data-action="rename">重命名</button>
          <button class="text-action danger" type="button" data-action="delete">删除</button>
        </div>
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
    row.querySelector('[data-action="rename"]').addEventListener('click', () => {
      openModal(createTemplateRenameDialog(template));
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
            <th>模板名称</th>
            <th>大账号</th>
            <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right template-manager-bundle-actions">
      <button class="secondary-btn small" type="button" data-action="import-bundle">导入模板文件</button>
      <button class="secondary-btn small" type="button" data-action="export-bundle">导出模板文件</button>
    </div>
  `;

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="import-bundle"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.importBundle();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message));
  });
  dialog.querySelector('[data-action="export-bundle"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.exportBundle();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status !== 'success') {
      openModal(createAlertDialog(result.message));
    }
  });
  renderTemplateTableRows(dialog.querySelector('tbody'));
  overlay.appendChild(dialog);
  return overlay;
}

function createMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  const advancedMappingFields = Array.isArray(payload.advancedMappingFields) && payload.advancedMappingFields.length
    ? payload.advancedMappingFields
    : ADVANCED_MAPPING_FIELDS;
  const currentBigAccounts = cloneBigAccountItems(payload.bigAccounts || []);
  dialog.className = 'modal-card mapping-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">映射关系管理</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper mapping-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>模板字段</th>
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
  const rowByField = new Map();
  const savedMap = new Map(payload.mappings.map((item) => [item.templateField, item]));
  const headerOptions = payload.template.headers.map((header) => {
    const escapedHeader = escapeHtml(header || '(空白字段)');
    const value = escapeHtml(header);
    return `<option value="${value}">${escapedHeader}</option>`;
  });

  payload.targetFields.forEach((fieldName) => {
    if (fieldName === advancedMappingFields[0]) {
      const sectionRow = document.createElement('tr');
      sectionRow.className = 'mapping-section-row';
      sectionRow.innerHTML = '<td colspan="2"><strong>映射关系设置</strong></td>';
      tbody.appendChild(sectionRow);
    }

    const row = document.createElement('tr');
    row.dataset.templateField = fieldName;
    const isBalanceField = fieldName === 'Balance';
    const isMerchantIdField = fieldName === 'MerchantId';
    const supportsSelfInputOption = isMerchantIdField;
    const savedMapping = savedMap.get(fieldName) || {
      mappedField: isBalanceField ? BALANCE_DISABLED_OPTION : '',
      customValue: '',
      isMultiBigAccount: false
    };
    const selectOptions = [isBalanceField ? `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>` : '<option value=""></option>']
      .concat(isBalanceField ? [`<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`] : [])
      .concat(supportsSelfInputOption ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
      .concat(headerOptions)
      .join('');
    row.innerHTML = `
      <td>${escapeHtml(fieldName)}</td>
      <td>
        <div class="mapping-field-editor">
          <select class="mapping-select">${selectOptions}</select>
          ${isMerchantIdField ? `
            <button class="secondary-btn small mapping-big-account-manage-btn" type="button" hidden>维护大账号</button>
          ` : ''}
        </div>
      </td>
    `;

    const select = row.querySelector('.mapping-select');
    const manageBigAccountBtn = row.querySelector('.mapping-big-account-manage-btn');
    select.value = savedMapping.mappedField || (isBalanceField ? BALANCE_DISABLED_OPTION : '');

    function syncEditorState() {
      const isCustomInput = select.value === MERCHANT_ID_SELF_INPUT_OPTION;

      if (manageBigAccountBtn) {
        manageBigAccountBtn.hidden = !isCustomInput;
      }
    }

    if (manageBigAccountBtn) {
      manageBigAccountBtn.addEventListener('click', () => {
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createBigAccountManagerDialog({
          bigAccounts: currentBigAccounts,
          onDone: (nextBigAccounts) => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings.map((mapping) => {
                return mapping.templateField === 'MerchantId'
                  ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION }
                  : mapping;
              }),
              bigAccounts: nextBigAccounts
            }));
          },
          onCancel: () => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: currentBigAccounts
            }));
          }
        }));
      });
    }

    select.addEventListener('change', syncEditorState);
    syncEditorState();
    rowByField.set(fieldName, row);
    tbody.appendChild(row);
  });

  function syncMerchantIdDependentRows() {
    const merchantRow = rowByField.get('MerchantId');
    const currencyRow = rowByField.get('Currency');
    const merchantSelect = merchantRow?.querySelector('.mapping-select');
    const isManagedByBigAccount = merchantSelect?.value === MERCHANT_ID_SELF_INPUT_OPTION;

    if (currencyRow) {
      currencyRow.hidden = Boolean(isManagedByBigAccount);
    }
  }

  const merchantSelect = rowByField.get('MerchantId')?.querySelector('.mapping-select');
  merchantSelect?.addEventListener('change', syncMerchantIdDependentRows);
  syncMerchantIdDependentRows();

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = collectMappingDraftFromTable(tbody);
    const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
    const result = await window.desktopApi.templates.saveMappings({
      templateId: payload.template.id,
      mappings,
      bigAccounts: draftBigAccounts
    });

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message, {
      onConfirm: () => {
        openModal(createMappingDialog({
          ...payload,
          mappings,
          bigAccounts: draftBigAccounts
        }));
      }
    }));
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

  if (result.status === 'select-big-account') {
    openModal(createBigAccountSelectionDialog(result.options || []));
    return;
  }

  applyStatementResult(result);
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
    currencies: state.selectedNewAccountCurrencies.slice(),
    isMultiCurrency: isNewAccountMultiCurrencyMode(),
    bankAccount: elements.newAccountBankAccountInput.value,
    openingDate: elements.newAccountOpenDateInput.value
  };
}

function applyNewAccountPreviewState() {
  setCurrentModule(MODULES.newAccountGenerator.id);
  elements.newAccountMultiCurrencyCheckbox.checked = false;
  state.selectedNewAccountCurrencies = [];
  syncNewAccountCurrencyMode();
  elements.newAccountBankNameInput.value = '中国银行';
  elements.newAccountLocationInput.value = '香港';
  elements.newAccountCurrencyInput.value = 'USD';
  elements.newAccountBankAccountInput.value = '6222000000000001';
  setNewAccountOpenDateValue('2026-01-01');
  updateNewAccountGenerateAvailability();
  setNewAccountExportAvailability(true);
  setNewAccountStatus('新开账户余额账单可导出', 'success', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });
}

function applyTemplateManagerPreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  state.templates = [
    {
      id: 'preview-template-1',
      name: 'LusoBank-MO',
      bigAccountSummary: '来自账单'
    },
    {
      id: 'preview-template-2',
      name: 'BankABC-HK',
      bigAccountSummary: '未设置'
    },
    {
      id: 'preview-template-3',
      name: 'PingPong-US',
      bigAccountSummary: '62220000000000012345'
    },
    {
      id: 'preview-template-4',
      name: 'HSBC-SG',
      bigAccountSummary: '3个'
    }
  ];
  openModal(createTemplateManagerDialog());
}

function buildPreviewMappingPayload() {
  return {
    template: {
      id: 'preview-template-4',
      name: 'HSBC-SG',
      headers: [
        '交易日期',
        '起息日期',
        '发生额',
        '余额',
        '对手户名',
        '对手账号',
        '币种',
        '附言'
      ]
    },
    targetFields: [
      'BillDate',
      'ValueDate',
      'Credit Amount',
      'Debit Amount',
      'Balance',
      'MerchantId',
      'Currency',
      'Payee Name',
      'Payee Cardno',
      'Drawee Name',
      'Drawee CardNo',
      SIGNED_AMOUNT_MAPPING_FIELD,
      AMOUNT_BASED_NAME_MAPPING_FIELD,
      AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
    ],
    mappings: [
      { templateField: 'BillDate', mappedField: '交易日期', customValue: '', isMultiBigAccount: false },
      { templateField: 'ValueDate', mappedField: '起息日期', customValue: '', isMultiBigAccount: false },
      { templateField: 'Credit Amount', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Debit Amount', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Balance', mappedField: BALANCE_CALCULATED_OPTION, customValue: '', isMultiBigAccount: false },
      { templateField: 'MerchantId', mappedField: MERCHANT_ID_SELF_INPUT_OPTION, customValue: '', isMultiBigAccount: true },
      { templateField: 'Currency', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Payee Name', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Payee Cardno', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Drawee Name', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: 'Drawee CardNo', mappedField: '', customValue: '', isMultiBigAccount: false },
      { templateField: SIGNED_AMOUNT_MAPPING_FIELD, mappedField: '发生额', customValue: '', isMultiBigAccount: false },
      { templateField: AMOUNT_BASED_NAME_MAPPING_FIELD, mappedField: '对手户名', customValue: '', isMultiBigAccount: false },
      { templateField: AMOUNT_BASED_ACCOUNT_MAPPING_FIELD, mappedField: '对手账号', customValue: '', isMultiBigAccount: false }
    ],
    bigAccounts: [
      {
        merchantId: '6222000000000001',
        currencies: ['USD'],
        isMultiBigAccount: false
      },
      {
        merchantId: '6222000000000001',
        currencies: ['HKD', 'CNY', 'EUR'],
        isMultiBigAccount: true
      }
    ],
    advancedMappingFields: ADVANCED_MAPPING_FIELDS.slice()
  };
}

function applyMappingDialogPreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY'];
  openModal(createMappingDialog(buildPreviewMappingPayload()));
}

function applyTemplateRenamePreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  openModal(createTemplateRenameDialog({
    id: 'preview-template-2',
    name: 'BankABC-HK'
  }));
}

function applyBigAccountManagerPreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY'];
  openModal(createBigAccountManagerDialog({
    bigAccounts: [
      {
        merchantId: '6222000000000001',
        currencies: ['USD'],
        isMultiCurrency: false
      },
      {
        merchantId: '6222000000000001',
        currencies: ['HKD', 'CNY', 'EUR', 'JPY'],
        isMultiCurrency: true
      },
      {
        merchantId: '9558800000000008',
        currencies: ['SGD', 'USD'],
        isMultiCurrency: true
      }
    ],
    onDone: () => {},
    onCancel: closeModal
  }));

  setTimeout(() => {
    const addButton = elements.modalRoot.querySelector('.big-account-card [data-action="add"]');
    addButton?.click();
    const rows = Array.from(elements.modalRoot.querySelectorAll('tr[data-big-account-row]'));
    const lastRow = rows[rows.length - 1];
    if (!lastRow) {
      return;
    }

    const merchantInput = lastRow.querySelector('.big-account-merchant-input');
    const currencySelect = lastRow.querySelector('.big-account-currency-select');
    if (merchantInput) {
      merchantInput.value = '8888999900001111';
    }

    if (currencySelect) {
      currencySelect.value = 'USD';
      currencySelect.dispatchEvent(new Event('change'));
    }
  }, 40);
}

function applyBigAccountManagerDropdownPreviewState() {
  applyBigAccountManagerPreviewState();

  setTimeout(() => {
    const rows = Array.from(elements.modalRoot.querySelectorAll('tr[data-big-account-row]'));
    const targetRow = rows[1];

    if (!targetRow) {
      return;
    }

    targetRow.querySelector('[data-action="toggle-complete"]')?.click();
    targetRow.querySelector('.big-account-currency-dropdown-btn')?.click();
  }, 160);
}

function applyBigAccountSelectionPreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  openModal(createBigAccountSelectionDialog([
    {
      label: '6222000000000001 / USD',
      merchantId: '6222000000000001',
      currency: 'USD'
    },
    {
      label: '6222000000000001 / HKD',
      merchantId: '6222000000000001',
      currency: 'HKD'
    },
    {
      label: '9558800000000008 / SGD',
      merchantId: '9558800000000008',
      currency: 'SGD'
    }
  ]));

  setTimeout(() => {
    const firstOption = elements.modalRoot.querySelector('.big-account-selection-list input[type="radio"]');
    if (firstOption) {
      firstOption.checked = true;
    }
  }, 40);
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
  state.currencyOptions = Array.isArray(info.currencyOptions) ? info.currencyOptions.slice() : [];
  state.backgroundSettings = cloneBackgroundSettings(info.backgroundConfig);
  state.backgroundDraft = cloneBackgroundSettings(info.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  elements.newAccountMultiCurrencyCheckbox.checked = false;
  state.selectedNewAccountCurrencies = [];
  renderNewAccountCurrencyOptions();
  setNewAccountOpenDateValue('');
  syncNewAccountCurrencyMode();
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
  elements.newAccountCurrencyDropdownBtn.addEventListener('click', () => {
    toggleNewAccountCurrencyDropdown();
  });
  elements.newAccountMultiCurrencyCheckbox.addEventListener('change', () => {
    syncNewAccountCurrencyMode();
    handleNewAccountFormMutation();
  });
  elements.statusBox.addEventListener('click', () => {
    if (state.manualBalancePromptReady && state.manualBalancePrompt) {
      openModal(createManualBalanceSeedDialog(state.manualBalancePrompt));
      return;
    }

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
    elements.newAccountBankAccountInput
  ].forEach((input) => {
    input.addEventListener('input', handleNewAccountFormMutation);
  });
  elements.newAccountOpenDateInput.addEventListener('focus', () => {
    if (elements.newAccountOpenDateInput.type !== 'date') {
      elements.newAccountOpenDateInput.type = 'date';
    }

    elements.newAccountOpenDateInput.showPicker?.();
  });
  elements.newAccountOpenDateInput.addEventListener('blur', () => {
    syncNewAccountOpenDateInputType();
  });
  elements.newAccountOpenDateInput.addEventListener('change', () => {
    syncNewAccountOpenDateInputType();
    handleNewAccountFormMutation();
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

    if (
      state.isNewAccountCurrencyDropdownOpen &&
      !elements.newAccountCurrencyDropdownWrap.contains(event.target)
    ) {
      closeNewAccountCurrencyDropdown();
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

      if (state.isNewAccountCurrencyDropdownOpen) {
        closeNewAccountCurrencyDropdown();
      }
    }
  });

  if (info.previewModal === 'account-mapping') {
    setTimeout(() => {
      handleOpenAccountMappings().catch((error) => {
        console.error(error);
      });
    }, 120);
  } else if (info.previewModal === 'template-manager') {
    setTimeout(() => {
      applyTemplateManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'mapping-dialog') {
    setTimeout(() => {
      applyMappingDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'template-rename') {
    setTimeout(() => {
      applyTemplateRenamePreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-manager') {
    setTimeout(() => {
      applyBigAccountManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-manager-dropdown') {
    setTimeout(() => {
      applyBigAccountManagerDropdownPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-selection') {
    setTimeout(() => {
      applyBigAccountSelectionPreviewState();
    }, 120);
  } else if (info.previewModal === 'new-account') {
    setTimeout(() => {
      applyNewAccountPreviewState();
    }, 120);
  } else if (info.previewModal === 'background-palette') {
    setTimeout(() => {
      openBackgroundPalette();
    }, 120);
  } else if (info.previewModal === 'new-account-palette') {
    setTimeout(() => {
      applyNewAccountPreviewState();
      openBackgroundPalette();
    }, 120);
  }
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
});
