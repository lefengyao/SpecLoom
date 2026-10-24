# SpecLoom 2.9.4 更新

去重与解耦：组件浏览器只保留一份实现，样式独立成文件。

## 去重

- 实体工作台的内联「创建组件」对话框（约 150 行）已删除，改用共享的 `ComponentBrowserDialog`。
- 两套工作台现在共用同一份浏览器：收藏、最近使用、搜索、筛选、分组与继承嵌套、描述与字段清单。
- 浏览器打开时自动选中第一个可添加的组件，描述区立即有内容。

## 解耦

- 新增 `component-browser.css`：把 `.ewb-create-*`、`.ewb-badge`、`.ewb-empty`、`.ewb-drawer-close`、`.ewb-component-note-list` 及其窄屏媒体查询从 `entity-workbench.css` 移出。
- 浏览器不再 import `entity-workbench.css`；两个工作台各自显式引入所需样式。

## 规模变化

| 文件 | 之前 | 之后 |
| --- | --- | --- |
| `EntityWorkbench.tsx` | 2044 | 1897 |
| `entity-workbench.css` | 1119 | 1106 |
| `ComponentBrowserDialog.tsx` | — | 281 |
| `component-browser.css` | — | 409 |

## 验证

- renderer 全量 **482/482**，typecheck 与 eslint 通过。
