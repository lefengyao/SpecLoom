# SpecLoom 2.9.6 更新

拆分实体工作台，消除主文件对画布、检查器、布局逻辑的耦合。

## 拆分结果

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `EntityWorkbench.tsx` | 1897 → **753** | 只做编排：加载资料、选中态、保存、对话框、页面结构 |
| `entity-workbench/model.ts` | 239 | 纯模型：类型、引用解析、字段读取、布局与配图的本地存储 |
| `entity-workbench/cards.tsx` | 99 | 画布卡片（实体卡 / 组件卡）与锚点手柄 |
| `entity-workbench/canvas.tsx` | 387 | 画布与节点连线、`EntityComponentBoard`、`FieldEditor` |
| `entity-workbench/inspectors.tsx` | 299 | 组件检查器、实体详情面板 |
| `entity-workbench/useEntityLayout.ts` | 158 | 布局状态：拖动、量尺寸、自动整理、自定义锚点、副作用保存 |

## 依赖方向

`model` ← `cards` ← `canvas` ← `inspectors` ← `EntityWorkbench`，全部单向，没有循环引用；`useEntityLayout` 只依赖 `model` 与 `entity-layout`。公共导出通过 `EntityWorkbench.tsx` 再导出，`entity/index.ts` 与现有调用方无需改动。

## 兼容

- 画布交互、锚点连线、自动整理、配图、对话框行为不变。
- `EntityWorkbench` 17 个测试、`App` 31 个测试全部通过；core + shared 1133 通过 / 3 跳过。
