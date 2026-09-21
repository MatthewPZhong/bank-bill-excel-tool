// v3.0.8：ESLint flat config —— 仅启用 no-undef，静态拦截「作用域内无定义却被引用」的 not-defined 类缺陷。
//   动机：createBankStatementRunProgressForwarder 事故（函数定义在收单 register 作用域、handler 跨作用域引用 →
//   运行时 not defined），而 release-check 的单测/集成从不触发 main.js 的 IPC handler 体，全绿也漏掉。
//   no-undef 做作用域解析，正好能静态拦下这一类（forwarder 在 handler 作用域链上无绑定 → 报错）。
//
// 刻意只开 no-undef（不开 no-unused-vars / 风格规则），避免海量历史噪音淹没真正的红线信号。
// globals 取 node ∪ browser：主进程/preload/backend 是 CommonJS（require/module/Buffer/structuredClone…），
//   覆盖全部平台全局；本配置覆盖 Main、Preload、Backend 与使用显式依赖的 Renderer 工厂。
const globals = require('globals');

// 旧 ESLint 配置（已移除）遗留的内联注释 `// eslint-disable-next-line global-require, import/no-dynamic-require`
//   引用了 eslint-plugin-import 的规则；本最小配置不装该插件 → 注册同名 no-op 规则，
//   避免「Definition for rule 'import/no-dynamic-require' was not found」噪音把 no-undef 信号淹掉。
const noopRule = { meta: { schema: [] }, create: () => ({}) };

module.exports = [
  // G3 已将浏览器脚本的隐式跨文件函数引用收口为显式工厂注入，全部 Renderer 纳入 no-undef。
  {
    files: ['src/**/*.js'],
    plugins: { import: { rules: { 'no-dynamic-require': noopRule } } },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    // 旧配置遗留的 eslint-disable 指令（global-require/no-console 等）在本最小配置下「未触发问题」→
    //   关掉未用指令告警，避免噪音；不改 src/ 注释（非本次任务，留待清理）。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
];
