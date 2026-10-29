'use strict';

// v3.2.14 升级后首次启动的「更新说明」：随包数据 release-notes.json + 主库 app_settings 中的已确认版本。
//   启动时只判定一次并缓存在本进程；用户关闭弹窗后由渲染层确认，写入当前版本。
//   规则与编写规范见 changes/v3.2.14/feat/release-notes-on-upgrade/spec.md。

const { isStrictStableUpgrade } = require('../app-updater');
const BUNDLED_RELEASE_NOTES = require('./release-notes.json');

// 本功能之前的版本不记录确认版本：已有数据但无记录时，以最后一个不含本功能的正式版为基线。
const LEGACY_BASELINE_VERSION = '3.2.13';
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_LENGTH = 120;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isStableVersion(value) {
  return typeof value === 'string' && STABLE_VERSION_PATTERN.test(value);
}

function isValidDate(value) {
  const match = typeof value === 'string' ? value.match(DATE_PATTERN) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function entryProblems(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['不是对象'];
  const problems = [];
  if (!isStableVersion(entry.version)) problems.push(`版本号无效：${JSON.stringify(entry.version)}`);
  if (!isValidDate(entry.date)) problems.push(`日期无效：${JSON.stringify(entry.date)}`);
  const highlights = entry.highlights;
  if (!Array.isArray(highlights) || highlights.length < 1 || highlights.length > MAX_HIGHLIGHTS) {
    problems.push(`要点须为 1–${MAX_HIGHLIGHTS} 条`);
  } else {
    highlights.forEach((text, index) => {
      if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text)) {
        problems.push(`第 ${index + 1} 条要点须为单行非空文本`);
      } else if (text.trim().length > MAX_HIGHLIGHT_LENGTH) {
        problems.push(`第 ${index + 1} 条要点超过 ${MAX_HIGHLIGHT_LENGTH} 字`);
      }
    });
  }
  return problems;
}

// 返回通过校验的条目（按版本从新到旧）与全部问题；顺序错误也记为问题，便于测试门禁发现。
function normalizeReleaseNotes(raw) {
  if (!Array.isArray(raw)) return { entries: [], issues: ['更新说明数据必须是数组'] };
  const entries = [];
  const issues = [];
  raw.forEach((entry, index) => {
    const problems = entryProblems(entry);
    if (problems.length) {
      issues.push(`第 ${index + 1} 项：${problems.join('；')}`);
      return;
    }
    const previous = entries[entries.length - 1];
    if (entries.some((item) => item.version === entry.version)) {
      issues.push(`第 ${index + 1} 项：版本 ${entry.version} 重复`);
      return;
    }
    if (previous && !isStrictStableUpgrade(entry.version, previous.version)) {
      issues.push(`第 ${index + 1} 项：版本 ${entry.version} 未按从新到旧排列`);
    }
    entries.push({ version: entry.version, date: entry.date, highlights: entry.highlights.map((text) => text.trim()) });
  });
  entries.sort((left, right) => {
    if (isStrictStableUpgrade(left.version, right.version)) return 1;
    if (isStrictStableUpgrade(right.version, left.version)) return -1;
    return 0;
  });
  return { entries, issues };
}

// (fromVersion, toVersion]，按版本从新到旧。
function selectReleaseNotes({ entries, fromVersion, toVersion }) {
  return entries.filter((entry) => isStrictStableUpgrade(fromVersion, entry.version)
    && !isStrictStableUpgrade(toVersion, entry.version));
}

function findReleaseNotes(entries, version) {
  return entries.find((entry) => entry.version === version) || null;
}

// 纯判定：返回本次启动待显示的说明（或 null）与启动时需写入的确认版本（或 null）。
function resolveStartupReleaseNotes({ currentVersion, acknowledgedVersion, databaseExisted, entries }) {
  // 开发版、预发布号不参与，也不写记录，避免污染正式版判定。
  if (!isStableVersion(currentVersion)) return { pending: null, writeAcknowledged: null };
  const recorded = isStableVersion(acknowledgedVersion) ? acknowledgedVersion : null;
  if (!recorded && !databaseExisted) return { pending: null, writeAcknowledged: currentVersion };
  const baseline = recorded || LEGACY_BASELINE_VERSION;
  if (!isStrictStableUpgrade(baseline, currentVersion)) {
    // 同版本或降级：不弹；降级不改已有记录。
    return { pending: null, writeAcknowledged: recorded ? null : currentVersion };
  }
  const range = selectReleaseNotes({ entries, fromVersion: baseline, toVersion: currentVersion });
  if (!range.length) return { pending: null, writeAcknowledged: currentVersion };
  return {
    pending: { fromVersion: recorded, toVersion: currentVersion, entries: range },
    writeAcknowledged: null
  };
}

function cloneEntry(entry) {
  return entry ? { ...entry, highlights: [...entry.highlights] } : null;
}

function clonePending(pending) {
  return pending ? { ...pending, entries: pending.entries.map(cloneEntry) } : null;
}

function errorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

function createReleaseNotesState({
  store,
  currentVersion,
  databaseExisted,
  rawNotes = BUNDLED_RELEASE_NOTES,
  log = () => {}
}) {
  const { entries, issues } = normalizeReleaseNotes(rawNotes);
  if (issues.length) log({ level: 'warning', message: '更新说明数据存在不合格条目，已跳过', details: issues });
  const current = findReleaseNotes(entries, currentVersion);
  const decision = resolveStartupReleaseNotes({
    currentVersion,
    acknowledgedVersion: store.getReleaseNotesAcknowledgedVersion(),
    databaseExisted,
    entries
  });
  if (decision.writeAcknowledged) {
    try {
      store.setReleaseNotesAcknowledgedVersion(decision.writeAcknowledged);
    } catch (error) {
      log({ level: 'warning', message: '记录更新说明版本失败', details: [errorMessage(error)] });
    }
  }
  let pending = decision.pending;

  return {
    getSnapshot() {
      return { current: cloneEntry(current), pending: clonePending(pending) };
    },
    acknowledge(version) {
      if (!pending || version !== pending.toVersion) return { status: 'ignored' };
      try {
        store.setReleaseNotesAcknowledgedVersion(version);
      } catch (error) {
        log({ level: 'warning', message: '确认更新说明失败', details: [errorMessage(error)] });
        return { status: 'failed', message: errorMessage(error) };
      }
      pending = null;
      return { status: 'ok', acknowledgedVersion: version };
    }
  };
}

module.exports = {
  LEGACY_BASELINE_VERSION,
  MAX_HIGHLIGHTS,
  MAX_HIGHLIGHT_LENGTH,
  createReleaseNotesState,
  findReleaseNotes,
  normalizeReleaseNotes,
  resolveStartupReleaseNotes,
  selectReleaseNotes
};
