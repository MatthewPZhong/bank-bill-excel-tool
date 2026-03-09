const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { AppDatabase } = require('./backend/database');
const {
  FileValidationError,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadEnumValues,
  transformFileToWorkbook
} = require('./backend/file-service');
const { appendLog } = require('./backend/logger');

if (process.env.APP_USER_DATA_DIR) {
  app.setPath('userData', process.env.APP_USER_DATA_DIR);
}

if (process.env.APP_DOCUMENTS_DIR) {
  app.setPath('documents', process.env.APP_DOCUMENTS_DIR);
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.openai.bankbillexceltool');
}

let mainWindow = null;
let database = null;
let lastGeneratedFile = null;

function pad(value) {
  return String(value).padStart(2, '0');
}

function getStorageRoot() {
  return path.join(app.getPath('documents'), '网银账单生成小助手');
}

function ensureStorageRoot() {
  const storageRoot = getStorageRoot();
  fs.mkdirSync(storageRoot, { recursive: true });
  return storageRoot;
}

function getImportedEnumConfig() {
  const enumConfig = database.getEnumConfig();

  if (!enumConfig || !enumConfig.filePath || !fs.existsSync(enumConfig.filePath)) {
    return null;
  }

  return enumConfig;
}

function getToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function buildOutputFilePath(templateName) {
  const date = getToday();
  const outputFolder = path.join(ensureStorageRoot(), 'exports', date);
  return {
    date,
    outputFolder,
    outputFilePath: path.join(outputFolder, `${templateName}-COMMON-${date}.xlsx`)
  };
}

function fileDialogFilters() {
  return [
    {
      name: 'Excel / CSV',
      extensions: ['xlsx', 'xls', 'csv']
    }
  ];
}

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:maximized-state', mainWindow.isMaximized());
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    frame: false,
    backgroundColor: '#f3efe6',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(app.getAppPath(), 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    sendWindowState();

    if (process.env.APP_CAPTURE_PATH) {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(process.env.APP_CAPTURE_PATH), { recursive: true });
          fs.writeFileSync(process.env.APP_CAPTURE_PATH, image.toPNG());
        } catch (error) {
          console.error(error);
        } finally {
          app.quit();
        }
      }, Number(process.env.APP_CAPTURE_DELAY_MS || 1800));
    }
  });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
}

function buildTemplateSummary(template) {
  return {
    id: template.id,
    name: template.name,
    sourceFileName: template.sourceFileName,
    headers: template.headers,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

function registerWindowHandlers() {
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    return { isMaximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });
}

function registerAppHandlers() {
  ipcMain.handle('app:get-info', () => {
    const enumConfig = getImportedEnumConfig();
    return {
      version: app.getVersion(),
      storageRoot: ensureStorageRoot(),
      hasEnum: Boolean(enumConfig),
      enumFileName: enumConfig ? enumConfig.sourceFileName : ''
    };
  });
}

function registerEnumHandlers() {
  ipcMain.handle('enum:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Excel',
          extensions: ['xlsx']
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      extractEnumValuesFromImportedFile(selectedPath);
      const enumDir = path.join(ensureStorageRoot(), 'enum');
      const targetPath = path.join(enumDir, '网银账单枚举表.xlsx');

      fs.mkdirSync(enumDir, { recursive: true });
      if (path.resolve(selectedPath) !== path.resolve(targetPath)) {
        fs.copyFileSync(selectedPath, targetPath);
      }

      database.setEnumConfig({
        filePath: targetPath,
        sourceFileName: path.basename(selectedPath)
      });

      return {
        status: 'success',
        message: `网银账单枚举表导入成功：${path.basename(selectedPath)}`,
        enumFileName: path.basename(selectedPath)
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return {
          status: 'error',
          message: error.message
        };
      }

      throw error;
    }
  });
}

function registerTemplateHandlers() {
  ipcMain.handle('template:list', () => {
    return database.listTemplates();
  });

  ipcMain.handle('template:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: fileDialogFilters()
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      const headers = extractHeaders(selectedPath);
      const templateName = path.parse(selectedPath).name;
      const template = database.upsertTemplate({
        name: templateName,
        sourceFileName: path.basename(selectedPath),
        headers
      });

      return {
        status: 'success',
        message: '模版导入成功，请在管理模版中维护映射关系',
        template: buildTemplateSummary(template)
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return { status: 'error', message: error.message };
      }

      throw error;
    }
  });

  ipcMain.handle('template:delete', (_event, templateId) => {
    database.deleteTemplate(templateId);
    return { status: 'success' };
  });

  ipcMain.handle('template:get-mappings', (_event, templateId) => {
    const mappingSet = database.getTemplateMappings(templateId);

    if (!mappingSet) {
      return {
        status: 'error',
        message: '未找到对应模版'
      };
    }

    const enumConfig = getImportedEnumConfig();

    if (!enumConfig) {
      return {
        status: 'error',
        message: '请先导入网银账单枚举表'
      };
    }

    try {
      return {
        status: 'success',
        template: buildTemplateSummary(mappingSet.template),
        mappings: mappingSet.mappings,
        enumValues: loadEnumValues(enumConfig.filePath)
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return {
          status: 'error',
          message: '网银账单枚举表为空或不可读，请重新导入'
        };
      }

      throw error;
    }
  });

  ipcMain.handle('template:save-mappings', (_event, payload) => {
    const { templateId, mappings } = payload;
    const selectedValues = mappings
      .map((mapping) => mapping.mappedField.trim())
      .filter((value) => value !== '');
    const uniqueValues = new Set(selectedValues);

    if (selectedValues.length !== uniqueValues.size) {
      return {
        status: 'error',
        message: '校验不通过，请重新确认映射关系'
      };
    }

    database.saveMappings(templateId, mappings);
    return {
      status: 'success',
      message: '模版成功生成！'
    };
  });
}

function registerFileHandlers() {
  ipcMain.handle('file:import', async (_event, templateId) => {
    if (!getImportedEnumConfig()) {
      return {
        status: 'error',
        message: '请先导入网银账单枚举表'
      };
    }

    if (!templateId) {
      return {
        status: 'error',
        message: '请选择模版'
      };
    }

    const templatePayload = database.getTemplateMappings(templateId);

    if (!templatePayload) {
      return {
        status: 'error',
        message: '未找到对应模版'
      };
    }

    const usableMappings = templatePayload.mappings.filter(
      (mapping) => mapping.mappedField.trim() !== ''
    );

    if (usableMappings.length === 0) {
      return {
        status: 'error',
        message: '当前模版尚未设置映射关系'
      };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: fileDialogFilters()
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const inputFilePath = result.filePaths[0];
    const mappingByField = usableMappings.reduce((accumulator, item) => {
      accumulator[item.templateField] = item.mappedField;
      return accumulator;
    }, {});

    try {
      const { outputFilePath, date } = buildOutputFilePath(templatePayload.template.name);
      transformFileToWorkbook({
        inputFilePath,
        mappingByField,
        outputFilePath
      });
      lastGeneratedFile = outputFilePath;

      return {
        status: 'success',
        message: '可以导出文件',
        outputFilePath,
        outputDate: date
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return {
          status: 'error',
          message: error.message
        };
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      return {
        status: 'error',
        message: '文件转换错误，请查看log',
        logPath
      };
    }
  });

  ipcMain.handle('file:export', async () => {
    if (!lastGeneratedFile || !fs.existsSync(lastGeneratedFile)) {
      return {
        status: 'error',
        message: '暂无可导出的文件'
      };
    }

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.basename(lastGeneratedFile),
      filters: [
        {
          name: 'Excel',
          extensions: ['xlsx']
        }
      ]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { status: 'cancelled' };
    }

    fs.copyFileSync(lastGeneratedFile, saveResult.filePath);
    return {
      status: 'success',
      message: '文件导出成功',
      filePath: saveResult.filePath
    };
  });
}

app.whenReady().then(() => {
  const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
  database = new AppDatabase(dataPath);
  database.init();

  registerWindowHandlers();
  registerAppHandlers();
  registerEnumHandlers();
  registerTemplateHandlers();
  registerFileHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
