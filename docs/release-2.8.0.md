# SpecLoom 2.8.0 更新

决策树条件支持信号来源，并附带一棵可直接打开的样板树。

## 信号条件

- 实体与系统规范可以声明 `signals:`（`[a-z][a-z0-9_]*`，最多 64 个），资料详情里新增「信号」区，可增删、改名校验。
- 条件节点新增第三种模式「信号」：先选**信号来源**（任意实体或系统），再选该来源声明的信号；来源没有声明时退化为文本输入并提示。
- 比较式、事件名、信号三者互斥，切换模式会自动清掉另外两种。
- 校验：
  - 来源不存在 → `TREE_SIGNAL_UNKNOWN_SOURCE`
  - 来源没有声明该信号 → `TREE_SIGNAL_UNKNOWN_NAME`
  - 信号结构不合法 → `TREE_SIGNAL_INVALID`
- 反查新增「被这些决策树监听」：实体与系统详情里能看到哪些树在等它的信号。

## 样板树

`specs/decision_trees/combat_decision.md`：选择节点下分「撤退 / 攻击 / 巡逻」三条分支，覆盖顺序节点、冷却修饰、字段比较（`offense.enabled == true`）、信号（`hp_low`、`enemy_in_range`）与事件（`no_threat_detected`）。

配套在 `combat_entity` 上声明了 `hp_low`、`enemy_in_range`、`no_threat_detected` 三个信号。

## 校验脚本

新增 `scripts/validate-project.mts`：`esbuild` 打包后可直接对任意项目跑一遍校验，输出诊断摘要，方便在不开界面的情况下复核。

## 兼容

- 现有不含 `signals` 的实体与系统不受影响。
- 只写比较式或事件的条件继续有效。
