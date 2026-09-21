(function installScenarioDialogs(global) {
  'use strict';
  function createScenarioDialogs({ scenarioCommands, subscriptions, appConstants, modalBridge, ui }) {
    let scenarioDraft = null;
    let managerOverlay = null;
    const reads = new WeakMap();
    function beginRead(overlay, kind) {
      const versions = reads.get(overlay) || new Map();
      reads.set(overlay, versions);
      const version = (versions.get(kind) || 0) + 1;
      versions.set(kind, version);
      return () => versions.get(kind) === version && modalBridge.host.getHandle(overlay)?.isOpen();
    }
    function openScenarioView(factory) {
      const manager = managerOverlay && modalBridge.host.getHandle(managerOverlay);
      const top = modalBridge.host.getTop();
      if (!manager?.isOpen()) return openModal(factory);
      return top === manager ? pushModal(manager, factory) : replaceModal(top, factory);
    }
    function returnToScenarioManager(source) {
      if (!modalBridge.host.getHandle(source)?.isOpen()) return { status: 'stale' };
      if (!managerOverlay || !modalBridge.host.getHandle(managerOverlay)?.isOpen()) return closeModal(source);
      return returnToModal(managerOverlay);
    }
    function subscribeView(overlay, channelRefresh, scenarioRefresh) {
      registerModal(overlay, { onMount(handle, scope) {
        if (channelRefresh) scope.onDispose(subscriptions.subscribeChannels((event) => { if (handle.isOpen()) channelRefresh(event); }));
        if (scenarioRefresh) scope.onDispose(subscriptions.subscribeScenarios((event) => { if (handle.isOpen()) scenarioRefresh(event); }));
      } });
    }
    let activeScenarioListFilter = null;
    let activeScenarioChannelId = 1;
    const { createOverlay, createAlertDialog, createConfirmDialog, escapeHtml, pushAlert } = ui;
    const { openModal, closeModal, pushModal, replaceModal, registerModal, returnToModal } = modalBridge;
    // v2.0.0-beta.3 PR #32b：银行对账单处理模块字段常量（preload 暴露 → window.appConstants → deps）
    const BANK_STATEMENT_FIELDS = (appConstants && appConstants.bankStatementFields) || [];
    const BANK_STATEMENT_FIELDS_FOR_C3 = (appConstants && appConstants.bankStatementFieldsForC3) || BANK_STATEMENT_FIELDS;
    // v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废）：C3「网关账单字段」枚举改异步加载。
    //   旧实现取同步常量 appConstants.gatewayReconFields（preload inline 副本）；W1 起改为经
    //   IPC scenarios:gateway-recon-headers 从 main 读 assets/网关对账单.xlsx 表头行，缓存于
    //   gatewayReconHeadersValues。C3 弹窗渲染/校验改调 getGatewayReconFields() 读缓存（见 ensureGatewayReconHeaders）。
    let gatewayReconHeadersValues = [];
    // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块字段常量（spec §四，business 子模式）
    const BUSINESS_BILL_FIELDS = (appConstants && appConstants.businessBillFields) || [];
    const OPPONENT_BILL_FIELDS = (appConstants && appConstants.opponentBillFields) || [];
    // v2.1.0-beta.3 T7：网关对账单 ReconID 修复模块字段常量（gateway 子模式）
    const GATEWAY_BILL_FIELDS = (appConstants && appConstants.gatewayBillFields) || [];
    const CHANNEL_BILL_FIELDS = (appConstants && appConstants.channelBillFields) || [];
    const parsePaymentBigAccounts = window.__paymentBigAccounts
      && window.__paymentBigAccounts.parsePaymentBigAccounts;

    // 条件操作枚举（C1 行 3 + C2 行 3 共用）
    const SCENARIO_CONDITION_OPS = ['等于', '不等于', '包含', '不包含', '空值', '非空值', '开头为'];
    const C2_RECON_OPS = ['等于', '包含'];

    // 操作 op 是否需要值输入框（'空值' / '非空值' 不需要）
    function opNeedsValue(op) {
      return op !== '空值' && op !== '非空值';
    }

    // 给 select 渲染 options（用文件已有的 escapeHtml）
    function renderScenarioOptions(values, selected = '') {
      const sel = String(selected ?? '');
      return values
        .map((v) => {
          const s = String(v);
          const safe = escapeHtml(s);
          return `<option value="${safe}"${s === sel ? ' selected' : ''}>${safe}</option>`;
        })
        .join('');
    }

    // v2.1.11 T3（spec §4.5 / 决策 D-T3-2-src=xlsx / strict=a）：FundType 字段值枚举
    //   - 经 IPC scenarios:fund-type-enum 从 main 进程读 assets/FundType枚举值.xlsx（preload 无法 require 自定义模块）
    //   - 模块级缓存：首次加载后复用，避免每次打开 C2 弹窗重复 IPC
    //   - 状态：'unloaded'（未拉取）/ 'loading'（拉取中）/ 'ready'（成功，含降级空数组）
    //   - 降级：values 为空数组（文件缺失 / 读取失败）→ renderer 回退文本输入 + 一次性提示
    let fundTypeEnumValues = [];
    let fundTypeEnumState = 'unloaded';
    let fundTypeEnumPromise = null;
    let fundTypeEnumDowngradeNotified = false; // 一次性降级提示去重

    // 拉取 FundType 枚举（带缓存）。返回 Promise<string[]>（resolve 后 fundTypeEnumValues 已就绪）。
    //   - 已 ready → 直接 resolve 缓存
    //   - loading 中 → 复用同一 Promise（去抖）
    //   - 失败 → 降级为空数组（不 reject，保证调用方 .then 链不断）
    function ensureFundTypeEnum() {
      if (fundTypeEnumState === 'ready') return Promise.resolve(fundTypeEnumValues);
      if (fundTypeEnumState === 'loading' && fundTypeEnumPromise) return fundTypeEnumPromise;
      fundTypeEnumState = 'loading';
      const api = scenarioCommands && scenarioCommands.scenarios && scenarioCommands.scenarios.getFundTypeEnum;
      if (typeof api !== 'function') {
        // 旧 preload / preview 兜底：无该 IPC → 直接降级
        fundTypeEnumValues = [];
        fundTypeEnumState = 'ready';
        return Promise.resolve(fundTypeEnumValues);
      }
      fundTypeEnumPromise = Promise.resolve()
        .then(() => api())
        .then((result) => {
          fundTypeEnumValues = result && Array.isArray(result.values) ? result.values : [];
          fundTypeEnumState = 'ready';
          return fundTypeEnumValues;
        })
        .catch(() => {
          // IPC 异常 → 降级空数组（不抛，调用方据空数组回退文本输入）
          fundTypeEnumValues = [];
          fundTypeEnumState = 'ready';
          return fundTypeEnumValues;
        });
      return fundTypeEnumPromise;
    }

    // 判断某字段是否应渲染为 FundType 枚举下拉（field==='FundType' 且枚举非空）
    function shouldUseFundTypeDropdown(fieldName) {
      return fieldName === 'FundType' && fundTypeEnumState === 'ready' && fundTypeEnumValues.length > 0;
    }

    // FundType 字段枚举是否处于「降级」态（已尝试加载但为空数组 → 文件缺失/读取失败）
    function isFundTypeEnumDowngraded() {
      return fundTypeEnumState === 'ready' && fundTypeEnumValues.length === 0;
    }

    // FundType 枚举降级时是否需要在弹窗内显示一次性提示（同一次会话只提示一次）
    //   返回 true 仅一次（首次命中后置位 fundTypeEnumDowngradeNotified）
    function shouldShowFundTypeDowngradeHint() {
      if (fundTypeEnumDowngradeNotified) return false;
      if (!isFundTypeEnumDowngraded()) return false;
      fundTypeEnumDowngradeNotified = true;
      return true;
    }

    // 渲染单个「值」控件：FundType 字段且枚举就绪 → 严格下拉（仅枚举值）；否则文本输入
    //   - dataAttr：控件 data 属性串（如 'data-multi-field="value"' / 'data-mark-field="value"'）
    //   - fieldName：当前行选中的字段名（决定 FundType 下拉与否）
    //   - currentValue：当前值
    //   - hidden：op 为 空值/非空值 时隐藏值控件（visibility:hidden 占位，保留布局）
    //   strict（D-T3-2-strict=a）：下拉首项为空选项，用户必须从枚举中选；不混入自由文本
    function renderScenarioValueControl(dataAttr, fieldName, currentValue, { isReadonly = false, hidden = false, allowCustom = false, customMode = false, extraClass = '' } = {}) {
      const hiddenStyle = hidden ? ' style="visibility:hidden"' : '';
      const disabled = isReadonly ? 'disabled' : '';
      const clsSuffix = extraClass ? ` ${extraClass}` : '';
      // v2.1.14 第3条：markValue 赋值区「自己输入」模式 → 直接渲染输入框（用户已从下拉选「自己输入」）
      if (customMode) {
        return `<input class="scenario-config-input${clsSuffix}" type="text" ${dataAttr} ${disabled} value="${escapeHtml(currentValue || '')}" placeholder="自己输入值"${hiddenStyle}>`;
      }
      if (shouldUseFundTypeDropdown(fieldName)) {
        // 严格枚举下拉：空选项 + 枚举值。
        // I5（v2.1.11 SR-FIX Round 1）：currentValue 非空且不在枚举内（如枚举表更新后旧配置值失效）→
        //   额外渲染一个 selected 的「旧值（不在枚举）」option，保留并显示旧值。
        //   旧实现此时下拉回落到空选项 → 显示与 model 背离（model 仍留旧值）→ 用户误判未配置 / 误选覆盖旧值。
        const cur = currentValue == null ? '' : String(currentValue);
        const inEnum = fundTypeEnumValues.some((v) => String(v) === cur);
        const staleOption = (cur !== '' && !inEnum)
          ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}（不在枚举）</option>`
          : '';
        // v2.1.14 第3条：allowCustom（仅 markValue 赋值区）→ 枚举末尾加「自己输入」
        const customOption = allowCustom ? '<option value="__CUSTOM_INPUT__">自己输入</option>' : '';
        return `<select class="scenario-config-input${clsSuffix}" ${dataAttr} ${disabled}${hiddenStyle}>
          <option value="">请选择 FundType</option>
          ${staleOption}
          ${renderScenarioOptions(fundTypeEnumValues, currentValue)}
          ${customOption}
        </select>`;
      }
      return `<input class="scenario-config-input${clsSuffix}" type="text" ${dataAttr} ${disabled} value="${escapeHtml(currentValue || '')}" placeholder="值"${hiddenStyle}>`;
    }

    // v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废）：C3「网关账单字段」枚举（异步加载）
    //   - 经 IPC scenarios:gateway-recon-headers 从 main 进程读 assets/网关对账单.xlsx 表头行（preload 无法 require 自定义模块）
    //   - 模块级缓存：首次加载后复用，避免每次打开 C3 弹窗重复 IPC
    //   - 状态：'unloaded'（未拉取）/ 'loading'（拉取中）/ 'ready'（成功，main 端已 fallback，正常非空）
    //   - main 端 loader 在文件缺失/读取失败时已 fallback 到旧硬编码 GATEWAY_RECON_FIELDS，故 renderer 正常拿到可用枚举；
    //     仅当 IPC 本身不可用（旧 preload / preview 兜底）才得空数组。
    let gatewayReconHeadersState = 'unloaded';
    let gatewayReconHeadersPromise = null;

    // 拉取网关账单表头枚举（带缓存）。返回 Promise<string[]>（resolve 后 gatewayReconHeadersValues 已就绪）。
    //   - 已 ready → 直接 resolve 缓存
    //   - loading 中 → 复用同一 Promise（去抖）
    //   - 失败 → 降级为空数组（不 reject，保证调用方 .then 链不断）
    function ensureGatewayReconHeaders() {
      if (gatewayReconHeadersState === 'ready') return Promise.resolve(gatewayReconHeadersValues);
      if (gatewayReconHeadersState === 'loading' && gatewayReconHeadersPromise) return gatewayReconHeadersPromise;
      gatewayReconHeadersState = 'loading';
      const api = scenarioCommands && scenarioCommands.scenarios && scenarioCommands.scenarios.getGatewayReconHeaders;
      if (typeof api !== 'function') {
        // 旧 preload / preview 兜底：无该 IPC → 直接降级空数组
        gatewayReconHeadersValues = [];
        gatewayReconHeadersState = 'ready';
        return Promise.resolve(gatewayReconHeadersValues);
      }
      gatewayReconHeadersPromise = Promise.resolve()
        .then(() => api())
        .then((result) => {
          const values = result && Array.isArray(result.values) ? result.values : [];
          // 🔴 资金红线双保险：renderer 端再剔除 __CUSTOM__ sentinel（main loader 已剔除，此处兜底防回流）
          gatewayReconHeadersValues = values.filter((v) => String(v) !== '__CUSTOM__');
          gatewayReconHeadersState = 'ready';
          return gatewayReconHeadersValues;
        })
        .catch(() => {
          // IPC 异常 → 降级空数组（不抛，调用方据空数组渲染空下拉）
          gatewayReconHeadersValues = [];
          gatewayReconHeadersState = 'ready';
          return gatewayReconHeadersValues;
        });
      return gatewayReconHeadersPromise;
    }

    // C3 弹窗渲染/校验统一读当前缓存（首帧可能为空 → 弹窗 ensureGatewayReconHeaders().then 后重渲染填充）
    function getGatewayReconFields() {
      return gatewayReconHeadersValues;
    }

    function clearScenarioDraft() {
      scenarioDraft = null;
    }

    // 把 mode 转换为弹窗右下按钮配置
    // create / edit → "取消 / 确认"；view → "返回"
    function getScenarioDialogActions(mode) {
      if (mode === 'view') {
        return [{ kind: 'secondary', action: 'back', text: '返回' }];
      }
      // v2.1.0-beta.2 PR-B（task B6）：[确认 取消] 顺序（互换），4 个 scenario config dialog 都受影响
      return [
        { kind: 'primary', action: 'confirm', text: '确认' },
        { kind: 'secondary', action: 'cancel', text: '取消' }
      ];
    }

    // v2.1.0-beta.3 T6：对账单ReconID修复模块下挂 business（单据）+ gateway（网关）两个子模式 helper
    //   两个 category 共用 C4 dialog 骨架（matchRules/billTypes/reconGroups/output schema 相同）；
    //   仅文案/枚举/SubBizType 显隐/输出列等"表层"按 mode 切换（详见 T7）。
    const RECON_ID_FIX_CATEGORIES = ['recon-id-fix', 'gateway-recon-id-fix'];
    function isReconIdFixCategory(category) {
      return RECON_ID_FIX_CATEGORIES.includes(category);
    }
    function reconIdFixModeFromCategory(category) {
      // 'recon-id-fix' → 'business'（v2.1.0-beta.1 已有单据子模式）
      // 'gateway-recon-id-fix' → 'gateway'（v2.1.0-beta.3 新增网关子模式）
      return category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
    }

    // 4 个 dialog 配置弹窗 + 确认详情弹窗共用：根据 category 进入对应配置弹窗
    function openScenarioConfigByCategory(category) {
      if (category === 'extract-recon-id') return openScenarioView(() => createScenarioConfigDialogC1());
      if (category === 'offset-bill-mark') return openScenarioView(() => createScenarioConfigDialogC2());
      if (category === 'gateway-recon-join') return openScenarioView(() => createScenarioConfigDialogC3());
      // v2.1.0-beta.1 PR-A（task A6 / A7）：C4 类配置弹窗（单据子模式）
      // v2.1.0-beta.3 T6/T7：两个 ReconID 子模式（business/gateway）共用 createScenarioConfigDialogC4；
      //   dialog 内部从 scenarioDraft.category 推导 subMode（business/gateway），不依赖参数
      if (isReconIdFixCategory(category)) {
        return openScenarioView(() => createScenarioConfigDialogC4());
      }
      throw new Error(`unknown scenario category: ${category}`);
    }

    // 同步修改：main 侧的另一份实现位于 src/backend/file-service/normalizers.js 内
    // REGEX_LITERAL_PATTERN / isRegexLiteral / compileRegexLiteral / matchAmountSplitConditionValue。
    // 两份必须保持行为一致。按团队约定不引入 src/shared/ 公共模块。
    const REGEX_LITERAL_PATTERN_RENDERER = /^\/(.+)\/([gimsu]*)$/;

    function looksLikeRegexLiteral(input) {
      if (typeof input !== 'string') {
        return false;
      }
      return REGEX_LITERAL_PATTERN_RENDERER.test(input);
    }

    function parseRegexLiteral(input) {
      const match = REGEX_LITERAL_PATTERN_RENDERER.exec(String(input || ''));
      if (!match) {
        return null;
      }
      try {
        return new RegExp(match[1], match[2]);
      } catch (_error) {
        return null;
      }
    }


    const SCENARIO_CATEGORY_LABELS = {
      'extract-recon-id': '提取ReconId-From Self',
      // v2.1.13 B3：'银行对账单字段赋值' → '银行对账单赋值自身'（DB category 不变）
      'offset-bill-mark': '银行对账单赋值自身',
      // v2.1.13 B2：'提取ReconId-From 网关' → '网关对账单赋值银行对账单'（DB category 不变）
      'gateway-recon-join': '网关对账单赋值银行对账单',
      // v2.1.0-beta.1 PR-A（task A6）：单据对账修复
      // v2.1.0-beta.3 修订（用户反馈）：'单据对账修复' → '单据对账单修复'
      'recon-id-fix': '单据对账单修复',
      // v2.1.0-beta.3 T7：网关对账修复（C4 gateway 子模式）
      // v2.1.0-beta.3 修订（用户反馈）：'网关对账修复' → '网关对账单修复'
      'gateway-recon-id-fix': '网关对账单修复',
      // v2.1.13 D-4：自带写死场景在列表「功能类别」列显示文本（仅文本，与 offset-bill-mark 改名后一致）
      'builtin-fixed': '银行对账单赋值自身'
    };

    function getCategoryLabel(category) {
      return SCENARIO_CATEGORY_LABELS[category] || category;
    }

    // v2.1.16 需求1：builtin-fixed 自带写死场景「功能类别」列按 config.funcCategory 映射业务分组显示。
    //   T10 落地的 RECON_ROUND_BUILTIN_SCENARIOS（migrations.js）config 含 funcCategory：
    //     - 'fund-nature-check'      → 资金性质校验
    //     - 'platform-order'         → 中台订单数据处理（旧称「中台订单校验」更名后的值）
    //     - 'dbs-charge-fund-check'  → 资金性质校验（v3.0.6 用户反馈：DBS-Charge 与原 charge-outbound 同类，
    //                                  均为改 FundType 的资金校验；funcCategory 为编排器 R3.5 分桶键不可改，仅补 UI 标签）
    //   无 funcCategory 的既有 builtin-fixed 场景（如「从银行对账单提取调拨订单对账ID」）
    //   不在此表 → 回退 getCategoryLabel(category)（= '银行对账单赋值自身'），保证既有显示不回归。
    const FUNC_CATEGORY_LABELS = {
      'fund-nature-check': '资金性质校验',
      'platform-order': '中台订单数据处理',
      'dbs-charge-fund-check': '资金性质校验'
    };

    // builtin-fixed 行「功能类别」取值：优先 config.funcCategory 映射，映射不到回退既有 category 标签。
    function getScenarioCategoryDisplay(scenario) {
      const funcCategory = scenario && scenario.config && scenario.config.funcCategory;
      if (funcCategory && FUNC_CATEGORY_LABELS[funcCategory]) {
        return FUNC_CATEGORY_LABELS[funcCategory];
      }
      return getCategoryLabel(scenario ? scenario.category : '');
    }

    function hasFundTransferReservedSignatureUi(scenario) {
      const config = scenario && scenario.config;
      return Boolean(
        scenario
        && scenario.category === 'builtin-fixed'
        && config
        && typeof config === 'object'
        && !Array.isArray(config)
        && config.funcCategory === 'platform-order'
        && config.subCategory === 'fund-transfer-backfill'
      );
    }

    function isCanonicalFundTransferOwnerUi(scenario) {
      return hasFundTransferReservedSignatureUi(scenario)
        && scenario.isBuiltin === true;
    }

    async function loadScenariosOrAlert(overlay) {
      const result = await scenarioCommands.scenarios.list();
      if (result && result.status === 'ok') {
        return Array.isArray(result.scenarios) ? result.scenarios : [];
      }
      pushAlert(overlay, () => createAlertDialog(`加载场景列表失败：${result?.message || '未知错误'}`));
      return null;
    }

    // v2.1.9 N5：银行渠道管理弹框 factory（spec §4.2）
    //   表头：名称 / 开户地 / 执行操作
    //   表体行：[完成/修改] [删除]；「通用」(is_builtin=1) 行 input disabled + 删除按钮 disabled + tooltip
    //   表尾「新增」行复用 createAccountMappingDialog 范式（行 5228 createAddRow）
    //   onClose 回调由调用方传（场景管理 dialog 调用时关闭 → reopen scenarios manager）
    function createChannelManagerDialog({ onClose } = {}) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card channels-manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">银行渠道管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table channels-table">
            <thead>
              <tr>
                <th style="width: 40%; text-align: left;">名称</th>
                <th style="width: 30%; text-align: left;">开户地</th>
                <th class="manager-action-header" style="width: 30%;"><span class="manager-action-header-label">执行操作</span></th>
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

      function closeAndCallback() {
        closeModal();
        if (typeof onClose === 'function') onClose();
      }

      // 渲染查看态行（已落库 + 非编辑中）
      function createReadOnlyRow(channel) {
        const tr = document.createElement('tr');
        tr.dataset.channelId = String(channel.id);
        // v2.1.9 N5 T15：「通用」(is_builtin=1) UI 保护
        //   builtin 行：名称/开户地 input disabled；操作列只渲提示文案不渲按钮
        //   非 builtin 行：渲 [修改] [删除]
        tr.dataset.builtin = channel.isBuiltin ? '1' : '0';

        const nameTd = document.createElement('td');
        const locationTd = document.createElement('td');
        const actionTd = document.createElement('td');
        actionTd.className = 'channels-action-cell';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = channel.name;
        const locationSpan = document.createElement('span');
        locationSpan.textContent = channel.ownerLocation;

        const nameInput = document.createElement('input');
        nameInput.className = 'mapping-text-input';
        nameInput.type = 'text';
        nameInput.spellcheck = false;
        nameInput.value = channel.name;
        nameInput.style.display = 'none';

        const locationInput = document.createElement('input');
        locationInput.className = 'mapping-text-input';
        locationInput.type = 'text';
        locationInput.spellcheck = false;
        locationInput.value = channel.ownerLocation;
        locationInput.style.display = 'none';

        nameTd.append(nameSpan, nameInput);
        locationTd.append(locationSpan, locationInput);

        if (channel.isBuiltin) {
          // 内置「通用」：input disabled + 操作列 placeholder
          nameInput.disabled = true;
          locationInput.disabled = true;
          const placeholder = document.createElement('span');
          placeholder.className = 'channels-builtin-placeholder';
          placeholder.title = '系统内置渠道，不可修改 / 删除';
          placeholder.textContent = '（内置不可删）';
          actionTd.append(placeholder);
        } else {
          // 非 builtin：[修改] [删除]
          const editBtn = document.createElement('button');
          editBtn.className = 'text-action';
          editBtn.type = 'button';
          editBtn.textContent = '修改';

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'text-action danger-text';
          deleteBtn.type = 'button';
          deleteBtn.textContent = '删除';

          let isEditing = false;
          editBtn.addEventListener('click', async () => {
            if (!isEditing) {
              // 进入编辑态
              isEditing = true;
              nameSpan.style.display = 'none';
              locationSpan.style.display = 'none';
              nameInput.style.display = '';
              locationInput.style.display = '';
              editBtn.textContent = '完成';
            } else {
              // 提交修改
              const nextName = nameInput.value.trim();
              const nextLocation = locationInput.value.trim();
              if (!nextName) {
                pushAlert(overlay, () => createAlertDialog('渠道名称不能为空', { onConfirm: null }));
                return;
              }
              if (!nextLocation) {
                pushAlert(overlay, () => createAlertDialog('开户地不能为空', { onConfirm: null }));
                return;
              }
              const result = await scenarioCommands.channels.update(channel.id, {
                name: nextName,
                ownerLocation: nextLocation
              });
              if (!result || result.status !== 'ok') {
                pushAlert(overlay, () => createAlertDialog(`修改渠道失败：${result?.message || '未知错误'}`, {
                  onConfirm: null
                }));
                return;
              }

            }
          });

          deleteBtn.addEventListener('click', () => {
            pushModal(overlay, () => createConfirmDialog({
              message: `确认删除渠道「${channel.name}-${channel.ownerLocation}」？此操作不可撤销。`,
              confirmText: '删除',
              cancelText: '取消',
              onConfirm: async () => {
                const result = await scenarioCommands.channels.deleteOne(channel.id);
                if (!result || result.status !== 'ok') {
                  // 删除失败（如下属 scenarios > 0）→ 错误提示 + reopen 渠道管理
                  pushAlert(overlay, () => createAlertDialog(`删除渠道失败：${result?.message || '未知错误'}`, {
                    onConfirm: null
                  }));
                  return;
                }
                // 同一父层读取已删除的渠道列表，保留原表及滚动位置。
                returnToModal(overlay);

              }
            }));
          });

          actionTd.append(editBtn, deleteBtn);
        }

        tr.append(nameTd, locationTd, actionTd);
        return tr;
      }

      // 渲染新增态行（点击「新增」插入到表底「+ 新增」按钮之上；用户填名称+开户地后点「完成」落库）
      function createEditableNewRow() {
        const tr = document.createElement('tr');
        tr.dataset.newRow = '1';

        const nameTd = document.createElement('td');
        const locationTd = document.createElement('td');
        const actionTd = document.createElement('td');
        actionTd.className = 'channels-action-cell';

        const nameInput = document.createElement('input');
        nameInput.className = 'mapping-text-input';
        nameInput.type = 'text';
        nameInput.spellcheck = false;
        // 2026-05-27 fix1-N5-UI-2：去掉新增行 placeholder（之前是「例：工商」「例：上海」）

        const locationInput = document.createElement('input');
        locationInput.className = 'mapping-text-input';
        locationInput.type = 'text';
        locationInput.spellcheck = false;
        // 2026-05-27 fix1-N5-UI-2：去掉新增行 placeholder

        const doneBtn = document.createElement('button');
        doneBtn.className = 'text-action';
        doneBtn.type = 'button';
        doneBtn.textContent = '完成';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'text-action danger-text';
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';

        doneBtn.addEventListener('click', async () => {
          const name = nameInput.value.trim();
          const location = locationInput.value.trim();
          if (!name) {
            pushAlert(overlay, () => createAlertDialog('渠道名称不能为空', { onConfirm: null }));
            return;
          }
          if (!location) {
            pushAlert(overlay, () => createAlertDialog('开户地不能为空', { onConfirm: null }));
            return;
          }
          const result = await scenarioCommands.channels.create({ name, ownerLocation: location });
          if (!result || result.status !== 'ok') {
            pushAlert(overlay, () => createAlertDialog(`新增渠道失败：${result?.message || '未知错误'}`, {
              onConfirm: null
            }));
            return;
          }

        });

        cancelBtn.addEventListener('click', () => {
          tr.remove();
        });

        nameTd.append(nameInput);
        locationTd.append(locationInput);
        actionTd.append(doneBtn, cancelBtn);
        tr.append(nameTd, locationTd, actionTd);
        return tr;
      }

      // 复用 createAccountMappingDialog（行 5228 createAddRow）的「新增」行范式：
      //   表尾固定一行 [新增] 按钮（占满 td.colspan=3 视觉左对齐），点击 insertBefore 编辑行
      function createAddRow() {
        const tr = document.createElement('tr');
        tr.className = 'add-row';
        tr.innerHTML = `
          <td><button class="text-action" type="button" data-action="add">新增</button></td>
          <td></td>
          <td></td>
        `;
        tr.querySelector('[data-action="add"]').addEventListener('click', () => {
          tbody.insertBefore(createEditableNewRow(), tr);
        });
        return tr;
      }

      async function refreshTable() {
        const isCurrentRead = beginRead(overlay, 'refreshTable');
        let channels = [];
        try {
          const result = await scenarioCommands.channels.list();
        if (!isCurrentRead()) return;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          if (result && result.status === 'ok' && Array.isArray(result.channels)) {
            channels = result.channels;
          } else {
            pushAlert(overlay, () => createAlertDialog(`加载银行渠道列表失败：${result?.message || '未知错误'}`));
            return;
          }
        } catch (err) {
        if (!isCurrentRead()) return;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          pushAlert(overlay, () => createAlertDialog(`加载银行渠道列表异常：${err && err.message ? err.message : err}`));
          return;
        }
        tbody.innerHTML = '';
        // 2026-05-27 fix1-N5-UI-6.1：银行渠道管理页面跳过 is_builtin=1 行
        //   「通用」作为系统兜底渠道仍存在于 DB，但用户不应在管理界面看到 / 编辑 / 删除；
        //   DB 层 deleteChannel / updateChannel 已抛错（防御性，即使有 bug 让 UI 透出仍阻止落库）
        channels
          .filter((channel) => !channel.isBuiltin)
          .forEach((channel) => {
            tbody.appendChild(createReadOnlyRow(channel));
          });
        tbody.appendChild(createAddRow());
      }

      dialog.querySelector('.icon-close').addEventListener('click', closeAndCallback);
      dialog.querySelector('[data-action="done"]').addEventListener('click', closeAndCallback);

      subscribeView(overlay, refreshTable);
      registerModal(overlay, { onMount: () => refreshTable() });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.9 N7 Phase 7 T29：场景模板导出弹框 factory（spec §4.5 + §6）
    //   标题：「选择导出的银行渠道的模板」
    //   内容：多选 checklist（枚举 = channels 表全集，含「通用」）
    //   操作：「导出」按钮 → 调 scenarioCommands.scenarios.exportBundle(selectedChannelIds)
    //   main 端 saveDialog 让用户选路径 → 写入 JSON 文件 → 返回 status
    //
    // 资金红线（spec §10.2）：
    //   - 必须 ≥ 1 个渠道勾选才允许导出（前端 + main 端双校验）
    //   - main 端用 SUPPORTED_SCENARIO_BUNDLE_VERSION + scenarios-bundle-io 保证类型隔离
    function createExportScenarioBundleDialog({ onCompleted, onCancel } = {}) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card export-scenario-bundle-card';
      // 2026-05-27 fix1-N5-UI-5：
      //   5.1 多选下拉用项目内 .new-account-currency-option + .new-account-checkbox 范式
      //       checkbox 在左、文本在右（与"维护大账号"模块一致）
      //   5.2 删除"加载渠道列表中..."loading hint 文案，仅保留标题 + 多选区 + 按钮
      //       （加载异常仍弹 alert；列表为空时也用 alert 而非 inline hint）
      //   5.3 右下角按钮顺序：导出（左）+ 取消（右）
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">选择导出的银行渠道的模板</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body" style="padding: 16px 24px;">
          <div class="export-scenario-bundle-checklist" data-role="channel-checklist"></div>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="confirm-export">导出</button>
          <button class="secondary-btn small" type="button" data-action="cancel-export">取消</button>
        </div>
      `;

      const checklistContainer = dialog.querySelector('[data-role="channel-checklist"]');
      const exportBtn = dialog.querySelector('[data-action="confirm-export"]');
      const cancelBtn = dialog.querySelector('[data-action="cancel-export"]');
      exportBtn.disabled = true;

      function closeWithCancel() {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeWithCancel);
      // 2026-05-27 fix1-N5-UI-5.3：取消按钮 = 同 closeWithCancel（关弹框 + 回调）
      cancelBtn.addEventListener('click', closeWithCancel);

      let channelsLoaded = false;
      let exporting = false;
      async function refreshExportChannels() {
        const isCurrentRead = beginRead(overlay, 'channels');
        exportBtn.disabled = true;
        let channels = [];
        try {
          const result = await scenarioCommands.channels.list();
        if (!isCurrentRead()) return;
          if (result && result.status === 'ok' && Array.isArray(result.channels)) {
            channels = result.channels;
          } else {
            pushAlert(overlay, () => createAlertDialog(
              `加载银行渠道列表失败：${result?.message || '未知错误'}`,
              { onConfirm: closeWithCancel }
            ));
            return;
          }
        } catch (err) {
        if (!isCurrentRead()) return;
          pushAlert(overlay, () => createAlertDialog(
            `加载银行渠道列表异常：${err && err.message ? err.message : err}`,
            { onConfirm: closeWithCancel }
          ));
          return;
        }
        if (channels.length === 0) {
          pushAlert(overlay, () => createAlertDialog(
            '渠道列表为空，请先新建渠道再导出',
            { onConfirm: closeWithCancel }
          ));
          return;
        }
        // 2026-05-27 fix1-N5-UI-5.1：每行 <label class="new-account-currency-option">
        //   DOM 顺序：checkbox 在左 + text 在右（覆盖 .new-account-currency-option 默认的 space-between；
        //   配套 CSS .export-scenario-bundle-checklist 强制 justify-content: flex-start + gap）
        // 读取结算时再取当前勾选，保留请求在途时用户作出的选择。
        const selections = new Map(Array.from(checklistContainer.querySelectorAll('[data-channel-id]'), checkbox => [Number(checkbox.dataset.channelId), checkbox.checked]));
        checklistContainer.innerHTML = channels.map((c) => {
          const label = escapeHtml(c.label || `${c.name}-${c.ownerLocation}`);
          // 默认全选（用户体验：导出场景一般是完整复制，全选符合直觉；用户可去勾不需要的）
          return `
            <label class="new-account-currency-option">
              <input type="checkbox" class="new-account-checkbox" data-role="channel-checkbox" data-channel-id="${c.id}" ${(!channelsLoaded || !selections.has(Number(c.id)) || selections.get(Number(c.id))) ? 'checked' : ''} />
              <span class="new-account-currency-option-text">${label}</span>
            </label>
          `;
        }).join('');
        channelsLoaded = true;
        exportBtn.disabled = exporting;
      }
      subscribeView(overlay, refreshExportChannels);
      registerModal(overlay, { onMount: refreshExportChannels });

      exportBtn.addEventListener('click', async () => {
        if (exporting || !modalBridge.host.getHandle(overlay)?.isTop()) return;
        const checkedBoxes = checklistContainer.querySelectorAll('input[data-role="channel-checkbox"]:checked');
        const channelIds = Array.from(checkedBoxes).map((cb) => Number(cb.dataset.channelId)).filter((n) => Number.isFinite(n) && n > 0);
        if (channelIds.length === 0) {
          pushAlert(overlay, () => createAlertDialog('请至少勾选一个银行渠道再导出', {
            onConfirm: null
          }));
          return;
        }
        exporting = true;
        exportBtn.disabled = true;
        let result;
        try {
          result = await scenarioCommands.scenarios.exportBundle(channelIds);
        } catch (err) {
          exporting = false;
          exportBtn.disabled = false;
          pushAlert(overlay, () => createAlertDialog(
            `导出异常：${err && err.message ? err.message : err}`,
            { onConfirm: null }
          ));
          return;
        }
        exporting = false;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
        if (!result || result.status === 'cancelled') {
          // 用户取消 saveDialog → 不关弹框，让用户重选
          exportBtn.disabled = false;
          return;
        }
        if (result.status === 'failed') {
          exportBtn.disabled = false;
          pushAlert(overlay, () => createAlertDialog(
            `导出失败：${result.message || '未知错误'}`,
            { onConfirm: null }
          ));
          return;
        }
        // status='ok'

        pushAlert(overlay, () => createAlertDialog(
          `导出成功：<br/>文件：${escapeHtml(result.filePath || '')}<br/>渠道数：${result.exportedChannels || 0}<br/>场景数：${result.exportedScenarios || 0}`,
          { onConfirm: () => { if (typeof onCompleted === 'function') onCompleted(); } }
        ));
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.9 N5 Phase 5 T20 / T22：场景「转移到目标银行渠道」弹框 factory（spec §4.3）
    //   单条转移（T20）：opts.scenarioIds = [oneId]
    //   批量转移（T22）：opts.scenarioIds = [...allCheckedIds]
    //   currentChannelId：当前所在渠道（从下拉中排除，防止"转移到自己"）
    //   onCompleted：转移成功回调（关弹框 + 刷新场景管理）
    //   onCancel：用户点 ×/空白处取消的回调（回到场景管理 dialog）
    //
    // 资金红线（spec §10.1 转移搬运语义不可逆）：
    //   弹框文案明确含场景 id 数；用户点「完成」前可二次确认
    //   DB 层事务保护：失败抛错 → UI 弹错误 + 不关弹框（用户可改选目标重试）
    function createTransferScenariosDialog({ scenarioIds, currentChannelId, onCompleted, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card transfer-scenarios-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">请选择转移到的目标银行渠道</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body" style="padding: 16px 24px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="select-label" style="white-space: nowrap;">目标渠道</label>
            <!-- 2026-05-27 fix1-N5-UI-3：转移弹框下拉视觉同主面板"模式"下拉（.select-shell + .template-select） -->
            <div class="select-shell" style="flex: 1;">
              <select class="template-select" data-role="target-channel" style="min-width: 220px;"></select>
            </div>
          </div>
          <div data-role="loading-hint" style="margin-top: 8px; color: var(--muted); font-size: 12px;">加载渠道列表中...</div>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="confirm">完成</button>
        </div>
      `;

      const select = dialog.querySelector('[data-role="target-channel"]');
      const loadingHint = dialog.querySelector('[data-role="loading-hint"]');
      const confirmBtn = dialog.querySelector('[data-action="confirm"]');
      confirmBtn.disabled = true;

      function closeWithCancel() {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeWithCancel);

      async function refreshChannels() {
        const selected = select.value;
        const isCurrentRead = beginRead(overlay, 'channels');
        let channels = [];
        try {
          const result = await scenarioCommands.channels.list();
        if (!isCurrentRead()) return;
          if (result && result.status === 'ok' && Array.isArray(result.channels)) {
            channels = result.channels;
          } else {
            pushAlert(overlay, () => createAlertDialog(
              `加载银行渠道列表失败：${result?.message || '未知错误'}`,
              { onConfirm: () => { if (typeof onCancel === 'function') onCancel(); } }
            ));
            return;
          }
        } catch (err) {
        if (!isCurrentRead()) return;
          pushAlert(overlay, () => createAlertDialog(
            `加载银行渠道列表异常：${err && err.message ? err.message : err}`,
            { onConfirm: () => { if (typeof onCancel === 'function') onCancel(); } }
          ));
          return;
        }
        // 排除当前所在渠道（spec §4.3：不含当前所在渠道）
        const filtered = channels.filter((c) => Number(c.id) !== Number(currentChannelId));
        if (filtered.length === 0) {
          loadingHint.textContent = '没有可转移到的其他渠道，请先新建渠道';
          loadingHint.style.color = 'var(--danger)';
          return;
        }
        select.innerHTML = filtered.map((c) => {
          const label = escapeHtml(c.label || `${c.name}-${c.ownerLocation}`);
          return `<option value="${c.id}">${label}</option>`;
        }).join('');
        loadingHint.style.display = 'none';
        if (filtered.some(channel => String(channel.id) === selected)) select.value = selected;
        confirmBtn.disabled = false;
      }
      subscribeView(overlay, refreshChannels);
      registerModal(overlay, { onMount: refreshChannels });

      confirmBtn.addEventListener('click', async () => {
        const targetChannelId = Number(select.value);
        if (!Number.isFinite(targetChannelId) || targetChannelId <= 0) {
          pushAlert(overlay, () => createAlertDialog('请先选择目标渠道', {
            onConfirm: null
          }));
          return;
        }
        const result = await scenarioCommands.scenarios.transfer({ scenarioIds, targetChannelId });
        if (!result || result.status !== 'ok') {
          pushAlert(overlay, () => createAlertDialog(
            `转移失败：${result?.message || '未知错误'}`,
            { onConfirm: null }
          ));
          return;
        }
        closeModal();
        if (typeof onCompleted === 'function') onCompleted(targetChannelId, result.transferredCount);
      });

      overlay.appendChild(dialog);
      return overlay;
    }


    function createScenariosManagerDialog(allowedCategories = null) {
      // v2.1.0-beta.2 PR-A：白名单过滤（null = 不过滤，向后兼容）
      // 同时落 activeScenarioListFilter，让所有 reopen 链路（reopenScenariosManager helper）
      // 都能回到正确的过滤视图（C1-C4 dialog 取消 / 保存成功 / 删除成功 / 类别选择取消都会 reopen）
      const filter = Array.isArray(allowedCategories) && allowedCategories.length > 0
        ? allowedCategories
        : null;
      activeScenarioListFilter = filter;
      // v2.1.0-beta.2 PR-A Round 2（task R2-8）：单类别入口（filter.length === 1）隐藏 优先级 + 是否启动 两列
      // 单类别没有"跨场景调度"语义，优先级和是否启动失去意义；同时让其余列宽度按比例放大填满。
      const isCompactView = Array.isArray(filter) && filter.length === 1;
      // v2.1.16-beta.5 F1 修复：网关对账单修复-场景管理（compact，filter=['gateway-recon-id-fix']）必须显示「是否启动」列。
      //   原因：需求1 决策2 让资金对账《开始运行》运行「已启用」的 gateway-recon-id-fix 场景（renderer.js
      //   handleBankStatementGatewayReconRun → scenarios.list 过滤 enabled），而 JPM 写死场景默认 enabled=0；
      //   compact 视图若不渲启用框，用户无处勾选启用 → 死锁（《开始运行》永远 0 个启用场景）。
      //   收窄到 gateway-recon-id-fix：业务 ReconID 修复 compact（filter=['recon-id-fix']）靠场景下拉选场景运行、
      //   不读 enabled（renderer.js handleReconIdFixRun 用 state.reconIdFixSelectedScenarioId），保持原样无该列。
      const isGatewayReconIdFixCompact = isCompactView && filter[0] === 'gateway-recon-id-fix';
      const showEnabledCol = !isCompactView || isGatewayReconIdFixCompact;
      // v3.0.0 PR-7（批量勾选列致表格偏移修复）：列宽口径统一重做。
      //   背景：批量模式左侧勾选列原为「固定 32px」，但表格 table-layout:fixed + 其余列百分比，
      //     px+% 混用在 1140px 最大宽下溢出 ≈2.8% → 批量模式整表集体左移/错位（changes/scenario-batch-css-offset/spec.md）。
      //   修复：① 勾选列 32px → 3%（与百分比列同口径，见 th/td 内联）；
      //         ② 移除 styles*.css 中 .scenarios-col-name 的 width !important + 重复定义，让 th 内联 nameWidth 真正生效（单一口径）；
      //         ③ 三套视图模式「其余列指定宽度总和 = 97%」，使「批量(勾选列3% + 其余97%) = 100% 不溢出」，
      //            「非批量(勾选列 display:none) 浏览器把 3% 按比例分摊回各列 → 视觉与修复前实际渲染比例一致（零回归）」。
      //   各列指定宽度 = 修复前 fixed 布局实际渲染比例 × 0.97（详见 spec / dev 核算）。
      const priorityWidth = '8.6%';
      const enabledWidth = isGatewayReconIdFixCompact ? '10.01%' : '12.29%';
      const priorityTh = isCompactView ? '' : `<th class="scenarios-col-priority" style="width: ${priorityWidth}; text-align: center;">优先级</th>`;
      const enabledTh = showEnabledCol ? `<th class="scenarios-col-enabled" style="width: ${enabledWidth};">是否启动</th>` : '';
      // 三套：非 compact（含优先级+启用）/ 网关 compact（无优先级、有启用）/ 业务 compact（无优先级、无启用）。每套其余列和 = 97%。
      const idWidth = isGatewayReconIdFixCompact ? '6%' : (isCompactView ? '6.4%' : '6.14%');
      const categoryWidth = isGatewayReconIdFixCompact ? '24.01%' : (isCompactView ? '29.87%' : '15.97%');
      const nameWidth = isGatewayReconIdFixCompact ? '30.96%' : (isCompactView ? '33%' : '38.03%');
      const actionsWidth = isGatewayReconIdFixCompact ? '26.02%' : (isCompactView ? '27.73%' : '15.97%');
      // v2.1.15 W3：仅资金对账模块入口（filter 含 'gateway-recon-join'、非单类别 compact）显示「网关对账单修复-管理」入口；
      //   ReconID 修复模块自身入口（compact，filter=['gateway-recon-id-fix']）随 wrapper 隐藏，避免重复/自指。
      const showGatewayReconIdFixEntry = !isCompactView && Array.isArray(filter) && filter.includes('gateway-recon-join');
      const overlay = createOverlay();
      let detailGeneration = 0;
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card scenarios-manager-card';
      // v2.1.9 N5：场景管理顶部新增「银行渠道」选择器 + 「管理」按钮（spec §4.1）
      //   初始默认选「通用」(id=1)；下拉渲染由 refreshChannelFilter 延迟填充
      //   activeChannelId 状态局部维护；切换时 refreshTable 重新拉取场景列表
      // v2.1.9 N5 Phase 5 T21：批量操作模式（局部状态）
      //   inBatchMode = false → 隐藏勾选列 + 隐藏批量动作按钮
      //   inBatchMode = true  → 表格左侧出现勾选列（含表头全选）+ footer 右侧出现「转移」「删除」按钮
      //   再次点「批量操作」→ 退出批量模式
      // 关键设计决策：勾选列用 <th>/<td> hidden 切换（CSS display:none），不动表结构 → 列宽不抖动
      // 行内「转移」按钮 + footer「批量操作」组合可叠加（单条转移不阻塞批量模式）
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">场景管理</div>
          <div class="scenario-channel-filter-wrapper" style="display: ${isCompactView ? 'none' : 'inline-flex'}; align-items: center; gap: 8px; margin-left: 16px;">
            <label class="select-label channel-filter-label" style="white-space: nowrap;">银行渠道</label>
            <!-- 2026-05-27 fix1-N5-UI-3：单选下拉视觉同主面板"模式"下拉（.select-shell + .template-select.small） -->
            <div class="select-shell channel-filter-shell" style="flex: 0 0 auto;">
              <select id="scenario-channel-filter" class="template-select small" data-role="channel-filter" data-channel-id="1" style="min-width: 160px;"></select>
            </div>
            <button class="secondary-btn small" type="button" data-action="manage-channels">管理</button>
            <!-- v2.1.15 W3：「网关对账单修复」入口（仅资金对账模块入口显示）→ 打开 ReconID 修复模块的网关对账单场景管理 -->
            <span class="gateway-recon-id-fix-entry" style="display: ${showGatewayReconIdFixEntry ? 'inline-flex' : 'none'}; align-items: center; gap: 8px; margin-left: 8px; transform: translateX(400px);">
              <label class="select-label" style="white-space: nowrap;">网关对账单修复</label>
              <button class="secondary-btn small" type="button" data-action="manage-gateway-recon-id-fix">管理</button>
            </span>
          </div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table scenarios-table">
            <thead>
              <tr>
                <th class="scenarios-col-checkbox" data-role="checkbox-col" style="width: 3%; padding-left: 8px; padding-right: 0; text-align: center; display: none;">
                  <input type="checkbox" data-role="select-all" title="全选 / 取消全选" />
                </th>
                <th class="scenarios-col-id" style="width: ${idWidth}; padding-left: 0; padding-right: 0; text-align: left; white-space: nowrap;"><span style="display: inline-block; margin-left: 21px;">序号</span></th>
                <th class="scenarios-col-category" style="width: ${categoryWidth}; padding-left: 0; padding-right: 4px; text-align: left;">功能类别</th>
                <th class="scenarios-col-name" style="width: ${nameWidth}; padding-left: 0; text-align: left;">场景名称</th>
                ${priorityTh}
                <th class="scenarios-col-actions" style="width: ${actionsWidth}; padding-left: 8px; text-align: left;">执行操作</th>
                ${enabledTh}
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <!-- 2026-05-27 fix1-N5-UI-4：footer 重排为「左组 + spacer + 右组」
             左组：新增场景 + 批量操作（普通模式）/ 新增场景 + 退出批量 + 转移 + 删除（批量模式）
             右组：导入模板文件 + 导出模板文件 + 完成（始终紧贴右）
             spacer 用 margin-left:auto 把右组推到最右；左组按钮紧贴；右组按钮间隙缩小 -->
        <div class="dialog-actions scenarios-manager-footer">
          <button class="primary-btn small" type="button" data-action="add-scenario">新增场景</button>
          <button class="secondary-btn small" type="button" data-action="batch-mode-toggle">批量操作</button>
          <button class="secondary-btn small" type="button" data-action="batch-transfer" style="display: none;">转移</button>
          <button class="danger-btn small" type="button" data-action="batch-delete" style="display: none;">删除</button>
          <!-- spacer：占据剩余宽度，把右组推到最右；display:flex 已 gap，spacer 是空 div + flex:1 -->
          <div class="scenarios-footer-spacer" style="flex: 1 1 auto;"></div>
          <!-- v2.1.9 N7 Phase 7 T28：场景模板按渠道导入/导出 -->
          <div class="scenarios-footer-right-group">
            <button class="secondary-btn small" type="button" data-action="import-scenario-bundle">导入模板文件</button>
            <button class="secondary-btn small" type="button" data-action="export-scenario-bundle">导出模板文件</button>
            <button class="primary-btn small" type="button" data-action="finish">完成</button>
          </div>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');
      const channelFilterSelect = dialog.querySelector('[data-role="channel-filter"]');
      // v2.1.9 N5 Phase 5 T21：批量模式 DOM 引用
      const checkboxHeaderTh = dialog.querySelector('[data-role="checkbox-col"]');
      const selectAllCheckbox = dialog.querySelector('[data-role="select-all"]');
      const batchModeToggleBtn = dialog.querySelector('[data-action="batch-mode-toggle"]');
      const batchTransferBtn = dialog.querySelector('[data-action="batch-transfer"]');
      const batchDeleteBtn = dialog.querySelector('[data-action="batch-delete"]');
      let inBatchMode = false;

      // v2.1.9 N5：当前选定渠道 id（默认「通用」id=1）；refreshTable 按此过滤场景
      //   activeScenarioChannelId 同步落给 reopen 链路（reopenScenariosManager helper）使用
      let activeChannelId = Number(activeScenarioChannelId) > 0
        ? Number(activeScenarioChannelId)
        : 1;
      activeScenarioChannelId = activeChannelId;

      // v3.0.8 需求2（W6）：场景管理两大功能分组三角折叠。
      //   分组键 = config.funcCategory 归并：
      //     - 'fund-nature-check' + 'dbs-charge-fund-check' → 组「资金性质校验」（groupKey='fund-nature-check'）
      //     - 'platform-order'                              → 组「中台订单数据处理」（groupKey='platform-order'）
      //   无 funcCategory 或不在上述集合的场景（既有 builtin-fixed「从银行对账单提取调拨订单对账ID」/ C1 / C2 等）
      //   → groupKey=null，保持原扁平显示（不强制分组、不折叠）。
      //   组名复用 FUNC_CATEGORY_LABELS（renderer-dialogs.js:5621），避免硬编码漂移。
      const SCENARIO_GROUP_DEFS = [
        { key: 'fund-nature-check', label: FUNC_CATEGORY_LABELS['fund-nature-check'], funcCategories: ['fund-nature-check', 'dbs-charge-fund-check'] },
        { key: 'platform-order', label: FUNC_CATEGORY_LABELS['platform-order'], funcCategories: ['platform-order'] }
      ];
      // 两组默认 collapsed（收纳）；折叠态为前端临时状态（不持久化，每次打开弹框默认收纳）。
      const collapsedGroups = new Set(SCENARIO_GROUP_DEFS.map((g) => g.key));

      // 取场景所属分组键（无匹配 → null = 扁平显示）。
      function getScenarioGroupKey(scenario) {
        const funcCategory = scenario && scenario.config && scenario.config.funcCategory;
        if (!funcCategory) return null;
        const hit = SCENARIO_GROUP_DEFS.find((g) => g.funcCategories.includes(funcCategory));
        return hit ? hit.key : null;
      }

      // 当前表格可见列数（用于分组标题行 colspan）：
      //   勾选列（始终存在，仅 display 切换）+ 序号 + 功能类别 + 场景名称 + 执行操作 = 5 基础列；
      //   优先级（非 compact）+ 是否启动（showEnabledCol）按视图模式叠加。
      function getScenarioTableColSpan() {
        return 5 + (isCompactView ? 0 : 1) + (showEnabledCol ? 1 : 0);
      }

      // 渲染分组标题行（含 ▶/▼ 三角 + 组名）。子场景行带 data-group=groupKey，按折叠态显隐。
      function renderGroupHeaderRow(groupKey, label, collapsed) {
        const tr = document.createElement('tr');
        tr.className = 'scenario-group-header';
        tr.dataset.groupHeader = groupKey;
        const triangle = collapsed ? '▶' : '▼';
        tr.innerHTML = `
          <td class="scenario-group-header-cell" colspan="${getScenarioTableColSpan()}">
            <button type="button" class="scenario-group-toggle" data-action="toggle-group" data-group="${escapeHtml(groupKey)}" aria-expanded="${collapsed ? 'false' : 'true'}">
              <span class="scenario-group-triangle">${triangle}</span>
              <span class="scenario-group-label">${escapeHtml(label)}</span>
            </button>
          </td>
        `;
        return tr;
      }

      function renderRow(scenario, displayIndex, groupKey) {
        const tr = document.createElement('tr');
        tr.dataset.id = String(scenario.id);
        tr.dataset.category = scenario.category;
        // v2.1.16-beta.5 需求2（PR-4 修订）：标记 is_builtin → 批量收集（collectChecked*）据此双保险排除内置写死场景。
        tr.dataset.builtin = scenario.isBuiltin === true ? '1' : '0';
        // v3.0.8 需求2（W6）：分组子场景行标记 data-group + scenario-group-row class；折叠态加 .collapsed（CSS display:none）。
        //   扁平行 groupKey=null 不标记、恒显。
        if (groupKey) {
          tr.dataset.group = groupKey;
          tr.classList.add('scenario-group-row');
          if (collapsedGroups.has(groupKey)) tr.classList.add('collapsed');
        }
        // v2.1.0-beta.2 PR-A Round 2：
        // - task R2-7：序号 = 列表内 1-based 顺序号（不再用真实 scenarios.id；dataset.id 仍是真实 id 用于 IPC）
        // - task R2-8：compact 模式（单类别入口）隐藏 优先级 + 是否启动 td
        const priorityTd = isCompactView ? '' : `<td class="scenarios-col-priority">${escapeHtml(String(scenario.priority))}</td>`;
        // v2.1.16-beta.5 F1 修复：启用框随 showEnabledCol 渲染（网关 compact 也显示）。
        //   JPM(is_builtin) 的启用框不 disabled —— 启停与操作列只读保护（CRUD）正交：
        //   操作列禁编辑/删除/转移（isBuiltinGatewayScenario），但「是否启动」必须可点，否则需求5 死锁。
        const enabledTd = showEnabledCol ? `<td class="scenarios-col-enabled"><input type="checkbox" data-row-action="toggle-enabled" ${scenario.enabled ? 'checked' : ''} /></td>` : '';
        // v2.1.9 N5 Phase 5 T21：勾选列（批量模式下显示）
        const checkboxDisplay = inBatchMode ? '' : 'display: none;';
        // v2.1.13 D-2：自带写死场景（builtin-fixed）执行操作列仅「管理」按钮（无转移/删除）；
        //   「管理」点击分流到适用银行渠道弹窗（manage handler 按 tr.dataset.category 判定）
        const isBuiltinFixed = scenario.category === 'builtin-fixed';
        const isFundTransferReservedConflict = hasFundTransferReservedSignatureUi(scenario)
          && !isCanonicalFundTransferOwnerUi(scenario);
        // v2.1.16-beta.5 需求2（PR-4 修订）：网关对账单修复-场景管理列表里的内置场景（如「JPM调拨订单修复」，is_builtin=1
        //   且 category='gateway-recon-id-fix'）= 写死场景，不可编辑/删除/转移 → 执行操作列去掉全部文字按钮，渲只读提示。
        //   收窄到 category='gateway-recon-id-fix' 是为零回归：is_builtin=1 的 C2(offset-bill-mark)/C3(gateway-recon-join)/
        //   builtin-fixed 只出现在银行对账单主面板（其 filter 不含 gateway-recon-id-fix），不受此分支影响，操作列保持现状。
        const isBuiltinGatewayScenario = scenario.isBuiltin === true && scenario.category === 'gateway-recon-id-fix';
        // v2.1.13 UI 微调：对账单 ReconID 修复模块（isCompactView=单类别入口）执行操作列去掉「转移」按钮
        const transferBtn = isCompactView ? '' : `<button class="text-action" type="button" data-row-action="transfer">转移</button>`;
        let actionsInner;
        if (isBuiltinGatewayScenario) {
          // 写死场景：操作列只读，无任何可点按钮（参照渠道管理 is_builtin 保护范式）
          actionsInner = '<span class="text-action" style="opacity: 0.55; cursor: default;" title="系统内置场景，不可编辑 / 删除 / 转移">（内置场景）</span>';
        } else if (isFundTransferReservedConflict) {
          actionsInner = '<span class="text-action" style="opacity: 0.7; cursor: default;" title="该普通场景占用了系统保留签名，运行会被阻断">非系统冲突场景</span>'
            + '<button class="text-action danger-text" type="button" data-row-action="delete">删除冲突</button>';
        } else if (isBuiltinFixed) {
          actionsInner = '<button class="text-action" type="button" data-row-action="manage">管理</button>';
        } else {
          actionsInner = `<button class="text-action" type="button" data-row-action="manage">管理</button>
            ${transferBtn}
            <button class="text-action danger-text" type="button" data-row-action="delete">删除</button>`;
        }
        // 批量勾选列：builtin-fixed 与网关写死场景均不可批量操作 → checkbox disabled
        const selectRowDisabled = isBuiltinFixed || isBuiltinGatewayScenario;
        // v3.0.1（用户要求）：场景管理「场景名称」列去掉冗余前缀「资金性质校验-」（与「功能类别」列已显示的「资金性质校验」重复）。
        //   仅显示层 strip，不改 DB seed 名字；对账引擎按 config/category 匹配、不引用 name 字符串（后端 grep 零引用），故安全。
        const scenarioDisplayName = String(scenario.name || '').split('资金性质校验-').join('');
        tr.innerHTML = `
          <td class="scenarios-col-checkbox" data-role="row-checkbox-cell" style="width: 3%; padding-left: 8px; padding-right: 0; text-align: center; ${checkboxDisplay}">
            <input type="checkbox" data-row-action="select-row" ${selectRowDisabled ? 'disabled title="内置写死场景不可批量操作"' : ''} />
          </td>
          <td class="scenarios-col-id" style="padding-left: 0; padding-right: 0; text-align: left; white-space: nowrap;"><span style="display: inline-block; margin-left: 21px;">${escapeHtml(String(displayIndex))}</span></td>
          <td class="scenarios-col-category">${escapeHtml(getScenarioCategoryDisplay(scenario))}</td>
          <td class="scenarios-col-name">${escapeHtml(scenarioDisplayName)}</td>
          ${priorityTd}
          <td class="scenarios-col-actions">${actionsInner}</td>
          ${enabledTd}
        `;
        return tr;
      }

      // v2.1.9 N5 Phase 5 T21：批量模式切换 — 显隐勾选列 + 批量动作按钮
      //   再次点击 batch-mode-toggle 退出批量模式 + 清空所有勾选状态（避免下次进入时残留）
      function setBatchMode(next) {
        inBatchMode = !!next;
        checkboxHeaderTh.style.display = inBatchMode ? '' : 'none';
        batchTransferBtn.style.display = inBatchMode ? '' : 'none';
        batchDeleteBtn.style.display = inBatchMode ? '' : 'none';
        batchModeToggleBtn.classList.toggle('active', inBatchMode);
        batchModeToggleBtn.textContent = inBatchMode ? '退出批量' : '批量操作';
        // 显隐所有行的勾选列；退出时清空勾选状态
        tbody.querySelectorAll('[data-role="row-checkbox-cell"]').forEach((td) => {
          td.style.display = inBatchMode ? '' : 'none';
        });
        if (!inBatchMode) {
          tbody.querySelectorAll('input[data-row-action="select-row"]').forEach((cb) => {
            cb.checked = false;
          });
          if (selectAllCheckbox) selectAllCheckbox.checked = false;
        }
      }

      // 收集当前批量勾选的 scenario id 数组
      function collectCheckedScenarioIds() {
        const ids = [];
        tbody.querySelectorAll('tr').forEach((tr) => {
          // v2.1.13：builtin-fixed（自带写死场景）不可批量操作（转移/删除），双保险排除
          // v2.1.16-beta.5 需求2（修订）：仅额外排除网关写死场景「JPM调拨订单修复」(gateway-recon-id-fix + builtin)；
          //   C2/C3(offset-bill-mark/gateway-recon-join，is_builtin=1)保持可批量删 —— 与 selectRowDisabled
          //   (isBuiltinFixed || isBuiltinGatewayScenario) 条件一致，避免 checkbox 可勾却删不掉的不一致回归。
          if (tr.dataset.category === 'builtin-fixed'
            || (tr.dataset.builtin === '1' && tr.dataset.category === 'gateway-recon-id-fix')) return;
          const cb = tr.querySelector('input[data-row-action="select-row"]');
          if (cb && cb.checked && tr.dataset.id) {
            ids.push(Number(tr.dataset.id));
          }
        });
        return ids;
      }

      // 收集当前批量勾选的场景名（用于批量删除确认框列出清单）
      function collectCheckedScenarioNames() {
        const names = [];
        tbody.querySelectorAll('tr').forEach((tr) => {
          // v2.1.13：builtin-fixed（自带写死场景）不可批量操作，双保险排除
          // v2.1.16-beta.5 需求2（修订）：仅额外排除网关写死场景「JPM调拨订单修复」；C2/C3 保持可批量删
          //   （与 collectCheckedScenarioIds / selectRowDisabled 一致，零回归）。
          if (tr.dataset.category === 'builtin-fixed'
            || (tr.dataset.builtin === '1' && tr.dataset.category === 'gateway-recon-id-fix')) return;
          const cb = tr.querySelector('input[data-row-action="select-row"]');
          if (cb && cb.checked) {
            const nameTd = tr.querySelector('.scenarios-col-name');
            if (nameTd) names.push(nameTd.textContent || '');
          }
        });
        return names;
      }

      async function refreshTable() {
        const isCurrentRead = beginRead(overlay, 'refreshTable');
        const scenariosRaw = await loadScenariosOrAlert(overlay);
        if (!isCurrentRead()) return;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
        if (scenariosRaw === null) return;
        // v3.0.8 需求2（W6）：退役自带场景 C3「与网关对账单根据金额币种一对一匹配对账ID」（category='gateway-recon-join'）
        //   —— 仅隐藏「软件自带的 C3」（isBuiltin=true）：自带 C3 列表项在场景管理列表看不到、不可在表内启停，
        //      最大可回滚、零 migration 风险。
        //   v3.0.8 fix（用户拍板）：保留用户自建 C3（isBuiltin=false）可见可管理——只过滤自带 C3，不再一刀切隐藏全部
        //      gateway-recon-join，避免误伤用户在 BOSH-CN 等渠道下自建的 C3 场景。
        //   注意：本过滤只隐藏自带列表项，不是全链路屏蔽——新建场景下拉（约 8003 行）仍可建 C3，
        //   已有库中手动启用的 C3 因后端保留仍会运行（向后兼容，属 TECHDOC OPEN-2 已知取舍）。
        //   后端引擎 / dispatcher case / CHECK 约束 / 已有库记录 / 新库 seed 全不动；新库 seed 的 enabled=0 自带 C3 被此过滤等效退役。
        //   字段来源：scenarios-repository.rowToListItem → isBuiltin: Number(row.is_builtin) === 1（camelCase）。
        const scenarios = scenariosRaw.filter((s) => !(s.category === 'gateway-recon-join' && s.isBuiltin));
        // v2.1.16 需求1：listScenarios 不返 config → 为 builtin-fixed 行补 config，
        //   使「功能类别」列能按 config.funcCategory 显示业务分组（资金性质校验 / 中台订单数据处理）。
        await Promise.all(
          scenarios
            .filter((s) => s.category === 'builtin-fixed')
            .map(async (s) => {
              try {
                const detail = await scenarioCommands.scenarios.get(s.id);
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
                if (detail && detail.status === 'ok' && detail.scenario) s.config = detail.scenario.config;
              } catch (_) {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return; /* 失败则回退 category 标签 */ }
            })
        );
        if (!isCurrentRead()) return;
        // v2.1.0-beta.2 PR-A：按白名单过滤
        let visible = filter ? scenarios.filter((s) => filter.includes(s.category)) : scenarios;
        // v2.1.9 N5：再按当前选定渠道过滤（spec §4.1；activeChannelId 默认 1 = 通用）
        //   场景列表的 channelId 字段由 scenarios-repository.listScenarios 返回（N5 加列）
        //   老库未 backfill 行 channelId == null → repository rowToListItem 已兜底为 1
        // v2.1.13 A2：ReconID 修复入口（compact）已去银行渠道概念 → 不按渠道过滤；银行对账单入口仍按 activeChannelId 过滤
        if (!isCompactView) {
          visible = visible.filter((s) => Number(s.channelId || 1) === Number(activeChannelId));
        }
        // v2.1.13 D-2：自带写死场景（builtin-fixed）置顶（序号固定 1）；其余保持 listScenarios 原序（stable sort）
        visible.sort((a, b) => (a.category === 'builtin-fixed' ? 0 : 1) - (b.category === 'builtin-fixed' ? 0 : 1));
        tbody.innerHTML = '';
        // v3.0.8 需求2（W6）：二级分组渲染（纯视觉重排，序号口径不变）。
        //   ① 无分组场景（groupKey=null）保持原扁平显示，按上面的 builtin-first 顺序先渲染（含 C1/C2/既有 builtin-fixed）。
        //   ② 「资金性质校验」「中台订单数据处理」两组各插一行分组标题（▶/▼ 三角），子场景行按折叠态显隐，默认 collapsed。
        // 🔴 N3-1 一致性红线（rules/important-variables.md displayIndex）：序号列必须用 scenario.displayIndex
        //   （scenarios-repository.listScenarios 渠道内 builtin-fixed 优先 1-based 派发口径，run 状态框 / 命中场景行报表共享同一份），
        //   严禁用「分组重排后的位置序数」——否则 run 状态框「场景 N」与场景管理 UI 序号串号（N3-1 修复失效）。
        //   分组只改渲染顺序与折叠显隐，不改任何场景的序号显示值；displayIndex 缺失时才回退列表位次（兜底）。
        const displayNumberOf = (scenario, fallbackPos) =>
          Number.isFinite(Number(scenario.displayIndex)) ? Number(scenario.displayIndex) : fallbackPos;
        let fallbackPos = 0;
        const flatScenarios = visible.filter((s) => getScenarioGroupKey(s) === null);
        // v2.1.0-beta.2 PR-A Round 2（task R2-7）：序号优先取 displayIndex（派发口径），缺失才回退位次。
        flatScenarios.forEach((scenario) => {
          fallbackPos += 1;
          tbody.appendChild(renderRow(scenario, displayNumberOf(scenario, fallbackPos), null));
        });
        SCENARIO_GROUP_DEFS.forEach((group) => {
          const members = visible.filter((s) => getScenarioGroupKey(s) === group.key);
          if (members.length === 0) return; // 该组无场景 → 不渲分组标题（避免空组）
          const collapsed = collapsedGroups.has(group.key);
          tbody.appendChild(renderGroupHeaderRow(group.key, group.label, collapsed));
          members.forEach((scenario) => {
            fallbackPos += 1;
            tbody.appendChild(renderRow(scenario, displayNumberOf(scenario, fallbackPos), group.key));
          });
        });
        // v2.1.9 N5 Phase 5 T21：refresh 后重置「全选」状态（新建 rows 都未勾）
        if (selectAllCheckbox) selectAllCheckbox.checked = false;
      }

      // v3.0.8 需求2（W6）：折叠态切换 —— 不重渲整表，仅翻转该组 collapsed 标志 + 显隐子行 + 翻转三角。
      function toggleScenarioGroup(groupKey) {
        if (!groupKey) return;
        const willCollapse = !collapsedGroups.has(groupKey);
        if (willCollapse) {
          collapsedGroups.add(groupKey);
        } else {
          collapsedGroups.delete(groupKey);
        }
        tbody.querySelectorAll(`tr[data-group="${groupKey}"]`).forEach((tr) => {
          tr.classList.toggle('collapsed', willCollapse);
        });
        const headerRow = tbody.querySelector(`tr[data-group-header="${groupKey}"]`);
        if (headerRow) {
          const toggleBtn = headerRow.querySelector('[data-action="toggle-group"]');
          if (toggleBtn) toggleBtn.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
          const triangle = headerRow.querySelector('.scenario-group-triangle');
          if (triangle) triangle.textContent = willCollapse ? '▶' : '▼';
        }
      }

      // v2.1.9 N5：拉取渠道列表 + 填充 select 下拉
      //   保留当前选定 activeChannelId（若仍存在）；否则 fallback 「通用」(id=1)
      //   IPC 失败时静默兜底为单选「通用」（保持下拉至少 1 项可用）
      async function refreshChannelFilter() {
        const isCurrentRead = beginRead(overlay, 'refreshChannelFilter');
        let channels = [];
        try {
          const result = await scenarioCommands.channels.list();
        if (!isCurrentRead()) return;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          if (result && result.status === 'ok' && Array.isArray(result.channels)) {
            channels = result.channels;
          } else {
            pushAlert(overlay, () => createAlertDialog(`加载银行渠道列表失败：${result?.message || '未知错误'}`));
          }
        } catch (err) {
        if (!isCurrentRead()) return;
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          pushAlert(overlay, () => createAlertDialog(`加载银行渠道列表异常：${err && err.message ? err.message : err}`));
        }
        if (channels.length === 0) {
          // 兜底：至少塞一个「通用」占位防 select 空表
          // 2026-05-27 fix1-N5-UI-6.2：兜底 label 同步退化为 '通用'（不再「通用-通用」）
          channels = [{ id: 1, name: '通用', ownerLocation: '通用', label: '通用', displayIndex: 1, isBuiltin: true }];
        }
        // 若当前 activeChannelId 在新列表中不存在 → 回退「通用」
        if (!channels.some((c) => Number(c.id) === Number(activeChannelId))) {
          activeChannelId = 1;
          activeScenarioChannelId = 1;
        }
        channelFilterSelect.innerHTML = channels.map((c) => {
          const label = escapeHtml(c.label || `${c.name}-${c.ownerLocation}`);
          const selected = Number(c.id) === Number(activeChannelId) ? ' selected' : '';
          return `<option value="${c.id}"${selected}>${label}</option>`;
        }).join('');
        channelFilterSelect.dataset.channelId = String(activeChannelId);
      }

      // v2.1.9 N5：渠道下拉 change → 切换 activeChannelId + 重渲场景列表
      channelFilterSelect.addEventListener('change', async () => {
        ++detailGeneration;
        const next = Number(channelFilterSelect.value);
        if (!Number.isFinite(next) || next <= 0) return;
        activeChannelId = next;
        activeScenarioChannelId = next;
        channelFilterSelect.dataset.channelId = String(next);
        await refreshTable();
      });

      // v2.1.9 N5：「管理」按钮 → 打开渠道管理弹框
      //   渠道弹框关闭时回调 reopen 当前场景管理 dialog + 刷新渠道下拉
      const manageChannelsBtn = dialog.querySelector('[data-action="manage-channels"]');
      if (manageChannelsBtn) {
        manageChannelsBtn.addEventListener('click', () => {
          pushModal(overlay, () => createChannelManagerDialog({
            onClose: () => {
              // 关闭渠道管理后回到当前场景管理 dialog（保留 filter + activeChannelId）
              (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
            }
          }));
        });
      }

      // v2.1.15 W3：「网关对账单修复-管理」→ 打开对账单 ReconID 修复模块的网关对账单场景管理
      //   复用同一工厂：单类别白名单 ['gateway-recon-id-fix'] → compact 视图（与从 ReconID 模块主面板「场景管理」打开一致）
      //   仅资金对账模块入口（showGatewayReconIdFixEntry=true）渲染该按钮；点击替换当前弹窗，关闭后回主界面（行为同 ReconID 入口）
      const manageGatewayReconIdFixBtn = dialog.querySelector('[data-action="manage-gateway-recon-id-fix"]');
      if (manageGatewayReconIdFixBtn) {
        manageGatewayReconIdFixBtn.addEventListener('click', () => {
          openModal(() => createScenariosManagerDialog(['gateway-recon-id-fix']));
        });
      }

      // 委托：单一 click handler 处理 tbody 内所有 row-action
      tbody.addEventListener('click', async (event) => {
        // v3.0.8 需求2（W6）：分组标题三角折叠（不属于 row-action，先于行操作处理）。
        const groupToggle = event.target.closest('[data-action="toggle-group"]');
        if (groupToggle) {
          toggleScenarioGroup(groupToggle.dataset.group);
          return;
        }
        const button = event.target.closest('[data-row-action]');
        if (!button) return;
        const tr = button.closest('tr');
        if (!tr) return;
        const id = Number(tr.dataset.id);
        const action = button.dataset.rowAction;

        if (action === 'manage') {
          // v2.1.13 D-2/D-3：自带写死场景（builtin-fixed）「管理」= 适用银行渠道弹窗（非编辑配置）
          if (tr.dataset.category === 'builtin-fixed') {
            pushModal(overlay, () => createBuiltinFixedChannelManageDialog(id));
            return;
          }
          // 直接进入 edit 模式（取消两段式锁，简化为单按钮"管理"）
          const detailRequest = ++detailGeneration;
          const result = await scenarioCommands.scenarios.get(id);
          if (detailRequest !== detailGeneration || !modalBridge.host.getHandle(overlay)?.isTop()) return;
          if (!result || result.status !== 'ok' || !result.scenario) {
            pushAlert(overlay, () => createAlertDialog(`加载场景失败：${result?.message || '未知错误'}`));
            return;
          }
          const sc = result.scenario;
          scenarioDraft = {
            mode: 'edit',
            category: sc.category,
            scenarioId: sc.id,
            name: sc.name,
            priority: sc.priority,
            config: sc.config
          };
          openScenarioConfigByCategory(sc.category);
          return;
        }

        // v2.1.9 N5 Phase 5 T20：单条「转移」按钮 → 转移弹框（复用 createTransferScenariosDialog）
        //   单条转移：scenarioIds = [id]，currentChannelId = 当前 activeChannelId
        //   onCompleted：关弹框 + reopen 场景管理（保留当前 filter + activeChannelId）
        //   onCancel：关弹框 + reopen 场景管理（用户取消不损失任何状态）
        if (action === 'transfer') {
          pushModal(overlay, () => createTransferScenariosDialog({
            scenarioIds: [id],
            currentChannelId: activeChannelId,
            onCompleted: () => {
              returnToScenarioManager(overlay);
            },
            onCancel: () => {
              (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
            }
          }));
          return;
        }

        if (action === 'delete') {
          const name = tr.querySelector('.scenarios-col-name')?.textContent || '';
          pushModal(overlay, () => createConfirmDialog({
            message: `确认删除场景「${name}」？此操作不可撤销。`,
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              const result = await scenarioCommands.scenarios.deleteOne(id);
              if (result && result.status === 'ok') {
                // v2.1.0-beta.2 PR #38 round 2 P2-2：按 category 分流，避免操作 C1/C2/C3 清掉 ReconID 导出态，反之亦然
                // v2.1.0-beta.3 PR #39 Finding 2（P2）：用 isReconIdFixCategory 识别两个 C4 子模式（含 gateway-recon-id-fix）
                (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
              } else {
                pushAlert(overlay, () => createAlertDialog(`删除失败：${result?.message || '未知错误'}`));
              }
            }
          }));
          return;
        }
      });

      // v2.1.9 N5 Phase 5 T21：勾选列交互（行选中 change + 全选/取消全选）
      //   全选 checkbox 状态联动：所有行勾选 → 表头自动 checked；任一未勾 → 表头 unchecked
      tbody.addEventListener('change', (event) => {
        const rowCb = event.target.closest('input[data-row-action="select-row"]');
        if (!rowCb) return;
        // 同步表头状态
        if (selectAllCheckbox) {
          const allCbs = Array.from(tbody.querySelectorAll('input[data-row-action="select-row"]'));
          selectAllCheckbox.checked = allCbs.length > 0 && allCbs.every((cb) => cb.checked);
        }
      });

      if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', () => {
          const next = selectAllCheckbox.checked;
          tbody.querySelectorAll('input[data-row-action="select-row"]').forEach((cb) => {
            // v2.1.13：builtin-fixed（自带写死场景）select-row 为 disabled，全选跳过（不可批量操作）
            if (cb.disabled) return;
            cb.checked = next;
          });
        });
      }

      // 是否启动 checkbox 用 change 事件单独绑（与 click 区分）
      tbody.addEventListener('change', async (event) => {
        const checkbox = event.target.closest('input[data-row-action="toggle-enabled"]');
        if (!checkbox) return;
        const tr = checkbox.closest('tr');
        if (!tr) return;
        const id = Number(tr.dataset.id);
        const enabled = checkbox.checked;
        const result = await scenarioCommands.scenarios.toggleEnabled(id, enabled);
        if (!result || result.status !== 'ok') {
          // 失败回滚 + 重渲（容错）
          console.warn('toggle scenario enabled failed:', result);
          checkbox.checked = !enabled;
          await refreshTable();
          pushAlert(overlay, () => createAlertDialog(`切换启用状态失败：${result?.message || '未知错误'}`));
        } else {
          // v2.1.0-beta.2 PR #38 round 2 P2-2：按 category 分流，避免跨模块互抹状态
        }
      });

      // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 关闭时（× / 点空白处通用 closeModal 通道也覆盖）
      // v2.1.0-beta.2 PR #38 round 2 P2-2：仅 ReconID 入口（filter 含 'recon-id-fix'）才刷新 ReconID 主面板下拉
      function closeAndReloadReconList() {
        closeModal(overlay);
      }
      registerModal(overlay, {
        onMount: () => { managerOverlay = overlay; },
        onClose: () => { if (managerOverlay === overlay) { managerOverlay = null; scenarioDraft = null; } scenarioCommands.closed(); }
      });
      subscribeView(overlay, refreshChannelFilter, (event) => { if (event?.kind !== 'scenarios-closed') { ++detailGeneration; refreshTable(); } });
      dialog.querySelector('.icon-close').addEventListener('click', closeAndReloadReconList);
      // v2.1.0-beta.2 PR-A Round 2（task R2-6）：右下"完成"按钮 = 关闭 dialog 并刷新主面板下拉（同 closeAndReloadReconList）
      dialog.querySelector('[data-action="finish"]').addEventListener('click', closeAndReloadReconList);
      dialog.querySelector('[data-action="add-scenario"]').addEventListener('click', () => {
        // v2.1.0-beta.2 PR-A：单类别白名单（如 ReconID 入口）跳过类别选择窗，直接进入对应配置 dialog
        if (filter && filter.length === 1) {
          const onlyCategory = filter[0];
          scenarioDraft = {
            mode: 'create',
            category: onlyCategory,
            scenarioId: null,
            name: '',
            priority: 0,
            config: createDefaultScenarioConfig(onlyCategory)
          };
          openScenarioConfigByCategory(onlyCategory);
          return;
        }
        openScenarioView(() => createScenarioCategorySelectDialog(filter));
      });

      // v2.1.9 N5 Phase 5 T21：「批量操作」按钮 — 切换批量模式
      if (batchModeToggleBtn) {
        batchModeToggleBtn.addEventListener('click', () => {
          setBatchMode(!inBatchMode);
        });
      }

      // v2.1.9 N5 Phase 5 T22：「批量转移」按钮 — 复用 createTransferScenariosDialog
      //   payload.scenarioIds = 当前所有勾选的 id；空选时弹提示
      if (batchTransferBtn) {
        batchTransferBtn.addEventListener('click', () => {
          const ids = collectCheckedScenarioIds();
          if (ids.length === 0) {
            pushAlert(overlay, () => createAlertDialog('请先勾选至少一个场景再点「转移」', {
              onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })()
            }));
            return;
          }
          pushModal(overlay, () => createTransferScenariosDialog({
            scenarioIds: ids,
            currentChannelId: activeChannelId,
            onCompleted: () => {
              returnToScenarioManager(overlay);
            },
            onCancel: () => {
              (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
            }
          }));
        });
      }

      // v2.1.9 N5 Phase 5 T22：「批量删除」按钮 — 确认框列出场景名清单 + 确认后调 batch-delete IPC
      //   资金红线（spec §10.1）：确认框必须含场景名清单（让用户能 review，不能盲删）
      if (batchDeleteBtn) {
        batchDeleteBtn.addEventListener('click', () => {
          const ids = collectCheckedScenarioIds();
          const names = collectCheckedScenarioNames();
          if (ids.length === 0) {
            pushAlert(overlay, () => createAlertDialog('请先勾选至少一个场景再点「删除」', {
              onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })()
            }));
            return;
          }
          const nameList = names.map((n) => `• ${escapeHtml(n)}`).join('<br/>');
          pushModal(overlay, () => createConfirmDialog({
            message: `确认批量删除以下 ${ids.length} 个场景？此操作不可撤销。<br/><br/>${nameList}`,
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              const result = await scenarioCommands.scenarios.batchDelete(ids);
              if (result && result.status === 'ok') {
                // 双清缓存语义已在 IPC handler 内做（processingResult + reconIdFixResult 双清）
                // 这里走 UI 侧两个 refresh，与单条 delete 保持一致 — 但批量可能跨 category，全跑覆盖
                (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
              } else {
                pushAlert(overlay, () => createAlertDialog(
                  `批量删除失败：${result?.message || '未知错误'}`,
                  { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
                ));
              }
            },
            onCancel: () => {
              // 取消 → 不关 dialog；用户停留在场景管理
            }
          }));
        });
      }

      // v2.1.9 N7 Phase 7 T28：「导入模板文件」按钮 — 调 scenarioCommands.scenarios.importBundle()
      //   流程：openFile → main 解析 → 二阶段处理
      //     - status='cancelled'  → 静默回 reopen
      //     - status='failed'     → 弹错误 + reopen
      //     - status='needs-confirm' → 弹确认框（列出缺失渠道）→ 确认后调 applyImport(bundle, {confirm=true})
      //     - status='ok'         → 弹结果框（导入数 + 跳过数 + 创建渠道数）→ reopen
      //   资金红线：误用 bundleVersion=4 文件 main 端会返 failed「文件类型不匹配」
      const importBundleBtn = dialog.querySelector('[data-action="import-scenario-bundle"]');
      if (importBundleBtn) {
        importBundleBtn.addEventListener('click', async () => {
          let result;
          try {
            result = await scenarioCommands.scenarios.importBundle();
          } catch (err) {
            pushAlert(overlay, () => createAlertDialog(
              `导入场景模板文件异常：${err && err.message ? err.message : err}`,
              { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
            ));
            return;
          }
          if (!result || result.status === 'cancelled') {
            // 用户取消文件选择 → 静默返回（不弹任何提示，与现有 templates.importBundle 模式一致）
            return;
          }
          if (result.status === 'failed') {
            pushAlert(overlay, () => createAlertDialog(
              `导入失败：${result.message || '未知错误'}`,
              { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
            ));
            return;
          }
          if (result.status === 'needs-confirm') {
            // 缺失渠道二阶段确认框（spec §6.3.1 D11=a）
            const missing = Array.isArray(result.missingChannels) ? result.missingChannels : [];
            const missingList = missing
              .map((c) => `• ${escapeHtml(c.name)}-${escapeHtml(c.ownerLocation)}`)
              .join('<br/>');
            pushModal(overlay, () => createConfirmDialog({
              message: `导入将自动创建以下 ${missing.length} 个新渠道：<br/><br/>${missingList}<br/><br/>是否确认创建并继续导入？`,
              confirmText: '确认创建',
              cancelText: '取消',
              onConfirm: async () => {
                let applyResult;
                try {
                  applyResult = await scenarioCommands.scenarios.applyImport(result.preparedContextId, {
                    confirmCreateMissingChannels: true
                  });
                } catch (err) {

                  pushAlert(overlay, () => createAlertDialog(
                    `应用导入异常：${err && err.message ? err.message : err}`,
                    { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
                  ));
                  return;
                }
                closeModal();
                if (applyResult && applyResult.status === 'ok') {
                  showImportResultDialog(applyResult);
                } else {
                  pushAlert(overlay, () => createAlertDialog(
                    `导入失败：${applyResult?.message || '未知错误'}`,
                    { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
                  ));
                }
              },
              onCancel: () => {

                (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })();
              }
            }));
            return;
          }
          if (result.status === 'ready-to-apply') {
            let applyResult;
            try {
              applyResult = await scenarioCommands.scenarios.applyImport(result.preparedContextId, {
                confirmCreateMissingChannels: false
              });
            } catch (err) {
              pushAlert(overlay, () => createAlertDialog(
                `应用导入异常：${err && err.message ? err.message : err}`,
                { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
              ));
              return;
            }
            if (applyResult && applyResult.status === 'ok') {
              showImportResultDialog(applyResult);
            } else {
              pushAlert(overlay, () => createAlertDialog(
                `导入失败：${applyResult?.message || '未知错误'}`,
                { onConfirm: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })() }
              ));
            }
            return;
          }
          if (result.status === 'ok') {
            showImportResultDialog(result);
          }
        });
      }

      // 导入结果框（成功后展示 导入数 / 跳过同名数 / 创建渠道数）
      function showImportResultDialog(result) {
        const importedCount = Number(result.importedCount) || 0;
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        const createdChannels = Array.isArray(result.createdChannels) ? result.createdChannels : [];
        const lines = [];
        lines.push(`成功导入 <b>${importedCount}</b> 个场景`);
        if (createdChannels.length > 0) {
          lines.push(`新建 ${createdChannels.length} 个渠道：${createdChannels.map((c) => escapeHtml(`${c.name}-${c.ownerLocation}`)).join(', ')}`);
        }
        if (conflicts.length > 0) {
          const conflictList = conflicts
            .map((c) => {
              const reasonLabel = c.reason === 'channel-missing'
                ? '渠道缺失未创建'
                : (c.reason === 'name-duplicate' ? '同名场景已存在' : c.reason || '冲突');
              return `• ${escapeHtml(c.channel || '')} / ${escapeHtml(c.scenario || '')} (${reasonLabel})`;
            })
            .join('<br/>');
          lines.push(`跳过 ${conflicts.length} 个场景：<br/>${conflictList}`);
        }
        pushAlert(overlay, () => createAlertDialog(lines.join('<br/><br/>'), {
          onConfirm: async () => {
            // 导入完成 → 刷新场景列表（如选中渠道 ∈ createdChannels，仍按 activeChannelId 过滤）
            await refreshChannelFilter();
            await refreshTable();
            // 双清 main 端缓存的语义已在 IPC handler 内完成；UI 侧补刷渠道下拉即可
          }
        }));
      }

      // v2.1.9 N7 Phase 7 T29：「导出模板文件」按钮 — 弹出导出选择弹框
      //   弹框：多选渠道下拉 → 「导出」按钮 → 调 scenarioCommands.scenarios.exportBundle(channelIds)
      //   main 端 saveDialog 让用户选路径；返回 status=ok/cancelled/failed
      const exportBundleBtn = dialog.querySelector('[data-action="export-scenario-bundle"]');
      if (exportBundleBtn) {
        exportBundleBtn.addEventListener('click', () => {
          pushModal(overlay, () => createExportScenarioBundleDialog({
            onCancel: () => (() => { returnToModal(overlay); refreshChannelFilter(); refreshTable(); })(),
            onCompleted: () => returnToScenarioManager(overlay)
          }));
        });
      }

      // v2.1.9 N5：先拉渠道下拉，再渲场景表（场景表需 activeChannelId 正确才能正确过滤）
      //   refreshChannelFilter 内部可能回退 activeChannelId（当原值不存在于渠道列表）
      registerModal(overlay, { onMount: () => (async () => {
        const isCurrentRead = beginRead(overlay, 'initial');
        await refreshChannelFilter();
        if (!isCurrentRead()) return;
        await refreshTable();
        if (!isCurrentRead()) return;
      })() });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.0-beta.2 PR-A：reopen 场景管理 dialog 的统一入口（透传当前白名单）
    // 用于 C1-C4 dialog 取消 / 删除场景 / 类别选择取消 / 确认弹窗成功 等 11 处 reopen 链路。
    // 不传 allowedCategories 调用 createScenariosManagerDialog 会回到全表，破坏隔离。
    function reopenScenariosManager() {
      return createScenariosManagerDialog(activeScenarioListFilter);
    }

    // v2.1.13 D-3：自带写死场景「管理」→ 适用银行渠道多选弹窗（PRD 2.2.2.1）
    //   左上「请选择适用银行渠道」；中间多选下拉（左「银行渠道」label，枚举=channels.list，默认全选）；
    //   下拉样式复用维护大账号「多币种」浮动面板（CSS new-account-currency-dropdown-*）；
    //   加载 getApplicableChannels（空=全部=全选）；保存 setApplicableChannels（全选→存空=全部）；右下「保存」「返回」。
    function createBuiltinFixedChannelManageDialog(scenarioId) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card builtin-fixed-channel-manage-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title" data-role="manager-title">请选择适用的银行渠道</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body builtin-fixed-channel-body">
          <!-- v2.1.13 bug 修复：用 div 而非 label，避免点击行内文本/空白误触发内部下拉按钮 -->
          <!-- 非调拨场景：「银行渠道」在左、「优先级」在右；canonical 调拨场景隐藏银行渠道，
               改为「调拨单匹配日期」在左、「优先级」在右，始终共用这一行。 -->
          <div class="builtin-fixed-channel-row builtin-fixed-priority-row" data-role="date-priority-row">
            <div class="builtin-fixed-date-policy-group" data-role="date-policy-row" hidden>
              <label class="builtin-fixed-payment-check">
                <input type="checkbox" data-field="date-match-enabled">
                调拨单匹配日期
              </label>
              <span class="builtin-fixed-channel-label">±</span>
              <input class="scenario-config-input scenario-config-input-narrow builtin-fixed-priority-input"
                type="number" min="1" max="999" step="1" data-field="date-tolerance-days" value="1">
              <span class="builtin-fixed-channel-label">天</span>
            </div>
            <div class="builtin-fixed-channel-group" data-role="applicable-channel-group">
              <span class="builtin-fixed-channel-label">银行渠道</span>
              <div class="new-account-currency-dropdown-wrap builtin-fixed-channel-dropdown-wrap">
                <button class="new-account-currency-dropdown-btn builtin-fixed-channel-dropdown-btn" type="button" aria-expanded="false"> </button>
              </div>
            </div>
            <div class="builtin-fixed-priority-group">
              <span class="builtin-fixed-channel-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
              <input class="scenario-config-input scenario-config-input-narrow builtin-fixed-priority-input" type="number" min="0" max="3" data-field="priority" value="0">
            </div>
          </div><!-- /builtin-fixed-date-priority-row -->
          <div class="builtin-fixed-payment-error builtin-fixed-date-policy-error" data-role="date-policy-error" hidden></div>
          <!-- v3.0.8（用户要求）：两个勾选框（对账数据来源 / Payment线下调拨）并排一行显示 → 外层 flex 容器包裹。
               与两勾选框同 gating（仅 fund-transfer-backfill 场景显示）：加载 IIFE 里 isPaymentScenario 时 unhide，
               避免非 payment 场景留空容器的多余间距。 -->
          <div class="builtin-fixed-checks-row" data-role="checks-row" hidden>
          <!-- v3.0.6 需求2（T6）：「对账数据来源为中台调拨单表」二选一勾选行。
               仅 config.subCategory==='fund-transfer-backfill' 场景显示（与 payment 行同一 gating）；
               默认勾选（加载口径 cachedConfig.reconSourceMid !== false，老库无字段→视为勾选）。
               勾选→编排器 R5s2 用调拨对账单派生表匹配回填；取消→沿用旧网关对账单逻辑。 -->
          <div class="builtin-fixed-payment-row builtin-fixed-recon-source-row" data-role="recon-source-row" hidden>
            <label class="builtin-fixed-payment-check">
              <input type="checkbox" data-field="recon-source-mid">
              对账数据来源为中台调拨单表
            </label>
          </div>
          <!-- v3.0.4 块 F · F1：「Payment线下调拨订单回填处理」勾选行 + 条件展开区。
               仅 config.subCategory==='fund-transfer-backfill' 场景显示（加载 IIFE gating 控制 hidden）；
               展开区默认隐藏，勾选后显示（照 C3 extraFee 范式，取消勾选保留输入值）。 -->
          <div class="builtin-fixed-payment-row" data-role="payment-row" hidden>
            <label class="builtin-fixed-payment-check">
              <input type="checkbox" data-field="payment-offline-enabled">
              Payment线下调拨订单回填处理
            </label>
          </div>
          </div><!-- /builtin-fixed-checks-row -->
          <div class="builtin-fixed-payment-fields" data-role="payment-fields" hidden>
            <div class="builtin-fixed-payment-field">
              <span class="builtin-fixed-channel-label">银行渠道</span>
              <input class="scenario-config-input builtin-fixed-payment-input" type="text" data-field="payment-bank-channel" placeholder="如 CITI">
            </div>
            <div class="builtin-fixed-payment-field">
              <span class="builtin-fixed-channel-label">地区</span>
              <input class="scenario-config-input builtin-fixed-payment-input" type="text" data-field="payment-region" placeholder="如 CN">
            </div>
            <div class="builtin-fixed-payment-field">
              <span class="builtin-fixed-channel-label">大账号</span>
              <input class="scenario-config-input builtin-fixed-payment-input" type="text" data-field="payment-big-account" placeholder="如 202782001、202782002">
            </div>
            <div class="builtin-fixed-payment-error" data-role="payment-error" hidden></div>
          </div>
          <div class="builtin-fixed-refund-fuzzy-row" data-role="refund-fuzzy-row" hidden>
            <label class="builtin-fixed-payment-check">
              <input type="checkbox" data-field="bank-payment-serial-fuzzy-enabled">
              银行打款流水号模糊匹配
            </label>
          </div>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="save">保存</button>
          <button class="secondary-btn small" type="button" data-action="back">返回</button>
        </div>
      `;

      const dropdownButton = dialog.querySelector('.builtin-fixed-channel-dropdown-btn');
      const managerTitle = dialog.querySelector('[data-role="manager-title"]');
      const applicableChannelGroup = dialog.querySelector('[data-role="applicable-channel-group"]');
      // v2.1.16 A1：优先级输入框（0-3 整数；回填当前场景 priority，保存时随适用渠道一并 update）
      const priorityInput = dialog.querySelector('input[data-field="priority"]');
      const datePolicyRow = dialog.querySelector('[data-role="date-policy-row"]');
      const dateMatchEnabledCheck = dialog.querySelector('input[data-field="date-match-enabled"]');
      const dateToleranceDaysInput = dialog.querySelector('input[data-field="date-tolerance-days"]');
      const datePolicyError = dialog.querySelector('[data-role="date-policy-error"]');
      // v3.0.6 需求2（T6）：对账数据来源二选一 —— 勾选行（默认勾选；仅 fund-transfer-backfill 场景显示，与 payment 行同 gating）
      const reconSourceRow = dialog.querySelector('[data-role="recon-source-row"]');
      const reconSourceCheck = dialog.querySelector('input[data-field="recon-source-mid"]');
      // v3.0.8（用户要求）：两勾选框并排一行的外层容器（与两勾选框同 gating，仅 fund-transfer-backfill 场景 unhide）
      const checksRow = dialog.querySelector('[data-role="checks-row"]');
      // v3.0.4 块 F · F1：Payment 线下调拨订单回填处理 —— 勾选行 + 三输入框展开区（条件渲染 + 显隐联动）
      const paymentRow = dialog.querySelector('[data-role="payment-row"]');
      const paymentFields = dialog.querySelector('[data-role="payment-fields"]');
      const paymentCheck = dialog.querySelector('input[data-field="payment-offline-enabled"]');
      const paymentBankChannelInput = dialog.querySelector('input[data-field="payment-bank-channel"]');
      const paymentRegionInput = dialog.querySelector('input[data-field="payment-region"]');
      const paymentBigAccountInput = dialog.querySelector('input[data-field="payment-big-account"]');
      const paymentError = dialog.querySelector('[data-role="payment-error"]');
      const refundFuzzyRow = dialog.querySelector('[data-role="refund-fuzzy-row"]');
      const refundFuzzyCheck = dialog.querySelector('input[data-field="bank-payment-serial-fuzzy-enabled"]');
      const saveButton = dialog.querySelector('[data-action="save"]');
      const floatingPanel = document.createElement('div');
      floatingPanel.className = 'new-account-currency-dropdown-panel builtin-fixed-channel-floating-panel';
      floatingPanel.hidden = true;
      overlay.appendChild(floatingPanel);

      let allChannels = [];          // [{id, label}]
      let selectedIds = new Set();   // 当前选中的 channel id
      let panelOpen = false;
      // v3.0.4 块 F · F2：缓存当前场景完整 config（供保存时读-改-写浅合并；加载完成前禁用保存防竞态写空）
      let cachedConfig = null;       // scenarios.get 返回的 config（已 JSON.parse）
      let isPaymentScenario = false; // 仅完整 canonical fund-transfer owner 显示 Payment 子配置
      let isRefundScenario = false;  // config.subCategory==='refund-order-backfill' 才显示退款模糊匹配开关
      let isCanonicalFundTransferOwner = false;
      let configLoaded = false;      // 加载 IIFE 完成标记；未完成禁用保存

      function syncDatePolicyInputState() {
        if (!dateMatchEnabledCheck || !dateToleranceDaysInput) return;
        dateToleranceDaysInput.disabled = !dateMatchEnabledCheck.checked;
        if (datePolicyError) datePolicyError.hidden = true;
      }
      if (dateMatchEnabledCheck) {
        dateMatchEnabledCheck.addEventListener('change', syncDatePolicyInputState);
      }

      // F1：勾选/取消勾选联动。v3.1.7 Payment 开启时强制勾选并锁定派生调拨表来源；关闭后解除锁定。
      function syncPaymentFieldsVisibility() {
        if (!paymentFields || !paymentCheck) return;
        const enabled = paymentCheck.checked === true;
        paymentFields.hidden = !enabled;
        if (reconSourceCheck) {
          if (enabled) reconSourceCheck.checked = true;
          reconSourceCheck.disabled = enabled;
          reconSourceCheck.title = enabled ? 'Payment开启时必须使用中台调拨单派生表' : '';
        }
        if (!enabled && paymentError) {
          paymentError.hidden = true; // 取消勾选时清掉 inline 校验提示
        }
      }
      if (paymentCheck) {
        paymentCheck.addEventListener('change', syncPaymentFieldsVisibility);
      }

      function updateLabel() {
        if (selectedIds.size === 0) {
          dropdownButton.textContent = ' ';
        } else if (allChannels.length > 0 && selectedIds.size === allChannels.length) {
          dropdownButton.textContent = '全部';
        } else {
          const names = allChannels.filter((c) => selectedIds.has(c.id)).map((c) => c.label);
          dropdownButton.textContent = names.join('、') || ' ';
        }
        dropdownButton.title = dropdownButton.textContent;
      }

      function renderOptions() {
        floatingPanel.replaceChildren();
        allChannels.forEach((c) => {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';
          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = c.label;
          const checkbox = document.createElement('input');
          checkbox.className = 'new-account-checkbox';
          checkbox.type = 'checkbox';
          checkbox.value = String(c.id);
          checkbox.checked = selectedIds.has(c.id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedIds.add(c.id);
            else selectedIds.delete(c.id);
            updateLabel();
          });
          option.append(text, checkbox);
          floatingPanel.appendChild(option);
        });
      }

      function positionPanel() {
        const rect = dropdownButton.getBoundingClientRect();
        const margin = 12;
        floatingPanel.style.position = 'fixed';
        floatingPanel.style.minWidth = `${Math.max(rect.width, 188)}px`;
        floatingPanel.style.maxWidth = `${Math.max(220, Math.min(260, window.innerWidth - margin * 2))}px`;
        floatingPanel.hidden = false;
        const panelHeight = floatingPanel.offsetHeight || 216;
        const panelWidth = floatingPanel.offsetWidth || 200;
        const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - panelWidth - margin));
        const top = rect.bottom + 6 + panelHeight > window.innerHeight - margin
          ? Math.max(margin, rect.top - panelHeight - 6)
          : rect.bottom + 6;
        floatingPanel.style.left = `${left}px`;
        floatingPanel.style.top = `${top}px`;
      }

      function closePanel() {
        panelOpen = false;
        floatingPanel.hidden = true;
        dropdownButton.classList.remove('is-open');
        dropdownButton.setAttribute('aria-expanded', 'false');
      }
      function openPanel() {
        renderOptions();
        panelOpen = true;
        dropdownButton.classList.add('is-open');
        dropdownButton.setAttribute('aria-expanded', 'true');
        positionPanel();
      }
      dropdownButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (panelOpen) closePanel(); else openPanel();
      });

      // 先加载完整场景，只有完整 canonical owner 才进入“调拨回填功能管理”。
      // canonical owner 固定全渠道，因此不读取渠道列表/适用渠道；其它 builtin-fixed 保持原管理页行为。
      // v3.0.4 块 F · F2：加载完成前禁用保存（防 config 未就绪时点保存 → 浅合并基底 null 写空 config）
      if (saveButton) saveButton.disabled = true;
      registerModal(overlay, { onMount: () => (async () => {
        const isCurrentRead = beginRead(overlay, 'initial');
        try {
          const scResult = await scenarioCommands.scenarios.get(scenarioId);
        if (!isCurrentRead()) return;
          if (!scResult || scResult.status !== 'ok' || !scResult.scenario) {
            throw new Error(scResult?.message || '场景不存在');
          }
          const scenarioDetail = scResult.scenario;
          if (priorityInput) {
            priorityInput.value = String(scenarioDetail.priority ?? 0);
          }
          cachedConfig = (scenarioDetail.config && typeof scenarioDetail.config === 'object')
            ? scenarioDetail.config
            : {};
          isCanonicalFundTransferOwner = isCanonicalFundTransferOwnerUi(scenarioDetail);
          isPaymentScenario = isCanonicalFundTransferOwner;
          isRefundScenario = cachedConfig.subCategory === 'refund-order-backfill';

          if (isCanonicalFundTransferOwner) {
            if (managerTitle) managerTitle.textContent = '调拨回填功能管理';
            if (applicableChannelGroup) applicableChannelGroup.hidden = true;
            if (datePolicyRow) datePolicyRow.hidden = false;
            if (dateMatchEnabledCheck) {
              dateMatchEnabledCheck.checked = cachedConfig.dateMatchEnabled !== false;
            }
            const configuredDays = cachedConfig.dateToleranceDays;
            if (dateToleranceDaysInput) {
              dateToleranceDaysInput.value = String(
                Number.isInteger(configuredDays) && configuredDays >= 1 && configuredDays <= 999
                  ? configuredDays
                  : 1
              );
            }
            syncDatePolicyInputState();
          } else {
            const chResult = await scenarioCommands.channels.list();
        if (!isCurrentRead()) return;
            if (chResult && chResult.status === 'ok' && Array.isArray(chResult.channels)) {
              allChannels = chResult.channels.map((c) => ({ id: Number(c.id), label: c.label || c.name }));
            }
            const apResult = await scenarioCommands.scenarios.getApplicableChannels(scenarioId);
        if (!isCurrentRead()) return;
            const applicable = (apResult && apResult.status === 'ok' && Array.isArray(apResult.channelIds))
              ? apResult.channelIds
              : [];
            selectedIds = applicable.length === 0
              ? new Set(allChannels.map((c) => c.id))
              : new Set(applicable.map(Number));
            updateLabel();
          }

          if (isPaymentScenario && checksRow) checksRow.hidden = false;
          if (isPaymentScenario && reconSourceRow) {
            reconSourceRow.hidden = false;
            if (reconSourceCheck) reconSourceCheck.checked = cachedConfig.reconSourceMid !== false;
          }
          if (isPaymentScenario && paymentRow) {
            paymentRow.hidden = false;
            const backfill = (cachedConfig.paymentOfflineBackfill && typeof cachedConfig.paymentOfflineBackfill === 'object')
              ? cachedConfig.paymentOfflineBackfill
              : {};
            if (paymentCheck) paymentCheck.checked = backfill.enabled === true;
            if (paymentBankChannelInput) paymentBankChannelInput.value = String(backfill.bankChannel ?? '');
            if (paymentRegionInput) paymentRegionInput.value = String(backfill.region ?? '');
            if (paymentBigAccountInput) paymentBigAccountInput.value = String(backfill.bigAccount ?? '');
            syncPaymentFieldsVisibility();
          }
          if (isRefundScenario && refundFuzzyRow) {
            refundFuzzyRow.hidden = false;
            if (refundFuzzyCheck) {
              refundFuzzyCheck.checked = cachedConfig.bankPaymentSerialFuzzyMatchEnabled === true;
            }
          }
          // 加载完成 → 允许保存
          configLoaded = true;
          if (channelRefreshPending) { channelRefreshPending = false; refreshChannelOptions(); }
          if (saveButton) saveButton.disabled = false;
        } catch (err) {
        if (!isCurrentRead()) return;
          pushAlert(overlay, () => createAlertDialog(`加载功能配置失败：${err && err.message ? err.message : err}`));
        }
      })() });

      let channelRefreshPending = false;
      async function refreshChannelOptions() {
        if (!configLoaded) { channelRefreshPending = true; return; }
        if (isCanonicalFundTransferOwner) return;
        const current = beginRead(overlay, 'channels');
        try {
          const result = await scenarioCommands.channels.list();
          if (!current()) return;
          if (!result || result.status !== 'ok' || !Array.isArray(result.channels)) throw new Error(result?.message || '渠道列表不可用');
          allChannels = result.channels.map(channel => ({ id: Number(channel.id), label: channel.label || channel.name }));
          selectedIds = new Set([...selectedIds].filter(id => allChannels.some(channel => channel.id === id)));
          updateLabel();
          if (panelOpen) renderOptions();
        } catch (error) { if (current()) pushAlert(overlay, () => createAlertDialog(error.message)); }
      }
      subscribeView(overlay, refreshChannelOptions);
      function teardownAndReopen() {
        closePanel();
        returnToScenarioManager(overlay);
      }

      dialog.querySelector('.icon-close').addEventListener('click', teardownAndReopen);
      dialog.querySelector('[data-action="back"]').addEventListener('click', teardownAndReopen);
      dialog.querySelector('[data-action="save"]').addEventListener('click', async () => {
        // v3.0.4 块 F · F2：config 未加载完成不允许保存（双保险，saveButton 已 disabled）。
        //   防止 cachedConfig 仍为 null 时浅合并基底为空 → 写空 config 丢 seed 字段（资金红线）。
        if (!configLoaded) return;
        // v2.1.16 A1：先校验优先级（0-3 整数）。失败走与「0 渠道」一致的 alert + reopen 模式，
        //   避免用户点确认后回不到本弹窗（reopen 会从 DB 回填上次有效 priority）。
        const priorityRaw = priorityInput ? priorityInput.value : '0';
        const priorityNum = Number(priorityRaw);
        if (!Number.isInteger(priorityNum) || priorityNum < 0 || priorityNum > 3) {
          closePanel();
          pushAlert(overlay, () => createAlertDialog('优先级必须是 0-3 之间的整数', {
            onConfirm: null
          }));
          return;
        }
        let dateMatchEnabled = null;
        let dateToleranceDays = null;
        if (isCanonicalFundTransferOwner) {
          dateMatchEnabled = dateMatchEnabledCheck && dateMatchEnabledCheck.checked === true;
          dateToleranceDays = Number(dateToleranceDaysInput ? dateToleranceDaysInput.value : '');
          if (!Number.isInteger(dateToleranceDays) || dateToleranceDays < 1 || dateToleranceDays > 999) {
            if (datePolicyError) {
              datePolicyError.textContent = '调拨单匹配日期天数必须是 1–999 的整数';
              datePolicyError.hidden = false;
            }
            return;
          }
          if (datePolicyError) datePolicyError.hidden = true;
        }
        // v2.1.13 PR#58 review P2-C：阻止 0 选项保存。后端定义「空数组 = 适用全部」，
        //   若允许取消全部勾选后保存空数组，会与用户"不适用任何渠道"的直觉相反（反向变全渠道生效）。
        if (!isCanonicalFundTransferOwner && selectedIds.size === 0) {
          // v2.1.13 PR#58 review P3：openModal 替换当前弹窗 → 校验 alert 传 onConfirm reopen 适用渠道弹窗，
          //   避免用户点确认后回不到配置弹窗（否则需从场景列表重新点「管理」）。先移除浮动面板避免残留。
          closePanel();
          pushAlert(overlay, () => createAlertDialog('请至少选择一个适用的银行渠道', {
            onConfirm: null
          }));
          return;
        }
        // v3.0.4 块 F · F1：Payment 线下调拨订单回填处理 —— 勾选时银行渠道/地区/大账号三项全必填（Q1 拍板）。
        //   inline 校验：在弹窗内展开区显示错误提示，不关弹窗、不 reopen（保留用户已填草稿）。
        let paymentOfflineBackfill = null;
        if (isPaymentScenario && paymentCheck) {
          const enabled = paymentCheck.checked === true;
          const bankChannel = paymentBankChannelInput ? paymentBankChannelInput.value.trim() : '';
          const region = paymentRegionInput ? paymentRegionInput.value.trim() : '';
          const bigAccountRaw = paymentBigAccountInput ? paymentBigAccountInput.value : '';
          const parsedBigAccounts = bigAccountRaw.trim() === '' && !enabled
            ? { ok: true, normalized: '' }
            : parsePaymentBigAccounts(bigAccountRaw);
          if (enabled && (!bankChannel || !region || bigAccountRaw.trim() === '')) {
            if (paymentError) {
              paymentError.textContent = '勾选「Payment线下调拨订单回填处理」后，银行渠道、地区、大账号三项均必填';
              paymentError.hidden = false;
            }
            return; // inline 校验失败：不关弹窗、不调任何保存 IPC
          }
          if (!parsedBigAccounts || !parsedBigAccounts.ok) {
            if (paymentError) {
              paymentError.textContent = parsedBigAccounts?.message || '大账号格式无效，请使用中文顿号“、”分隔';
              paymentError.hidden = false;
            }
            return;
          }
          if (paymentError) paymentError.hidden = true;
          paymentOfflineBackfill = {
            enabled,
            bankChannel,
            region,
            bigAccount: parsedBigAccounts.normalized
          };
        }
        // v3.1.7：Payment 开启时持久化 reconSourceMid=true，防止历史冲突配置继续存在。
        let reconSourceMid = null;
        if (isPaymentScenario && reconSourceCheck) {
          reconSourceMid = paymentOfflineBackfill && paymentOfflineBackfill.enabled === true
            ? true
            : reconSourceCheck.checked === true;
        }
        let bankPaymentSerialFuzzyMatchEnabled = null;
        if (isRefundScenario && refundFuzzyCheck) {
          bankPaymentSerialFuzzyMatchEnabled = refundFuzzyCheck.checked === true;
        }
        // 全选 → 存空数组（= 适用全部，新增渠道自动适用）；否则存选中 ids
        const ids = (allChannels.length > 0 && selectedIds.size === allChannels.length)
          ? []
          : Array.from(selectedIds);
        // canonical owner 固定适用所有渠道：UI 不调用渠道写入；后端旁路也会强制归一为空。
        if (!isCanonicalFundTransferOwner) {
          const result = await scenarioCommands.scenarios.setApplicableChannels(scenarioId, ids);
          if (!result || result.status !== 'ok') {
            pushAlert(overlay, () => createAlertDialog(`保存失败：${result?.message || '未知错误'}`));
            return;
          }
        }
        // v2.1.16 A1：适用渠道保存成功后，追加更新场景优先级（updateScenario 仅改 priority，不动 category/is_builtin）。
        // v3.0.4 块 F · F2（🔴 资金红线）：payment 场景额外携带 config 浅合并 ——
        //   读-改-写：以 cachedConfig（加载时缓存的完整 config）为基底展开，仅覆盖 reconSourceMid/paymentOfflineBackfill 子键，
        //   funcCategory/subCategory/roundPhase/directions/dateToleranceDays 等 seed 契约字段原样保留（不可丢，否则掉桶/引擎漂移）。
        //   非 payment 场景维持原行为：仅 update priority，不携带 config（不引入无谓 config 写入）。
        // v3.1.7：两项仍在同一次浅合并中写入；Payment 开启时 reconSourceMid 被强制为 true。
        const updateFields = { priority: priorityNum };
        if (isPaymentScenario && (reconSourceMid !== null || paymentOfflineBackfill)) {
          updateFields.config = { ...(cachedConfig || {}) };
          if (reconSourceMid !== null) updateFields.config.reconSourceMid = reconSourceMid;
          if (paymentOfflineBackfill) updateFields.config.paymentOfflineBackfill = paymentOfflineBackfill;
          if (dateMatchEnabled !== null) updateFields.config.dateMatchEnabled = dateMatchEnabled;
          if (dateToleranceDays !== null) updateFields.config.dateToleranceDays = dateToleranceDays;
        }
        if (isRefundScenario && bankPaymentSerialFuzzyMatchEnabled !== null) {
          updateFields.config = { ...(cachedConfig || {}) };
          updateFields.config.bankPaymentSerialFuzzyMatchEnabled = bankPaymentSerialFuzzyMatchEnabled;
        }
        const priorityResult = await scenarioCommands.scenarios.update(scenarioId, updateFields);
        if (!priorityResult || priorityResult.status !== 'ok') {
          pushAlert(overlay, () => createAlertDialog(`保存失败：${priorityResult?.message || '未知错误'}`));
          return;
        }
        teardownAndReopen();
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.13 C：复制场景弹窗（PRD §二 C）
    //   银行对账单（C1/C2/C3）：左窄「银行渠道」下拉 + 右宽「场景」下拉（右框随渠道联动，默认空）
    //   ReconID 修复（C4）：单「场景」下拉（同 category 其他场景，默认空）
    //   选定 → scenarios.get(srcId).config 深拷贝覆盖当前 draft.config（不覆盖名称，C5）→ reopen 当前配置弹窗
    //   可用范围：新建 + 修改均可（draft 始终存在）
    function createCopyScenarioDialog() {
      const draft = scenarioDraft;
      if (!draft) return createAlertDialog('无当前编辑场景，无法复制');
      const isReconIdFix = isReconIdFixCategory(draft.category);
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card copy-scenario-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">选择需要复制的场景</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body copy-scenario-body">
          <div class="copy-scenario-row">
            ${isReconIdFix
              ? '<span class="copy-scenario-field-label">场景</span>'
              : '<span class="copy-scenario-field-label-sm">银行渠道</span><div class="select-shell copy-scenario-channel-shell"><select class="template-select small" data-role="channel-select"></select></div>'}
            <div class="select-shell copy-scenario-scenario-shell"><select class="template-select" data-role="scenario-select"><option value=""></option></select></div>
          </div>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="confirm">确定</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `;

      const channelSelect = dialog.querySelector('[data-role="channel-select"]');
      const scenarioSelect = dialog.querySelector('[data-role="scenario-select"]');
      const confirmButton = dialog.querySelector('[data-action="confirm"]');
      let allScenarios = [];
      let loading = true;
      let copying = false;
      function invalidateCopy() {
        beginRead(overlay, 'copy');
        copying = false;
        confirmButton.disabled = loading;
      }
      // 同类别、同渠道筛选；仍存在的选择保持，失效源退回空选项。
      function fillScenarioOptions(channelId, selected = scenarioSelect.value) {
        let candidates = allScenarios.filter((scenario) =>
          scenario.category === draft.category && Number(scenario.id) !== Number(draft.scenarioId));
        if (!isReconIdFix && channelId != null) {
          candidates = candidates.filter((scenario) => Number(scenario.channelId || 1) === Number(channelId));
        }
        scenarioSelect.innerHTML = '<option value=""></option>'
          + candidates.map((scenario) => `<option value="${scenario.id}">${escapeHtml(scenario.name)}</option>`).join('');
        scenarioSelect.value = candidates.some(scenario => String(scenario.id) === selected) ? selected : '';
      }
      async function refreshCopyOptions() {
        loading = true;
        invalidateCopy();
        const isCurrentRead = beginRead(overlay, 'options');
        try {
          const [result, chResult] = await Promise.all([
            scenarioCommands.scenarios.list(),
            !isReconIdFix && channelSelect ? scenarioCommands.channels.list() : Promise.resolve(null)
          ]);
          if (!isCurrentRead()) return;
          if (!result || result.status !== 'ok' || !Array.isArray(result.scenarios)) throw new Error(result?.message || '场景列表不可用');
          if (channelSelect && (!chResult || chResult.status !== 'ok' || !Array.isArray(chResult.channels))) throw new Error(chResult?.message || '渠道列表不可用');
          const selectedChannel = channelSelect?.value || '';
          const selectedScenario = scenarioSelect.value;
          allScenarios = result.scenarios;
          if (channelSelect) {
            const channels = chResult.channels;
            channelSelect.innerHTML = channels.map(channel => `<option value="${channel.id}">${escapeHtml(channel.label || channel.name)}</option>`).join('');
            channelSelect.value = channels.some(channel => String(channel.id) === selectedChannel) ? selectedChannel : String(channels[0]?.id || '');
          }
          fillScenarioOptions(channelSelect ? Number(channelSelect.value) : null, selectedScenario);
          loading = false;
          confirmButton.disabled = copying;
        } catch (error) {
          if (isCurrentRead()) pushAlert(overlay, () => createAlertDialog(`加载场景失败：${error?.message || error}`));
        }
      }
      channelSelect?.addEventListener('change', () => {
        invalidateCopy();
        fillScenarioOptions(Number(channelSelect.value));
      });
      scenarioSelect.addEventListener('change', invalidateCopy);
      subscribeView(overlay, isReconIdFix ? null : refreshCopyOptions, event => {
        if (event?.kind !== 'scenarios-closed') refreshCopyOptions();
      });
      registerModal(overlay, { onMount: refreshCopyOptions });

      function backToConfig() {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
        openScenarioConfigByCategory(draft.category);
      }
      dialog.querySelector('.icon-close').addEventListener('click', backToConfig);
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', backToConfig);
      confirmButton.addEventListener('click', async () => {
        if (loading || copying || !modalBridge.host.getHandle(overlay)?.isTop()) return;
        const srcId = Number(scenarioSelect.value);
        if (!srcId) {
          pushAlert(overlay, () => createAlertDialog('请选择要复制的场景', { onConfirm: null }));
          return;
        }
        copying = true;
        confirmButton.disabled = true;
        const current = beginRead(overlay, 'copy');
        try {
          const result = await scenarioCommands.scenarios.get(srcId);
          if (!current()) return;
          if (!result || result.status !== 'ok' || !result.scenario) {
            pushAlert(overlay, () => createAlertDialog(`加载源场景失败：${result?.message || '未知错误'}`, { onConfirm: null }));
            return;
          }
          // 复制仅覆盖 config；新建草稿的 mode/name/目标渠道保持，最终仍由确认页 create。
          draft.config = JSON.parse(JSON.stringify(result.scenario.config));
          scenarioDraft = draft;
          backToConfig();
        } catch (error) {
          if (current()) pushAlert(overlay, () => createAlertDialog(`加载源场景失败：${error?.message || error}`));
        } finally {
          if (current()) { copying = false; confirmButton.disabled = loading; }
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.0.0-beta.3：新增场景流程第 1 步 — 类别选择弹窗
    // v2.1.0-beta.2 PR-A：按 allowedCategories 白名单过滤可见类别
    // v2.1.0-beta.3 T6：新增 'gateway-recon-id-fix' 类别（label "网关对账单 ReconID 修复"）
    //   实际不会暴露给用户：ReconID 模块入口的白名单总是单类别（business 或 gateway），
    //   单类别 → 跳过此弹窗直接进 C4 dialog（参考 L5573 的 add-scenario click handler）
    function createScenarioCategorySelectDialog(allowedCategories = null) {
      const ALL_CATEGORY_OPTIONS = [
        // v2.1.13 D-1：移除 'extract-recon-id'（提取ReconId-From Self）— 用户不可再新建该类别
        //   （原内置提取场景已归入 builtin-fixed 自带写死场景，由 migration 管理）
        // v2.1.13 B3：label '银行对账单字段赋值' → '银行对账单赋值自身'
        { value: 'offset-bill-mark', label: '银行对账单赋值自身' },
        // v2.1.13 B2：label '提取ReconId-From 网关' → '网关对账单赋值银行对账单'
        { value: 'gateway-recon-join', label: '网关对账单赋值银行对账单' },
        { value: 'recon-id-fix', label: '单据对账修复' },
        { value: 'gateway-recon-id-fix', label: '网关对账单修复' }
      ];
      const visibleOptions = Array.isArray(allowedCategories) && allowedCategories.length > 0
        ? ALL_CATEGORY_OPTIONS.filter((c) => allowedCategories.includes(c.value))
        : ALL_CATEGORY_OPTIONS;
      const optionsHtml = visibleOptions
        .map((c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`)
        .join('');
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-category-select-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">新增场景</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-category-body">
          <label class="scenario-category-row">
            <span class="scenario-category-label">请选择功能类别</span>
            <select class="scenario-category-select">
              ${optionsHtml}
            </select>
          </label>
        </div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="continue">继续</button>
        </div>
      `;

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        returnToScenarioManager(overlay);
      });
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        returnToScenarioManager(overlay);
      });
      dialog.querySelector('[data-action="continue"]').addEventListener('click', () => {
        const select = dialog.querySelector('.scenario-category-select');
        const category = select?.value || '';
        if (!category) return;
        // 初始化 create 模式的 draft（mode='create'，无预填）
        scenarioDraft = {
          mode: 'create',
          category,
          scenarioId: null,
          name: '',
          priority: 0,
          config: createDefaultScenarioConfig(category)
        };
        openScenarioConfigByCategory(category);
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.0.0-beta.3 PR #32b：默认 config 模板（create 模式无预填时用）
    function createDefaultScenarioConfig(category) {
      if (category === 'extract-recon-id') {
        return {
          conditions: [{ field: '', op: '等于', value: '' }],
          // v2.1.7 round 2 R5：新建默认 AND（用户日常 90% 用 AND；spec §8.6.2）
          //   ⚠️ 资金红线三层护栏（spec §8.6.5）：
          //     1) createDefaultScenarioConfig（仅 mode=create 路径）默认 AND ←本行
          //     2) pickConditionsLogicChecked helper：mode=edit + 老 scenario 无 logic 字段 → OR 选中
          //     3) c1-extract-recon-id.js runC1Scenario fallback：undefined → OR（不动；spec §2.2 引擎保护）
          //   绝不允许"老 scenario 加载时 UI 显示 AND"，否则用户点保存（未察觉默认值变化）就把语义从 OR 翻成 AND
          conditionsLogic: 'AND',
          extractByFeature: null,
          extractByOtherField: null
        };
      }
      if (category === 'offset-bill-mark') {
        // v2.1.7 F4：默认清空 — 不再预填 2 行 billTypes / 1 行 reconFields / markValue.type=2
        //   spec §5.1 / PRD §五；DB category 不变
        return {
          billTypes: [],
          reconFields: [],
          markValue: { type: null, field: '', value: '' }
        };
      }
      if (category === 'gateway-recon-join') {
        return {
          // v2.1.5 N3：柔性默认 — 空数组（不强制添加首行；区别于 C1 默认 1 行）
          conditions: [],
          reconFields: [{ seq: 1, gwField: '', bankField: '' }],
          // v2.1.8 N2：扩展 assign 数据结构（mode='direct' 兼容旧逻辑，'custom' = 自取值静态字符串）
          assign: { gwField: '', bankField: '', mode: 'direct', customValue: '' },
          // v2.1.12 需求5：extra fee 匹配 — 默认关（enabled:false + amount:0 = 与旧 C3 byte-for-byte 一致，零回归红线）
          extraFee: { enabled: false, amount: 0 }
        };
      }
      // v2.1.0-beta.1 PR-A（task A7）：C4 类默认 config（spec §8.2）
      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconFields[] → reconGroups[]
      //   每个 group 自带 leftTypeSeq/rightTypeSeq + fieldPairs[]（一组内 AND；多组 OR）
      // v2.1.0-beta.1 PR-B Round 3（Decision 4，2026-05-09）：默认 group 带 Amount 锁定字段对
      // v2.1.0-beta.3 T6：两个 ReconID 子模式共用默认 config schema（matchRules/billTypes/reconGroups/output）
      //   gateway 模式与 business 模式默认 config 结构相同；差异在 dialog 渲染（mode-switch，T7）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：gateway 子模式默认锁定字段 rightField 必须为 'receiveAmount'
      //   （之前 'Amount' 让用户新建 gateway 场景引擎匹配不到渠道账单 — 1v1/1v多/多v1 都 fixedRows=0）
      if (isReconIdFixCategory(category)) {
        const defaultLockedRight = category === 'gateway-recon-id-fix' ? 'receiveAmount' : 'Amount';
        return {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: '', op: '等于', value: '' }] }
          ],
          reconGroups: [
            {
              leftTypeSeq: 1,
              rightTypeSeq: 1,
              fieldPairs: [
                { leftField: 'Amount', rightField: defaultLockedRight, locked: true }
              ]
            }
          ],
          output: {
            mode: 'main', // 'main' | 'opp' | 'both'
            // v3.0.2 需求3：网关「修复订单ID取值」启用开关，默认 true（保持现有必填，零回归）
            //   取消勾选 → 跳过 Reference 赋值与校验（引擎取网关账单 Reference 原值）
            idEnabled: true,
            commonId: { source: 'main', suffix: '' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' } // 'auto' | 'manualMain' | 'manualOpp' | 'manualBoth'
          },
          // v2.1.1 T2-2：BillDate ±N 默认 enabled=false（引擎走 ±1day 缺省，零回归）；days=3（勾选后首次展示值）
          billDateRange: { enabled: false, days: 3 },
          // v3.0.2 需求3：网关「修复订单字段取值」独立开关 + 多行规则（默认关，零回归）
          //   rules[i] = { mainTypeSeq:Number, mainField:'', oppTypeSeq:Number, oppField:'' }
          //   🔴 mainTypeSeq/oppTypeSeq 必须存 Number（引擎用 Set<Number>.has，存字符串会静默失效）
          fieldValue: { enabled: false, rules: [] }
        };
      }
      return {};
    }

    // v2.0.0-beta.3 PR #32b：dialog 共用工具
    function buildScenarioActionsHtml(mode) {
      return getScenarioDialogActions(mode)
        .map((a) => `<button class="${a.kind}-btn small" type="button" data-action="${a.action}">${a.text}</button>`)
        .join('');
    }

    function getCategoryDialogTitle(category, mode) {
      const modeLabel = mode === 'view' ? '查看场景' : (mode === 'edit' ? '修改场景' : '新增场景');
      // v2.1.0-beta.2 PR-B（task B5）：仅 C4（recon-id-fix）类别省略 ` — 类别名` 后缀（用户决定 C1/C2/C3 保留）
      // v2.1.0-beta.3 T6：两个 ReconID 子模式都省略后缀（dialog 标题统一"新增/修改场景"）
      if (isReconIdFixCategory(category)) {
        return modeLabel;
      }
      const label = getCategoryLabel(category);
      return `${modeLabel} — ${label}`;
    }

    // v2.1.14 第4条：标题 HTML 版——「— 类别名」后缀不加粗（modeLabel 保持默认）；仅 C2/C3 dialog-title 用（去外层 escapeHtml）
    function getCategoryDialogTitleHtml(category, mode) {
      const modeLabel = mode === 'view' ? '查看场景' : (mode === 'edit' ? '修改场景' : '新增场景');
      if (isReconIdFixCategory(category)) return escapeHtml(modeLabel);
      const label = getCategoryLabel(category);
      return `${escapeHtml(modeLabel)} <span class="scenario-config-title-suffix">— ${escapeHtml(label)}</span>`;
    }

    // 把 draft.name / .priority 同步到 input
    function bindScenarioBasicFields(dialog, draft) {
      const nameInput = dialog.querySelector('input[data-field="name"]');
      const priorityInput = dialog.querySelector('input[data-field="priority"]');
      if (nameInput) {
        nameInput.addEventListener('input', () => {
          draft.name = nameInput.value;
        });
      }
      if (priorityInput) {
        priorityInput.addEventListener('input', () => {
          const v = Number(priorityInput.value);
          draft.priority = Number.isFinite(v) ? v : 0;
        });
      }
    }

    // 校验 + 错误提示（弹 alert）
    function validateScenarioDraft(draft) {
      const errors = [];
      if (!draft.name || draft.name.trim() === '') errors.push('场景名称不能为空');
      const p = Number(draft.priority);
      if (!Number.isInteger(p) || p < 0 || p > 3) errors.push('优先级必须是 0-3 之间的整数');
      if (draft.category === 'extract-recon-id') {
        const c = draft.config || {};
        if (!Array.isArray(c.conditions) || c.conditions.length === 0) errors.push('条件至少需要 1 行');
        else if (c.conditions.some((cd) => !cd.field || (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)))) {
          errors.push('条件每行的字段不能为空；非「空值/非空值」操作的值不能为空');
        }
        const f = c.extractByFeature;
        const o = c.extractByOtherField;
        // 行 4/5 至少勾一个（否则场景没有任何提取规则，运行时无产出）
        const featureChosen = !!(f && f.enabled);
        const otherChosen = !!o;
        if (!featureChosen && !otherChosen) {
          errors.push('「根据特征提取 ReconId」和「根据其他字段提取 ReconId」必须至少勾选一个');
        }
        if (featureChosen) {
          const validSearchFields = Array.isArray(f.searchFields) ? f.searchFields.filter((x) => x && String(x).trim()) : [];
          // 同步清理 draft：去掉空字段（用户加了空行又不选）
          f.searchFields = validSearchFields;
          if (validSearchFields.length === 0) errors.push('"根据特征提取"的筛选字段至少选 1 个');
          if (!/^[A-Z]+$/.test(String(f.featureCode || ''))) errors.push('英文特征必须是大写英文字母（A-Z）');
          if (!Number.isInteger(Number(f.digitCount)) || Number(f.digitCount) < 1) errors.push('数字位数必须 ≥ 1');
          if (!Number.isInteger(Number(f.totalLength)) || Number(f.totalLength) < Number(f.digitCount) + String(f.featureCode || '').length) {
            errors.push('总位数必须 ≥ 数字位数 + 英文特征长度');
          }
        }
        if (otherChosen && (!o.field || o.field === '')) errors.push('"根据其他字段提取"的字段不能为空');
      } else if (draft.category === 'offset-bill-mark') {
        // v2.1.7 F4：放宽 — billTypes < 2 改 < 1；reconFields 允许 0 行；保留 reconFields ≥ 1 时内容校验
        //   赋值文案：spec §5.2 — '打标值' → '赋值'（保持向后兼容也含"赋值"语义）
        // v2.1.11 T3（spec §4.1 D-T3-1a=AND）：billTypes 行结构 {seq,field,op,value} → {seq,conditions:[{field,op,value}…]}
        //   校验改遍历 conditions：每类型 ≥ 1 条件；每条件字段非空 + 非「空值/非空值」op 的值非空
        const c = draft.config || {};
        if (!Array.isArray(c.billTypes) || c.billTypes.length < 1) errors.push('账单类型至少需要 1 行');
        else if (c.billTypes.some((b) => {
          const conds = b && Array.isArray(b.conditions) ? b.conditions : [];
          if (conds.length === 0) return true; // 空条件类型 → 不合法（引擎视为不命中，配置应禁止保存）
          return conds.some((cd) => !cd.field || (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)));
        })) {
          errors.push('账单类型每个条件的字段不能为空；非「空值/非空值」操作的值不能为空');
        }
        // v2.1.11 T3（spec §4.6）：对账字段可空 — 不强制 ≥ 1 行；保留「非空行两端字段必填」
        //   reconFields=0（全删）→ 引擎走「无条件赋值」（v2.1.7 衍生方案 A）；留空行（两端任一空）→ 报错提示用户补全或删除
        if (Array.isArray(c.reconFields) && c.reconFields.some((r) => !r.leftField || !r.rightField)) {
          errors.push('对账字段每行两端的字段都不能为空（如不需要对账请删除该行）');
        }
        if (Array.isArray(c.reconFields) && c.reconFields.some((r) => r.op !== undefined && !C2_RECON_OPS.includes(r.op))) {
          errors.push('对账字段操作符只能为“等于”或“包含”');
        }
        const mv = c.markValue || {};
        const billTypeSeqs = (c.billTypes || []).map((b) => b.seq);
        if (!billTypeSeqs.includes(Number(mv.type))) errors.push('赋值的"账单类型"必须存在于上方账单类型列表中');
        if (!mv.field) errors.push('赋值的字段不能为空');
        if (mv.value === '' || mv.value === undefined) errors.push('赋值的写入值不能为空');
      } else if (draft.category === 'gateway-recon-join') {
        const c = draft.config || {};
        if (!Array.isArray(c.reconFields) || c.reconFields.length === 0) errors.push('对账字段至少需要 1 行');
        else if (c.reconFields.some((r) => !r.gwField || !r.bankField)) errors.push('对账字段每行两端都不能为空');
        const a = c.assign || {};
        if (!a.gwField || !a.bankField) errors.push('对账成立后赋值的两端都不能为空');
        // v2.1.15 W1 补强（self-review Important）：网关账单字段须在当前 assets/网关对账单.xlsx 表头枚举内，
        //   防存量场景引用旧字段名「打开不动直接保存」存入无效字段 → 运行时静默失效。
        //   仅枚举可用时校验（降级空时跳过，不误拦）；__CUSTOM__ 为「自取值」合法 sentinel，豁免。
        {
          const gwValid = new Set(getGatewayReconFields());
          if (gwValid.size > 0) {
            if (a.gwField && a.gwField !== '__CUSTOM__' && !gwValid.has(a.gwField)) errors.push('赋值的网关账单字段已不在当前网关对账单模板表头中，请重新选择');
            if ((c.reconFields || []).some((r) => r.gwField && !gwValid.has(r.gwField))) errors.push('对账字段中存在已不在当前网关对账单模板表头的网关字段，请重新选择');
            if ((c.conditions || []).some((cd) => cd && cd.side === '网关' && cd.field && !gwValid.has(cd.field))) errors.push('条件中存在已不在当前网关对账单模板表头的网关字段，请重新选择');
          }
        }
        // v2.1.8 N2：mode='custom' 时 customValue 必填（dialog UI 已限制 maxlength=200）
        if (a.mode === 'custom' && (!a.customValue || String(a.customValue).trim() === '')) {
          errors.push('对账成立后赋值的"自取值"内容不能为空');
        }
        // v2.1.12 需求5：extra fee 校验 — 勾选后 amount 必填且为有限数（未勾选不校验；允许正负/小数/0）
        const ef = c.extraFee || {};
        if (ef.enabled) {
          if (ef.amount === '' || ef.amount === undefined || ef.amount === null) {
            errors.push('勾选「网关对账单金额与银行对账单不一致」后，extra fee 金额不能为空');
          } else if (!Number.isFinite(Number(ef.amount))) {
            errors.push('extra fee 金额必须是数字');
          }
        }
        // v2.1.5 N3：conditions 柔性校验
        //   - conditions.length === 0 → 通过（视为不过滤）
        //   - ≥ 1 行 → 每行 side / field 必填；非「空值/非空值」op 的 value 必填；side 与 field 一致性校验
        const conds = Array.isArray(c.conditions) ? c.conditions : [];
        if (conds.length > 0) {
          conds.forEach((cd, idx) => {
            const rowLabel = `条件 #${idx + 1}`;
            if (cd.side !== '网关' && cd.side !== '银行') {
              errors.push(`${rowLabel} 的"侧"必填（网关 / 银行）`);
              return;
            }
            if (!cd.field || String(cd.field).trim() === '') {
              errors.push(`${rowLabel} 的"字段"不能为空`);
              return;
            }
            // side 与 field 一致性（防御左一切换未清空 + 手改 DB）
            const validFields = cd.side === '网关' ? getGatewayReconFields() : BANK_STATEMENT_FIELDS_FOR_C3;
            if (!validFields.includes(cd.field)) {
              errors.push(`${rowLabel} 的"字段" ${cd.field} 不在 ${cd.side} 字段列表中`);
              return;
            }
            if (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)) {
              errors.push(`${rowLabel} 非"空值/非空值"操作的"值"不能为空`);
            }
          });
        }
      } else if (isReconIdFixCategory(draft.category)) {
        // v2.1.0-beta.1 PR-A（task A7）：C4 校验
        // v2.1.0-beta.3 T6：两个 ReconID 子模式共用校验（schema 相同）；SubBizType 校验跳过逻辑由 T7 按 mode 实施
        const c = draft.config || {};
        const mr = c.matchRules || {};
        if (!mr.oneToOne && !mr.oneToMany && !mr.manyToOne) {
          errors.push('单据匹配规则至少勾 1 项');
        }
        if (mr.oneToMany && mr.manyToOne) {
          errors.push('"1 v 多"与"多 v 1"互斥，不能同时勾选');
        }
        // v2.1.1 T2-2：BillDate ±N 校验（仅勾选时校验 days；不勾选 → 用默认 ±1day，无需校验）
        const bdr = c.billDateRange || null;
        if (bdr && bdr.enabled) {
          const d = Number(bdr.days);
          if (!Number.isInteger(d) || d < 1 || d > 999) {
            errors.push('BillDate 日期范围必须是 1-999 的正整数');
          }
        }
        const billTypesArr = Array.isArray(c.billTypes) ? c.billTypes : [];
        if (billTypesArr.length === 0) {
          errors.push('对账字段至少需要 1 行');
        } else {
          billTypesArr.forEach((bt, idx) => {
            if (!bt.side || (bt.side !== 'main' && bt.side !== 'opp')) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 的"主/从"必填`);
            }
            const conds = Array.isArray(bt.conditions) ? bt.conditions : [];
            if (conds.length === 0) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 至少需要 1 个条件`);
            } else if (conds.some((cd) => !cd.field || (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)))) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 每行的字段不能为空；非"空值/非空值"操作的值不能为空`);
            }
          });
        }
        // v2.1.0-beta.1 PR-A round 2 P2-2（数据完整性）：必须主从两侧都有账单类型
        // 否则保存出来的 C4 配置在 PR-B 引擎里会跑出空 leftRows / rightRows，相当于无效场景
        const hasMainBillType = billTypesArr.some((bt) => bt.side === 'main');
        const hasOppBillType = billTypesArr.some((bt) => bt.side === 'opp');
        if (billTypesArr.length > 0) {
          if (!hasMainBillType) errors.push('对账字段必须至少包含 1 条"主边"对账字段');
          if (!hasOppBillType) errors.push('对账字段必须至少包含 1 条"从边"对账字段');
        }

        // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：对账字段以 reconGroups[] 形式存储
        //   reconGroups[i] = { leftTypeSeq, rightTypeSeq, fieldPairs: [{leftField, rightField}, ...] }
        //   - 一个 group 内部 AND（fieldPair 数 ≥ 1）
        //   - 多个 group 之间 OR（group 数 ≥ 1）
        if (!Array.isArray(c.reconGroups) || c.reconGroups.length === 0) {
          errors.push('对账内容至少需要 1 个分组');
        } else {
          c.reconGroups.forEach((grp, gIdx) => {
            const grpLabel = `对账内容分组 #${gIdx + 1}`;
            if (!grp || typeof grp !== 'object') {
              errors.push(`${grpLabel} 结构错误`);
              return;
            }
            if (!Array.isArray(grp.fieldPairs) || grp.fieldPairs.length === 0) {
              errors.push(`${grpLabel} 至少需要 1 行字段对`);
            } else if (grp.fieldPairs.some((fp) => !fp || !fp.leftField || !fp.rightField)) {
              errors.push(`${grpLabel} 每行字段对的两端字段都不能为空`);
            }
          });
        }
        // v2.1.0-beta.1 PR-A round 2 P2-2（数据完整性，PR-B Q1=B 适配后保留语义）：
        //   每个 reconGroup 的 leftTypeSeq → side === 'main'；rightTypeSeq → side === 'opp'
        //   否则保存的配置语义错误，PR-B 引擎按主/从边过滤行时会丢分组
        if (Array.isArray(c.reconGroups) && c.reconGroups.length > 0 && billTypesArr.length > 0) {
          const sideBySeq = new Map(billTypesArr.map((bt) => [Number(bt.seq), bt.side]));
          c.reconGroups.forEach((grp, gIdx) => {
            if (!grp || typeof grp !== 'object') return;
            const grpLabel = `对账内容分组 #${gIdx + 1}`;
            const leftSeq = Number(grp.leftTypeSeq);
            const rightSeq = Number(grp.rightTypeSeq);
            if (!sideBySeq.has(leftSeq)) {
              errors.push(`${grpLabel} 左侧的对账字段序号 #${grp.leftTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeq.get(leftSeq) !== 'main') {
              errors.push(`${grpLabel} 左侧必须指向"主边"对账字段`);
            }
            if (!sideBySeq.has(rightSeq)) {
              errors.push(`${grpLabel} 右侧的对账字段序号 #${grp.rightTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeq.get(rightSeq) !== 'opp') {
              errors.push(`${grpLabel} 右侧必须指向"从边"对账字段`);
            }
          });
        }
        const out = c.output || {};
        // v2.1.0-beta.3 T7：errors 文案按 subMode 切换；SubBizType 校验在 gateway 模式整段跳过
        const subMode = reconIdFixModeFromCategory(draft.category);
        const isGwSubMode = subMode === 'gateway';
        // v3.0.2 需求3：gateway「修复订单ID取值」未勾选（idEnabled===false）→ 跳过 output.mode 必填 /
        //   1v多禁main / both commonId 校验（引擎取网关账单 Reference 原值）。business 模式恒视为启用，不跳过。
        const idEnabled = !isGwSubMode || out.idEnabled !== false;
        if (idEnabled) {
          if (!out.mode || (out.mode !== 'main' && out.mode !== 'opp' && out.mode !== 'both')) {
            errors.push(isGwSubMode
              ? '修复订单ID取值必填（网关账单 / 渠道账单 / 自取值）'
              : '修复结果输出方向必填（主边 / 从边 / 主从都修复）');
          }
          // gateway 模式：勾选 1v多/多v1 时禁止 output.mode='main'
          if (isGwSubMode && out.mode === 'main' && (c.matchRules.oneToMany || c.matchRules.manyToOne)) {
            errors.push('网关 1v多 / 多v1 模式下不能选择"网关账单"作为修复订单ID取值');
          }
          if (out.mode === 'both') {
            const ci = out.commonId || {};
            // v2.1.0-beta.3 修订（用户反馈）：取值来源新增空值选项 ''（用户主动选）；
            //   选择空值时 suffix "加上"输入框必须非空
            if (ci.source !== 'main' && ci.source !== 'opp' && ci.source !== '') {
              errors.push(isGwSubMode
                ? '"自取值"取值来源选项无效'
                : '"主从都修复"取值来源选项无效');
            }
            if (ci.source === '' && (!ci.suffix || String(ci.suffix).trim() === '')) {
              errors.push(isGwSubMode
                ? '"自取值"取值来源选择空值时，右侧"加上"输入框必须填写内容'
                : '"主从都修复"取值来源选择空值时，右侧"加上"输入框必须填写内容');
            }
          }
        }
        // v3.0.2 需求3：gateway「修复订单字段取值」启用时校验规则（至少 1 条 / 四字段非空 / 字段∈枚举 / seq 指向正确 side）
        //   🔴 mainTypeSeq 必须指向 side==='main'、oppTypeSeq 指向 side==='opp'（仿上方 reconGroups sideBySeq 校验）
        if (isGwSubMode && c.fieldValue && c.fieldValue.enabled === true) {
          // v3.0.2 需求3（用户修订）：限定「网关1v1渠道」—— 勾选 1v多/多v1 时不允许启用字段取值（防御旧配置/导入绕过 UI）
          if (c.matchRules && (c.matchRules.oneToMany || c.matchRules.manyToOne)) {
            errors.push('「修复订单字段取值」仅支持"网关1v1渠道"匹配模式（请取消勾选 网关1v多 / 多v1）');
          }
          const fvRules = Array.isArray(c.fieldValue.rules) ? c.fieldValue.rules : [];
          if (fvRules.length === 0) {
            errors.push('「修复订单字段取值」已启用，至少需要 1 条规则');
          }
          const sideBySeqFv = new Map(billTypesArr.map((bt) => [Number(bt.seq), bt.side]));
          fvRules.forEach((rule, rIdx) => {
            const ruleLabel = `修复订单字段取值规则 #${rIdx + 1}`;
            if (!rule || typeof rule !== 'object') {
              errors.push(`${ruleLabel} 结构错误`);
              return;
            }
            // 网关字段（mainField）：空值只报"不能为空"，非空才查枚举
            if (!rule.mainField) {
              errors.push(`${ruleLabel} 的网关字段不能为空`);
            } else if (!GATEWAY_BILL_FIELDS.includes(rule.mainField)) {
              errors.push(`${ruleLabel} 的网关字段 ${rule.mainField} 不在网关账单字段列表中`);
            }
            // 渠道字段（oppField）
            if (!rule.oppField) {
              errors.push(`${ruleLabel} 的渠道字段不能为空`);
            } else if (!CHANNEL_BILL_FIELDS.includes(rule.oppField)) {
              errors.push(`${ruleLabel} 的渠道字段 ${rule.oppField} 不在渠道账单字段列表中`);
            }
            // 主分组 seq → 必须指向 side==='main'
            const mainSeq = Number(rule.mainTypeSeq);
            if (!sideBySeqFv.has(mainSeq)) {
              errors.push(`${ruleLabel} 的网关分组序号 #${rule.mainTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeqFv.get(mainSeq) !== 'main') {
              errors.push(`${ruleLabel} 的网关分组必须指向"主边"对账字段`);
            }
            // 从分组 seq → 必须指向 side==='opp'
            const oppSeq = Number(rule.oppTypeSeq);
            if (!sideBySeqFv.has(oppSeq)) {
              errors.push(`${ruleLabel} 的渠道分组序号 #${rule.oppTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeqFv.get(oppSeq) !== 'opp') {
              errors.push(`${ruleLabel} 的渠道分组必须指向"从边"对账字段`);
            }
          });
        }
        // gateway 模式：SubBizType 整段跳过（dialog 内已不渲染该区块）
        if (!isGwSubMode) {
          const sub = out.subBizType || {};
          const validSubModes = ['auto', 'manualMain', 'manualOpp', 'manualBoth'];
          if (!validSubModes.includes(sub.mode)) {
            errors.push('SubBizType 取值方式必填');
          }
          if (sub.mode === 'manualMain' && !sub.mainValue) errors.push('"主边单据 SubBizType 值"不能为空');
          if (sub.mode === 'manualOpp' && !sub.oppValue) errors.push('"从边单据 SubBizType 值"不能为空');
          if (sub.mode === 'manualBoth') {
            if (!sub.mainValue) errors.push('"主边单据 SubBizType 值"不能为空');
            if (!sub.oppValue) errors.push('"从边单据 SubBizType 值"不能为空');
          }
        }
      }
      return errors;
    }

    // ===== F1 — C3 配置弹窗（最简，4 行）=====
    function createScenarioConfigDialogC3() {
      const draft = scenarioDraft;
      if (!draft || draft.category !== 'gateway-recon-join') {
        return createAlertDialog('内部错误：scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      // config 防御：若 draft.config 缺失则补默认
      if (!draft.config) draft.config = createDefaultScenarioConfig('gateway-recon-join');
      const config = draft.config;
      if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
        config.reconFields = [{ seq: 1, gwField: '', bankField: '' }];
      }
      if (!config.assign) config.assign = { gwField: '', bankField: '' };
      // v2.1.5 N3：旧 v2.1.4 scenario 无 conditions 字段 → 默认空数组（不过滤）
      if (!Array.isArray(config.conditions)) {
        config.conditions = [];
      }
      // v2.1.12 需求5：老 C3 scenario 无 extraFee 字段 → 兜底默认关（与引擎 fee=null 一致，零回归）
      if (!config.extraFee || typeof config.extraFee !== 'object') {
        config.extraFee = { enabled: false, amount: 0 };
      }

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c3';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${getCategoryDialogTitleHtml(draft.category, mode)}</div>
          <span class="copy-scenario-label">复制场景</span>
          <button class="secondary-btn small copy-scenario-btn" type="button" data-action="copy-scenario">选择</button>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="同时满足全部条件才进入提取（AND）">ⓘ</span></span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="c3-conditions"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-c3-condition">+ 新增条件</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="reconFields"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-recon-field">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">对账成立后赋值</span>
            <div class="scenario-config-vs-row">
              <select class="scenario-config-input" data-field="assign-gw" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择网关账单字段</option>
                <option value="__CUSTOM__"${config.assign.gwField === '__CUSTOM__' ? ' selected' : ''}>自取值</option>
                ${renderScenarioOptions(getGatewayReconFields(), config.assign.gwField)}
              </select>
              <input class="scenario-config-input" type="text" data-field="assign-custom-value"
                     maxlength="200" placeholder="请填写自取值"
                     value="${escapeHtml(config.assign.customValue || '')}"
                     ${isReadonly ? 'disabled' : ''}
                     style="${config.assign.mode === 'custom' ? '' : 'display:none;'}">
              <span class="scenario-config-vs-arrow">赋值给</span>
              <select class="scenario-config-input" data-field="assign-bank" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择银行对账单字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS_FOR_C3, config.assign.bankField)}
              </select>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-extrafee">
            <label class="scenario-config-extrafee-check">
              <input type="checkbox" data-field="extrafee-enabled" ${config.extraFee.enabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              网关对账单金额与银行对账单不一致
            </label>
            <span class="scenario-config-extrafee-hint" style="${config.extraFee.enabled ? '' : 'display:none;'}">
              输入框的差额用于网关账单与银行对账单的金额比对
            </span>
          </div>
          <div class="scenario-config-row scenario-config-row-extrafee-formula-row" style="${config.extraFee.enabled ? '' : 'display:none;'}">
            <span class="scenario-config-extrafee-formula">
              网关对账单金额 +
              <input class="scenario-config-input scenario-config-input-fee" type="text" data-field="extrafee-amount"
                     value="${escapeHtml(String(config.extraFee.amount ?? ''))}" ${isReadonly ? 'disabled' : ''}>
              = 银行对账单金额
            </span>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const reconRowsContainer = dialog.querySelector('[data-multi="reconFields"]');
      const c3CondContainer = dialog.querySelector('[data-multi="c3-conditions"]');

      // ===== v2.1.5 N3：「条件」栏渲染 + 数据流 =====
      // v2.1.5 fix1.1：用 scenario-config-c3-cond-row 专属 class（grid 布局列宽固定）
      //   - 不复用 .scenario-config-multi-row（避免影响 reconFields 行的 flex 布局）
      //   - 左二字段 select 固定 240px，超长字段名由浏览器原生 ellipsis 截断；下拉打开时 option 完整可见
      //   - v2.1.15 W1：网关侧字段来自 getGatewayReconFields()（xlsx 表头缓存），首帧可能空 → then 后重渲染
      function renderC3ConditionRow(cd, idx) {
        const fields = cd.side === '银行' ? BANK_STATEMENT_FIELDS_FOR_C3 : getGatewayReconFields();
        const valueHidden = !opNeedsValue(cd.op);
        return `
          <div class="scenario-config-c3-cond-row" data-c3-cond-row="${idx}">
            <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="side" ${isReadonly ? 'disabled' : ''}>
              <option value="网关"${cd.side === '网关' ? ' selected' : ''}>网关</option>
              <option value="银行"${cd.side === '银行' ? ' selected' : ''}>银行</option>
            </select>
            <select class="scenario-config-input scenario-config-c3-cond-field" data-c3-cond-field="field" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(fields, cd.field)}
            </select>
            <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="op" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
            </select>
            <input class="scenario-config-input" type="text" data-c3-cond-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${valueHidden ? 'style="visibility:hidden"' : ''}>
            ${isReadonly ? '' : '<button class="icon-close-small" type="button" data-c3-cond-action="remove" title="删除">×</button>'}
          </div>
        `;
      }

      function renderC3Conditions() {
        if (!c3CondContainer) return;
        c3CondContainer.innerHTML = config.conditions.map((cd, idx) => renderC3ConditionRow(cd, idx)).join('');
      }
      renderC3Conditions();

      // 「条件」事件绑定（参考 C1 模式 — change / input / click 三层）
      // v2.1.5 fix1.1：closest selector 改为 .scenario-config-c3-cond-row（与 row 的专属 class 一致）
      c3CondContainer?.addEventListener('change', (event) => {
        if (isReadonly) return;
        const ctl = event.target.closest('[data-c3-cond-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        const f = ctl.dataset.c3CondField;
        if (!Number.isFinite(idx) || !config.conditions[idx]) return;
        config.conditions[idx][f] = ctl.value;
        // side 切换 → 重渲（重新拉字段下拉枚举）+ 清空 field（防御切换后旧字段名残留）
        if (f === 'side') {
          config.conditions[idx].field = '';
          renderC3Conditions();
        } else if (f === 'op') {
          // op 切换 → 重渲（隐藏/显示 value 输入框）
          renderC3Conditions();
        }
      });
      c3CondContainer?.addEventListener('input', (event) => {
        if (isReadonly) return;
        const input = event.target.closest('input[data-c3-cond-field="value"]');
        if (!input) return;
        const row = input.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx].value = input.value;
        }
      });
      c3CondContainer?.addEventListener('click', (event) => {
        if (isReadonly) return;
        const removeBtn = event.target.closest('button[data-c3-cond-action="remove"]');
        if (!removeBtn) return;
        const row = removeBtn.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        if (Number.isFinite(idx)) {
          // v2.1.5 N3 柔性校验：可删完所有条件
          config.conditions.splice(idx, 1);
          renderC3Conditions();
        }
      });
      dialog.querySelector('[data-action="add-c3-condition"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        config.conditions.push({ side: '网关', field: '', op: '等于', value: '' });
        renderC3Conditions();
      });

      function renderReconFields() {
        reconRowsContainer.innerHTML = config.reconFields.map((rf, idx) => `
          <div class="scenario-config-multi-row" data-row-index="${idx}">
            <select class="scenario-config-input" data-multi-field="gwField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择网关账单字段</option>
              ${renderScenarioOptions(getGatewayReconFields(), rf.gwField)}
            </select>
            <span class="scenario-config-vs-arrow">vs</span>
            <select class="scenario-config-input" data-multi-field="bankField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择银行对账单字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS_FOR_C3, rf.bankField)}
            </select>
            ${isReadonly || config.reconFields.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
          </div>
        `).join('');
      }
      renderReconFields();

      // v2.1.15 W1（spec §3）：网关账单字段下拉枚举异步加载。
      //   - 首帧已用当前缓存（gatewayReconHeadersValues，可能为空）同步渲染上面三处下拉，不阻塞弹窗弹出
      //   - 枚举到位后重渲染三处：① assign-gw 下拉（主 HTML 内，重建 options；保留首项 + 自取值 + 当前选中）
      //     ② 条件行网关字段 ③ 对账字段网关字段。重建 options 时不替换 select 元素本身，事件监听不丢失。
      function rerenderC3GatewayFields() {
        // v2.1.15 W1 补强（self-review Important）：枚举到位后，把不在当前网关表头枚举内的网关字段规整为空，
        //   让「DOM 显示 = config model」一致 + 保存时非空校验能拦截存量旧字段（避免静默存无效值 / 运行时失效）。
        //   仅在枚举非空（已加载，或降级到旧硬编码）时规整 → 避免首帧空枚举误清有效字段；
        //   __CUSTOM__ 是「自取值」合法 sentinel，豁免规整；bankField 枚举（BANK_STATEMENT_FIELDS_FOR_C3）本迭代未变，无需规整。
        //   self-review round2：view（只读查看）模式不规整 config —— view 应如实保留存储值供查看，
        //   且 view 不能保存、无需规整；仅编辑态（新建/修改）规整以让保存校验拦截旧字段。
        const gwValidForNormalize = isReadonly ? new Set() : new Set(getGatewayReconFields());
        if (gwValidForNormalize.size > 0) {
          if (config.assign && config.assign.gwField && config.assign.gwField !== '__CUSTOM__'
              && !gwValidForNormalize.has(config.assign.gwField)) {
            config.assign.gwField = '';
            if (config.assign.mode !== 'custom') config.assign.mode = 'direct';
          }
          if (Array.isArray(config.reconFields)) {
            for (const rf of config.reconFields) { if (rf.gwField && !gwValidForNormalize.has(rf.gwField)) rf.gwField = ''; }
          }
          if (Array.isArray(config.conditions)) {
            for (const cd of config.conditions) { if (cd.side === '网关' && cd.field && !gwValidForNormalize.has(cd.field)) cd.field = ''; }
          }
        }
        const assignGwSelect = dialog.querySelector('select[data-field="assign-gw"]');
        if (assignGwSelect) {
          assignGwSelect.innerHTML = `
            <option value="">请选择网关账单字段</option>
            <option value="__CUSTOM__"${config.assign.gwField === '__CUSTOM__' ? ' selected' : ''}>自取值</option>
            ${renderScenarioOptions(getGatewayReconFields(), config.assign.gwField)}
          `;
        }
        renderC3Conditions();
        renderReconFields();
      }
      // 弹窗可能已被关闭（用户快速取消）→ 容器脱离 DOM 时跳过 rerender（照搬 C2 isConnected 守卫）
      registerModal(overlay, { onMount: () => ensureGatewayReconHeaders().then(() => {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
        if (dialog.isConnected) rerenderC3GatewayFields();
      }) });

      bindScenarioBasicFields(dialog, draft);

      // 行 4 赋值字段同步
      dialog.querySelector('select[data-field="assign-gw"]')?.addEventListener('change', (e) => {
        const v = e.target.value;
        config.assign.gwField = v;
        // v2.1.8 N2：选「自取值」→ 显示 input + 设 mode='custom'；选真实字段 → 隐藏 input + 设 mode='direct'
        const customInput = dialog.querySelector('input[data-field="assign-custom-value"]');
        if (v === '__CUSTOM__') {
          config.assign.mode = 'custom';
          if (customInput) customInput.style.display = '';
        } else {
          config.assign.mode = 'direct';
          if (customInput) customInput.style.display = 'none';
        }
      });
      // v2.1.12 需求5：extra fee 勾选框 + 金额输入（参照 assign-custom-value 显隐套路）
      dialog.querySelector('input[data-field="extrafee-enabled"]')?.addEventListener('change', (e) => {
        config.extraFee.enabled = e.target.checked;
        // v2.1.13 UI 微调：勾选联动右侧说明文本 + 下移的公式行（含输入框）
        const hint = dialog.querySelector('.scenario-config-extrafee-hint');
        const formulaRow = dialog.querySelector('.scenario-config-row-extrafee-formula-row');
        if (hint) hint.style.display = e.target.checked ? '' : 'none';
        if (formulaRow) formulaRow.style.display = e.target.checked ? '' : 'none';
        // 取消勾选不清空 amount（保留用户输入，下次勾选还在）；校验时 enabled=false 不校验 amount
      });
      dialog.querySelector('input[data-field="extrafee-amount"]')?.addEventListener('input', (e) => {
        config.extraFee.amount = e.target.value;
      });
      dialog.querySelector('input[data-field="assign-custom-value"]')?.addEventListener('input', (e) => {
        config.assign.customValue = e.target.value;
      });
      dialog.querySelector('select[data-field="assign-bank"]')?.addEventListener('change', (e) => {
        config.assign.bankField = e.target.value;
      });

      // 行 3 多行编辑（新增 / 删除 / 字段同步）
      reconRowsContainer.addEventListener('change', (event) => {
        const select = event.target.closest('select[data-multi-field]');
        if (!select) return;
        const row = select.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = select.dataset.multiField;
        if (Number.isFinite(idx) && config.reconFields[idx]) {
          config.reconFields[idx][f] = select.value;
        }
      });
      reconRowsContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.reconFields.length > 1) {
          config.reconFields.splice(idx, 1);
          // 重排 seq
          config.reconFields.forEach((r, i) => { r.seq = i + 1; });
          renderReconFields();
        }
      });
      const addBtn = dialog.querySelector('[data-action="add-recon-field"]');
      addBtn?.addEventListener('click', () => {
        if (isReadonly) return;
        config.reconFields.push({ seq: config.reconFields.length + 1, gwField: '', bankField: '' });
        renderReconFields();
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        returnToScenarioManager(overlay);
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      // v2.1.13 C：复制场景「选择」按钮（仅 C1-C4 header 含此按钮；其他 dialog ?. 短路无害）
      dialog.querySelector('[data-action="copy-scenario"]')?.addEventListener('click', () => openScenarioView(() => createCopyScenarioDialog()));
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（scenarioDraft 仍在，input 已保留）
          pushAlert(overlay, () => createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: null
          }));
          return;
        }
        openScenarioView(() => createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F2 — C1 配置弹窗（5 行 + 行 4/5 互斥）=====
    // v2.1.7 round 2 R5 资金红线护栏 helper（spec §8.6.4 / §8.6.5）：
    //   决定 C1 dialog 加载时 AND/OR radio 哪个选中
    //   - mode=create：用 draft.config.conditionsLogic（createDefaultScenarioConfig 已注入 'AND'）
    //   - mode=edit / view：老 scenario 无 conditionsLogic 字段 → 显示 OR 选中（与引擎 fallback OR 行为一致）
    //   - mode=edit / view：新 scenario 有 'AND' / 'OR' → 用本值
    //
    //   ⚠️ 禁止修改 draft.config（helper 只读决策；用户切换 radio 后才落 config.conditionsLogic）
    //   ⚠️ 绝不允许"老 scenario 加载时 UI 显示 AND"，否则保存（未察觉默认值变化）会把语义从 OR 翻成 AND
    function pickConditionsLogicChecked(draft) {
      const mode = draft && draft.mode;
      const cfg = (draft && draft.config) || {};
      if (mode === 'create') {
        // 新建：使用 createDefaultScenarioConfig 注入的默认值（AND）；防御性 fallback 'AND'
        return cfg.conditionsLogic === 'OR' ? 'OR' : 'AND';
      }
      // 编辑 / 查看：老 scenario undefined → OR；新 scenario 用本值
      return cfg.conditionsLogic === 'AND' ? 'AND' : 'OR';
    }

    function createScenarioConfigDialogC1() {
      const draft = scenarioDraft;
      if (!draft || draft.category !== 'extract-recon-id') {
        return createAlertDialog('内部错误：scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      if (!draft.config) draft.config = createDefaultScenarioConfig('extract-recon-id');
      const config = draft.config;
      if (!Array.isArray(config.conditions) || config.conditions.length === 0) {
        config.conditions = [{ field: '', op: '等于', value: '' }];
      }
      // v2.1.7 round 2 R5：用 helper 决定 radio 选中状态（资金红线护栏，spec §8.6.5）
      //   helper 只读，不改 draft.config —— 用户切换 radio 后才落 config.conditionsLogic
      const checkedLogic = pickConditionsLogicChecked(draft);
      // 互斥状态：行 4 vs 行 5 最多勾一个
      const featureChecked = !!(config.extractByFeature && config.extractByFeature.enabled);
      const otherChecked = !!(config.extractByOtherField);
      if (featureChecked && otherChecked) {
        // 修正：默认保留行 4
        config.extractByOtherField = null;
      }

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c1';

      const featureCfg = config.extractByFeature || { enabled: false, searchFields: [], featureCode: '', digitCount: '', totalLength: '' };
      const otherCfg = config.extractByOtherField || { field: '' };

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <span class="copy-scenario-label">复制场景</span>
          <button class="secondary-btn small copy-scenario-btn" type="button" data-action="copy-scenario">选择</button>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <!-- v2.1.7 round 4 B1（spec §10.2.2 Layout-1 用户拍板）：
               左列 .scenario-config-label-stack 纵向堆叠 label "条件" + AND/OR radio；右列 conditions 列表 + 按钮
               资金红线护栏 R5 三层不动（默认 config / pickConditionsLogicChecked / 引擎 fallback OR） -->
          <div class="scenario-config-row scenario-config-row-multi">
            <div class="scenario-config-label-stack">
              <!-- v2.1.7 round 5 B1（spec §11.2.3 方案 B 单 tooltip 整合）：
                   去掉 radio 括号文本 '（同时满足）/（满足任一）'；提示合到 '条件' label tooltip 多行
                   &#10; 是 HTML 实体换行（macOS / Windows / Linux native tooltip 都兼容）
                   资金红线护栏 R5 三层不动；B1 round 4 Layout-1 字体/布局不动 -->
              <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑：&#10;AND — 同时满足所有条件才命中&#10;OR — 满足任一条件即命中">ⓘ</span></span>
              <div class="scenario-config-logic-inline">
                <label class="scenario-config-logic-option">
                  <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                  AND
                </label>
                <label class="scenario-config-logic-option">
                  <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                  OR
                </label>
              </div>
            </div>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="conditions"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <label class="scenario-config-mutex-label">
              <input type="checkbox" data-field="extract-feature-enabled" ${featureChecked ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>根据特征提取 ReconId</span>
            </label>
            <div class="scenario-config-mutex-content" data-mutex="feature">
              <div class="scenario-config-feature-grid">
                <label>筛选字段：
                  <button class="new-account-input new-account-currency-dropdown-btn big-account-currency-dropdown-btn scenario-config-feature-search-btn"
                          type="button"
                          ${isReadonly || !featureChecked ? 'disabled' : ''}
                          data-field="feature-search-fields-btn"
                          aria-expanded="false"></button>
                </label>
                <label>英文特征：<input class="scenario-config-input scenario-config-input-narrow" type="text" data-field="feature-code" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${escapeHtml(featureCfg.featureCode || '')}" placeholder="如 FT"></label>
                <label>数字位数：<input class="scenario-config-input scenario-config-input-narrow" type="number" min="1" data-field="feature-digit-count" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${featureCfg.digitCount ?? ''}"></label>
                <label>总位数：<input class="scenario-config-input scenario-config-input-narrow" type="number" min="1" data-field="feature-total-length" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${featureCfg.totalLength ?? ''}"></label>
              </div>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <label class="scenario-config-mutex-label">
              <input type="checkbox" data-field="extract-other-enabled" ${otherChecked ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>根据其他字段提取 ReconId</span>
            </label>
            <div class="scenario-config-mutex-content" data-mutex="other">
              <label>字段：<select class="scenario-config-input" data-field="other-field" ${isReadonly || !otherChecked ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS, otherCfg.field)}
              </select></label>
            </div>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const condContainer = dialog.querySelector('[data-multi="conditions"]');

      function renderConditions() {
        condContainer.innerHTML = config.conditions.map((cd, idx) => {
          const valueHidden = !opNeedsValue(cd.op);
          return `
            <div class="scenario-config-multi-row" data-row-index="${idx}">
              <select class="scenario-config-input" data-multi-field="field" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS, cd.field)}
              </select>
              <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="op" ${isReadonly ? 'disabled' : ''}>
                ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
              </select>
              <input class="scenario-config-input" type="text" data-multi-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${valueHidden ? 'style="visibility:hidden"' : ''}>
              ${isReadonly || config.conditions.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
            </div>
          `;
        }).join('');
      }
      renderConditions();

      bindScenarioBasicFields(dialog, draft);

      // 行 3 多行编辑
      condContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = ctl.dataset.multiField;
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx][f] = ctl.value;
          if (f === 'op') renderConditions();  // 切换"空值/非空值"时重渲（隐藏值输入）
        }
      });
      condContainer.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-multi-field="value"]');
        if (!input) return;
        const row = input.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx].value = input.value;
        }
      });
      condContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.conditions.length > 1) {
          config.conditions.splice(idx, 1);
          renderConditions();
        }
      });
      dialog.querySelector('[data-action="add-condition"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        config.conditions.push({ field: '', op: '等于', value: '' });
        renderConditions();
      });

      // v2.1.7 F1：AND/OR radio 切换 → 直接落 config.conditionsLogic
      //   只读模式 disabled 已在 innerHTML 渲染时设置；这里仍多一层 isReadonly 防御
      dialog.querySelectorAll('input[name="conditionsLogic"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (isReadonly) return;
          if (radio.checked) {
            config.conditionsLogic = (radio.value === 'AND') ? 'AND' : 'OR';
          }
        });
      });

      // 行 4/5 互斥 + 启用切换
      const featureCheckbox = dialog.querySelector('input[data-field="extract-feature-enabled"]');
      const otherCheckbox = dialog.querySelector('input[data-field="extract-other-enabled"]');
      function setFeatureEnabled(enabled) {
        if (enabled) {
          if (!config.extractByFeature) config.extractByFeature = { enabled: true, searchFields: [], featureCode: '', digitCount: '', totalLength: '' };
          else config.extractByFeature.enabled = true;
          config.extractByOtherField = null;
        } else if (config.extractByFeature) {
          config.extractByFeature.enabled = false;
        }
        // 重绘整个 dialog 的"特征提取" + "其他字段" 区块（重设 disabled 状态）
        rerender();
      }
      function setOtherEnabled(enabled) {
        if (enabled) {
          config.extractByOtherField = config.extractByOtherField || { field: '' };
          if (config.extractByFeature) config.extractByFeature.enabled = false;
        } else {
          config.extractByOtherField = null;
        }
        rerender();
      }
      featureCheckbox?.addEventListener('change', () => setFeatureEnabled(featureCheckbox.checked));
      otherCheckbox?.addEventListener('change', () => setOtherEnabled(otherCheckbox.checked));

      function rerender() {
        // 简单做法：重新打开 dialog（draft 已经更新到 state）
        openScenarioView(() => createScenarioConfigDialogC1());
      }

      // 行 4 筛选字段（与"维护大账号"页面币种多选下拉同款 floating panel）
      const searchBtn = dialog.querySelector('button[data-field="feature-search-fields-btn"]');
      const searchPanel = document.createElement('div');
      searchPanel.className = 'new-account-currency-dropdown-panel scenario-config-feature-search-panel';
      searchPanel.hidden = true;
      overlay.appendChild(searchPanel);
      let searchPanelOpen = false;

      function getSearchFieldsList() {
        const f = config.extractByFeature;
        return Array.isArray(f?.searchFields) ? f.searchFields.filter(Boolean) : [];
      }

      function updateSearchBtnLabel() {
        if (!searchBtn) return;
        const list = getSearchFieldsList();
        if (list.length === 0) {
          searchBtn.textContent = '请选择筛选字段';
        } else if (list.length === 1) {
          searchBtn.textContent = list[0];
        } else if (list.length <= 3) {
          searchBtn.textContent = list.join(', ');
        } else {
          searchBtn.textContent = `${list.length} 个字段已选`;
        }
        searchBtn.title = list.join(', ') || '请选择筛选字段';
      }

      function renderSearchPanelOptions() {
        searchPanel.replaceChildren();
        const selected = getSearchFieldsList();
        BANK_STATEMENT_FIELDS.forEach((field) => {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';
          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = field;
          const cb = document.createElement('input');
          cb.className = 'new-account-checkbox';
          cb.type = 'checkbox';
          cb.value = field;
          cb.checked = selected.includes(field);
          cb.addEventListener('change', () => {
            const all = Array.from(searchPanel.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
            if (config.extractByFeature) config.extractByFeature.searchFields = all;
            updateSearchBtnLabel();
          });
          option.append(text, cb);
          searchPanel.appendChild(option);
        });
      }

      function positionSearchPanel() {
        if (!searchBtn) return;
        const rect = searchBtn.getBoundingClientRect();
        const margin = 12;
        searchPanel.style.position = 'fixed';
        searchPanel.style.minWidth = `${Math.max(rect.width, 220)}px`;
        searchPanel.style.maxHeight = '320px';
        searchPanel.style.overflowY = 'auto';
        searchPanel.style.visibility = 'hidden';
        searchPanel.hidden = false;
        const panelHeight = searchPanel.offsetHeight || 320;
        const panelWidth = searchPanel.offsetWidth || 220;
        const left = Math.max(margin, Math.min(rect.left, window.innerWidth - panelWidth - margin));
        const top = (rect.bottom + 6 + panelHeight > window.innerHeight - margin)
          ? Math.max(margin, rect.top - panelHeight - 6)
          : rect.bottom + 6;
        searchPanel.style.left = `${left}px`;
        searchPanel.style.top = `${top}px`;
        searchPanel.style.visibility = 'visible';
      }

      function closeSearchPanel() {
        searchPanel.hidden = true;
        searchPanelOpen = false;
        searchBtn?.setAttribute('aria-expanded', 'false');
      }

      searchBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (searchBtn.disabled) return;
        if (searchPanelOpen) {
          closeSearchPanel();
          return;
        }
        renderSearchPanelOptions();
        positionSearchPanel();
        searchPanelOpen = true;
        searchBtn.setAttribute('aria-expanded', 'true');
      });

      // panel 外点击 → 关闭；dialog 关闭后自动 self-detach
      function searchPanelOutsideClick(event) {
        if (!searchPanel.isConnected) {
          document.removeEventListener('click', searchPanelOutsideClick);
          return;
        }
        if (!searchPanelOpen) return;
        if (!searchPanel.contains(event.target) && event.target !== searchBtn) {
          closeSearchPanel();
        }
      }
      registerModal(overlay, {
        onMount: () => document.addEventListener('click', searchPanelOutsideClick),
        onDispose: () => document.removeEventListener('click', searchPanelOutsideClick)
      });

      updateSearchBtnLabel();
      dialog.querySelector('input[data-field="feature-code"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) config.extractByFeature.featureCode = String(e.target.value || '').toUpperCase();
        // 不立即 rerender 避免输入光标跳；用户失焦时如果是非法值会在校验阶段提示
      });
      dialog.querySelector('input[data-field="feature-digit-count"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) {
          const v = Number(e.target.value);
          config.extractByFeature.digitCount = Number.isFinite(v) ? v : '';
        }
      });
      dialog.querySelector('input[data-field="feature-total-length"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) {
          const v = Number(e.target.value);
          config.extractByFeature.totalLength = Number.isFinite(v) ? v : '';
        }
      });
      // 行 5
      dialog.querySelector('select[data-field="other-field"]')?.addEventListener('change', (e) => {
        if (config.extractByOtherField) config.extractByOtherField.field = e.target.value;
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        returnToScenarioManager(overlay);
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      // v2.1.13 C：复制场景「选择」按钮（仅 C1-C4 header 含此按钮；其他 dialog ?. 短路无害）
      dialog.querySelector('[data-action="copy-scenario"]')?.addEventListener('click', () => openScenarioView(() => createCopyScenarioDialog()));
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（scenarioDraft 仍在，input 已保留）
          pushAlert(overlay, () => createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: null
          }));
          return;
        }
        openScenarioView(() => createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F3 — C2 配置弹窗（5 行 + 序号自动 + 联动）=====
    function createScenarioConfigDialogC2() {
      const draft = scenarioDraft;
      if (!draft || draft.category !== 'offset-bill-mark') {
        return createAlertDialog('内部错误：scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      if (!draft.config) draft.config = createDefaultScenarioConfig('offset-bill-mark');
      const config = draft.config;
      // v2.1.7 F4：仅保证是数组，不强补行（dialog 加载时允许 0 行；校验时按新规则放宽）
      //   spec §5.3 / PRD §五
      if (!Array.isArray(config.billTypes)) {
        config.billTypes = [];
      }
      // v2.1.11 T3（spec §4.2 D-T3-mig=a）：dialog 入口归一化 billTypes 单条件 → 多条件 conditions
      //   - 三处归一化对齐（scenarios-repository.normalizeC2Config / 引擎入口 / 此处 dialog）
      //   - 覆盖「不走 repository 的内存 draft」：preview fixture / 校验失败回填后的旧结构 / 老内存对象
      //   - 已是 conditions 结构 → 幂等（仅补齐缺字段）；旧 {field,op,value} → 包成 conditions:[{...}]
      config.billTypes = config.billTypes.map((bt) => {
        if (!bt || typeof bt !== 'object') return { seq: undefined, conditions: [{ field: '', op: '等于', value: '' }] };
        if (Array.isArray(bt.conditions)) {
          const conditions = bt.conditions.map((c) => ({
            field: (c && c.field) || '',
            op: (c && c.op) || '等于',
            value: c && c.value !== undefined && c.value !== null ? c.value : ''
          }));
          // 防御：conditions 为空 → 补 1 空条件占位（避免渲染出无条件行的空类型块）
          return { ...bt, conditions: conditions.length > 0 ? conditions : [{ field: '', op: '等于', value: '' }] };
        }
        const { field, op, value, ...rest } = bt;
        return {
          ...rest,
          conditions: [{
            field: field || '',
            op: op || '等于',
            value: value !== undefined && value !== null ? value : ''
          }]
        };
      });
      if (!Array.isArray(config.reconFields)) {
        config.reconFields = [];
      }
      config.reconFields = config.reconFields.map((rf) => ({
        ...rf, op: rf.op === undefined ? '等于' : rf.op
      }));
      if (!config.markValue) config.markValue = { type: null, field: '', value: '' };

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c2';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${getCategoryDialogTitleHtml(draft.category, mode)}</div>
          <span class="copy-scenario-label">复制场景</span>
          <button class="secondary-btn small copy-scenario-btn" type="button" data-action="copy-scenario">选择</button>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">账单类型 <span class="scenario-config-tooltip" title="每行 = 一种独立账单类型">ⓘ</span></span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="billTypes"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-bill-type">+ 新增账单类型</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="reconFields"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-recon-field">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">赋值</span>
            <div class="scenario-config-vs-row" data-mark-value-row></div>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const billTypeContainer = dialog.querySelector('[data-multi="billTypes"]');
      const reconContainer = dialog.querySelector('[data-multi="reconFields"]');
      const markRow = dialog.querySelector('[data-mark-value-row]');
      // v2.1.14 第3条：markValue 赋值区「自己输入」模式标志（局部变量，不落 config 避免污染后端）；枚举就绪后校正初值
      let markValueCustom = false;

      // v2.1.11 T3（spec §4.4 D-T3-1b=空白行 / D-T3-1c=子序号）：账单类型按 seq 分组渲染
      //   - 每个账单类型 = 一个分组块（.scenario-config-billtype-group，data-seq）
      //   - 块内每条件行子序号 #{seq}.{idx+1}，控件 [字段][操作][值][×删除][新增]
      //   - 一种账单类型 = 块内所有条件 AND 全满足（引擎 conditions.every）
      //   - 值控件：FundType 字段 → 严格枚举下拉；其它 → 文本输入（renderScenarioValueControl）
      //   - 删除门槛（spec §4.6）：删条件到该类型最后 1 条保留占位（避免空块 / seq 空洞）；
      //     整类型删除走顶部分组的「删类型」按钮（remove-bill-type），允许删到 0 个类型
      function renderBillTypes() {
        // 降级提示（一次性）：若用户已配 FundType 字段但枚举为空，弹窗顶部显示一行提示
        const fundTypeFields = config.billTypes.some((bt) => Array.isArray(bt.conditions) && bt.conditions.some((c) => c.field === 'FundType'))
          || config.markValue.field === 'FundType';
        billTypeContainer.innerHTML = config.billTypes.map((bt) => {
          const conditions = Array.isArray(bt.conditions) ? bt.conditions : [];
          const condRowsHtml = conditions.map((cond, ci) => `
            <div class="scenario-config-multi-row" data-seq="${bt.seq}" data-cond-index="${ci}">
              <select class="scenario-config-input" data-multi-field="field" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS, cond.field)}
              </select>
              <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="op" ${isReadonly ? 'disabled' : ''}>
                ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cond.op || '等于')}
              </select>
              ${renderScenarioValueControl('data-multi-field="value"', cond.field, cond.value, { isReadonly, hidden: !opNeedsValue(cond.op) })}
              ${isReadonly ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove-condition" title="删除条件">×</button>'}
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-multi-action="add-condition" title="在下方新增一个 AND 条件">新增</button>'}
            </div>
          `).join('');
          return `
            <div class="scenario-config-billtype-group" data-seq="${bt.seq}">
              <div class="scenario-config-billtype-group-head">
                <span class="scenario-config-billtype-group-title">账单类型 #${bt.seq}</span>
                ${isReadonly ? '' : `<button class="text-action small scenario-config-billtype-remove" type="button" data-multi-action="remove-bill-type" data-seq="${bt.seq}" title="删除整个账单类型 #${bt.seq}（含其全部条件）">删除该类型</button>`}
              </div>
              ${condRowsHtml}
            </div>
          `;
        }).join('');
        // FundType 枚举降级（文件缺失）且当前已用到 FundType 字段 → 弹窗内一次性提示
        if (fundTypeFields && shouldShowFundTypeDowngradeHint()) {
          const hint = document.createElement('div');
          hint.className = 'scenario-config-fundtype-hint';
          hint.style.cssText = 'color:var(--danger);font-size:12px;margin-top:4px;';
          hint.textContent = '未找到 FundType 枚举文件（assets/FundType枚举值.xlsx），FundType 字段值暂用手动输入';
          billTypeContainer.appendChild(hint);
        }
      }
      function renderReconFields() {
        const billTypeSeqs = config.billTypes.map((b) => b.seq);
        reconContainer.innerHTML = config.reconFields.map((rf, idx) => `
          <div class="scenario-config-multi-row" data-row-index="${idx}">
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="leftType" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(billTypeSeqs.map(String), String(rf.leftType))}
            </select>
            <select class="scenario-config-input" data-multi-field="leftField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS, rf.leftField)}
            </select>
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="op" aria-label="对账字段操作符" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(C2_RECON_OPS, rf.op)}
            </select>
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="rightType" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(billTypeSeqs.map(String), String(rf.rightType))}
            </select>
            <select class="scenario-config-input" data-multi-field="rightField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS, rf.rightField)}
            </select>
            ${isReadonly ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
          </div>
        `).join('');
      }
      function renderMarkValue() {
        const billTypeSeqs = config.billTypes.map((b) => b.seq);
        // v2.1.11 fix（手测）：markValue.type 不在有效 seq 列表（新建场景初始 null / 新增类型未校正 / 删类型失效）时，
        //   <select> 会回落显示第一项，但 model 仍是无效值 → 保存时 validateScenarioDraft
        //   `billTypeSeqs.includes(Number(mv.type))` 误报"赋值的账单类型必须存在于上方列表"。
        //   渲染前把 type 规整为第一个有效 seq，保证「下拉显示 = model」（覆盖初始/新增/删除/迁移所有路径）。
        if (billTypeSeqs.length > 0 && !billTypeSeqs.includes(Number(config.markValue.type))) {
          config.markValue.type = billTypeSeqs[0];
        }
        markRow.innerHTML = `
          <select class="scenario-config-input scenario-config-input-narrow" data-mark-field="type" ${isReadonly ? 'disabled' : ''}>
            ${renderScenarioOptions(billTypeSeqs.map(String), String(config.markValue.type))}
          </select>
          <span class="scenario-config-vs-arrow">的</span>
          <select class="scenario-config-input scenario-config-assign-select" data-mark-field="field" ${isReadonly ? 'disabled' : ''}>
            <option value="">请选择字段</option>
            ${renderScenarioOptions(BANK_STATEMENT_FIELDS, config.markValue.field)}
          </select>
          <span class="scenario-config-vs-arrow">写入值</span>
          ${renderScenarioValueControl('data-mark-field="value"', config.markValue.field, config.markValue.value, { isReadonly, allowCustom: true, customMode: markValueCustom, extraClass: 'scenario-config-assign-select' })}
        `;
      }
      function rerender() {
        renderBillTypes();
        renderReconFields();
        renderMarkValue();
      }
      rerender();

      // v2.1.11 T3（spec §4.5）：异步拉取 FundType 枚举，就绪后重渲染（把已配 FundType 字段值升级为下拉）
      //   - 首帧先以「枚举未就绪」渲染（FundType 值暂为文本输入），不阻塞弹窗弹出
      //   - 枚举到位（或降级空数组）后 rerender：成功 → FundType 值变下拉；降级 → 保持文本 + 一次性提示
      registerModal(overlay, { onMount: () => ensureFundTypeEnum().then(() => {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
        // v2.1.14 第3条：枚举就绪后，编辑态若 markValue 已存自定义值（FundType 字段但值不在枚举）→ 进入「自己输入」模式，原值显示为输入框
        if (config.markValue && config.markValue.field === 'FundType' && config.markValue.value
            && fundTypeEnumState === 'ready'
            && !fundTypeEnumValues.some((v) => String(v) === String(config.markValue.value))) {
          markValueCustom = true;
        }
        // 弹窗可能已被关闭（用户快速取消）→ 容器脱离 DOM 时跳过 rerender
        if (billTypeContainer.isConnected) rerender();
      }) });

      bindScenarioBasicFields(dialog, draft);

      // v2.1.11 T3：按 seq + condition idx 定位某条 condition（替代旧 data-row-index 直查）
      function findCondition(el) {
        const row = el.closest('.scenario-config-multi-row');
        if (!row) return null;
        const seq = Number(row.dataset.seq);
        const ci = Number(row.dataset.condIndex);
        const bt = config.billTypes.find((b) => Number(b.seq) === seq);
        if (!bt || !Array.isArray(bt.conditions) || !bt.conditions[ci]) return null;
        return { bt, ci, condition: bt.conditions[ci] };
      }

      // 行 3 账单类型多行编辑（v2.1.11 T3：改按 seq + cond idx 定位 conditions）
      billTypeContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const loc = findCondition(ctl);
        if (!loc) return;
        const f = ctl.dataset.multiField;
        if (f === 'field') {
          loc.condition.field = ctl.value;
          // 字段变化可能影响值控件类型（FundType ↔ 普通）→ 重渲染该行；同时清空旧值（避免普通值残留进 FundType 下拉）
          loc.condition.value = '';
          renderBillTypes();
        } else if (f === 'op') {
          loc.condition.op = ctl.value;
          renderBillTypes(); // op 变化影响值输入框显隐
        } else if (f === 'value') {
          // FundType 下拉的 value 走 change（select）
          loc.condition.value = ctl.value;
        }
      });
      billTypeContainer.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-multi-field="value"]');
        if (!input) return;
        const loc = findCondition(input);
        if (loc) loc.condition.value = input.value;
      });

      // v2.1.11 T3：删整个账单类型后重排 seq（1-based 连续）+ 校正行 4/5 引用（超范围回退）
      //   - 保留 v2.1.7 F4 删空语义：允许删到 0 个类型（保存校验兜底「至少 1 行」L5832 已就绪）
      function reindexBillTypesAndFixRefs() {
        config.billTypes.forEach((b, i) => { b.seq = i + 1; });
        const validSeqs = config.billTypes.map((b) => b.seq);
        config.reconFields.forEach((r) => {
          if (!validSeqs.includes(Number(r.leftType))) r.leftType = validSeqs[0] || 1;
          if (!validSeqs.includes(Number(r.rightType))) r.rightType = validSeqs[1] || validSeqs[0] || 1;
        });
        if (!validSeqs.includes(Number(config.markValue.type))) config.markValue.type = validSeqs[validSeqs.length - 1] || 1;
      }

      billTypeContainer.addEventListener('click', (event) => {
        if (isReadonly) return;
        // 1) 删整个账单类型（spec §4.6：允许删到 0 个类型）
        const removeTypeBtn = event.target.closest('button[data-multi-action="remove-bill-type"]');
        if (removeTypeBtn) {
          const seq = Number(removeTypeBtn.dataset.seq);
          const typeIdx = config.billTypes.findIndex((b) => Number(b.seq) === seq);
          if (typeIdx >= 0) {
            config.billTypes.splice(typeIdx, 1);
            reindexBillTypesAndFixRefs();
            rerender();
          }
          return;
        }
        // 2) 删单个条件
        const removeCondBtn = event.target.closest('button[data-multi-action="remove-condition"]');
        if (removeCondBtn) {
          const loc = findCondition(removeCondBtn);
          if (!loc) return;
          if (loc.bt.conditions.length > 1) {
            loc.bt.conditions.splice(loc.ci, 1);
          } else {
            // 删该类型最后 1 条件 → 不留空块/seq 空洞：重置为 1 空白条件占位
            //   （如需整类型删除，请用「删除类型」按钮）
            loc.bt.conditions = [{ field: '', op: '等于', value: '' }];
          }
          renderBillTypes();
          return;
        }
        // 3) 在当前条件下方新增一个空白 AND 条件（spec §4.4 D-T3-1b=空白行）
        const addCondBtn = event.target.closest('button[data-multi-action="add-condition"]');
        if (addCondBtn) {
          const loc = findCondition(addCondBtn);
          if (!loc) return;
          loc.bt.conditions.splice(loc.ci + 1, 0, { field: '', op: '等于', value: '' });
          renderBillTypes();
        }
      });
      dialog.querySelector('[data-action="add-bill-type"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        // v2.1.11 T3：新增账单类型 = 1 个空白条件起步（多条件结构）
        config.billTypes.push({ seq: config.billTypes.length + 1, conditions: [{ field: '', op: '等于', value: '' }] });
        rerender();
      });

      // 行 4 对账字段多行编辑
      reconContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = ctl.dataset.multiField;
        if (Number.isFinite(idx) && config.reconFields[idx]) {
          if (f === 'leftType' || f === 'rightType') config.reconFields[idx][f] = Number(ctl.value);
          else config.reconFields[idx][f] = ctl.value;
        }
      });
      reconContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        // v2.1.11 T3（spec §4.6）：对账字段可空 — 删除门槛放开到允许删到 0 行（引擎 reconFields=0 走无条件赋值）
        if (Number.isFinite(idx) && config.reconFields.length >= 1) {
          config.reconFields.splice(idx, 1);
          // 重排 seq（显示序号用 idx+1，内部 seq 字段同步保持连续）
          config.reconFields.forEach((r, i) => { r.seq = i + 1; });
          renderReconFields();
        }
      });
      dialog.querySelector('[data-action="add-recon-field"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const seqs = config.billTypes.map((b) => b.seq);
        config.reconFields.push({ seq: config.reconFields.length + 1, leftType: seqs[0] || 1, leftField: '', op: '等于', rightType: seqs[1] || seqs[0] || 1, rightField: '' });
        renderReconFields();
      });

      // 行 5 赋值（v2.1.7 F4 重命名；v2.1.11 T3：field 切 FundType 时值控件改严格下拉）
      markRow.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-mark-field]');
        if (!ctl) return;
        const f = ctl.dataset.markField;
        if (f === 'type') {
          config.markValue.type = Number(ctl.value);
        } else if (f === 'field') {
          config.markValue.field = ctl.value;
          // 字段变化可能切换值控件类型（FundType 下拉 ↔ 文本）→ 清空旧值并重渲染赋值行
          config.markValue.value = '';
          markValueCustom = false; // v2.1.14 第3条：切字段 → 退出自己输入模式
          renderMarkValue();
        } else if (f === 'value') {
          // v2.1.14 第3条：选「自己输入」→ 切输入框；否则正常存枚举值（FundType 下拉的写入值走 change）
          if (ctl.value === '__CUSTOM_INPUT__') {
            markValueCustom = true;
            config.markValue.value = '';
            renderMarkValue();
          } else {
            markValueCustom = false;
            config.markValue.value = ctl.value;
          }
        }
      });
      markRow.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-mark-field="value"]');
        if (!input) return;
        config.markValue.value = input.value;
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        returnToScenarioManager(overlay);
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      // v2.1.13 C：复制场景「选择」按钮（仅 C1-C4 header 含此按钮；其他 dialog ?. 短路无害）
      dialog.querySelector('[data-action="copy-scenario"]')?.addEventListener('click', () => openScenarioView(() => createCopyScenarioDialog()));
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（scenarioDraft 仍在，input 已保留）
          pushAlert(overlay, () => createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: null
          }));
          return;
        }
        openScenarioView(() => createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== v2.1.0-beta.1 PR-A — F5 C4 配置弹窗（5 行 + 识读按钮 disabled 占位）=====
    // 主从双下拉枚举：BUSINESS_BILL_FIELDS（主边）/ OPPONENT_BILL_FIELDS（从边）
    // 行结构详见 spec §八.1；互斥逻辑详见 PRD §三 D2 / D5
    // v2.1.0-beta.3 T7：按 subMode 切换枚举源
    //   business → BUSINESS_BILL_FIELDS / OPPONENT_BILL_FIELDS（单据对账，业务/对手部门账单）
    //   gateway  → GATEWAY_BILL_FIELDS  / CHANNEL_BILL_FIELDS（网关对账，网关/渠道账单）
    function getReconIdFixFieldsForSide(side, subMode) {
      if (subMode === 'gateway') {
        return side === 'opp' ? CHANNEL_BILL_FIELDS : GATEWAY_BILL_FIELDS;
      }
      return side === 'opp' ? OPPONENT_BILL_FIELDS : BUSINESS_BILL_FIELDS;
    }

    function createScenarioConfigDialogC4() {
      const draft = scenarioDraft;
      // v2.1.0-beta.3 T7：扩 category 校验到两个 ReconID 子模式
      if (!draft || !isReconIdFixCategory(draft.category)) {
        return createAlertDialog('内部错误：scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      // v2.1.0-beta.3 T7：从 draft.category 推导账单类别子模式（business / gateway）
      //   注意：与上一行的 mode（create/edit/view）正交，subMode 仅影响文案/枚举/SubBizType 显隐/输出列
      const subMode = reconIdFixModeFromCategory(draft.category);
      const isGatewayMode = subMode === 'gateway';
      if (!draft.config) draft.config = createDefaultScenarioConfig(draft.category);
      const config = draft.config;
      // 防御：每行字段补默认
      if (!config.matchRules) config.matchRules = { oneToOne: true, oneToMany: false, manyToOne: false };
      // v2.1.1 T2-2：BillDate ±N 默认初始化（不勾选 → 引擎走 ±1day 缺省，零回归）
      if (!config.billDateRange) config.billDateRange = { enabled: false, days: 3 };
      if (!Array.isArray(config.billTypes) || config.billTypes.length === 0) {
        config.billTypes = [{ seq: 1, side: 'main', conditions: [{ field: '', op: '等于', value: '' }] }];
      }
      // 兼容修正：保证 conditions 字段存在
      config.billTypes.forEach((bt, idx) => {
        if (!bt.seq) bt.seq = idx + 1;
        if (!bt.side) bt.side = 'main';
        if (!Array.isArray(bt.conditions) || bt.conditions.length === 0) {
          bt.conditions = [{ field: '', op: '等于', value: '' }];
        }
      });
      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconGroups[] 取代 reconFields[]
      // v2.1.0-beta.1 PR-B Round 3（Decision 4，2026-05-09）：每个 group 强制带 Amount 锁定 fieldPair
      // 兼容老 draft（用户在迁移前保存的草稿） — in-memory 转换
      if (!Array.isArray(config.reconGroups) || config.reconGroups.length === 0) {
        if (Array.isArray(config.reconFields) && config.reconFields.length > 0) {
          // 一次性把老 reconFields[] 按 seq 聚合到 reconGroups[]，并删除 reconFields
          const grouped = new Map();
          for (const rf of config.reconFields) {
            if (!rf || typeof rf !== 'object') continue;
            const seq = rf.seq;
            if (!grouped.has(seq)) {
              grouped.set(seq, {
                leftTypeSeq: rf.leftTypeSeq,
                rightTypeSeq: rf.rightTypeSeq,
                fieldPairs: []
              });
            }
            grouped.get(seq).fieldPairs.push({
              leftField: rf.leftField,
              rightField: rf.rightField,
              // Round 3：恰好 Amount/Amount 的老 fieldPair 自动补 locked
              locked: rf.leftField === 'Amount' && rf.rightField === 'Amount'
            });
          }
          config.reconGroups = Array.from(grouped.values());
          delete config.reconFields;
        } else {
          // v2.1.0-beta.3 T11：gateway 子模式默认 amount-locked 是 Amount/receiveAmount（网关账单 vs 渠道账单字段名）
          const defaultRight = isGatewayMode ? 'receiveAmount' : 'Amount';
          config.reconGroups = [{
            leftTypeSeq: 1,
            rightTypeSeq: 1,
            fieldPairs: [{ leftField: 'Amount', rightField: defaultRight, locked: true }]
          }];
        }
      } else if (Object.prototype.hasOwnProperty.call(config, 'reconFields')) {
        // 用户已是新结构，仅清理残留
        delete config.reconFields;
      }
      // 保证每个 group 自身结构完整 + Round 3：强制带一条 Amount 锁定行
      // v2.1.0-beta.3 T11：gateway 子模式 amount-locked 是 Amount/receiveAmount（渠道账单字段名）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：归一化必须主动修正 locked 行的 rightField，
      //   防止"老 draft Amount/Amount + locked=true 进 gateway dialog 后引擎匹配不到渠道"
      const lockedRightField = isGatewayMode ? 'receiveAmount' : 'Amount';
      config.reconGroups.forEach((grp) => {
        if (!Array.isArray(grp.fieldPairs) || grp.fieldPairs.length === 0) {
          grp.fieldPairs = [{ leftField: 'Amount', rightField: lockedRightField, locked: true }];
          return;
        }
        // 检查是否已有 amount-locked fieldPair（按 subMode 决定 rightField 名）
        let hasAmountLocked = false;
        grp.fieldPairs.forEach((fp) => {
          if (!fp) return;
          // 已有 locked 行：强制修正 leftField/rightField 为当前 subMode 正确字段（修复跨子模式残留）
          if (fp.locked === true) {
            if (fp.leftField !== 'Amount') fp.leftField = 'Amount';
            if (fp.rightField !== lockedRightField) fp.rightField = lockedRightField;
            hasAmountLocked = true;
            return;
          }
          // 老 draft 未标 locked 但字段对匹配 → 自动补 locked
          if (fp.leftField === 'Amount' && fp.rightField === lockedRightField) {
            fp.locked = true;
            hasAmountLocked = true;
          }
        });
        if (!hasAmountLocked) {
          // 头部插入锁定 Amount/<rightField> 行
          grp.fieldPairs.unshift({ leftField: 'Amount', rightField: lockedRightField, locked: true });
        }
      });
      if (!config.output) {
        config.output = {
          mode: 'main',
          commonId: { source: 'main', suffix: '' },
          subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
        };
      }
      if (!config.output.commonId) config.output.commonId = { source: 'main', suffix: '' };
      if (!config.output.subBizType) config.output.subBizType = { mode: 'auto', mainValue: '', oppValue: '' };
      // v3.0.2 需求3：网关「修复订单ID取值」/「修复订单字段取值」兜底默认（旧场景无字段=ID取值启用 / 字段取值关）
      //   🔴 逐条 Number() 归一 mainTypeSeq/oppTypeSeq（引擎用 Set<Number>.has，存字符串会静默失效）
      if (typeof config.output.idEnabled !== 'boolean') config.output.idEnabled = true; // 老场景无字段=启用
      if (!config.fieldValue || typeof config.fieldValue !== 'object') config.fieldValue = { enabled: false, rules: [] };
      if (typeof config.fieldValue.enabled !== 'boolean') config.fieldValue.enabled = false;
      if (!Array.isArray(config.fieldValue.rules)) config.fieldValue.rules = [];
      config.fieldValue.rules.forEach((r) => {
        r.mainTypeSeq = Number(r.mainTypeSeq) || (config.billTypes.find((b) => b.side === 'main')?.seq ?? 1);
        r.oppTypeSeq = Number(r.oppTypeSeq) || (config.billTypes.find((b) => b.side === 'opp')?.seq ?? 1);
        if (typeof r.mainField !== 'string') r.mainField = '';
        if (typeof r.oppField !== 'string') r.oppField = '';
      });

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c4';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <span class="copy-scenario-label">复制场景</span>
          <button class="secondary-btn small copy-scenario-btn" type="button" data-action="copy-scenario">选择</button>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <span class="scenario-config-label">匹配模式</span>
            <div class="scenario-config-c4-checkboxes">
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="oneToOne" ${config.matchRules.oneToOne ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 1 v 1 渠道' : '主边 1 v 1 从边'}</span>
              </label>
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="oneToMany" ${config.matchRules.oneToMany ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 1 v 多 渠道' : '主边 1 v 多 从边'}</span>
              </label>
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="manyToOne" ${config.matchRules.manyToOne ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 多 v 1 渠道' : '主边 多 v 1 从边'}</span>
              </label>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <span class="scenario-config-label" style="white-space:nowrap;">
              BillDate 日期范围
              <span class="scenario-config-tooltip" title="默认 BillDate 容错范围 ±1 天（先严格匹配，再 ±1 天容错）。勾选后可调整容错窗口为 ±N 天（N=1-999），用于跨日扎单场景。严格匹配阶段不受影响。">ⓘ</span>
            </span>
            <div class="scenario-config-c4-checkboxes">
              <label class="scenario-config-c4-checkbox-item" style="white-space:nowrap;">
                <input type="checkbox" data-c4-bill-date-range-enabled ${config.billDateRange.enabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>BillDate ±</span>
                <input type="number" data-c4-bill-date-range-days min="1" max="999" value="${Number(config.billDateRange.days) > 0 ? Number(config.billDateRange.days) : 3}" ${(!config.billDateRange.enabled || isReadonly) ? 'disabled' : ''} style="width: 3em; margin: 0 4px;">
                <span>Days</span>
              </label>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-c4-bill-types></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-c4-action="add-bill-type">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账内容</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-c4-recon-groups></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-c4-action="add-recon-group">+ 新增对账内容分组</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex"${isGatewayMode ? ' style="display:block;"' : ''}>
            ${isGatewayMode ? `
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
              <span class="scenario-config-label" style="width:auto; white-space:nowrap; margin:0;">修复订单ID取值 <span class="scenario-config-tooltip" title="指定修复订单 ID 取值：取自网关 ReconID / 取自渠道 ReconID / 自取值（自定义来源 + 拼接&quot;加上&quot;输入框文本）。">ⓘ</span></span>
              <label class="scenario-config-c4-checkbox-item" style="white-space:nowrap;"><input type="checkbox" data-c4-id-enabled ${config.output.idEnabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}><span>启用该功能</span></label>
            </div>
            ` : `
            <span class="scenario-config-label">修复结果输出 <span class="scenario-config-tooltip" title="指定修复结果写到哪一侧：主边修复 / 从边修复 / 主从都修复。选&quot;主从都修复&quot;会展开取值来源选项，决定共同 ReconID 从哪一侧取。">ⓘ</span></span>
            `}
            <div class="scenario-config-c4-output" data-c4-output></div>
          </div>
          ${isGatewayMode ? `
          <div class="scenario-config-row" style="display:block;">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
              <span class="scenario-config-label" style="width:auto; white-space:nowrap; margin:0;">修复订单字段取值 <span class="scenario-config-tooltip" title="对账匹配成功后，按规则把'匹配成功的从边[渠道分组].[渠道字段]'值赋给'匹配成功的主边[网关分组].[网关字段]'，叠加进订单修复导出行（仅落在14列订单修复模板内的目标字段体现于导出；目标列为Amount/Reference时会覆盖默认拆账/对账号取值）。仅&quot;网关1v1渠道&quot;模式可用。">ⓘ</span></span>
              <label class="scenario-config-c4-checkbox-item" style="white-space:nowrap;"><input type="checkbox" data-c4-fv-enabled ${config.fieldValue.enabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}><span>启用该功能</span></label>
              <span data-c4-fv-hint style="display:none; font-size:13px; color:var(--muted); white-space:nowrap;">仅"网关1v1渠道"模式可用</span>
            </div>
            <div class="scenario-config-multi-rows" data-c4-field-value></div>
          </div>` : ''}
        </div>
        <div class="dialog-actions">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const billTypesEl = dialog.querySelector('[data-c4-bill-types]');
      const reconGroupsEl = dialog.querySelector('[data-c4-recon-groups]');
      const outputEl = dialog.querySelector('[data-c4-output]');

      function renderBillTypes() {
        billTypesEl.innerHTML = config.billTypes.map((bt, idx) => {
          const fields = getReconIdFixFieldsForSide(bt.side, subMode);
          const conditionsHtml = (bt.conditions || []).map((cd, cIdx) => `
            <div class="scenario-config-c4-condition-row" data-c4-cond-row="${cIdx}">
              <select class="scenario-config-input" data-c4-cond-field="field" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(fields, cd.field)}
              </select>
              <select class="scenario-config-input scenario-config-input-narrow" data-c4-cond-field="op" ${isReadonly ? 'disabled' : ''}>
                ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
              </select>
              <input class="scenario-config-input" type="text" data-c4-cond-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${!opNeedsValue(cd.op) ? 'style="visibility:hidden"' : ''}>
              ${isReadonly || (bt.conditions || []).length <= 1 ? '' : '<button class="icon-close-small" type="button" data-c4-cond-action="remove" title="删除">×</button>'}
              ${isReadonly || cIdx !== 0 ? '' : `<button class="text-action small" type="button" data-c4-cond-action="add-cond" title="同序号 AND">新增</button>`}
            </div>
          `).join('');
          return `
            <div class="scenario-config-c4-bill-type" data-c4-bt-row="${idx}">
              <div class="scenario-config-c4-bt-header">
                <span class="scenario-config-multi-seq">#${bt.seq}</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-bt-field="side" ${isReadonly ? 'disabled' : ''}>
                  <option value="main"${bt.side === 'main' ? ' selected' : ''}>主边</option>
                  <option value="opp"${bt.side === 'opp' ? ' selected' : ''}>从边</option>
                </select>
                ${isReadonly || config.billTypes.length <= 1 ? '' : '<button class="icon-close-small" type="button" data-c4-bt-action="remove" title="删除该序号">×</button>'}
              </div>
              <div class="scenario-config-c4-conditions">
                ${conditionsHtml}
              </div>
            </div>
          `;
        }).join('');
      }

      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：行 4 渲染 reconGroups[]
      //   每个 group 一个 block：[左类型↓ vs 右类型↓] 头 + 多行字段对（同 group 内 AND）+ "+ 新增字段对" + "❌ 删除分组"
      //   多个 group 之间显示 "OR" 分隔（提示用户：不同 group 之间是 OR）
      //   行底"+ 新增 OR 分组"按钮（在 dialog HTML 直接渲染，事件下方绑定）
      function renderReconGroups() {
        const seqs = config.billTypes.map((b) => b.seq);
        const sideBySeq = new Map(config.billTypes.map((b) => [b.seq, b.side]));
        reconGroupsEl.innerHTML = config.reconGroups.map((grp, gIdx) => {
          const leftSide = sideBySeq.get(Number(grp.leftTypeSeq)) || 'main';
          const rightSide = sideBySeq.get(Number(grp.rightTypeSeq)) || 'opp';
          const leftFields = getReconIdFixFieldsForSide(leftSide, subMode);
          const rightFields = getReconIdFixFieldsForSide(rightSide, subMode);
          // v2.1.0-beta.2 PR-A Round 2（task R2-12）：fieldpair 加 col 1 spacer，让 [leftField][=][rightField] 与
          // group-header 的 [leftTypeSeq][vs右：][rightTypeSeq] 在 grid 上下对齐
          const fieldPairsHtml = (grp.fieldPairs || []).map((fp, fpIdx) => {
            // Round 3（Decision 4）：locked fieldPair 不可改 / 不可删
            const locked = fp && fp.locked === true;
            const fpDisabled = isReadonly || locked;
            // 锁定行：select 显示实际字段名（business 默认 Amount/Amount，gateway 默认 Amount/receiveAmount）
            // v2.1.0-beta.3 T11：按 subMode 取 locked 行的实际字段名（fp.leftField/rightField 由前面 ensure 逻辑写好）
            const lockedLeftLabel = fp && fp.leftField ? fp.leftField : 'Amount';
            const lockedRightLabel = fp && fp.rightField ? fp.rightField : 'Amount';
            const renderLeftSelect = locked
              ? `<select class="scenario-config-input" data-c4-rg-fp-field="leftField" disabled title="Amount 字段对锁定（用于池子 1v多 / 多v1 算法）">
                   <option value="${escapeHtml(lockedLeftLabel)}" selected>${escapeHtml(lockedLeftLabel)}</option>
                 </select>`
              : `<select class="scenario-config-input" data-c4-rg-fp-field="leftField" ${fpDisabled ? 'disabled' : ''}>
                   <option value="">请选择左字段</option>
                   ${renderScenarioOptions(leftFields, fp.leftField)}
                 </select>`;
            const renderRightSelect = locked
              ? `<select class="scenario-config-input" data-c4-rg-fp-field="rightField" disabled title="Amount 字段对锁定（用于池子 1v多 / 多v1 算法）">
                   <option value="${escapeHtml(lockedRightLabel)}" selected>${escapeHtml(lockedRightLabel)}</option>
                 </select>`
              : `<select class="scenario-config-input" data-c4-rg-fp-field="rightField" ${fpDisabled ? 'disabled' : ''}>
                   <option value="">请选择右字段</option>
                   ${renderScenarioOptions(rightFields, fp.rightField)}
                 </select>`;
            // 删除按钮：locked 行永不显示
            const removeBtnHtml = (isReadonly || locked || (grp.fieldPairs || []).length <= 1)
              ? ''
              : '<button class="icon-close-small" type="button" data-c4-rg-fp-action="remove" title="删除字段对">×</button>';
            // v2.1.0-beta.2 PR-A Round 2（task R2-11）："新增"按钮仅每个分组的第一行（fpIdx === 0）保留，其余隐藏
            // 锁定的 Amount 行通常 fpIdx === 0，仍保留"新增"入口；若用户调整顺序使 Amount 不在首位也按 fpIdx === 0 控制
            const addBtnHtml = isReadonly || fpIdx !== 0
              ? ''
              : '<button class="text-action small" type="button" data-c4-rg-fp-action="add" title="同分组内 AND">新增</button>';
            return `
              <div class="scenario-config-c4-recon-fieldpair${locked ? ' scenario-config-c4-recon-fieldpair-locked' : ''}" data-c4-rg-fp-row="${fpIdx}">
                <span class="scenario-config-c4-recon-fieldpair-spacer" aria-hidden="true"></span>
                ${renderLeftSelect}
                <span class="scenario-config-vs-arrow">=</span>
                ${renderRightSelect}
                ${removeBtnHtml}
                ${addBtnHtml}
              </div>
            `;
          }).join('');
          // v2.1.0-beta.2 PR-B（task B4）：分组之间不渲染 "OR" 文字，仅保留 8px 视觉间距（CSS height:8px）
          const orSeparatorHtml = gIdx > 0 ? '<div class="scenario-config-c4-recon-or-sep" aria-hidden="true"></div>' : '';
          return `
            ${orSeparatorHtml}
            <div class="scenario-config-c4-recon-group" data-c4-rg-row="${gIdx}">
              <div class="scenario-config-c4-recon-group-header">
                <!-- v2.1.0-beta.2 PR-A Round 2（task R2-12）：合并"分组 N"+"左："为单 span 占 col 1，让 [leftTypeSeq] 与下方 [leftField] 在 grid col 2 上下对齐 -->
                <span class="scenario-config-multi-seq">分组 ${gIdx + 1} 左：</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-rg-field="leftTypeSeq" ${isReadonly ? 'disabled' : ''}>
                  ${renderScenarioOptions(seqs.map(String), String(grp.leftTypeSeq))}
                </select>
                <span>vs 右：</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-rg-field="rightTypeSeq" ${isReadonly ? 'disabled' : ''}>
                  ${renderScenarioOptions(seqs.map(String), String(grp.rightTypeSeq))}
                </select>
                ${isReadonly || config.reconGroups.length === 1 ? '' : '<button class="icon-close-small" type="button" data-c4-rg-action="remove" title="删除分组">×</button>'}
              </div>
              <div class="scenario-config-c4-recon-fieldpairs">
                ${fieldPairsHtml}
              </div>
            </div>
          `;
        }).join('');
      }

      function renderOutput() {
        const out = config.output;
        const sub = out.subBizType;
        const isBoth = out.mode === 'both';
        // v3.0.2 需求3：gateway「修复订单ID取值」未勾选 → 三选一 radio + commonId 子行 disabled + 容器灰显
        //   （business 模式无此开关，恒视为启用）
        const idEnabled = !isGatewayMode || config.output.idEnabled;
        // v2.1.0-beta.3 T7：gateway 子模式文案映射
        //   主边单据 → 网关账单 / 从边单据 → 渠道账单 / 主从边都修复 → 自取值
        //   "主边单据 reconId" → "网关账单ReconID" / "从边单据 reconId" → "渠道账单ReconID"
        //   去掉"主从边共同的"字样；SubBizType 取值栏整段不渲染
        const labelMain = isGatewayMode ? '网关账单' : '主边单据';
        const labelOpp = isGatewayMode ? '渠道账单' : '从边单据';
        const labelBoth = isGatewayMode ? '自取值' : '主从边都修复';
        const labelCommonIdMain = isGatewayMode ? '网关账单ReconID' : '主边单据 reconId';
        const labelCommonIdOpp = isGatewayMode ? '渠道账单ReconID' : '从边单据 reconId';
        const labelCommonIdSuffix = isGatewayMode ? '作为修复 ID' : '作为主从边共同的修复 ID';
        // gateway：勾选 1v多 或 多v1 时"网关账单"radio 禁用（参考 PRD §3.4 / spec §2.4.2）
        const lockMainOption = isGatewayMode && (config.matchRules.oneToMany || config.matchRules.manyToOne);
        const mainDisabled = isReadonly || !idEnabled || lockMainOption;
        outputEl.innerHTML = `
          <div class="scenario-config-c4-output-modes${idEnabled ? '' : ' is-disabled'}">
            <label class="scenario-config-c4-checkbox-item${lockMainOption ? ' is-disabled' : ''}">
              <input type="radio" name="c4-output-mode" value="main" ${out.mode === 'main' ? 'checked' : ''} ${mainDisabled ? 'disabled' : ''}>
              <span>${labelMain}</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-output-mode" value="opp" ${out.mode === 'opp' ? 'checked' : ''} ${(isReadonly || !idEnabled) ? 'disabled' : ''}>
              <span>${labelOpp}</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-output-mode" value="both" ${out.mode === 'both' ? 'checked' : ''} ${(isReadonly || !idEnabled) ? 'disabled' : ''}>
              <span>${labelBoth}</span>
            </label>
          </div>
          ${isBoth ? `
            <div class="scenario-config-c4-common-id">
              <span>取</span>
              <select class="scenario-config-input" data-c4-common-id="source" ${(isReadonly || !idEnabled) ? 'disabled' : ''}>
                <!-- v2.1.0-beta.3 修订（用户反馈）：新增空值 option（人眼看为空白行），选取后右侧"加上"输入框必须有值（校验时强制） -->
                <option value=""${(!out.commonId.source) ? ' selected' : ''}></option>
                <option value="main"${out.commonId.source === 'main' ? ' selected' : ''}>${labelCommonIdMain}</option>
                <option value="opp"${out.commonId.source === 'opp' ? ' selected' : ''}>${labelCommonIdOpp}</option>
              </select>
              <!-- v2.1.0-beta.3 修订（用户反馈）：gateway 模式也加 suffix 输入框（功能同 business 的"加上"输入框） -->
              <span>加上</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-common-id="suffix" ${(isReadonly || !idEnabled) ? 'disabled' : ''} value="${escapeHtml(out.commonId.suffix || '')}" placeholder="后缀">
              <span>${labelCommonIdSuffix}</span>
            </div>
          ` : ''}
          ${isGatewayMode ? '' : `
          <div class="scenario-config-c4-sub-biz">
            <div class="scenario-config-c4-sub-biz-title">SubBizType 取值</div>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="auto" ${sub.mode === 'auto' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>订单修复表的 SubBizType 值取对应单据在对账结果表里单据子类型</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualMain" ${sub.mode === 'manualMain' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>主边单据 SubBizType 值</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-sub-field="mainValue" ${isReadonly || (sub.mode !== 'manualMain' && sub.mode !== 'manualBoth') ? 'disabled' : ''} value="${escapeHtml(sub.mainValue || '')}" placeholder="主边手填值">
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualOpp" ${sub.mode === 'manualOpp' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>从边单据 SubBizType 值</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-sub-field="oppValue" ${isReadonly || (sub.mode !== 'manualOpp' && sub.mode !== 'manualBoth') ? 'disabled' : ''} value="${escapeHtml(sub.oppValue || '')}" placeholder="从边手填值">
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualBoth" ${sub.mode === 'manualBoth' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>主从边各自手填</span>
            </label>
          </div>
          `}
        `;
      }

      // v3.0.2 需求3：网关「修复订单字段取值」多行规则渲染（仅 gateway）
      //   每行 = 下拉1(主分组seq) + 下拉2(网关字段) + 文本"取" + 下拉3(从分组seq) + 下拉4(渠道字段)
      //   下拉1/3 枚举来自 config.billTypes 的 side==='main'/'opp' 序号；下拉2/4 用 GATEWAY/CHANNEL_BILL_FIELDS
      //   🔴 seq 存盘必须 Number（引擎 Set<Number>.has），事件里 Number(ctl.value)
      function renderFieldValue() {
        if (!isGatewayMode) return;
        const fvEl = dialog.querySelector('[data-c4-field-value]');
        if (!fvEl) return;
        // v3.0.2 需求3（用户修订）：限定「网关1v1渠道」—— 勾选 1v多/多v1 时禁用开关 + 强制关闭 + 显示提示
        const fvLocked = !!(config.matchRules.oneToMany || config.matchRules.manyToOne);
        if (fvLocked && config.fieldValue.enabled) config.fieldValue.enabled = false;
        const fvToggle = dialog.querySelector('input[data-c4-fv-enabled]');
        if (fvToggle) {
          fvToggle.disabled = isReadonly || fvLocked;
          fvToggle.checked = config.fieldValue.enabled;
        }
        const fvHint = dialog.querySelector('[data-c4-fv-hint]');
        if (fvHint) fvHint.style.display = fvLocked ? '' : 'none';
        const enabled = config.fieldValue.enabled;
        const mainSeqs = config.billTypes.filter((b) => b.side === 'main').map((b) => b.seq);
        const oppSeqs = config.billTypes.filter((b) => b.side === 'opp').map((b) => b.seq);
        const rules = config.fieldValue.rules;
        // 勾选启用但无规则 → 自动补 1 行（首个 main / opp 分组）
        if (enabled && rules.length === 0) rules.push({ mainTypeSeq: mainSeqs[0] ?? 1, mainField: '', oppTypeSeq: oppSeqs[0] ?? 1, oppField: '' });
        const disabled = isReadonly || !enabled;
        fvEl.innerHTML = rules.map((rule, idx) => `
          <div class="scenario-config-c4-fv-row" data-c4-fv-row="${idx}">
            <select class="scenario-config-input scenario-config-input-narrow" data-c4-fv-field="mainTypeSeq" ${disabled ? 'disabled' : ''}>${renderScenarioOptions(mainSeqs.map(String), String(rule.mainTypeSeq))}</select>
            <select class="scenario-config-input" data-c4-fv-field="mainField" ${disabled ? 'disabled' : ''}><option value="">请选择网关字段</option>${renderScenarioOptions(GATEWAY_BILL_FIELDS, rule.mainField)}</select>
            <span class="scenario-config-vs-arrow">取</span>
            <select class="scenario-config-input scenario-config-input-narrow" data-c4-fv-field="oppTypeSeq" ${disabled ? 'disabled' : ''}>${renderScenarioOptions(oppSeqs.map(String), String(rule.oppTypeSeq))}</select>
            <select class="scenario-config-input" data-c4-fv-field="oppField" ${disabled ? 'disabled' : ''}><option value="">请选择渠道字段</option>${renderScenarioOptions(CHANNEL_BILL_FIELDS, rule.oppField)}</select>
            ${isReadonly || !enabled || rules.length <= 1 ? '' : '<button class="icon-close-small" type="button" data-c4-fv-action="remove" title="删除规则">×</button>'}
            ${isReadonly || !enabled ? '' : '<button class="text-action small" type="button" data-c4-fv-action="add" title="新增规则">新增</button>'}
          </div>`).join('');
      }

      function rerenderAll() {
        renderBillTypes();
        renderReconGroups();
        renderOutput();
        renderFieldValue();
      }
      rerenderAll();

      bindScenarioBasicFields(dialog, draft);

      // 行 2：单据匹配规则 — 1v多 / 多v1 互斥；1v1 自由
      // v2.1.0-beta.3 T7：gateway 子模式下勾选 1v多/多v1 时"网关账单"选项被禁用 →
      //   若当前 output.mode === 'main' 自动 fallback 到 'opp'（避免"勾着的禁用项"UX 灾难）+ 重渲染 output
      dialog.querySelectorAll('input[data-c4-match]').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (isReadonly) return;
          const key = cb.dataset.c4Match;
          config.matchRules[key] = cb.checked;
          // 互斥：1v多 与 多v1 不能同时
          if (key === 'oneToMany' && cb.checked) {
            config.matchRules.manyToOne = false;
          } else if (key === 'manyToOne' && cb.checked) {
            config.matchRules.oneToMany = false;
          }
          dialog.querySelectorAll('input[data-c4-match]').forEach((other) => {
            other.checked = !!config.matchRules[other.dataset.c4Match];
          });
          // gateway 子模式：勾选 1v多/多v1 锁定"网关账单"选项；若当前选中是 main 自动切到 'opp'
          if (isGatewayMode && (config.matchRules.oneToMany || config.matchRules.manyToOne)
              && config.output.mode === 'main') {
            config.output.mode = 'opp';
          }
          // 重渲染 output（更新 lockMainOption 视觉态 + radio 选中态）
          renderOutput();
          // v3.0.2 需求3（用户修订）：联动「修复订单字段取值」1v1 限定（勾 1v多/多v1 → 禁用开关 + 清状态 + 提示）
          renderFieldValue();
        });
      });

      // v2.1.1 T2-2：BillDate ±N 区事件 — 勾选框控制启用 + 输入框联动
      const billDateEnabledEl = dialog.querySelector('input[data-c4-bill-date-range-enabled]');
      const billDateDaysEl = dialog.querySelector('input[data-c4-bill-date-range-days]');
      if (billDateEnabledEl && billDateDaysEl) {
        billDateEnabledEl.addEventListener('change', () => {
          if (isReadonly) return;
          config.billDateRange.enabled = billDateEnabledEl.checked;
          billDateDaysEl.disabled = !billDateEnabledEl.checked;
        });
        billDateDaysEl.addEventListener('input', () => {
          if (isReadonly) return;
          const v = Number(billDateDaysEl.value);
          // 仅记入 config（校验留给保存时 validateScenarioDraft；range 是 1-999 正整数）
          config.billDateRange.days = Number.isFinite(v) ? v : config.billDateRange.days;
        });
      }

      // 行 3：对账字段动态行（内部变量名 billTypes 保留）
      billTypesEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        const sideSel = event.target.closest('select[data-c4-bt-field="side"]');
        if (sideSel) {
          const row = sideSel.closest('[data-c4-bt-row]');
          const idx = Number(row.dataset.c4BtRow);
          if (Number.isFinite(idx) && config.billTypes[idx]) {
            config.billTypes[idx].side = sideSel.value === 'opp' ? 'opp' : 'main';
            // 切 side → 字段下拉枚举改变 → 清空 conditions[].field
            (config.billTypes[idx].conditions || []).forEach((cd) => { cd.field = ''; });
            // v3.0.2 需求3：切 side 后校正「修复订单字段取值」失效 seq（main/opp 归属变了）+ 刷新下拉
            //   🔴 回退值保持 Number；某侧无 billType 时兜底 1，业务正确性由保存校验兜底
            const firstMainSeq = (config.billTypes.find((b) => b.side === 'main')?.seq) ?? 1;
            const firstOppSeq = (config.billTypes.find((b) => b.side === 'opp')?.seq) ?? 1;
            const sideBySeqFv = new Map(config.billTypes.map((b) => [b.seq, b.side]));
            (config.fieldValue?.rules || []).forEach((r) => {
              if (sideBySeqFv.get(Number(r.mainTypeSeq)) !== 'main') r.mainTypeSeq = firstMainSeq;
              if (sideBySeqFv.get(Number(r.oppTypeSeq)) !== 'opp') r.oppTypeSeq = firstOppSeq;
            });
            renderBillTypes();
            renderReconGroups(); // 联动行 4 字段下拉
            renderFieldValue(); // 联动「修复订单字段取值」分组下拉
          }
          return;
        }
        const condCtl = event.target.closest('[data-c4-cond-field]');
        if (condCtl) {
          const btRow = condCtl.closest('[data-c4-bt-row]');
          const condRow = condCtl.closest('[data-c4-cond-row]');
          if (!btRow || !condRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          const condIdx = Number(condRow.dataset.c4CondRow);
          const f = condCtl.dataset.c4CondField;
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]
              && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions[condIdx]) {
            config.billTypes[btIdx].conditions[condIdx][f] = condCtl.value;
            if (f === 'op') renderBillTypes();
          }
        }
      });
      billTypesEl.addEventListener('input', (event) => {
        if (isReadonly) return;
        const input = event.target.closest('input[data-c4-cond-field="value"]');
        if (!input) return;
        const btRow = input.closest('[data-c4-bt-row]');
        const condRow = input.closest('[data-c4-cond-row]');
        if (!btRow || !condRow) return;
        const btIdx = Number(btRow.dataset.c4BtRow);
        const condIdx = Number(condRow.dataset.c4CondRow);
        if (Number.isFinite(btIdx) && config.billTypes[btIdx]
            && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions[condIdx]) {
          config.billTypes[btIdx].conditions[condIdx].value = input.value;
        }
      });
      billTypesEl.addEventListener('click', (event) => {
        if (isReadonly) return;
        const removeBtBtn = event.target.closest('button[data-c4-bt-action="remove"]');
        if (removeBtBtn) {
          const row = removeBtBtn.closest('[data-c4-bt-row]');
          const idx = Number(row.dataset.c4BtRow);
          if (Number.isFinite(idx) && config.billTypes.length > 1) {
            config.billTypes.splice(idx, 1);
            // 重排 seq + 校正行 4 引用（reconGroups 每组的 leftTypeSeq/rightTypeSeq）
            config.billTypes.forEach((b, i) => { b.seq = i + 1; });
            const validSeqs = config.billTypes.map((b) => b.seq);
            (config.reconGroups || []).forEach((grp) => {
              if (!validSeqs.includes(Number(grp.leftTypeSeq))) grp.leftTypeSeq = validSeqs[0] || 1;
              if (!validSeqs.includes(Number(grp.rightTypeSeq))) grp.rightTypeSeq = validSeqs[0] || 1;
            });
            // v3.0.2 需求3：校正「修复订单字段取值」规则失效 seq（mainTypeSeq→首个 main、oppTypeSeq→首个 opp）
            //   🔴 回退值保持 Number（引擎 Set<Number>.has）；某侧无 billType 时兜底 1，业务正确性由保存校验兜底
            const firstMainSeq = (config.billTypes.find((b) => b.side === 'main')?.seq) ?? 1;
            const firstOppSeq = (config.billTypes.find((b) => b.side === 'opp')?.seq) ?? 1;
            const sideBySeqFv = new Map(config.billTypes.map((b) => [b.seq, b.side]));
            (config.fieldValue?.rules || []).forEach((r) => {
              if (sideBySeqFv.get(Number(r.mainTypeSeq)) !== 'main') r.mainTypeSeq = firstMainSeq;
              if (sideBySeqFv.get(Number(r.oppTypeSeq)) !== 'opp') r.oppTypeSeq = firstOppSeq;
            });
            rerenderAll();
          }
          return;
        }
        const removeCondBtn = event.target.closest('button[data-c4-cond-action="remove"]');
        if (removeCondBtn) {
          const btRow = removeCondBtn.closest('[data-c4-bt-row]');
          const condRow = removeCondBtn.closest('[data-c4-cond-row]');
          if (!btRow || !condRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          const condIdx = Number(condRow.dataset.c4CondRow);
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]
              && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions.length > 1) {
            config.billTypes[btIdx].conditions.splice(condIdx, 1);
            renderBillTypes();
          }
          return;
        }
        const addCondBtn = event.target.closest('button[data-c4-cond-action="add-cond"]');
        if (addCondBtn) {
          const btRow = addCondBtn.closest('[data-c4-bt-row]');
          if (!btRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]) {
            config.billTypes[btIdx].conditions.push({ field: '', op: '等于', value: '' });
            renderBillTypes();
          }
        }
      });
      dialog.querySelector('[data-c4-action="add-bill-type"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const nextSeq = config.billTypes.length + 1;
        // 默认新加的下一组从边
        const newSide = config.billTypes.length === 0 ? 'main' : (config.billTypes.length === 1 ? 'opp' : 'main');
        config.billTypes.push({ seq: nextSeq, side: newSide, conditions: [{ field: '', op: '等于', value: '' }] });
        renderBillTypes();
        renderReconGroups();
        renderFieldValue(); // v3.0.2 需求3：联动「修复订单字段取值」分组下拉（新 seq 进可选项）
      });

      // 行 4：对账内容（reconGroups[] — 每个 group 内 AND；多个 group OR；内部变量名 reconGroups 保留）
      // change 事件：处理"分组头的 leftTypeSeq/rightTypeSeq"和"字段对的 leftField/rightField"
      reconGroupsEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        // 分组头的左/右类型下拉
        const headerCtl = event.target.closest('[data-c4-rg-field]');
        if (headerCtl) {
          const grpRow = headerCtl.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          const f = headerCtl.dataset.c4RgField;
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]) {
            config.reconGroups[gIdx][f] = Number(headerCtl.value);
            // 切类型 → 字段下拉枚举改变 → 该分组内所有字段对的对应 left/rightField 清空
            // Round 3：locked Amount 行不清空（保持 'Amount' 不变）
            const sideKey = f === 'leftTypeSeq' ? 'leftField' : 'rightField';
            (config.reconGroups[gIdx].fieldPairs || []).forEach((fp) => {
              if (fp && fp.locked === true) return;
              fp[sideKey] = '';
            });
            renderReconGroups();
          }
          return;
        }
        // 字段对的 leftField / rightField 下拉（Round 3：locked 行拒绝改）
        const fpCtl = event.target.closest('[data-c4-rg-fp-field]');
        if (fpCtl) {
          const grpRow = fpCtl.closest('[data-c4-rg-row]');
          const fpRow = fpCtl.closest('[data-c4-rg-fp-row]');
          if (!grpRow || !fpRow) return;
          const gIdx = Number(grpRow.dataset.c4RgRow);
          const fpIdx = Number(fpRow.dataset.c4RgFpRow);
          const f = fpCtl.dataset.c4RgFpField;
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]
              && Number.isFinite(fpIdx) && config.reconGroups[gIdx].fieldPairs[fpIdx]) {
            const fp = config.reconGroups[gIdx].fieldPairs[fpIdx];
            if (fp && fp.locked === true) return;     // 锁定行不允许改
            fp[f] = fpCtl.value;
          }
        }
      });
      // click 事件：分组级 ❌（删除整个 group）/ 字段对级 ❌（删除单条 fieldPair）/ "+ 新增字段对"按钮
      reconGroupsEl.addEventListener('click', (event) => {
        if (isReadonly) return;
        // 删除整个分组
        const removeGrpBtn = event.target.closest('button[data-c4-rg-action="remove"]');
        if (removeGrpBtn) {
          const grpRow = removeGrpBtn.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          if (Number.isFinite(gIdx) && config.reconGroups.length > 1) {
            config.reconGroups.splice(gIdx, 1);
            renderReconGroups();
          }
          return;
        }
        // 删除某个字段对（Round 3：locked fieldPair 不可删，防御兜底）
        const removeFpBtn = event.target.closest('button[data-c4-rg-fp-action="remove"]');
        if (removeFpBtn) {
          const grpRow = removeFpBtn.closest('[data-c4-rg-row]');
          const fpRow = removeFpBtn.closest('[data-c4-rg-fp-row]');
          if (!grpRow || !fpRow) return;
          const gIdx = Number(grpRow.dataset.c4RgRow);
          const fpIdx = Number(fpRow.dataset.c4RgFpRow);
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]
              && Number.isFinite(fpIdx) && config.reconGroups[gIdx].fieldPairs[fpIdx]) {
            const fp = config.reconGroups[gIdx].fieldPairs[fpIdx];
            if (fp && fp.locked === true) return;     // 锁定行拒绝删除
            if (config.reconGroups[gIdx].fieldPairs.length > 1) {
              config.reconGroups[gIdx].fieldPairs.splice(fpIdx, 1);
              renderReconGroups();
            }
          }
          return;
        }
        // 同分组内 "+ 新增字段对"（AND）
        const addFpBtn = event.target.closest('button[data-c4-rg-fp-action="add"]');
        if (addFpBtn) {
          const grpRow = addFpBtn.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]) {
            config.reconGroups[gIdx].fieldPairs.push({ leftField: '', rightField: '' });
            renderReconGroups();
          }
        }
      });
      // "+ 新增 OR 分组"（Round 3：新分组默认带 Amount 锁定 fieldPair）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：gateway 子模式 rightField 必须为 'receiveAmount'
      dialog.querySelector('[data-c4-action="add-recon-group"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const seqs = config.billTypes.map((b) => b.seq);
        const newGroupLockedRight = isGatewayMode ? 'receiveAmount' : 'Amount';
        config.reconGroups.push({
          leftTypeSeq: seqs[0] || 1,
          rightTypeSeq: seqs[1] || seqs[0] || 1,
          fieldPairs: [{ leftField: 'Amount', rightField: newGroupLockedRight, locked: true }]
        });
        renderReconGroups();
      });

      // 行 5：修复结果输出
      outputEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        // mode 切换
        const modeRadio = event.target.closest('input[name="c4-output-mode"]');
        if (modeRadio && modeRadio.checked) {
          config.output.mode = modeRadio.value;
          renderOutput();
          return;
        }
        // sub mode 切换
        const subRadio = event.target.closest('input[name="c4-sub-mode"]');
        if (subRadio && subRadio.checked) {
          config.output.subBizType.mode = subRadio.value;
          renderOutput();
          return;
        }
        // commonId.source
        // v2.1.0-beta.3 修订（用户反馈）：支持空值 ''（用户主动选"空白行"），school 输入框校验在 validateScenarioDraft 内
        const ciSource = event.target.closest('[data-c4-common-id="source"]');
        if (ciSource) {
          const v = ciSource.value;
          config.output.commonId.source = (v === 'main' || v === 'opp' || v === '') ? v : 'main';
        }
      });
      outputEl.addEventListener('input', (event) => {
        if (isReadonly) return;
        const ciSuffix = event.target.closest('input[data-c4-common-id="suffix"]');
        if (ciSuffix) {
          config.output.commonId.suffix = ciSuffix.value;
          return;
        }
        const subInput = event.target.closest('input[data-c4-sub-field]');
        if (subInput) {
          const f = subInput.dataset.c4SubField;
          config.output.subBizType[f] = subInput.value;
        }
      });

      // v3.0.2 需求3：gateway「修复订单ID取值」启用开关（绑 dialog 级 — 勾选框在 label span 内、非 outputEl 内）
      dialog.querySelector('input[data-c4-id-enabled]')?.addEventListener('change', (e) => {
        if (isReadonly) return;
        config.output.idEnabled = e.target.checked;
        renderOutput();
      });

      // v3.0.2 需求3：gateway「修复订单字段取值」开关 + 多行规则事件（绑 dialog 级委托）
      //   🔴 seq（mainTypeSeq/oppTypeSeq）存盘必须 Number（引擎 Set<Number>.has，存字符串会静默失效）
      dialog.querySelector('input[data-c4-fv-enabled]')?.addEventListener('change', (e) => {
        if (isReadonly) return;
        config.fieldValue.enabled = e.target.checked;
        renderFieldValue();
      });
      const fvElBind = dialog.querySelector('[data-c4-field-value]');
      if (fvElBind) {
        fvElBind.addEventListener('change', (event) => {
          if (isReadonly) return;
          const ctl = event.target.closest('[data-c4-fv-field]');
          if (!ctl) return;
          const row = ctl.closest('[data-c4-fv-row]');
          const idx = Number(row?.dataset.c4FvRow);
          const f = ctl.dataset.c4FvField;
          if (!Number.isFinite(idx) || !config.fieldValue.rules[idx]) return;
          config.fieldValue.rules[idx][f] = (f === 'mainTypeSeq' || f === 'oppTypeSeq') ? Number(ctl.value) : ctl.value; // 🔴 seq 存 Number
        });
        fvElBind.addEventListener('click', (event) => {
          if (isReadonly) return;
          if (event.target.closest('button[data-c4-fv-action="add"]')) {
            const ms = config.billTypes.filter((b) => b.side === 'main').map((b) => b.seq);
            const os = config.billTypes.filter((b) => b.side === 'opp').map((b) => b.seq);
            config.fieldValue.rules.push({ mainTypeSeq: ms[0] ?? 1, mainField: '', oppTypeSeq: os[0] ?? 1, oppField: '' });
            renderFieldValue();
            return;
          }
          const rm = event.target.closest('button[data-c4-fv-action="remove"]');
          if (rm) {
            const idx = Number(rm.closest('[data-c4-fv-row]')?.dataset.c4FvRow);
            if (Number.isFinite(idx) && config.fieldValue.rules.length > 1) {
              config.fieldValue.rules.splice(idx, 1);
              renderFieldValue();
            }
          }
        });
      }

      // 识读规律按钮（PR-A 占位 disabled，PR-C 实装）
      dialog.querySelector('[data-c4-action="infer-rules"]')?.addEventListener('click', () => {
        // PR-A 仅占位提示
        pushAlert(overlay, () => createAlertDialog('"识读场景规律"功能将在 PR-C 落地。'));
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        returnToScenarioManager(overlay);
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      // v2.1.13 C：复制场景「选择」按钮（仅 C1-C4 header 含此按钮；其他 dialog ?. 短路无害）
      dialog.querySelector('[data-action="copy-scenario"]')?.addEventListener('click', () => openScenarioView(() => createCopyScenarioDialog()));
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // v2.1.0-beta.3 修订（用户反馈）：错误文本去掉 "• " 前缀
          pushAlert(overlay, () => createAlertDialog(errors.join('<br>'), {
            onConfirm: null
          }));
          return;
        }
        openScenarioView(() => createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F4 — 确认场景详情弹窗（共用，文本预览 + 完成/返回）=====
    function buildScenarioConfirmDetailHtml(draft) {
      const c = draft.config || {};
      let html = `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">类别：</span>${escapeHtml(getCategoryLabel(draft.category))}</div>`;
      html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">名称：</span>${escapeHtml(draft.name)}</div>`;
      html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">优先级：</span>${draft.priority}</div>`;
      if (draft.category === 'extract-recon-id') {
        // v2.1.7 F1：条件聚合 label 按 conditionsLogic 切换；旧 scenario 无字段 → OR
        const c1LogicLabel = (c.conditionsLogic === 'AND') ? 'AND' : 'OR';
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">条件（${c1LogicLabel}）：</span><ul>${(c.conditions || []).map((cd) => `<li>${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}</li>`).join('')}</ul></div>`;
        if (c.extractByFeature && c.extractByFeature.enabled) {
          const f = c.extractByFeature;
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">根据特征提取：</span>筛选字段 [${(f.searchFields || []).map(escapeHtml).join(', ')}]，特征 ${escapeHtml(f.featureCode)}，数字位 ${f.digitCount}，总位 ${f.totalLength}</div>`;
        }
        if (c.extractByOtherField) {
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">根据其他字段提取：</span>${escapeHtml(c.extractByOtherField.field)}</div>`;
        }
      } else if (draft.category === 'offset-bill-mark') {
        // v2.1.11 T3（spec §4.1）：账单类型多条件 AND — 每类型块内 conditions 用 AND 连接渲染
        //   兼容兜底：老内存 draft 仍是 {field,op,value} 单条件 → 包成单条件 AND 串
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">账单类型：</span><ul>${(c.billTypes || []).map((bt) => {
          const conds = Array.isArray(bt.conditions)
            ? bt.conditions
            : [{ field: bt.field, op: bt.op, value: bt.value }];
          const condsHtml = conds.map((cd) => `${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}`).join(' AND ');
          return `<li>#${bt.seq}：${condsHtml}</li>`;
        }).join('')}</ul></div>`;
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段：</span><ul>${(c.reconFields || []).map((r) => `<li>类型#${r.leftType} ${escapeHtml(r.leftField)} ${escapeHtml(r.op === undefined ? '等于' : r.op)} 类型#${r.rightType} ${escapeHtml(r.rightField)}</li>`).join('')}</ul></div>`;
        const mv = c.markValue || {};
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">赋值：</span>类型#${mv.type} 的 ${escapeHtml(mv.field || '')} 写入 "${escapeHtml(String(mv.value || ''))}"</div>`;
      } else if (draft.category === 'gateway-recon-join') {
        // v2.1.5 N3：conditions 段（仅当 ≥ 1 行时渲染）
        const conds = Array.isArray(c.conditions) ? c.conditions : [];
        if (conds.length > 0) {
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">条件（AND）：</span><ul>${conds.map((cd) => `<li>${escapeHtml(cd.side)} ${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}</li>`).join('')}</ul></div>`;
        }
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段（AND）：</span><ul>${(c.reconFields || []).map((r) => `<li>网关 ${escapeHtml(r.gwField)} = 银行 ${escapeHtml(r.bankField)}</li>`).join('')}</ul></div>`;
        const a = c.assign || {};
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">赋值：</span>网关 ${escapeHtml(a.gwField || '')} → 银行 ${escapeHtml(a.bankField || '')}</div>`;
      } else if (isReconIdFixCategory(draft.category)) {
        // v2.1.0-beta.1 PR-A（task A8）：C4 文本预览（PRD §七.2 模板）
        // v2.1.0-beta.3 T6：两个 ReconID 子模式共用预览模板（文案差异由 T7 按 mode 处理）
        const mr = c.matchRules || {};
        const mrParts = [];
        if (mr.oneToOne) mrParts.push('1 v 1');
        if (mr.oneToMany) mrParts.push('1 v 多');
        if (mr.manyToOne) mrParts.push('多 v 1');
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">匹配规则：</span>${escapeHtml(mrParts.join(' / ') || '（未选）')}</div>`;
        // v2.1.0-beta.3 T7：预览文案按 subMode 切换（主边/从边 ↔ 网关/渠道；SubBizType 在 gateway 模式不预览）
        const previewSubMode = reconIdFixModeFromCategory(draft.category);
        const isGwSubMode = previewSubMode === 'gateway';
        const sideLabel = (s) => isGwSubMode
          ? (s === 'opp' ? '渠道' : '网关')
          : (s === 'opp' ? '从边' : '主边');
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段：</span><ul>${(c.billTypes || []).map((bt) => {
          const condsHtml = (bt.conditions || []).map((cd) => `${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}`).join(' AND ');
          return `<li>类型#${bt.seq} (${sideLabel(bt.side)})：${condsHtml}</li>`;
        }).join('')}</ul></div>`;
        // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconGroups[] 渲染
        //   每个 group 一个 li，组内字段对 AND 用"&"分隔；多个 group 用"OR"分隔
        const reconGroupsForPreview = Array.isArray(c.reconGroups)
          ? c.reconGroups
          : (Array.isArray(c.reconFields) // 兼容老 draft（理论上 in-memory 已转，仍保留兜底）
              ? Array.from(c.reconFields.reduce((m, rf) => {
                  if (!m.has(rf.seq)) m.set(rf.seq, { leftTypeSeq: rf.leftTypeSeq, rightTypeSeq: rf.rightTypeSeq, fieldPairs: [] });
                  m.get(rf.seq).fieldPairs.push({ leftField: rf.leftField, rightField: rf.rightField });
                  return m;
                }, new Map()).values())
              : []);
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账内容：</span><ul>${reconGroupsForPreview.map((grp, gIdx) => {
          const fpStr = (grp.fieldPairs || []).map((fp) => `${escapeHtml(fp.leftField || '')}=${escapeHtml(fp.rightField || '')}`).join(' AND ');
          const orPrefix = gIdx > 0 ? '<span class="scenario-confirm-detail-or">OR</span> ' : '';
          return `<li>${orPrefix}类型#${grp.leftTypeSeq} vs 类型#${grp.rightTypeSeq}：${fpStr}</li>`;
        }).join('')}</ul></div>`;
        const out = c.output || {};
        // v2.1.0-beta.3 T7：修复方向预览文案按 subMode 切换
        const modeLabel = isGwSubMode
          ? (out.mode === 'main' ? '网关账单' : (out.mode === 'opp' ? '渠道账单' : '自取值'))
          : (out.mode === 'main' ? '主边' : (out.mode === 'opp' ? '从边' : '主从都修复'));
        const labelTitle = isGwSubMode ? '修复订单ID取值' : '修复方向';
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">${labelTitle}：</span>${escapeHtml(modeLabel)}</div>`;
        if (out.mode === 'both') {
          // v2.1.0-beta.1 PR-B（Q2=a 决策，2026-04-30）：commonId 取 reconId 不是 OrderId
          // v2.1.0-beta.3 T7：gateway 子模式预览不带 suffix（dialog 中已隐藏）
          const ci = out.commonId || {};
          if (isGwSubMode) {
            const reconIdLabel = ci.source === 'opp' ? '渠道账单ReconID' : '网关账单ReconID';
            html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">自取值：</span>${escapeHtml(reconIdLabel)}</div>`;
          } else {
            html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">共同 ID：</span>取${escapeHtml(sideLabel(ci.source))}reconId + "${escapeHtml(ci.suffix || '')}"</div>`;
          }
        }
        // SubBizType 仅 business 子模式预览
        if (!isGwSubMode) {
          const sub = out.subBizType || {};
          let subText;
          if (sub.mode === 'auto') subText = '自动查（对账结果 sheet 单据子类型）';
          else if (sub.mode === 'manualMain') subText = `主边手填 = "${sub.mainValue || ''}"`;
          else if (sub.mode === 'manualOpp') subText = `从边手填 = "${sub.oppValue || ''}"`;
          else if (sub.mode === 'manualBoth') subText = `主边手填 = "${sub.mainValue || ''}"，从边手填 = "${sub.oppValue || ''}"`;
          else subText = '（未选）';
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">SubBizType：</span>${escapeHtml(subText)}</div>`;
        }
      }
      return html;
    }

    function createScenarioConfirmDetailDialog() {
      const draft = scenarioDraft;
      if (!draft) {
        return createAlertDialog('内部错误：scenarioDraft 缺失');
      }
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-confirm-detail-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">确认场景详情</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-confirm-detail-body">
          ${buildScenarioConfirmDetailHtml(draft)}
        </div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="back">返回</button>
          <button class="primary-btn small" type="button" data-action="finish">完成</button>
        </div>
      `;

      let saving = false;
      const finishButton = dialog.querySelector('[data-action="finish"]');
      registerModal(overlay, { canClose: () => !saving });
      function backToConfig() {
        if (saving || !modalBridge.host.getHandle(overlay)?.isOpen()) return;
        // 保留 draft，重新打开对应配置弹窗
        openScenarioConfigByCategory(draft.category);
      }
      function closeAndClearDraft() {
        if (saving || !modalBridge.host.getHandle(overlay)?.isOpen()) return;
        clearScenarioDraft();
        returnToScenarioManager(overlay);
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      // v2.1.13 C：复制场景「选择」按钮（仅 C1-C4 header 含此按钮；其他 dialog ?. 短路无害）
      dialog.querySelector('[data-action="copy-scenario"]')?.addEventListener('click', () => openScenarioView(() => createCopyScenarioDialog()));
      dialog.querySelector('[data-action="back"]').addEventListener('click', backToConfig);
      finishButton.addEventListener('click', async () => {
        if (saving || !modalBridge.host.getHandle(overlay)?.isTop()) return;
        saving = true;
        finishButton.disabled = true;
        try {
          let result;
          if (draft.mode === 'create') {
            // v2.1.9 SR-FIX-1 round 2 F1（spec §16.3.2）：UI 新建场景必须附 channelId
            //   不带 channelId → 后端 INSERT 不写 channel_id → 落 NULL → dispatcher
            //   listByChannelIdAndCategory(WHERE channel_id = ?) 不匹配 NULL → 新建场景
            //   在 dispatcher 永远不命中（v2.1.9 N5 核心功能完全失效）
            //   activeScenarioChannelId 由场景管理弹框（createScenariosManagerDialog）维护
            //   当前选中渠道 id；缺省兜底「通用」(id=1)，最小破坏面
            // v2.1.13 PR#58 review P2-2（🔴 业务红线）：ReconID 修复模块（recon-id-fix /
            //   gateway-recon-id-fix）按 category 隔离、无银行渠道维度（A2 compact manager 已去渠道下拉）。
            //   新建 ReconID 场景必须固定 channel_id=1（通用），不跟随 activeScenarioChannelId
            //   （否则会沿用上一个「银行对账单」manager 残留的渠道选择 → ReconID 场景落到隐藏渠道：
            //    ① (channel_id,name) UNIQUE 下同名可重复；② 按渠道导出 bundle 漏掉它）。
            const createChannelId = isReconIdFixCategory(draft.category)
              ? 1
              : (Number(activeScenarioChannelId) > 0 ? Number(activeScenarioChannelId) : 1);
            result = await scenarioCommands.scenarios.create({
              category: draft.category,
              name: String(draft.name || '').trim(),
              priority: Number(draft.priority),
              enabled: true,
              config: draft.config,
              channelId: createChannelId
            });
          } else if (draft.mode === 'edit') {
            result = await scenarioCommands.scenarios.update(draft.scenarioId, {
              name: String(draft.name || '').trim(),
              priority: Number(draft.priority),
              config: draft.config
            });
          } else {
            // view 模式不应到达这里（按钮只显示"返回"）
            saving = false;
            closeAndClearDraft();
            return;
          }
          if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          if (!result || result.status !== 'ok') {
            pushAlert(overlay, () => createAlertDialog(`保存失败：${result?.message || '未知错误'}`, {
              onConfirm: backToConfig
            }));
            return;
          }
          // 成功 → 清空 draft + 刷新场景管理弹窗
          // v2.1.0-beta.2 PR #38 round 2 P2-2：按 draft.category 分流，避免跨模块互抹状态
          saving = false;
          clearScenarioDraft();
          returnToScenarioManager(overlay);
        } catch (error) {
          pushAlert(overlay, () => createAlertDialog(`保存失败：${error.message || error}`, {
            onConfirm: backToConfig
          }));
        } finally {
          saving = false;
          finishButton.disabled = false;
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }


    return Object.freeze({
      createChannelManagerDialog,
      createExportScenarioBundleDialog,
      createTransferScenariosDialog,
      createScenariosManagerDialog,
      createScenarioCategorySelectDialog,
      createScenarioConfigDialogC1,
      createScenarioConfigDialogC2,
      createScenarioConfigDialogC3,
      createScenarioConfigDialogC4,
      createScenarioConfirmDetailDialog,
      applyPreviewDraft(value) { scenarioDraft = value ? structuredClone(value) : null; }
    });
  }
  global.ScenarioDialogs = Object.freeze({ createScenarioDialogs });
})(window);
