'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
    assert.ok(match, `版本号格式应为 x.y.z，实际为 ${value}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

test.describe('v3.0.18 在线升级静态契约', () => {
  test('构建配置固定 GitHub latest、无签名校验和更新元数据', () => {
    const packageJson = JSON.parse(read('package.json'));
    const publish = packageJson.build.publish[0];

    assert.ok(compareVersions(packageJson.version, '3.0.18') >= 0);
    assert.ok(packageJson.dependencies['electron-updater']);
    assert.equal(packageJson.scripts['stage:update-artifacts'], 'node scripts/stage-update-artifacts.js');
    assert.match(packageJson.scripts['preview:all'], /npm run preview:app-update-settings/);
    for (const scriptName of ['dist:win', 'dist:win:setup', 'dist:win:portable']) {
      assert.match(
        packageJson.scripts[scriptName],
        /electron-builder[^&]*--publish never/,
        `${scriptName} 必须禁止 electron-builder 隐式发布`
      );
    }
    assert.equal(packageJson.build.win.verifyUpdateCodeSignature, false);
    assert.equal(packageJson.build.win.publisherName, undefined);
    assert.equal(packageJson.build.win.signtoolOptions?.publisherName, undefined);
    assert.doesNotMatch(JSON.stringify(packageJson.build.win), /publisherName/);
    assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable']);
    assert.deepEqual(publish, {
      provider: 'github',
      owner: 'MatthewPZhong',
      repo: 'bank-bill-excel-tool',
      channel: 'latest',
      publishAutoUpdate: true,
      releaseType: 'release'
    });
  });

  test('底部按钮顺序和设置状态点保持固定', () => {
    const html = read('index.html');
    const ids = [
      'backgroundPaletteBtn',
      'saveUserGuideBtn',
      'settingsBtn',
      'moduleCabinetBtn',
      'toolboxBtn'
    ];
    const positions = ids.map((id) => html.indexOf(`id="${id}"`));

    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(html, /id="settingsBtn"[\s\S]*?id="appUpdateStatusDot"/);
    const renderer = read('src/renderer.js');
    assert.match(renderer, /data-role="last-checked"/);
    assert.match(renderer, /function formatAppUpdateVersion\(value\)/);
    assert.match(renderer, /function setupAppUpdatePromptObserver\(\)/);
    assert.match(renderer, /activeModal\.querySelector\?\.\('\.app-update-settings-card'\)/);
    assert.match(renderer, /设置，更新已下载/);
    assert.match(renderer, /aria-label="更新下载进度"/);
    assert.match(renderer, /data-role="auto-update-toggle" aria-label="自动更新"/);
    assert.match(renderer, /closeButton\.textContent = status\.canRestart \? '稍后' : '完成'/);
  });

  test('preload 仅暴露约定的升级 IPC 能力', () => {
    const preload = read('src/preload.js');

    for (const channel of [
      'app-update:get-status',
      'app-update:set-enabled',
      'app-update:check-now',
      'app-update:restart-and-install',
      'app-update:status-changed'
    ]) {
      assert.ok(preload.includes(channel), `${channel} 应存在`);
    }
  });

  test('启动检查没有周期定时器，portable 只打开固定 Releases 页面', () => {
    const updater = read('src/main-process/app-updater.js');
    const main = read('src/main.js');

    assert.doesNotMatch(updater, /setInterval\s*\(/);
    assert.match(main, /const APP_UPDATE_RELEASE_URL = 'https:\/\/github\.com\/MatthewPZhong\/bank-bill-excel-tool\/releases';/);
    assert.match(main, /function scheduleAppUpdaterStartupCheck\(\)[\s\S]*?setImmediate\(/);
    assert.match(main, /markAppInitDone\(\)[\s\S]*?scheduleAppUpdaterStartupCheck\(\);/);
    assert.match(main, /getLastCompletedCheckKind\(\)/, '并发加入检查时下载必须沿用真实触发来源');
  });

  test('升级安装闸门覆盖独立月份删除入口，升级错误不向 Renderer 透传底层 message', () => {
    const main = read('src/main.js');

    assert.match(
      main,
      /businessIpcHandle\('acquiringBillCurrency:clearMonth', '清空月份数据'/
    );
    assert.match(main, /resumeAfterFailedRestart: resumeApplicationAfterFailedRestart/);
    assert.match(main, /function resumeApplicationAfterFailedRestart\(\)/);
    assert.match(
      main,
      /mainWindow\.on\('close',[\s\S]*?isInstallTransitionActive\(\) && !quitPreparationComplete[\s\S]*?event\.preventDefault\(\)/,
      '安装退出清理完成前必须阻止用户关闭窗口抢占退出链'
    );
    assert.match(
      main,
      /app\.on\('before-quit',[\s\S]*?isInstallTransitionActive\(\) && !quitPreparationComplete[\s\S]*?event\.preventDefault\(\);[\s\S]*?return;/,
      '安装退出清理完成前必须阻止普通 app.quit 抢占退出链'
    );
    const checkHandler = main.slice(
      main.indexOf("ipcMain.handle('app-update:check-now'"),
      main.indexOf("ipcMain.handle('app-update:restart-and-install'")
    );
    const settingHandler = main.slice(
      main.indexOf("ipcMain.handle('app-update:set-enabled'"),
      main.indexOf("ipcMain.handle('app-update:check-now'")
    );
    assert.match(settingHandler, /if \(!before\.supported\)/);
    assert.ok(
      settingHandler.indexOf('if (!before.supported)') < settingHandler.indexOf('database.setAutoUpdateEnabled(enabled)'),
      'portable/development 必须在持久化前被拒绝'
    );
    assert.match(
      settingHandler,
      /alreadyUpdating = \['checking', 'available', 'downloading', 'downloaded'\]\.includes\(before\.state\)/,
      '手动检查或下载中开启开关不得重复发起检查'
    );
    assert.match(
      checkHandler,
      /message: failedStatus\.error\?\.message \|\| '检查失败，请稍后重试'/
    );
    assert.doesNotMatch(checkHandler, /error\.message/);
  });

  test('Windows 发布工作流验证 main、版本、更新哈希并直接发布稳定 Release', () => {
    const workflow = read('.github/workflows/release-windows.yml');
    const ordinaryBuild = read('.github/workflows/build-windows.yml');

    assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/);
    assert.match(workflow, /Release tag must point to the current main commit/);
    assert.match(workflow, /Package version \$version is not a stable semantic version/);
    assert.match(workflow, /npm run release-check/);
    assert.match(workflow, /npm run prebuild:meta/);
    assert.match(workflow, /electron-builder --win --publish never/);
    assert.match(workflow, /npm run stage:update-artifacts/);
    assert.match(workflow, /bank-bill-excel-tool-setup-\$version\.exe/);
    assert.match(workflow, /bank-bill-excel-tool-portable-\$version\.exe/);
    assert.doesNotMatch(workflow, /Get-ChildItem dist -Filter '\*-portable\.exe'/);
    assert.match(workflow, /latest\.yml SHA512 does not match/);
    assert.match(workflow, /gh release create[\s\S]*--latest/);
    assert.doesNotMatch(workflow, /--draft|--prerelease/);
    assert.match(ordinaryBuild, /electron-builder --win --publish never/);
    assert.match(ordinaryBuild, /dist\/bank-bill-excel-tool-portable-\*\.exe/);
  });
});
