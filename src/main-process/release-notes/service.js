'use strict';

// v3.2.14 升级后首次启动的「更新说明」：随包数据 release-notes.json + 主库 app_settings 中的已确认版本。
//   启动时只判定一次并缓存在本进程；用户关闭弹窗后由渲染层确认，写入当前版本与本次升级区间。
//   规则与编写规范见 changes/v3.2.14/feat/release-notes-on-upgrade/spec.md；
//   v3.2.15 起老用户区间、升级记录与设置入口范围见 changes/v3.2.15/feat/release-notes-range/spec.md。

const { isStrictStableUpgrade } = require('../app-updater');
const BUNDLED_RELEASE_NOTES = require('./release-notes.json');

// 本功能之前的版本不记录确认版本：已有数据但无记录时，来源版本未知，从 3.2.13（含）起显示到当前版本。
const LEGACY_FIRST_VERSION = '3.2.13';
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_LENGTH = 120;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isStableVersion(value) {
  return typeof value === 'string' && STABLE_VERSION_PATTERN.test(value);
}

// 构建元数据（“+”之后）不影响版本先后，按对应正式版处理，与 app-updater 的稳定版判定同口径；预发布号仍不算正式版。
function toStableVersion(value) {
  if (typeof value !== 'string') return null;
  const version = value.replace(/\+[0-9A-Za-z.-]+$/, '');
  return isStableVersion(version) ? version : null;
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

// [3.2.13, toVersion]：从 v3.2.14 之前的版本升级上来、来源未知时的区间。
function selectLegacyReleaseNotes({ entries, toVersion }) {
  return entries.filter((entry) => !isStrictStableUpgrade(entry.version, LEGACY_FIRST_VERSION)
    && !isStrictStableUpgrade(toVersion, entry.version));
}

// 一次升级的说明区间：来源版本已知取 (from, to]，未知取 [3.2.13, to]。
function selectUpgradeReleaseNotes({ entries, fromVersion, toVersion }) {
  return fromVersion
    ? selectReleaseNotes({ entries, fromVersion, toVersion })
    : selectLegacyReleaseNotes({ entries, toVersion });
}

// 主库中的升级记录：两个版本号须为正式版本号且 from 低于 to；fromVersion 为 null 表示来源未知。不合格视为没有记录。
function normalizeLastUpgrade(value) {
  if (!value || typeof value !== 'object' || !isStableVersion(value.toVersion)) return null;
  if (value.fromVersion === null || value.fromVersion === undefined) return { fromVersion: null, toVersion: value.toVersion };
  if (!isStableVersion(value.fromVersion) || !isStrictStableUpgrade(value.fromVersion, value.toVersion)) return null;
  return { fromVersion: value.fromVersion, toVersion: value.toVersion };
}

function findReleaseNotes(entries, version) {
  const stableVersion = toStableVersion(version);
  return entries.find((entry) => entry.version === stableVersion) || null;
}

// 纯判定：返回本次启动待显示的说明（或 null）、启动时需写入的确认版本（或 null）与升级记录（或 null）。
//   writeUpgrade 非空时与确认版本同一事务写入（区间内没有说明条目、直接确认的升级）。
function resolveStartupReleaseNotes({ currentVersion: rawCurrentVersion, acknowledgedVersion, databaseExisted, entries }) {
  const none = { pending: null, writeAcknowledged: null, writeUpgrade: null };
  // 开发版、预发布号不参与，也不写记录，避免污染正式版判定。
  const currentVersion = toStableVersion(rawCurrentVersion);
  if (!currentVersion) return none;
  const recorded = isStableVersion(acknowledgedVersion) ? acknowledgedVersion : null;
  if (!recorded && !databaseExisted) return { ...none, writeAcknowledged: currentVersion };
  // 同版本或降级：不弹，不改已有记录。
  if (recorded && !isStrictStableUpgrade(recorded, currentVersion)) return none;
  // 无记录且当前版本早于 3.2.13（本功能不会随这类版本发布，防御）：补写记录，不弹。
  if (!recorded && isStrictStableUpgrade(currentVersion, LEGACY_FIRST_VERSION)) return { ...none, writeAcknowledged: currentVersion };
  const upgrade = { fromVersion: recorded, toVersion: currentVersion };
  const range = selectUpgradeReleaseNotes({ entries, ...upgrade });
  if (!range.length) return { ...none, writeAcknowledged: currentVersion, writeUpgrade: upgrade };
  return { ...none, pending: { ...upgrade, entries: range } };
}

// 设置入口显示的区间：待显示（未确认）的升级 → 最近一次升级到当前版本的记录 → 只有当前版本。
function resolveReleaseNotesHistory({ entries, currentVersion: rawCurrentVersion, pending, lastUpgrade }) {
  if (pending) {
    return { kind: 'upgrade', fromVersion: pending.fromVersion, toVersion: pending.toVersion, entries: pending.entries };
  }
  const currentVersion = toStableVersion(rawCurrentVersion);
  const upgrade = normalizeLastUpgrade(lastUpgrade);
  if (currentVersion && upgrade && upgrade.toVersion === currentVersion) {
    const range = selectUpgradeReleaseNotes({ entries, ...upgrade });
    if (range.length) return { kind: 'upgrade', ...upgrade, entries: range };
  }
  const current = findReleaseNotes(entries, rawCurrentVersion);
  return { kind: 'current', fromVersion: null, toVersion: currentVersion, entries: current ? [current] : [] };
}

function cloneEntry(entry) {
  return entry ? { ...entry, highlights: [...entry.highlights] } : null;
}

function clonePending(pending) {
  return pending ? { ...pending, entries: pending.entries.map(cloneEntry) } : null;
}

function readLastUpgrade(store, log) {
  try {
    return normalizeLastUpgrade(store.getReleaseNotesLastUpgrade());
  } catch (error) {
    log({ level: 'warning', message: '读取更新说明升级记录失败', details: [errorMessage(error)] });
    return null;
  }
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
  let lastUpgrade = readLastUpgrade(store, log);
  if (decision.writeAcknowledged) {
    try {
      if (decision.writeUpgrade) {
        store.recordReleaseNotesUpgrade(decision.writeUpgrade);
        lastUpgrade = decision.writeUpgrade;
      } else {
        store.setReleaseNotesAcknowledgedVersion(decision.writeAcknowledged);
      }
    } catch (error) {
      log({ level: 'warning', message: '记录更新说明版本失败', details: [errorMessage(error)] });
    }
  }
  let pending = decision.pending;

  return {
    getSnapshot() {
      const history = resolveReleaseNotesHistory({ entries, currentVersion, pending, lastUpgrade });
      return {
        current: cloneEntry(current),
        pending: clonePending(pending),
        history: { ...history, entries: history.entries.map(cloneEntry) }
      };
    },
    acknowledge(version) {
      if (!pending || version !== pending.toVersion) return { status: 'ignored' };
      const upgrade = { fromVersion: pending.fromVersion, toVersion: version };
      try {
        store.recordReleaseNotesUpgrade(upgrade);
      } catch (error) {
        log({ level: 'warning', message: '确认更新说明失败', details: [errorMessage(error)] });
        return { status: 'failed', message: errorMessage(error) };
      }
      pending = null;
      lastUpgrade = upgrade;
      return { status: 'ok', acknowledgedVersion: version };
    }
  };
}

module.exports = {
  LEGACY_FIRST_VERSION,
  MAX_HIGHLIGHTS,
  MAX_HIGHLIGHT_LENGTH,
  createReleaseNotesState,
  findReleaseNotes,
  normalizeReleaseNotes,
  normalizeLastUpgrade,
  resolveReleaseNotesHistory,
  resolveStartupReleaseNotes,
  selectReleaseNotes,
  selectUpgradeReleaseNotes
};
