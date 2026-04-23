/**
 * v1.5.2 大账号 M:1 映射状态机单测
 *
 * 从 src/renderer-dialogs.js createBigAccountSelectionDialog 中提取等价纯函数，
 * 覆盖 block 粒度勾选联动 + assignments 展开。
 *
 * 运行：node scripts/test-v1.5.2-state-machine.js
 */

'use strict';

const assert = require('assert');

// ============================================================
// Part 1 — 提取纯函数（等价于 renderer-dialogs.js 中的状态机逻辑）
// ============================================================

/**
 * 创建状态对象（等价于 renderer-dialogs.js:645-648 的 4 个 let 变量）
 */
function createState() {
  return {
    multiMode: true,
    multiEditing: true,
    pendingGroup: null,   // {leftBlockRowIndices:[], rightAccount:null, startedBy:'left'|'right'}
    multiGroups: []       // [{leftBlockRowIndices:number[], rightAccount:{merchantId,currency}}]
  };
}

/**
 * 等价于 renderer-dialogs.js:824-826
 */
function sameAccount(a, b) {
  return a && b && a.merchantId === b.merchantId && a.currency === b.currency;
}

/**
 * 等价于 renderer-dialogs.js:831-834
 * 判断某 rowIndex 是否已被 pendingGroup 或任何已闭合组覆盖
 */
function isRowIndexCovered(state, rowIndex) {
  if (state.pendingGroup && state.pendingGroup.leftBlockRowIndices.includes(rowIndex)) return true;
  return state.multiGroups.some((g) => g.leftBlockRowIndices.includes(rowIndex));
}

/**
 * 等价于 renderer-dialogs.js:836-843
 * 查找某大账号属于 pendingGroup 或哪个已闭合组
 */
function findGroupByAccount(state, account) {
  if (state.pendingGroup && state.pendingGroup.rightAccount && sameAccount(state.pendingGroup.rightAccount, account)) {
    return { source: 'pending', index: -1 };
  }
  const idx = state.multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
  if (idx >= 0) return { source: 'closed', index: idx };
  return null;
}

/**
 * 等价于 renderer-dialogs.js:845-852
 * 查找某 rowIndex 属于 pendingGroup 或哪个已闭合组
 */
function findGroupByRowIndex(state, rowIndex) {
  if (state.pendingGroup && state.pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
    return { source: 'pending', groupIndex: -1 };
  }
  const idx = state.multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(rowIndex));
  if (idx >= 0) return { source: 'closed', groupIndex: idx };
  return null;
}

/**
 * 等价于 renderer-dialogs.js:928-937
 * 闭合当前 pendingGroup（若有效：同时存在至少 1 个 left 且 1 个 right）
 */
function closeCurrentGroup(state) {
  if (!state.pendingGroup) return;
  if (state.pendingGroup.leftBlockRowIndices.length > 0 && state.pendingGroup.rightAccount) {
    state.multiGroups.push({
      leftBlockRowIndices: state.pendingGroup.leftBlockRowIndices.slice(),
      rightAccount: { ...state.pendingGroup.rightAccount }
    });
  }
  state.pendingGroup = null;
}

/**
 * 等价于 renderer-dialogs.js:854-892
 * 左侧 block 勾选/取消
 */
function onLeftBlockChecked(state, rowIndex, checked) {
  if (!state.multiMode || !state.multiEditing) return;
  if (checked) {
    // 已在任一组内 -> 保持原状（不允许同一 block 属于多组）
    if (findGroupByRowIndex(state, rowIndex)) return;
    if (!state.pendingGroup) {
      state.pendingGroup = { leftBlockRowIndices: [rowIndex], rightAccount: null, startedBy: 'left' };
    } else {
      // 追加本 block 到当前 pendingGroup
      if (!state.pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
        state.pendingGroup.leftBlockRowIndices.push(rowIndex);
      }
    }
  } else {
    // 取消：若在 pendingGroup 中 -> 移除；若 pendingGroup 因此变空（无 left 无 right）-> 置 null
    // 若在已闭合组中 -> 从该组移除；若该组变空 -> 整组移除
    if (state.pendingGroup && state.pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
      state.pendingGroup.leftBlockRowIndices = state.pendingGroup.leftBlockRowIndices.filter((r) => r !== rowIndex);
      if (state.pendingGroup.leftBlockRowIndices.length === 0 && !state.pendingGroup.rightAccount) {
        state.pendingGroup = null;
      }
    } else {
      for (let i = state.multiGroups.length - 1; i >= 0; i -= 1) {
        const g = state.multiGroups[i];
        if (g.leftBlockRowIndices.includes(rowIndex)) {
          g.leftBlockRowIndices = g.leftBlockRowIndices.filter((r) => r !== rowIndex);
          if (g.leftBlockRowIndices.length === 0) {
            state.multiGroups.splice(i, 1);
          }
          break;
        }
      }
    }
  }
}

/**
 * 等价于 renderer-dialogs.js:894-926
 * 右侧大账号勾选/取消
 */
function onRightAccountChecked(state, account, checked) {
  if (!state.multiMode || !state.multiEditing) return;
  if (checked) {
    // 同一大账号最多只能属于一组
    if (findGroupByAccount(state, account)) return;
    if (!state.pendingGroup) {
      state.pendingGroup = { leftBlockRowIndices: [], rightAccount: { ...account }, startedBy: 'right' };
    } else if (!state.pendingGroup.rightAccount) {
      state.pendingGroup.rightAccount = { ...account };
    } else {
      // pendingGroup 已绑右侧 -> 触发闭合，开始新组
      closeCurrentGroup(state);
      state.pendingGroup = { leftBlockRowIndices: [], rightAccount: { ...account }, startedBy: 'right' };
    }
  } else {
    // 取消：若在 pendingGroup -> 清 rightAccount；若因此变空 -> 置 null
    // 若在已闭合组 -> 整组移除
    if (state.pendingGroup && state.pendingGroup.rightAccount && sameAccount(state.pendingGroup.rightAccount, account)) {
      state.pendingGroup.rightAccount = null;
      if (state.pendingGroup.leftBlockRowIndices.length === 0) {
        state.pendingGroup = null;
      }
    } else {
      const idx = state.multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
      if (idx >= 0) {
        state.multiGroups.splice(idx, 1);
      }
    }
  }
}

/**
 * 字母序号计算（等价于 renderer-dialogs.js:939-966 中的字母分配逻辑）
 * 返回 Map<accountKey, letterString>
 * - 已闭合组按 multiGroups 下标分配 a, b, c...
 * - pendingGroup（若有 rightAccount）分配 multiGroups.length 对应的字母
 */
function computeAlphaIndex(state, expandedOptions) {
  const result = new Map();
  expandedOptions.forEach((option) => {
    const account = { merchantId: option.merchantId, currency: option.currency };
    const closedIdx = state.multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
    if (closedIdx >= 0) {
      result.set(`${account.merchantId}@@${account.currency}`, String.fromCharCode(97 + closedIdx));
    } else if (state.pendingGroup && state.pendingGroup.rightAccount && sameAccount(state.pendingGroup.rightAccount, account)) {
      result.set(`${account.merchantId}@@${account.currency}`, String.fromCharCode(97 + state.multiGroups.length));
    }
  });
  return result;
}

/**
 * 等价于 renderer-dialogs.js:1476-1528 doneBtn handler 中的 finalAssignments 构造
 *
 * @param {object} state - 状态对象
 * @param {Array} currentFileRows - [{index: rowIndex, ...}, ...]
 * @param {Array} checkedOrder - [{merchantId, currency, key}, ...]（1:1 模式的 checkedOrder）
 * @returns {Array} finalAssignments - [{rowIndex, merchantId, currency}, ...]
 */
function buildFinalAssignments(state, currentFileRows, checkedOrder) {
  let finalAssignments;
  if (state.multiMode) {
    // 编辑态下主完成 -> 尝试闭合当前组
    if (state.multiEditing) {
      closeCurrentGroup(state);
      state.multiEditing = false;
    }
    finalAssignments = [];
    const coveredRowIndices = new Set();
    state.multiGroups.forEach((group) => {
      group.leftBlockRowIndices.forEach((rowIndex) => {
        finalAssignments.push({
          rowIndex,
          merchantId: group.rightAccount.merchantId,
          currency: group.rightAccount.currency
        });
        coveredRowIndices.add(rowIndex);
      });
    });
    // 未入组 block 按 checkedOrder 顺序补齐
    let orderCursor = 0;
    for (const row of currentFileRows) {
      const rowIdx = Number.isInteger(row.index) ? row.index : null;
      if (rowIdx === null) continue;
      if (coveredRowIndices.has(rowIdx)) continue;
      const item = checkedOrder[orderCursor];
      if (!item) break;
      finalAssignments.push({
        rowIndex: rowIdx,
        merchantId: item.merchantId,
        currency: item.currency
      });
      orderCursor += 1;
    }
    finalAssignments.sort((a, b) => a.rowIndex - b.rowIndex);
  } else {
    // 非多对一模式
    finalAssignments = checkedOrder.map((item, index) => ({
      rowIndex: index,
      merchantId: item.merchantId,
      currency: item.currency
    }));
  }
  return finalAssignments;
}

/**
 * 模拟"点编辑按钮"（等价于 renderer-dialogs.js:1188-1201 multiEditBtn click handler）
 * 决策 D3：每次进入编辑态时清空 multiGroups，让字母真正从 a 重开
 */
function pressEditButton(state) {
  if (!state.multiMode) return;
  state.multiEditing = true;
  state.multiGroups = [];
  state.pendingGroup = null;
}

/**
 * 模拟"点完成按钮"（等价于 renderer-dialogs.js:1204-1210 multiDoneBtn click handler）
 */
function pressDoneButton(state) {
  if (!state.multiMode || !state.multiEditing) return;
  closeCurrentGroup(state);
  state.multiEditing = false;
}

/**
 * 模拟"取消勾选多对一模式"（等价于 renderer-dialogs.js:1159-1182 multiModeCheckbox change handler）
 */
function toggleMultiMode(state, checked) {
  state.multiMode = checked;
  if (checked) {
    state.multiEditing = true;
    state.multiGroups = [];
    state.pendingGroup = null;
  } else {
    state.multiGroups = [];
    state.pendingGroup = null;
    state.multiEditing = false;
  }
}

/**
 * 模拟"记住顺序" 与 "多对一模式" 互斥逻辑
 * （等价于 renderer-dialogs.js:1213-1240 syncMultiModeMutualDisabled）
 * 返回 {rememberDisabled, multiModeDisabled}
 */
function syncMultiModeMutualDisabled(state, rememberChecked, currentMode) {
  if (rememberChecked) {
    // 记住顺序勾上 -> 多对一模式 disabled 并取消
    if (state.multiMode) {
      state.multiMode = false;
      state.multiEditing = false;
      state.multiGroups = [];
      state.pendingGroup = null;
    }
    return { rememberDisabled: false, multiModeDisabled: true };
  }
  if (state.multiMode) {
    // 多对一模式勾上 -> 记住顺序 disabled
    return { rememberDisabled: true, multiModeDisabled: false };
  }
  // 仅在 fixed 模式才允许启用记住顺序
  if (currentMode === 'fixed') {
    return { rememberDisabled: false, multiModeDisabled: false };
  }
  return { rememberDisabled: true, multiModeDisabled: false };
}

// ============================================================
// Part 2 — 测试用例
// ============================================================

const results = [];
let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    passCount += 1;
  } catch (err) {
    results.push({ name, pass: false, error: err });
    failCount += 1;
  }
}

// ---------- 测试用账号 ----------
const ACCOUNT_A = { merchantId: 'ACC001', currency: 'CNY' };
const ACCOUNT_B = { merchantId: 'ACC002', currency: 'CNY' };
const ACCOUNT_C = { merchantId: 'ACC003', currency: 'USD' };

// ===== 基础映射（P0-4/P0-5/P0-6）=====

runTest('T-01 先左后右基本映射', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0]);
  assert.strictEqual(sameAccount(s.multiGroups[0].rightAccount, ACCOUNT_A), true);
  assert.strictEqual(s.pendingGroup, null);
});

runTest('T-02 先右后左触发闭合', () => {
  const s = createState();
  // 先勾右侧 A
  onRightAccountChecked(s, ACCOUNT_A, true);
  assert.notStrictEqual(s.pendingGroup, null);
  assert.strictEqual(sameAccount(s.pendingGroup.rightAccount, ACCOUNT_A), true);
  assert.strictEqual(s.pendingGroup.startedBy, 'right');
  // 再勾左侧 block[0]
  onLeftBlockChecked(s, 0, true);
  assert.deepStrictEqual(s.pendingGroup.leftBlockRowIndices, [0]);
  // 再勾右侧 B -> 触发闭合（pendingGroup 已绑右侧 A，新的 B 触发闭合）
  onRightAccountChecked(s, ACCOUNT_B, true);
  // 闭合结果：multiGroups 有 1 组（A + [0]）
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0]);
  assert.strictEqual(sameAccount(s.multiGroups[0].rightAccount, ACCOUNT_A), true);
  // pendingGroup 是 B（新开的组）
  assert.notStrictEqual(s.pendingGroup, null);
  assert.strictEqual(sameAccount(s.pendingGroup.rightAccount, ACCOUNT_B), true);
});

runTest('T-03 多 block 映射同一账号', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0, 1]);
  assert.strictEqual(sameAccount(s.multiGroups[0].rightAccount, ACCOUNT_A), true);
});

runTest('T-04 完成两组映射 block[0]->A + block[2]->B', () => {
  const s = createState();
  // 第一组
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  // 第二组
  onLeftBlockChecked(s, 2, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);

  assert.strictEqual(s.multiGroups.length, 2);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0]);
  assert.strictEqual(sameAccount(s.multiGroups[0].rightAccount, ACCOUNT_A), true);
  assert.deepStrictEqual(s.multiGroups[1].leftBlockRowIndices, [2]);
  assert.strictEqual(sameAccount(s.multiGroups[1].rightAccount, ACCOUNT_B), true);
  // 字母序号：a=0 对应 multiGroups[0], b=1 对应 multiGroups[1]
  const options = [ACCOUNT_A, ACCOUNT_B];
  const alphas = computeAlphaIndex(s, options);
  assert.strictEqual(alphas.get('ACC001@@CNY'), 'a');
  assert.strictEqual(alphas.get('ACC002@@CNY'), 'b');
});

// ===== P0-12 block 粒度（最关键场景）=====

runTest('T-05 buildFinalAssignments block 粒度展开', () => {
  // 3 个 block(rowIndex=0,1,2)，block[0]->A, block[1]->B, block[2] 未映射
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  s.multiEditing = false; // 模拟已按"完成"

  const currentFileRows = [
    { index: 0, fileName: 'file1.xlsx' },
    { index: 1, fileName: 'file2.xlsx' },
    { index: 2, fileName: 'file3.xlsx' }
  ];
  // block[2] 未映射，由 checkedOrder 补齐
  const checkedOrder = [{ merchantId: ACCOUNT_C.merchantId, currency: ACCOUNT_C.currency, key: 'ACC003@@USD' }];

  const result = buildFinalAssignments(s, currentFileRows, checkedOrder);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].rowIndex, 0);
  assert.strictEqual(result[0].merchantId, 'ACC001');
  assert.strictEqual(result[1].rowIndex, 1);
  assert.strictEqual(result[1].merchantId, 'ACC002');
  assert.strictEqual(result[2].rowIndex, 2);
  assert.strictEqual(result[2].merchantId, 'ACC003');
});

runTest('T-06 同文件 block[0] 和 block[2] -> 同一账号 A（跳过 block[1]）', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 2, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'file1.xlsx' },
    { index: 1, fileName: 'file2.xlsx' },
    { index: 2, fileName: 'file3.xlsx' }
  ];
  const checkedOrder = [{ merchantId: ACCOUNT_B.merchantId, currency: ACCOUNT_B.currency, key: 'ACC002@@CNY' }];

  const result = buildFinalAssignments(s, currentFileRows, checkedOrder);
  assert.strictEqual(result.length, 3);
  // block[0] 和 block[2] 用 A
  assert.strictEqual(result[0].merchantId, 'ACC001'); // rowIndex=0
  assert.strictEqual(result[2].merchantId, 'ACC001'); // rowIndex=2
  // block[1] 不被覆盖 -> 用 checkedOrder 的 B
  assert.strictEqual(result[1].merchantId, 'ACC002'); // rowIndex=1
});

// ===== 字母序号（AC2-5/AC2-6）=====

runTest('T-07 字母序号按组顺序分配 a/b/c', () => {
  const s = createState();
  // 三组映射
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 2, true);
  onRightAccountChecked(s, ACCOUNT_C, true);
  closeCurrentGroup(s);

  const options = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
  const alphas = computeAlphaIndex(s, options);
  assert.strictEqual(alphas.get('ACC001@@CNY'), 'a');
  assert.strictEqual(alphas.get('ACC002@@CNY'), 'b');
  assert.strictEqual(alphas.get('ACC003@@USD'), 'c');
});

runTest('T-08 闭合 pendingGroup 后字母序号递增', () => {
  const s = createState();
  // 第一组已闭合
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 1);

  // pendingGroup 绑定 B -> 应该是 multiGroups.length = 1 -> 字母 'b'
  onRightAccountChecked(s, ACCOUNT_B, true);
  const options = [ACCOUNT_A, ACCOUNT_B];
  const alphas = computeAlphaIndex(s, options);
  assert.strictEqual(alphas.get('ACC001@@CNY'), 'a');
  assert.strictEqual(alphas.get('ACC002@@CNY'), 'b'); // pendingGroup 使用 multiGroups.length 位置

  // 闭合 pendingGroup 需要先给左侧 block
  onLeftBlockChecked(s, 1, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 2);
  const alphas2 = computeAlphaIndex(s, options);
  assert.strictEqual(alphas2.get('ACC002@@CNY'), 'b'); // 从 pending 变成 closed，index 不变
});

// ===== 编辑/完成切换（AC2-7/AC2-8 + 决策 D3）=====

runTest('T-09 点"完成" pendingGroup 被闭合', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  // pendingGroup 有效 -> pressDoneButton 应闭合
  pressDoneButton(s);
  assert.strictEqual(s.multiEditing, false);
  assert.strictEqual(s.pendingGroup, null);
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0]);
});

runTest('T-10 点"编辑" multiGroups 清空 + 字母从 a 重开', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  pressDoneButton(s);
  assert.strictEqual(s.multiGroups.length, 1);

  // 点编辑 -> 决策 D3：multiGroups 清空
  pressEditButton(s);
  assert.strictEqual(s.multiEditing, true);
  assert.strictEqual(s.multiGroups.length, 0);
  assert.strictEqual(s.pendingGroup, null);
  // 新建一组 -> 字母应从 'a' 开始
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  const alphas = computeAlphaIndex(s, [ACCOUNT_B]);
  assert.strictEqual(alphas.get('ACC002@@CNY'), 'a');
});

runTest('T-11 连续两次"编辑"状态安全', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  pressDoneButton(s);
  pressEditButton(s);
  pressEditButton(s); // 第二次编辑
  // 不崩溃即可；状态保持合理
  assert.strictEqual(s.multiEditing, true);
  assert.strictEqual(s.multiGroups.length, 0);
  assert.strictEqual(s.pendingGroup, null);
});

// ===== 取消勾选/回滚（G2-4 边界）=====

runTest('T-12 取消左侧 block 从 pendingGroup 移除', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 1, true);
  assert.deepStrictEqual(s.pendingGroup.leftBlockRowIndices, [0, 1]);
  onLeftBlockChecked(s, 0, false); // 取消 block[0]
  assert.deepStrictEqual(s.pendingGroup.leftBlockRowIndices, [1]);
});

runTest('T-13 pendingGroup 因取消而变空 -> 清零', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  assert.notStrictEqual(s.pendingGroup, null);
  onLeftBlockChecked(s, 0, false); // 取消唯一 block，且无 rightAccount
  assert.strictEqual(s.pendingGroup, null);
});

runTest('T-14 取消已闭合组中的某 block', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [0, 1]);
  // 取消 block[0] -> 组只剩 block[1]
  onLeftBlockChecked(s, 0, false);
  assert.strictEqual(s.multiGroups.length, 1);
  assert.deepStrictEqual(s.multiGroups[0].leftBlockRowIndices, [1]);
  // 取消 block[1] -> 组变空 -> 整组移除
  onLeftBlockChecked(s, 1, false);
  assert.strictEqual(s.multiGroups.length, 0);
});

runTest('T-15 取消"单个账号匹多个文件"勾选清空状态', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  assert.strictEqual(s.multiGroups.length, 1);
  // 取消多对一模式
  toggleMultiMode(s, false);
  assert.strictEqual(s.multiMode, false);
  assert.strictEqual(s.multiGroups.length, 0);
  assert.strictEqual(s.pendingGroup, null);
  assert.strictEqual(s.multiEditing, false);
});

// ===== doneBtn 展开（G2-5）=====

runTest('T-16 M:1 覆盖部分 block + checkedOrder 补齐', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'a.xlsx' },
    { index: 1, fileName: 'b.xlsx' },
    { index: 2, fileName: 'c.xlsx' }
  ];
  const checkedOrder = [{ merchantId: 'ACC002', currency: 'CNY', key: 'ACC002@@CNY' }];

  const result = buildFinalAssignments(s, currentFileRows, checkedOrder);
  assert.strictEqual(result.length, 3);
  // block[0], block[1] -> A
  assert.strictEqual(result[0].merchantId, 'ACC001');
  assert.strictEqual(result[0].currency, 'CNY');
  assert.strictEqual(result[1].merchantId, 'ACC001');
  assert.strictEqual(result[1].currency, 'CNY');
  // block[2] -> checkedOrder 的 B
  assert.strictEqual(result[2].merchantId, 'ACC002');
  assert.strictEqual(result[2].currency, 'CNY');
  // 每条含 rowIndex + merchantId + currency
  result.forEach((r) => {
    assert.ok(Number.isInteger(r.rowIndex));
    assert.ok(typeof r.merchantId === 'string');
    assert.ok(typeof r.currency === 'string');
  });
});

runTest('T-17 所有 block 被 M:1 覆盖', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 1, true);
  onLeftBlockChecked(s, 2, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'a.xlsx' },
    { index: 1, fileName: 'b.xlsx' },
    { index: 2, fileName: 'c.xlsx' }
  ];

  const result = buildFinalAssignments(s, currentFileRows, []);
  assert.strictEqual(result.length, 3);
  result.forEach((r) => {
    assert.strictEqual(r.merchantId, 'ACC001');
    assert.strictEqual(r.currency, 'CNY');
  });
});

runTest('T-18 没有 M:1 映射 -> 全从 checkedOrder 来', () => {
  const s = createState();
  s.multiMode = false; // 非多对一模式

  const checkedOrder = [
    { merchantId: 'ACC001', currency: 'CNY', key: 'ACC001@@CNY' },
    { merchantId: 'ACC002', currency: 'CNY', key: 'ACC002@@CNY' },
    { merchantId: 'ACC003', currency: 'USD', key: 'ACC003@@USD' }
  ];

  const result = buildFinalAssignments(s, [], checkedOrder);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].rowIndex, 0);
  assert.strictEqual(result[0].merchantId, 'ACC001');
  assert.strictEqual(result[1].rowIndex, 1);
  assert.strictEqual(result[1].merchantId, 'ACC002');
  assert.strictEqual(result[2].rowIndex, 2);
  assert.strictEqual(result[2].merchantId, 'ACC003');
});

runTest('T-19 coveredRowIndices 去重（同 rowIndex 不出现两次）', () => {
  const s = createState();
  // 两组映射，但不允许同一 block 在两组（状态机防御了这一点）
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 1, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'a.xlsx' },
    { index: 1, fileName: 'b.xlsx' }
  ];

  const result = buildFinalAssignments(s, currentFileRows, []);
  // 每个 rowIndex 只出现一次
  const rowIndices = result.map((r) => r.rowIndex);
  const unique = new Set(rowIndices);
  assert.strictEqual(unique.size, rowIndices.length);
  assert.strictEqual(result.length, 2);
});

runTest('T-20 finalAssignments 按 rowIndex 升序排列', () => {
  const s = createState();
  // 故意倒序建组：先 block[2]，再 block[0]
  onLeftBlockChecked(s, 2, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 0, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'a.xlsx' },
    { index: 1, fileName: 'b.xlsx' },
    { index: 2, fileName: 'c.xlsx' }
  ];
  const checkedOrder = [{ merchantId: 'ACC003', currency: 'USD', key: 'ACC003@@USD' }];

  const result = buildFinalAssignments(s, currentFileRows, checkedOrder);
  assert.strictEqual(result.length, 3);
  // 验证升序
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i].rowIndex > result[i - 1].rowIndex,
      `rowIndex[${i}]=${result[i].rowIndex} should > rowIndex[${i - 1}]=${result[i - 1].rowIndex}`);
  }
});

// ===== 互斥（AC2-10）=====

runTest('T-21 multiMode=true 时 rememberMode 应 disabled', () => {
  const s = createState(); // multiMode = true by default
  const result = syncMultiModeMutualDisabled(s, false, 'fixed');
  assert.strictEqual(result.rememberDisabled, true, 'rememberMode should be disabled when multiMode=true');
  assert.strictEqual(result.multiModeDisabled, false);
});

runTest('T-22 multiMode=false 时 rememberMode 恢复 enabled（fixed 模式）', () => {
  const s = createState();
  toggleMultiMode(s, false); // multiMode = false
  const result = syncMultiModeMutualDisabled(s, false, 'fixed');
  assert.strictEqual(result.rememberDisabled, false, 'rememberMode should be enabled when multiMode=false and fixed');
  assert.strictEqual(result.multiModeDisabled, false);
});

// ===== 边界/异常 =====

runTest('T-23 26 个 block 映射到 26 个不同账号 -> 字母 a~z', () => {
  const s = createState();
  const accounts = [];
  for (let i = 0; i < 26; i++) {
    const acc = { merchantId: `ACC${String(i).padStart(3, '0')}`, currency: 'CNY' };
    accounts.push(acc);
    onLeftBlockChecked(s, i, true);
    onRightAccountChecked(s, acc, true);
    closeCurrentGroup(s);
  }
  assert.strictEqual(s.multiGroups.length, 26);
  const alphas = computeAlphaIndex(s, accounts);
  for (let i = 0; i < 26; i++) {
    const key = `ACC${String(i).padStart(3, '0')}@@CNY`;
    const expected = String.fromCharCode(97 + i);
    assert.strictEqual(alphas.get(key), expected, `group ${i} should be '${expected}'`);
  }
});

runTest('T-24 空 currentFileRows + buildFinalAssignments -> 返回空数组', () => {
  const s = createState();
  s.multiEditing = false;
  const result = buildFinalAssignments(s, [], []);
  assert.strictEqual(result.length, 0);
});

runTest('T-25 不连续 rowIndex(0,5,12) 仍能正确归组', () => {
  const s = createState();
  onLeftBlockChecked(s, 0, true);
  onLeftBlockChecked(s, 12, true);
  onRightAccountChecked(s, ACCOUNT_A, true);
  closeCurrentGroup(s);
  onLeftBlockChecked(s, 5, true);
  onRightAccountChecked(s, ACCOUNT_B, true);
  closeCurrentGroup(s);
  s.multiEditing = false;

  const currentFileRows = [
    { index: 0, fileName: 'a.xlsx' },
    { index: 5, fileName: 'b.xlsx' },
    { index: 12, fileName: 'c.xlsx' }
  ];

  const result = buildFinalAssignments(s, currentFileRows, []);
  assert.strictEqual(result.length, 3);
  // 按 rowIndex 升序
  assert.strictEqual(result[0].rowIndex, 0);
  assert.strictEqual(result[0].merchantId, 'ACC001');
  assert.strictEqual(result[1].rowIndex, 5);
  assert.strictEqual(result[1].merchantId, 'ACC002');
  assert.strictEqual(result[2].rowIndex, 12);
  assert.strictEqual(result[2].merchantId, 'ACC001'); // block[0] 和 block[12] 在同一组
});

// ============================================================
// 输出结果
// ============================================================

console.log('');
console.log('v1.5.2 状态机单测');
console.log('==================');
results.forEach((r) => {
  if (r.pass) {
    console.log(`${r.name} \u2713`);
  } else {
    console.log(`${r.name} \u2717`);
    console.log(`  expected: ${r.error.expected !== undefined ? JSON.stringify(r.error.expected) : '(see message)'}`);
    console.log(`  actual:   ${r.error.actual !== undefined ? JSON.stringify(r.error.actual) : '(see message)'}`);
    console.log(`  message:  ${r.error.message}`);
  }
});
console.log('');
console.log(`${passCount}/${passCount + failCount} passed`);
if (failCount > 0) {
  process.exit(1);
}
