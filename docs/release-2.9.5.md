# SpecLoom 2.9.5 更新

拆分 `MaterialDetails`，把四个独立数据域搬到各自的小节组件里。

## 拆分结果

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `MaterialDetails.tsx` | 525 → **359** | 实体/组件主表单：名称、说明、继承、分组、组件绑定、字段 |
| `material-details/AudioSection.tsx` | 102 | 音频总线与事件 |
| `material-details/SpecLinkSection.tsx` | 69 | 系统/功能/决策的引用与状态 |
| `material-details/MountsSection.tsx` | 40 | 系统挂载实例 |
| `material-details/SignalsSection.tsx` | 30 | 实体/系统的信号声明 |

每块只接收 `data`、`patch`/`onChange`、`disabled`（音频与规范关联另需 `catalog`），不再读取主表单内部的闭包状态；音频的归一化、锁定规则、增删逻辑全部随小节走。

## 兼容

- 界面结构、可访问名称与保存行为不变；对应测试与 App 流程全量通过。
- 实体工作台仍复用同一份 `MaterialDetails`，行为未变。
