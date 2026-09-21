(function installNewAccountController(root) {
  'use strict';
  function createNewAccountController({ api = {}, panel, config, ui = {} } = {}) {
    if (!panel || !config?.getCurrencyOptions || !ui.modalHost) throw new TypeError('新账号控制器缺少领域依赖');
    const document = panel.ownerDocument;
    const owner = 'new-account-generator';
    const elements = Object.fromEntries(['newAccountGenerateBtn','newAccountExportBtn','newAccountStatusBox','newAccountRows',
      'newAccountOpenDateInput'].map(id => [id, panel.querySelector(`#${id}`)]));
    const state = { canExportNewAccount: false, newAccountHasErrorReport: false, isNewAccountCurrencyDropdownOpen: false };
    const newAccountRowStateMap = new WeakMap();
    const rowAborts = new Set();
    const timerIds = new Set();
    const staticAbort = new root.AbortController();
    let initialized = false;
    let active = false;
    let disposed = false;
    let generation = 0;
    let formRevision = 0;
    let busy = false;
    let needsRefresh = true;
    let feedback = { message: '请完整填写开户信息后点击生成', tone: 'info', options: {} };
    const live = (version = generation) => active && !disposed && version === generation;
    const reportError = error => ui.reportError?.(error);
    const rowStateFor = row => getNewAccountRowState(row);
    function listen(node, event, listener) {
      if (!node) return;
      const row = node.closest?.('[data-new-account-row]');
      let abort = staticAbort;
      if (row) {
        const rowState = rowStateFor(row);
        if (!rowState.abort) { rowState.abort = new root.AbortController(); rowAborts.add(rowState.abort); }
        abort = rowState.abort;
      }
      node.addEventListener(event, (value) => { if (live()) return listener(value); }, { signal: abort.signal });
    }
    function defer(callback) {
      const id = root.setTimeout(() => { timerIds.delete(id); callback(); }, 0);
      timerIds.add(id);
    }
    function setNewAccountStatus(message, tone = 'info', options = {}, version = generation) {
      if (disposed) return;
      state.newAccountHasErrorReport = Boolean(options.errorReportReady);
      feedback = { message, tone, options: { ...options, errorReportReady: state.newAccountHasErrorReport,
        idleTitle: options.idleTitle ?? '请完整填写开户信息后点击生成' } };
      if (live(version)) renderStatus(); else needsRefresh = true;
    }
    function renderStatus() {
      if (!live()) return;
      if (ui.status) ui.status(elements.newAccountStatusBox, feedback.message, feedback.tone, feedback.options);
      else { elements.newAccountStatusBox.textContent = feedback.message; elements.newAccountStatusBox.dataset.tone = feedback.tone; }
    }
    function setNewAccountExportAvailability(enabled = state.canExportNewAccount, version = generation) {
      state.canExportNewAccount = !!enabled;
      if (live(version)) elements.newAccountExportBtn.disabled = busy || !enabled;
    }
function getNewAccountStatusTitle() {
  return state.canExportNewAccount
    ? '新开账户余额账单已生成，可点击导出'
    : '请完整填写开户信息后点击生成';
}

function getNewAccountRows() {
  return Array.from(elements.newAccountRows?.querySelectorAll('[data-new-account-row]') || []);
}

function getNewAccountRowElements(row) {
  return {
    row,
    bankNameInput: row.querySelector('.new-account-bank-name-input'),
    locationInput: row.querySelector('.new-account-location-input'),
    currencyRow: row.querySelector('.new-account-currency-row'),
    currencyInput: row.querySelector('.new-account-currency-input'),
    currencyDropdownWrap: row.querySelector('.new-account-currency-dropdown-wrap'),
    currencyDropdownBtn: row.querySelector('.new-account-currency-dropdown-btn'),
    currencyDropdownPanel: row.querySelector('.new-account-currency-dropdown-panel'),
    multiCurrencyCheckbox: row.querySelector('.new-account-multi-currency-checkbox'),
    bankAccountInput: row.querySelector('.new-account-bank-account-input'),
    openDateInput: row.querySelector('.new-account-open-date-input'),
    rowActionBtn: row.querySelector('.new-account-row-action-btn')
  };
}

function getNewAccountRowState(row) {
  if (!newAccountRowStateMap.has(row)) {
    newAccountRowStateMap.set(row, {
      selectedCurrencies: [],
      currencySearchQuery: '',
      isDropdownOpen: false,
      initialized: false
    });
  }

  return newAccountRowStateMap.get(row);
}

function ensureCurrencyGhostShell(input) {
  let shell = input.parentElement?.classList.contains('enum-input-shell') ? input.parentElement : null;
  let ghostInput = shell?.querySelector('.enum-ghost-input');

  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'enum-input-shell';
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
  }

  if (!ghostInput) {
    ghostInput = document.createElement('input');
    ghostInput.className = `${input.className} enum-ghost-input`;
    ghostInput.type = 'text';
    ghostInput.tabIndex = -1;
    ghostInput.disabled = true;
    shell.insertBefore(ghostInput, input);
  }

  input.classList.add('enum-active-input');
  return { shell, ghostInput };
}

function normalizeCurrencyOptionEntry(option) {
  if (typeof option === 'string') {
    const code = option.trim();
    return code
      ? {
          code,
          name: '',
          label: code
        }
      : null;
  }

  if (!option || typeof option !== 'object') {
    return null;
  }

  const code = String(option.code || option.englishCode || '').trim();

  if (!code) {
    return null;
  }

  const name = String(option.name || option.displayName || option.chineseName || '').trim();
  return {
    code,
    name,
    label: String(option.label || '').trim() || (name ? `${code} ${name}` : code)
  };
}

function getCurrencyOptionEntries() {
  const optionMap = new Map();

  config.getCurrencyOptions().forEach((option) => {
    const normalized = normalizeCurrencyOptionEntry(option);

    if (!normalized || optionMap.has(normalized.code)) {
      return;
    }

    optionMap.set(normalized.code, normalized);
  });

  return Array.from(optionMap.values());
}

function getCurrencyOptionCodes() {
  return getCurrencyOptionEntries().map((option) => option.code);
}

function getCurrencyOptionLabel(code) {
  const normalizedCode = String(code || '').trim();
  const matchedOption = getCurrencyOptionEntries().find((option) => option.code === normalizedCode);
  return matchedOption?.label || normalizedCode;
}

function getCurrencySuggestion(value, allowedCodes = null) {
  const query = String(value || '').trim().toUpperCase();

  if (!query) {
    return '';
  }

  const allowedCodeSet = allowedCodes ? new Set(allowedCodes.map((code) => String(code || '').trim()).filter(Boolean)) : null;
  const matchedOption = getCurrencyOptionEntries().find((option) => {
    if (allowedCodeSet && !allowedCodeSet.has(option.code)) {
      return false;
    }

    return option.code.toUpperCase().startsWith(query);
  });

  return matchedOption?.code || '';
}

function formatSelectedCurrencySummary(currencies) {
  if (!currencies.length) {
    return '\u00A0';
  }

  if (currencies.length <= 2) {
    return currencies.map((code) => getCurrencyOptionLabel(code)).join('、');
  }

  return `已选${currencies.length}项`;
}

function syncNewAccountDropdownFlag() {
  state.isNewAccountCurrencyDropdownOpen = getNewAccountRows().some((row) => getNewAccountRowState(row).isDropdownOpen);
}

function closeAllNewAccountCurrencyDropdowns(exceptRow = null) {
  getNewAccountRows().forEach((row) => {
    if (exceptRow && row === exceptRow) {
      return;
    }

    closeNewAccountCurrencyDropdown(getNewAccountRowElements(row));
  });
}

function isNewAccountMultiCurrencyMode(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.multiCurrencyCheckbox ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  return Boolean(refs?.multiCurrencyCheckbox?.checked);
}

function syncNewAccountRowActionButtons() {
  getNewAccountRows().forEach((row, index) => {
    const refs = getNewAccountRowElements(row);

    if (refs.rowActionBtn) {
      const isFirstRow = index === 0;
      refs.rowActionBtn.hidden = false;
      refs.rowActionBtn.dataset.rowAction = isFirstRow ? 'add' : 'delete';
      refs.rowActionBtn.textContent = isFirstRow ? '新增' : '删除';
      refs.rowActionBtn.title = isFirstRow ? '新增账号行' : '删除当前账号行';
      refs.rowActionBtn.setAttribute('aria-label', isFirstRow ? '新增账号行' : '删除当前账号行');
    }
  });
}

function closeNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownPanel || !refs.currencyDropdownBtn) {
    return;
  }

  const rowState = getNewAccountRowState(refs.row);
  rowState.isDropdownOpen = false;
  rowState.currencySearchQuery = '';
  refs.currencyDropdownPanel.hidden = true;
  refs.currencyDropdownBtn.classList.remove('is-open');
  refs.currencyDropdownBtn.setAttribute('aria-expanded', 'false');
  if (isNewAccountMultiCurrencyMode(refs)) {
    renderNewAccountCurrencyOptions(refs);
  }
  syncNewAccountDropdownFlag();
}

function updateNewAccountCurrencyDropdownLabel(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownBtn ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownBtn) {
    return;
  }

  const rowState = getNewAccountRowState(refs.row);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const label = isMultiCurrency
    ? formatSelectedCurrencySummary(rowState.selectedCurrencies)
    : (refs.currencyInput.value ? getCurrencyOptionLabel(refs.currencyInput.value) : '\u00A0');

  refs.currencyDropdownBtn.textContent = label;
  refs.currencyDropdownBtn.title = isMultiCurrency
    ? rowState.selectedCurrencies.map((currency) => getCurrencyOptionLabel(currency)).join('、')
    : (refs.currencyInput.value ? getCurrencyOptionLabel(refs.currencyInput.value) : '显示全部币种');
  refs.currencyDropdownBtn.disabled = getCurrencyOptionEntries().length === 0;
}

function updateNewAccountCurrencySuggestion(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyInput ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyInput || refs.currencyInput.type === 'hidden') {
    return '';
  }

  const { ghostInput } = ensureCurrencyGhostShell(refs.currencyInput);
  const suggestion = isNewAccountMultiCurrencyMode(refs)
    ? ''
    : getCurrencySuggestion(refs.currencyInput.value);
  ghostInput.value = suggestion;
  return suggestion;
}

function matchesCurrencyOptionQuery(option, query) {
  const normalizedQuery = String(query || '').trim().toUpperCase();

  if (!normalizedQuery) {
    return true;
  }

  return [option.code, option.label, option.name]
    .map((value) => String(value || '').trim().toUpperCase())
    .some((value) => value.includes(normalizedQuery));
}

function renderNewAccountCurrencyOptionsList(refs, currencyOptions, host) {
  const rowState = getNewAccountRowState(refs.row);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const optionsHost = host || refs.currencyDropdownPanel;

  if (!optionsHost) {
    return;
  }

  optionsHost.replaceChildren();

  const visibleOptions = isMultiCurrency
    ? currencyOptions.filter((option) => matchesCurrencyOptionQuery(option, rowState.currencySearchQuery))
    : currencyOptions;

  if (!visibleOptions.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'new-account-currency-option';
    emptyState.innerHTML = `<span class="new-account-currency-option-text">${
      isMultiCurrency && String(rowState.currencySearchQuery || '').trim()
        ? '未匹配到币种选项'
        : '未读取到币种选项'
    }</span>`;
    optionsHost.appendChild(emptyState);
    updateNewAccountCurrencyDropdownLabel(refs);
    updateNewAccountCurrencySuggestion(refs);
    return;
  }

  visibleOptions.forEach(({ code, label }) => {
    const option = document.createElement('label');
    option.className = 'new-account-currency-option';

    const text = document.createElement('span');
    text.className = 'new-account-currency-option-text';
    text.textContent = label;

    if (isMultiCurrency) {
      const checkbox = document.createElement('input');
      checkbox.className = 'new-account-checkbox';
      checkbox.type = 'checkbox';
      checkbox.dataset.currencyCode = code;
      checkbox.checked = rowState.selectedCurrencies.includes(code);

      const indexSpan = document.createElement('span');
      indexSpan.className = 'concat-picker-index';
      const selectedIdx = rowState.selectedCurrencies.indexOf(code);
      indexSpan.textContent = selectedIdx >= 0 ? `${selectedIdx + 1}.` : '';

      listen(checkbox, 'change', () => {
        if (checkbox.checked) {
          rowState.selectedCurrencies = Array.from(new Set([...rowState.selectedCurrencies, code]));
        } else {
          rowState.selectedCurrencies = rowState.selectedCurrencies.filter((value) => value !== code);
        }

        refs.currencyDropdownPanel.querySelectorAll('.concat-picker-index').forEach((span) => {
          const optionCode = span.parentElement?.querySelector('.new-account-checkbox')?.dataset?.currencyCode || '';
          const idx = rowState.selectedCurrencies.indexOf(optionCode);
          span.textContent = idx >= 0 ? `${idx + 1}.` : '';
        });
        updateNewAccountCurrencyDropdownLabel(refs);
        handleNewAccountFormMutation();
      });

      option.append(checkbox, indexSpan, text);
    } else {
      option.classList.toggle('is-selected', refs.currencyInput.value === code);
      listen(option, 'click', () => {
        refs.currencyInput.value = code;
        updateNewAccountCurrencyDropdownLabel(refs);
        closeNewAccountCurrencyDropdown(refs);
        handleNewAccountFormMutation();
      });
      option.append(text);
    }

    optionsHost.appendChild(option);
  });

  updateNewAccountCurrencyDropdownLabel(refs);
  updateNewAccountCurrencySuggestion(refs);
}

function openNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownPanel || getCurrencyOptionEntries().length === 0) {
    return;
  }

  renderNewAccountCurrencyOptions(refs);
  closeAllNewAccountCurrencyDropdowns(refs.row);
  getNewAccountRowState(refs.row).isDropdownOpen = true;
  refs.currencyDropdownPanel.hidden = false;
  refs.currencyDropdownBtn.classList.add('is-open');
  refs.currencyDropdownBtn.setAttribute('aria-expanded', 'true');
  if (isNewAccountMultiCurrencyMode(refs)) {
    const version = generation;
    defer(() => {
      if (live(version) && rowStateFor(refs.row).isDropdownOpen) refs.currencyDropdownPanel.querySelector('.new-account-currency-search-input')?.focus({ preventScroll: true });
    });
  }
  syncNewAccountDropdownFlag();
}

function toggleNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  const rowState = refs?.row ? getNewAccountRowState(refs.row) : null;

  if (!refs || !rowState) {
    return;
  }

  if (rowState.isDropdownOpen) {
    closeNewAccountCurrencyDropdown(refs);
    return;
  }

  openNewAccountCurrencyDropdown(refs);
}

function handleNewAccountFormMutation() {
  ++formRevision;
  updateNewAccountGenerateAvailability();
  setNewAccountExportAvailability(false);
  setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });
}

function renderNewAccountCurrencyOptions(rowOrRefs = null) {
  if (!rowOrRefs) {
    getNewAccountRows().forEach((row) => {
      renderNewAccountCurrencyOptions(getNewAccountRowElements(row));
    });
    return;
  }

  const refs = rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs);
  const rowState = getNewAccountRowState(refs.row);
  const currencyOptions = getCurrencyOptionEntries();
  const currencyCodes = currencyOptions.map((option) => option.code);
  refs.currencyDropdownPanel.replaceChildren();
  rowState.selectedCurrencies = rowState.selectedCurrencies.filter((currency) => currencyCodes.includes(currency));
  if (refs.currencyInput.value && !currencyCodes.includes(refs.currencyInput.value)) {
    refs.currencyInput.value = '';
  }
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);

  if (!currencyOptions.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'new-account-currency-option';
    emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
    refs.currencyDropdownPanel.appendChild(emptyState);
    updateNewAccountCurrencyDropdownLabel(refs);
    updateNewAccountCurrencySuggestion(refs);
    return;
  }

  if (isMultiCurrency) {
    const searchRow = document.createElement('div');
    searchRow.className = 'new-account-currency-search-row';

    const searchInput = document.createElement('input');
    searchInput.className = 'new-account-input new-account-currency-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = '搜索币种';
    searchInput.spellcheck = false;
    searchInput.value = rowState.currencySearchQuery;
    listen(searchInput, 'input', () => {
      rowState.currencySearchQuery = searchInput.value;
      renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
    });
    listen(searchInput, 'pointerdown', (event) => {
      event.stopPropagation();
    });

    const optionsHost = document.createElement('div');
    optionsHost.className = 'new-account-currency-options-list';

    searchRow.appendChild(searchInput);
    refs.currencyDropdownPanel.append(searchRow, optionsHost);
    renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
    return;
  }

  const optionsHost = document.createElement('div');
  optionsHost.className = 'new-account-currency-options-list';
  refs.currencyDropdownPanel.appendChild(optionsHost);
  renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
}

function syncNewAccountCurrencyMode(rowOrRefs = null) {
  if (!rowOrRefs) {
    getNewAccountRows().forEach((row) => {
      syncNewAccountCurrencyMode(getNewAccountRowElements(row));
    });
    return;
  }

  const refs = rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const rowState = getNewAccountRowState(refs.row);
  refs.currencyInput.hidden = true;
  refs.currencyDropdownWrap.hidden = false;
  refs.currencyRow?.classList.toggle('is-multi', isMultiCurrency);
  refs.currencyRow?.classList.toggle('is-single', !isMultiCurrency);

  if (!isMultiCurrency) {
    if (rowState.selectedCurrencies.length > 0) {
      refs.currencyInput.value = rowState.selectedCurrencies[0];
    }
    rowState.selectedCurrencies = [];
    rowState.currencySearchQuery = '';
    closeNewAccountCurrencyDropdown(refs);
  } else if (refs.currencyInput.value) {
    rowState.selectedCurrencies = [refs.currencyInput.value];
    refs.currencyInput.value = '';
    rowState.currencySearchQuery = '';
  }

  renderNewAccountCurrencyOptions(refs);
}

function syncNewAccountOpenDateInputType(rowOrInput = elements.newAccountOpenDateInput) {
  const input = rowOrInput?.openDateInput || rowOrInput;
  input.type = input.value ? 'date' : 'text';
}

function setNewAccountOpenDateValue(value, rowOrRefs = null) {
  const refs = rowOrRefs ? (rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs)) : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.openDateInput) {
    return;
  }

  refs.openDateInput.type = value ? 'date' : 'text';
  refs.openDateInput.value = value;
}

function initializeNewAccountRow(row, defaults = {}) {
  const refs = getNewAccountRowElements(row);
  const rowState = getNewAccountRowState(row);

  if (!rowState.initialized) {
    listen(refs.currencyDropdownBtn, 'click', () => {
      toggleNewAccountCurrencyDropdown(refs);
    });
    listen(refs.multiCurrencyCheckbox, 'change', () => {
      syncNewAccountCurrencyMode(refs);
      handleNewAccountFormMutation();
    });
    [
      refs.bankNameInput,
      refs.locationInput,
      refs.bankAccountInput,
      refs.currencyInput
    ].forEach((input) => {
      listen(input, 'input', handleNewAccountFormMutation);
    });
    listen(refs.openDateInput, 'focus', () => {
      if (refs.openDateInput.type !== 'date') {
        refs.openDateInput.type = 'date';
      }

      refs.openDateInput.showPicker?.();
    });
    listen(refs.openDateInput, 'blur', () => {
      syncNewAccountOpenDateInputType(refs);
    });
    listen(refs.openDateInput, 'change', () => {
      syncNewAccountOpenDateInputType(refs);
      handleNewAccountFormMutation();
    });
    listen(refs.rowActionBtn, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (refs.rowActionBtn.dataset.rowAction === 'delete') {
        removeNewAccountRow(refs.row);
        return;
      }

      addNewAccountRow();
    });
    rowState.initialized = true;
  }

  refs.bankNameInput.value = defaults.bankName ?? refs.bankNameInput.value ?? '';
  refs.locationInput.value = defaults.location ?? refs.locationInput.value ?? '';
  refs.currencyInput.value = defaults.currency ?? refs.currencyInput.value ?? '';
  refs.bankAccountInput.value = defaults.bankAccount ?? refs.bankAccountInput.value ?? '';
  setNewAccountOpenDateValue(defaults.openingDate ?? refs.openDateInput.value ?? '', refs);
  refs.multiCurrencyCheckbox.checked = Boolean(defaults.isMultiCurrency);
  rowState.selectedCurrencies = Array.isArray(defaults.currencies) ? defaults.currencies.slice() : rowState.selectedCurrencies;
  rowState.currencySearchQuery = '';
  syncNewAccountCurrencyMode(refs);
  syncNewAccountRowActionButtons();
}

function addNewAccountRow(defaults = {}) {
  const sourceRow = getNewAccountRows()[0];

  if (!sourceRow) {
    return;
  }

  const clone = sourceRow.cloneNode(true);
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.querySelectorAll('input').forEach((input) => {
    if (input.type === 'checkbox') {
      input.checked = false;
    } else {
      input.value = '';
    }
  });
  elements.newAccountRows.appendChild(clone);
  initializeNewAccountRow(clone, defaults);
  syncNewAccountRowActionButtons();
  handleNewAccountFormMutation();
}

function removeNewAccountRow(row) {
  const rows = getNewAccountRows();

  if (!row || rows.length <= 1) {
    return;
  }

  const refs = getNewAccountRowElements(row);
  closeNewAccountCurrencyDropdown(refs);
  rowStateFor(row).abort?.abort();
  rowAborts.delete(rowStateFor(row).abort);
  row.remove();
  syncNewAccountRowActionButtons();
  syncNewAccountDropdownFlag();
  handleNewAccountFormMutation();
}

function resetNewAccountRows() {
  const rows = getNewAccountRows();
  rows.slice(1).forEach((row) => { rowStateFor(row).abort?.abort(); row.remove(); });
  const firstRow = rows[0];

  if (!firstRow) {
    return;
  }

  initializeNewAccountRow(firstRow, {
    bankName: '',
    location: '',
    currency: '',
    bankAccount: '',
    openingDate: '',
    isMultiCurrency: false,
    currencies: []
  });
  syncNewAccountRowActionButtons();
}

function isNewAccountFormComplete() {
  return getNewAccountRows().length > 0 && getNewAccountRows().every((row) => {
    const refs = getNewAccountRowElements(row);
    const rowState = getNewAccountRowState(row);
    const currencyReady = isNewAccountMultiCurrencyMode(refs)
      ? rowState.selectedCurrencies.length > 0
      : String(refs.currencyInput.value || '').trim() !== '';

    return [
      refs.bankNameInput.value,
      refs.locationInput.value,
      refs.bankAccountInput.value,
      refs.openDateInput.value
    ].every((value) => String(value || '').trim() !== '') && currencyReady;
  });
}

function updateNewAccountGenerateAvailability() {
  const isComplete = isNewAccountFormComplete();
  if (live()) elements.newAccountGenerateBtn.disabled = busy || !isComplete;
}


function getNewAccountPayload() {
  return {
    accounts: getNewAccountRows().map((row) => {
      const refs = getNewAccountRowElements(row);
      const rowState = getNewAccountRowState(row);
      const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);

      return {
        bankName: refs.bankNameInput.value,
        location: refs.locationInput.value,
        currency: isMultiCurrency ? '' : refs.currencyInput.value,
        currencies: isMultiCurrency ? rowState.selectedCurrencies.slice() : [],
        isMultiCurrency,
        bankAccount: refs.bankAccountInput.value,
        openingDate: refs.openDateInput.value
      };
    })
  };
}

    async function action(kind, operation) {
      if (!live() || busy) return { status: 'blocked' };
      const version = generation;
      const revision = formRevision;
      busy = true;
      updateNewAccountGenerateAvailability();
      setNewAccountExportAvailability();
      try { await operation(version, revision); }
      catch (error) {
        setNewAccountStatus(`${kind}失败：${error.message || error}`, 'error', {}, version);
        reportError(error);
      } finally {
        busy = false;
        if (live(version)) {
          updateNewAccountGenerateAvailability();
          setNewAccountExportAvailability();
        } else {
          needsRefresh = true;
          if (live()) await enter();
        }
      }
      return { status: live(version) ? 'completed' : 'stale' };
    }
    function generate() {
      if (!isNewAccountFormComplete()) return Promise.resolve({ status: 'blocked' });
      const payload = getNewAccountPayload();
      return action('生成新账号账单', async (version, revision) => {
        const result = await api.generate(payload);
        if (result.status === 'cancelled') return;
        // 后台生成仍完成，但用户已修改的表单不能获得旧输入的导出可用性。
        if (revision !== formRevision) { needsRefresh = true; return; }
        setNewAccountExportAvailability(result.status === 'success' && Boolean(result.exportReady), version);
        setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady), idleTitle: getNewAccountStatusTitle()
        }, version);
      });
    }
    function exportFile() {
      if (!state.canExportNewAccount) return Promise.resolve({ status: 'blocked' });
      return action('导出新账号账单', async version => {
        const result = await api.exportFile();
        if (result.status === 'cancelled') return;
        setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady), idleTitle: getNewAccountStatusTitle()
        }, version);
      });
    }
    function exportLastError() {
      if (!state.newAccountHasErrorReport) return Promise.resolve({ status: 'blocked' });
      return action('报错文件导出', async version => {
        const result = await api.exportLastError();
        if (result.status === 'cancelled' || result.status === 'empty') return;
        setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: result.status === 'success' ? true : Boolean(result.errorReportReady)
        }, version);
      });
    }
    function refreshConfiguration() {
      needsRefresh = true;
      if (!live() || !initialized) return;
      const before = JSON.stringify(getNewAccountPayload());
      renderNewAccountCurrencyOptions();
      if (JSON.stringify(getNewAccountPayload()) !== before) handleNewAccountFormMutation();
      updateNewAccountGenerateAvailability();
      needsRefresh = false;
    }
    const unsubscribe = config.subscribe?.(refreshConfiguration);
    function enter() {
      if (disposed) return Promise.resolve({ status: 'stale' });
      active = true;
      ++generation;
      if (!initialized) {
        resetNewAccountRows();
        listen(elements.newAccountGenerateBtn, 'click', () => generate().catch(reportError));
        listen(elements.newAccountExportBtn, 'click', () => exportFile().catch(reportError));
        listen(elements.newAccountStatusBox, 'click', () => exportLastError().catch(reportError));
        initialized = true;
      }
      refreshConfiguration();
      updateNewAccountGenerateAvailability();
      setNewAccountExportAvailability();
      renderStatus();
      return Promise.resolve({ status: 'ready' });
    }
    function leave({ reason = 'navigation' } = {}) {
      if (ui.modalHost.closeOwner(owner, reason).status === 'blocked') return { status: 'blocked' };
      closeAllNewAccountCurrencyDropdowns();
      active = false;
      ++generation;
      for (const id of timerIds) root.clearTimeout(id);
      timerIds.clear();
      return { status: 'left' };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      ++generation;
      staticAbort.abort();
      for (const abort of rowAborts) abort.abort();
      rowAborts.clear();
      for (const id of timerIds) root.clearTimeout(id);
      timerIds.clear();
      if (typeof unsubscribe === 'function') unsubscribe();
    }
    function handleOutsidePointerDown(event) {
      if (!live() || !state.isNewAccountCurrencyDropdownOpen) return;
      const inside = getNewAccountRows().some(row => {
        const refs = getNewAccountRowElements(row);
        return refs.currencyDropdownWrap?.contains(event.target) || refs.currencyInput?.contains(event.target)
          || refs.currencyInput?.parentElement?.contains(event.target);
      });
      if (!inside) closeAllNewAccountCurrencyDropdowns();
    }
    function handleKeyDown(event) {
      if (live() && event.key === 'Escape') closeAllNewAccountCurrencyDropdowns();
    }
    const preview = Object.freeze({
      applyRows(rows = []) {
        if (!live() || !rows.length) return;
        resetNewAccountRows();
        initializeNewAccountRow(getNewAccountRows()[0], rows[0]);
        rows.slice(1).forEach(row => addNewAccountRow(row));
        handleNewAccountFormMutation();
      },
      syncCurrencyMode: syncNewAccountCurrencyMode,
      updateGenerateAvailability: updateNewAccountGenerateAvailability,
      setExportAvailability: setNewAccountExportAvailability,
      setStatus: setNewAccountStatus,
      getStatusTitle: getNewAccountStatusTitle,
      setOpenDateValue: setNewAccountOpenDateValue,
      closeCurrencyDropdowns: closeAllNewAccountCurrencyDropdowns
    });
    return Object.freeze({ enter, leave, dispose, invalidate: refreshConfiguration, generate, export: exportFile,
      exportLastError, handleOutsidePointerDown, handleKeyDown, preview,
      getSnapshot: () => Object.freeze({ canExport: state.canExportNewAccount, busy, needsRefresh }),
      getPayload: () => getNewAccountPayload() });
  }
  root.__newAccountController = Object.freeze({ createNewAccountController });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.__newAccountController;
})(typeof window !== 'undefined' ? window : globalThis);
