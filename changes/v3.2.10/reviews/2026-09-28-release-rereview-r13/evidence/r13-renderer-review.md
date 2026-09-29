R13 Renderer调用时点专项已收口：确认一个新增P2漏报，条件调用的helper写入被当作确定执行。不扩大到数组重排或任意动态JS。

建议标题：[P2] 保留唯一helper调用所在分支的条件性。

位置 scripts/architecture/renderer-contracts.js:114–121，尤其:118–120将无调用帧的内部写入直接映射到唯一调用节点。writtenBefore :130–134据调用位置返回true；snapshotMember :184–187只检查原赋值节点至函数边界的控制流，没有沿调用链检查调用处的IfStatement，因此:200把旧对象候选无条件覆盖为新对象。

最短触发链：old/clean是独立静态对象，box.api初始为old；replace(){box.api=clean;}；if(info.hasEnum)replace(); const alias=box.api；alias.outsideScope=desktopApi.outsideScope；controller({api:old})。合法app:get-info的hasEnum=false时replace未运行，alias===old、实际注入old含可调用outsideScope，但当前检查器零诊断。完整source在四例JSONL和actual20 JSON内，无动态索引、反射、循环或跨文件时序。

新旧确认：before严格使用2026-09-23-release-r12-repair/input-manifest及before/checker，renderer sha256=6b57b228b5fb576bbd3ea40d42ff010c5414c1a6a96fb7efdc6aba92fd2c2bec；current=f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082并匹配R13冻结。其余四检查工具hash保持。条件调用反例最小配置及完整20 Renderer配置均before1→current0，证实为本次R12修复新增回归。

四例诊断before→current：conditional-call-skipped 1→0（新增漏报）；direct-call-before-unsafe 1→1（无条件替换后注入clean的违规对照）；capture-before-call-safe 1→0（读取旧别名后再替换、注入clean安全）；direct-call-before-old-safe 1→0（无条件替换后注入old安全）。均scanError=null，不将异常混作零诊断。

实际20配置的两代表：基线before/current均0；条件调用违规before1/current0，VM hasEnum=false时same=true、apiKeys=[run,outsideScope]、extraCallable=true且实际调用返回true；将条件调用改成无条件replace()的安全对照before1/current0，VM same=false、apiKeys=[run]。另按相同源码分别运行hasEnum=false/true：条件源码false越权、true安全；无条件对照false/true都安全。这说明条件本身改变运行时对象来源，不能因只有一个调用位置而认定调用必执行。

契约依据：G8 Spec:101 AC-05要求已迁移域超范围API注入失败；architecture/README.md:101/105要求条件来源保留可能身份、按已完成的成员替换选择来源；:143及TechDoc:130为普通helper唯一调用位置核对执行顺序，不能把调用的存在性变成执行必然性。当前代码:185也明确分支不能冒充确定替换。本例是普通同文件IfStatement和唯一静态helper调用，属于已解释来源/时序组合，不是任意动态循环或跨文件共享对象合同之外的情况。

修正方向：回溯调用时点时保留沿途调用节点的条件性；顺序能比较不代表写入必发生。无法证明执行时保留原成员与新成员候选或coverage诊断，并维持两个已证实安全时序对照。现有12项RR12测试均以无条件helper调用检验顺序，未覆盖调用自身在If分支中被跳过的路径。

输入一致：comparison-inputs.json核对795个src/index/机器配置文件与R13冻结清单字节一致；before/current均扫描同一worktree，2个追加source逐字相同，完整20 Renderer边界相同，4个共享工具hash相同。差异仅为Renderer检查器版本。该证明没有把完整CLI通过替代本反例。

证据均在/tmp/r13-renderer-*：review.md、verification.json；probes.cjs及probes-before/current.jsonl；before-bootstrap.cjs与before-inputs/current-inputs.json；conditional-realconfig.cjs、conditional-realconfig-replay.cjs（支持RENDERER_SCANNER_ROOT）、conditional-realconfig.json、conditional-realconfig-before.json及两份progress.log；branch-vm.cjs/.json；comparison-inputs.json。before-bootstrap从仓库R12repair归档自举，不依赖保留随机/tmp工具目录。branch-vm按脚本所在目录查实际配置结果，也可传结果JSON路径。没有修改生产源码、工具、测试、配置或历史材料。全架构/CLI由主审负责；产品Main/GUI和平台验收不由本探针证明。
