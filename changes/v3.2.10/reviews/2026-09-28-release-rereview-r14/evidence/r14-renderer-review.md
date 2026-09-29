R14 Renderer条件执行位置专项已收口：RR13-01原问题在列明范围关闭；确认一个新增P2漏报。单根因为do首轮执行被提升成循环体每处写入/测试必执行，未保留条件break/continue跳过写入的旧来源。

旧问题关闭证据：原4例当前诊断[1,1,0,0]（条件helper违规、无条件新对象违规、先捕获旧别名安全、无条件后旧对象安全）；原实际20配置基线0，条件helper违规1条ARCH-RENDERER-SCOPE、安全0。全部scanError=null。

建议标题：[P2] do首轮中可被条件跳出绕过的写入仍应保留旧来源。

主反例是单轮普通JS：
```js
const old={run(){}}, clean={run(){}}, box={api:old};
const info=await window.desktopApi.app.getInfo();
do {
  if(info.hasEnum) break;
  box.api=clean;
} while(false);
const alias=box.api;
alias.outsideScope=window.desktopApi.outsideScope;
window.BankStatementController.createBankStatementController({api:old});
```

hasEnum=true时条件break在赋值前退出，box.api仍为old，后续真实注入old含可调用outsideScope；false时赋值执行，old保持独立。不是无条件break后的不可达语句；两个分支都由同份源码的async IPC VM执行确认。安全对照只把box.api=clean移到条件break之前，在true/false下都不污染old。

位置：scripts/architecture/renderer-contracts.js:145默认conditional=false，:155–160列举循环/分支时未为DoWhileStatement的可跳过位置保留条件性，并明确将do首轮视作必执行。祖先遍历不会观察写入前作为兄弟语句的条件break/continue；:164返回false。snapshotMember :214–215接受这个必执行结论，:228最终以assigned覆盖旧候选，导致旧对象别名写入漏检。主锚点为:155–164。

这是R13repair新增回归：准确before f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082；current adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072。before对do保留条件来源，主反例诊断1；current0。不是把已披露的任意动态控制流限制当新问题：该项直接落在本轮新增的do首轮必执行分类，仅一次迭代、静态成员、布尔条件及普通break/continue，不使用异常、反射或不定循环。

6个邻近例before→current：do-break-before-write 1→0（新增漏报）；do-write-before-break-safe 1→0（安全精度保持）；do-continue-before-write 1→0（同根因）；do-break-skips-test 1→0（同根因，条件break跳过do条件中的赋值）；for-init-write-safe 1→0（安全）；while-zero-body 1→1（标准零次循环对照仍拒绝）。6份源码分别执行hasEnum=false/true共12个VM断言均通过，没有scanError。

实际20Renderer配置before/current：生产基线均0；do条件break在写入前的违规代表1→0，current VM same=true、apiKeys=[run,outsideScope]、extraCallable=true且调用返回true；写入先于break安全对照1→0，VM same=false、apiKeys=[run]。两侧追加source逐字相同，current五工具对齐R14冻结，before五工具对齐R13repair起点；源码/机器配置795文件与冻结一致。扫描器没有异常，不能把0诊断解释成例外失败。

合同：G8 Spec:101/AC-05要求已迁移域越权API注入失败；architecture/README.md:105/145与TechDoc:132要求保留未执行路径、区分条件写入和必执行位置。R13repair主动承诺do首轮精度，但首轮进入只证明入口，不证明break之前/之后的每个位置都可达。若不能证明前序控制转移不会跳过写入，应保留旧候选或coverage，不要求实现任意JS控制流解释器。新32项回归只覆盖do{replace();}while(false)直达写入，未覆盖条件跳出早于写入或跳过条件测试。

局部ESLint对主反例与安全对照按src/renderer.js配置检查均0error/0warning；该现有配置仅no-undef，不把lint结果夸大成控制流完整证明。未运行全门禁、数组专项、共享56或覆盖排序专项，均由主审/其他Agent负责。

材料均/tmp/r14-renderer-*并复制本轮evidence：review.md、verification.json、probes.cjs、probes-before/current.jsonl；before-bootstrap.cjs和before/current-inputs.json；do-realconfig.cjs及before/current JSON与progress；branch-vm.cjs/.json；lint.cjs/.json；comparison-inputs.json；original-probes.jsonl、original-realconfig.json及progress。before-bootstrap可从仓库R13repair归档自举，不需保存随机/tmp工具目录；do-realconfig用RENDERER_SCANNER_ROOT选择before/current；branch VM与lint脚本按自身目录读取归档JSONL。原样复跑脚本依赖R13review evidence中的r13-renderer-probes.cjs和r13-renderer-conditional-realconfig.cjs。

未修改源代码、测试、配置或历史证据。结论限于本项架构检查器静态回归，不代表真实产品Main/GUI/Windows/Excel-WPS验收。
