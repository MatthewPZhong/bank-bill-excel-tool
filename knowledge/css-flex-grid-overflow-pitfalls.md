# CSS Flex/Grid 嵌套穿透 max-height 的两个必修条线

> v2.1.7 round 4-6 经验沉淀（共 6 个 commit 才彻底修好"大账号确认 dialog ≥20 文件场景滚动条不出现"问题）
>
> 关联 PR：v2.1.7 PR；spec §11.3.1-§11.3.8；rules/important-variables.md 不入表（CSS 工程实践，不是业务变量）

## 一句话总结

**flex / grid 嵌套布局里，子项要在父级 `max-height` 约束下出现 `overflow: auto` 滚动条，必须同时修两条线**：

1. **每层 flex/grid item 显式设 `min-height: 0`** — 破除默认 `min-height: auto = content size` 让子项允许收缩
2. **grid 父容器显式设 `grid-template-rows: 1fr`（或 `100%`）** — 让 grid row 等于父高度而不是 content size

**缺任一条都会让 `overflow: auto` 永不触发**（`scrollHeight === clientHeight`）。

## v2.1.7 真实案例：大账号 multi-mode dialog ≥20 文件滚动

### 完整高度链（4 层 flex/grid 嵌套）

```
.modal-card (display: flex column; max-height: calc(100vh - 56px); overflow: hidden)
└── .big-account-selection-card.big-account-selection-split (modal-card 的 flex item)
    │
    ├── .dialog-header (flex item, ~80px)
    │
    └── .big-account-split-body (flex item: flex:1; overflow:hidden)
        ⚠️ 层 1（flex item, modal-card 的子）
        │
        └── .ba-scroll-container (display: grid; grid-template-columns: 1fr 1fr; max-height: 52vh; min-height: 360px)
            ⚠️ 层 4（grid 父容器自己）
            │
            ├── .big-account-split-left (grid item: display:flex column; overflow:hidden)
            │   ⚠️ 层 2（grid item, ba-scroll-container 的子）
            │   │
            │   ├── .big-account-split-header (40px fixed)
            │   │
            │   └── .big-account-file-list (flex item: flex:1; overflow-y:auto)
            │       ⚠️ 层 3（flex item, split-left 的子）
            │
            └── .big-account-split-right（同上）
```

### Dev round 历程（6 个 commit）

| Round | Commit | 改动 | 用户实测结果 |
|---|---|---|---|
| round 3 | a94792e | `.big-account-file-list/order-list` 加 `scrollbar-width: thin + ::-webkit-scrollbar` 强制可见 | ❌ 仍不能滚 |
| round 4 | fb88040 | 层 2 `.big-account-split-left/right` 加 `min-height: 0` | ❌ 仍不能滚 |
| round 5 | 3f72cfc | 层 3 `.big-account-file-list/order-list` 加 `min-height: 0` + 层 1 `.big-account-split-body` 防御性加 | ❌ 仍不能滚 |
| **round 6** | **a9cb2ad** | **层 4 `.ba-scroll-container` 加 `grid-template-rows: 1fr`** | **✓ 滚动正常** |

### round 6 DevTools 揭示真根因（用户 viewport 860px）

```
splitLeft_h:           5952px  ❌ 是父 447 的 13 倍
scrollContainer_h:     447px   ✓ max-height: 52vh 生效
fileList_client:       5911
fileList_scroll:       5911    ❌ = client，overflow 永不触发

computed_fileList_minH:        "0px"   ✓ round 5 生效
computed_splitLeft_minH:       "0px"   ✓ round 4 生效
computed_splitBody_minH:       "0px"   ✓ round 5 生效
computed_scrollContainer_maxH: "447.2px" ✓ 生效
```

**关键发现**：所有 round 4/5 加的 `min-height: 0` 都 computed 生效（条线 1 完整），但 splitLeft_h = 5952px 仍远超父 447。原因是**条线 2 缺失** — `.ba-scroll-container` 没设 `grid-template-rows`，默认 `grid-auto-rows: auto = content size`，grid row 跟随 splitLeft content 5952，grid item 跟随 row。

## 排查/修复 SOP

遇到 "max-height 设了但 overflow: auto 不触发 / scrollHeight = clientHeight" 时，按顺序检查：

### Step 1 — 用 DevTools 取 4 个值

```js
// 选最内层 overflow:auto 元素
const el = $0;
console.log({
  client: el.clientHeight,
  scroll: el.scrollHeight,
  parent_h: el.parentElement.clientHeight,
  parent_maxH: getComputedStyle(el.parentElement).maxHeight,
});
// 一路向上每一层都看 clientHeight + computed min-height
```

### Step 2 — 检查条线 1（每层 min-height: 0）

从最内层 overflow:auto 元素一路往上，**每层 flex/grid item 都看 computed min-height**：
- `min-height: auto`（默认）→ ⚠️ 需显式改 `min-height: 0`
- `min-height: 0px` → ✓ 这一层 OK

### Step 3 — 检查条线 2（grid 父容器 grid-template-rows）

如果链路中有 `display: grid` 父容器（不是只 flex），**看它有没有显式 `grid-template-rows`**：
- 没设 → ⚠️ 默认 `grid-auto-rows: auto = content size`，grid item 会撑出 max-height
- 设了 `grid-template-rows: 1fr` 或 `100%` 或具体高度 → ✓ OK

### Step 4 — 修齐后再实测

修完两条线后**必须用 DevTools 实测**，不要靠"理论上应该好"。round 4/5 PM 推断"min-height: 0 修齐三层就好"两次都错；round 6 用 DevTools 才发现条线 2 缺失。

## 反面教材：PM round 5 推断错的地方

PM 在 round 5 spec §11.3.2 推断 "每层 flex/grid item 都需要显式 min-height: 0，content size 才不会从最内层一路撑过所有父级约束"。**这句话单独是对的**，但**不完整**：

- 对 flex 嵌套链 → 完整（min-height: 0 + flex: 1 + overflow 链就够）
- 对 grid 父容器 → **不够** — grid 还要管 `grid-template-rows` 让 row 不跑 content size

**round 6 教训**：spec 阶段如果父容器是 `display: grid`，**必须显式检查 `grid-template-rows`**，不能只看 `min-height: 0` 链。

## 双写 src + Clear 范式

bank-bill-excel-tool 项目的 CSS 双路径范式：
- `src/styles-gemini-extra.css` — active CSS（index.html cssClearExtra）
- `Clear/styles-gemini-extra.css` — 设计稿同步副本

任何修 `src/styles-gemini-extra.css` 的改动都要**双写**到 `Clear/styles-gemini-extra.css`（commit 6b64690 / fb88040 / 3f72cfc / a9cb2ad 等 round 4-6 改动都遵循）。

> 提示：`src/styles.css` 在 index.html `cssGeneral` 是 `disabled` 状态，**不生效**；改 styles.css 是无效改动（spec 起草早期多次误指路，T14 收口已修正）。

## 参考

- v2.1.7 PR：B4 round 3-6 共 4 个 commit（a94792e / fb88040 / 3f72cfc / a9cb2ad）
- spec §11.3.1-§11.3.8（完整高度链 + round 6 DevTools 数据）
- MDN: [Auto-minimum size of Flex Items](https://www.w3.org/TR/css-flexbox-1/#min-size-auto)
- MDN: [Grid Layout - Grid Implicit Tracks](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Grid_Layout/Auto-placement_in_CSS_Grid_Layout)
