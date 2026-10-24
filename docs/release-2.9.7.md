# SpecLoom 2.9.7 更新

音频系统带上初始组件：能力组件 + 默认挂载实例。

## 新项目

初始化时额外创建两个官方组件（`scope: system`，分组「音频组件」）：

| 组件 | 字段 | 覆盖的音频功能 |
| --- | --- | --- |
| `audio_source` | `enabled`、`bus`、`volume_db`、`pitch`、`max_concurrent`、`cooldown`、`priority`、`loop`、`positional` | 事件播放：音量、音高、并发、冷却、优先级、循环、定位 |
| `audio_listener` | `enabled`、`volume` | 接收端与定位基准 |

音频系统默认挂载三个实例，工作台打开就能看到：

- `listener` → `audio_listener`
- `music` → `audio_source`，`bus: music`、`loop: true`
- `sfx` → `audio_source`，`bus: sfx`

音频系统的 `components` 引用这两个组件，其它字段（buses、events）不变。

## 旧项目

打开时按幂等规则补齐：

- 缺组件文件则创建；已有文件不覆盖。
- 音频系统缺少 `components` 或 `mounts` 时补默认值；已有内容原样保留。
- `specs/project.md` 缺少「音频组件」分组时追加，不影响其它分组。

## 分组

组件分组新增官方项 `group_audio_components`（音频组件）；两个组件按官方规则显示徽标，不能在分组树里重命名/删除。

## 兼容

- 组件定义是普通资料，可以像其它官方组件一样被挂载、继承、覆盖；`scope: system` 只影响官方标记，不妨碍用户复制。
- 本轮已为 pvz_warG 补上两个组件、默认挂载与「音频组件」分组，项目校验 0 诊断。
