# v3.0.3 性能 bench 留档

> 环境：macOS（Darwin 24.6.0）/ node v24.13.0 / 14 cores / SSD ｜ fixture：`tmp/poc-acquiring-flow-500000.xlsx`（50w 行 × 48 列收单 flow，解压后 1797MB 字符量）
> 跑法：各组多次取优（清静环境）；bench 脚本 `tmp/bench-p1-whitelist.js` / `tmp/bench-engine-parallel.js` / `tmp/bench-acquiring-opt.js`（tmp/ 不入库，脚本结构见各 PR 汇报）
> ⚠️ Windows 实机校准未做（W3 同批校准，留待 Windows SSD 环境复跑一次留档）

## 一、块 A 性能批次（P0 系列，PR-A/B）

| 项 | 迁移前 | 迁移后 | 提速 |
|----|--------|--------|------|
| flow 导入段（raw_json 停写 + 预计算，50w） | — | — | **6.36x** |
| 对账统计段（单 JOIN 合并 + covering 索引） | — | — | **5.2x** |

## 二、PR-P1 解析列白名单（O-5 五次修订收口）

| 组 | 50w 耗时 |
|----|---------|
| 物理地板（inflate + decode 零解析） | 2.47s |
| 手写全列解码（whitelist=null） | 11.87s |
| 手写白名单裁剪（P1b · flow 4/48 列 + 直接定位） | 9.89s |
| **提速（收口值）** | **1.20x**（AC-A7 修订：实测天花板 ~1.4x，行切块 ~5.5s 列裁剪不可触及；债务转 PR-G 字节层） |

## 三、PR-G1 引擎字节层 row-scanner（单遍字节状态机）

| 组 | 50w 耗时 |
|----|---------|
| 物理地板 | 2.48s |
| 手写全列 | 11.96s |
| P1b 白名单 | 9.87s |
| 引擎字节层（全列） | 8.24s（vs 手写全列 **1.45x**） |
| **引擎字节层（白名单 flow 4/48 列）** | **4.26s（vs P1b 2.32x ✅ gate ≥2x）** |

- 裸吞吐（状态机只扫结构不取值）：50w 2.57s ≈ 709MB/s，逼近 inflate 物理地板
- 100w fixture：1.96x（差 2x 约 1.6%，结构性约束——单遍扫描需过全部 48 cell 结构；50w 验收基准达标）
- 第一版「Buffer.indexOf 多 pattern 直接定位」方案 0.98x 被否：node --prof 实证 ~70% 时间在 indexOf C++ 跨界搜索（libsystem memchr 47.1% + nbytes LinearSearch 19.0%），每行等效重复扫描 6-8 遍

## 四、PR-G2 多文件并行（4 worker）

| 组 | 4×50w（200w 行）耗时 |
|----|---------------------|
| 串行解析 4 文件（依次 parseFile：解析+mapRow+batch） | 24.56s |
| **4-worker 并行（import-worker ×4）** | **8.03s = 3.06x ✅ gate ≈3x（±0.3）** |

## 五、PR-H 收单首迁端到端（导入全链含 INSERT）

| 路径 | 50w 单文件端到端 |
|------|-----------------|
| LEGACY（reader-handrolled 主进程直调） | 11.2s |
| **ENGINE（big-table-import worker）** | **7.3s（1.53x）** |

- 口径说明：spec 的 ≥2x 闸是解析段（PR-G1 已 2.32x 达标）；端到端含 INSERT + worker 通信开销，对比基线为已优化的 v2.1.12 手写字节扫描版
- W4 核心收益不在单文件倍数：**导入全程主进程零阻塞**（解析+写库全在 worker）+ 多文件并行 3.06x 叠加（500w 多文件场景为引擎主战场，推算 ~40-60s vs 现架构串行 ~150s+）
