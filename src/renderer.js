const state = {
  templates: [],
  selectedTemplateId: '',
  canExport: false,
  isMaximized: false,
  hasEnum: false,
  enumFileName: ''
};

const elements = {
  importFileBtn: document.getElementById('importFileBtn'),
  exportFileBtn: document.getElementById('exportFileBtn'),
  importTemplateBtn: document.getElementById('importTemplateBtn'),
  manageTemplateBtn: document.getElementById('manageTemplateBtn'),
  accountMappingBtn: document.getElementById('accountMappingBtn'),
  templateSelect: document.getElementById('templateSelect'),
  statusBox: document.getElementById('statusBox'),
  appVersion: document.getElementById('appVersion'),
  modalRoot: document.getElementById('modalRoot'),
  minimizeBtn: document.getElementById('minimizeBtn'),
  maximizeBtn: document.getElementById('maximizeBtn'),
  closeBtn: document.getElementById('closeBtn')
};

function setStatus(message, tone = 'info') {
  elements.statusBox.textContent = message;
  elements.statusBox.dataset.tone = tone;
}

function getEnumStatusMessage() {
  return state.hasEnum
    ? `已导入枚举表：${state.enumFileName}（点击可覆盖）`
    : '请导入网银账单枚举表';
}

function setExportEnabled(enabled) {
  state.canExport = enabled;
  elements.exportFileBtn.disabled = !enabled;
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
        <button class="text-action" type="button" data-action="manage">管理模版</button>
        <button class="text-action danger" type="button" data-action="delete">删除</button>
      </td>
    `;

    row.querySelector('[data-action="manage"]').addEventListener('click', async () => {
      const result = await window.desktopApi.templates.getMappings(template.id);

      if (result.status !== 'success') {
        setStatus(result.message, 'error');
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
  const savedMap = new Map(payload.mappings.map((item) => [item.templateField, item.mappedField]));

  payload.template.headers.forEach((header) => {
    const row = document.createElement('tr');
    const selectOptions = ['<option value=""></option>']
      .concat(
        payload.enumValues.map((value) => {
          const escaped = value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
          return `<option value="${escaped}">${escaped}</option>`;
        })
      )
      .join('');
    row.innerHTML = `
      <td>${header || '(空白字段)'}</td>
      <td>
        <select class="mapping-select">${selectOptions}</select>
      </td>
    `;

    const select = row.querySelector('select');
    select.value = savedMap.get(header) || '';
    select.dataset.templateField = header;
    tbody.appendChild(row);
  });

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = Array.from(dialog.querySelectorAll('.mapping-select')).map((select) => ({
      templateField: select.dataset.templateField,
      mappedField: select.value
    }));
    const result = await window.desktopApi.templates.saveMappings({
      templateId: payload.template.id,
      mappings
    });

    openModal(createAlertDialog(result.message));
    setStatus(result.message, result.status === 'success' ? 'success' : 'error');

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
      setStatus(result.message, 'success');
      elements.statusBox.title = info.accountMappingCount
        ? `当前账户映射条数：${info.accountMappingCount}，点击可导入或覆盖网银账单枚举表`
        : '点击可导入或覆盖网银账单枚举表';
    } else {
      setStatus(result.message, 'error');
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

  setStatus(result.message, result.status === 'success' ? 'success' : 'error');

  if (result.status === 'success') {
    await refreshTemplates();
  }
}

async function handleOpenAccountMappings() {
  const result = await window.desktopApi.accountMappings.list();

  if (result.status !== 'success') {
    setStatus(result.message, 'error');
    openModal(createAlertDialog(result.message));
    return;
  }

  openModal(createAccountMappingDialog(result));
}

async function handleImportFile() {
  if (!state.hasEnum) {
    await handleImportEnum();
    return;
  }

  const templateId = Number(state.selectedTemplateId);
  const result = await window.desktopApi.files.importFile(templateId);

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error');

  if (result.status === 'success') {
    setExportEnabled(true);
  }
}

async function handleImportEnum() {
  const result = await window.desktopApi.enums.importEnum();

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'success') {
    state.hasEnum = true;
    state.enumFileName = result.enumFileName;
    setExportEnabled(false);
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error');
}

async function handleExportFile() {
  const result = await window.desktopApi.files.exportFile();

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error');
}

async function initialize() {
  const info = await window.desktopApi.app.getInfo();
  elements.appVersion.textContent = info.version;
  state.hasEnum = info.hasEnum;
  state.enumFileName = info.enumFileName || '';
  await refreshTemplates();
  setExportEnabled(false);
  setStatus(getEnumStatusMessage());
  elements.statusBox.title = '点击可导入或覆盖网银账单枚举表';

  elements.importTemplateBtn.addEventListener('click', handleImportTemplate);
  elements.manageTemplateBtn.addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });
  elements.accountMappingBtn.addEventListener('click', handleOpenAccountMappings);
  elements.importFileBtn.addEventListener('click', handleImportFile);
  elements.exportFileBtn.addEventListener('click', handleExportFile);
  elements.statusBox.addEventListener('click', handleImportEnum);
  elements.templateSelect.addEventListener('change', (event) => {
    state.selectedTemplateId = event.target.value;
  });

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

  if (info.previewModal === 'account-mapping') {
    setTimeout(() => {
      handleOpenAccountMappings().catch((error) => {
        console.error(error);
      });
    }, 120);
  }
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
});
