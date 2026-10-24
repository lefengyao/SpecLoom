# 音频规范模型（系统内）

音频是**系统**的一部分，不是独立资料类别：总线和事件都写在音频系统的 front matter 里。

## 数据

`specs/systems/audio.md`（`type: system`，`id: audio`）：

```yaml
buses:
  - name: master
    volume: 1
    muted: false
    description: All audio routes through here.
  - name: music
    parent: master
    volume: 1
  - name: sfx
    parent: master
    volume: 1
  - name: ui
    parent: master
    volume: 0.8
events:
  - id: ui_click
    bus: ui
    streams:
      - res://audio/ui_click.ogg
    volume_db: 0
    pitch: 0
    max_concurrent: 3
    cooldown: 0
    priority: 0
    loop: false
    positional: false
```

- 名称与标识：小写字母开头，仅 `a-z0-9_`，1~64 字符，项目内唯一。
- 内置总线：`master`、`music`、`sfx`，随项目存在；`master` 不能有父总线，内置项不能删除。
- 自定义总线：直接追加，`parent` 指向已存在的总线；不写 `parent` 表示汇入 `master`。
- 事件：`bus` 必须引用已存在的总线；`streams` 可为空。

## 生成与补齐

- 新项目初始化时自动创建音频系统与三条内置总线。
- 打开已有项目时，若音频系统缺失则创建；若存在但缺少内置总线，则补齐缺失项，**不覆盖**项目里已有的值（幂等）。
- 其它系统不能声明 `buses` / `events`，会报 `AUDIO_SYSTEM_INVALID`。

## 能力组件

音频系统随项目附带两个官方组件，放在「音频组件」分组下（`scope: system`）：

| 组件 | 字段 | 对应音频功能 |
| --- | --- | --- |
| `audio_source`（音频源） | `enabled`、`bus`、`volume_db`、`pitch`、`max_concurrent`、`cooldown`、`priority`、`loop`、`positional` | 事件播放：音量、音高、并发、冷却、优先级、循环、定位 |
| `audio_listener`（音频监听器） | `enabled`、`volume` | 接收端与定位基准 |

音频系统默认挂载三个实例：`listener`、`music`（`bus: music`、循环）、`sfx`（`bus: sfx`）。补齐规则与总线一致：缺失才创建，已有 `components` / `mounts` 时原样保留。

## 校验

| 码 | 触发 |
| --- | --- |
| `AUDIO_BUS_NAME_INVALID` | 名称不符合规范 |
| `AUDIO_BUS_DUPLICATE` | 总线重名 |
| `AUDIO_BUS_BUILTIN_MISSING` | 三条内置总线缺失（等同拒绝删除内置项） |
| `AUDIO_MASTER_PARENT_INVALID` | `master` 设了父总线 |
| `AUDIO_BUS_PARENT_UNKNOWN` | 父总线不存在 |
| `AUDIO_BUS_PARENT_CYCLE` | 父级成环 |
| `AUDIO_BUS_VOLUME_INVALID` | 音量不在 0~1 |
| `AUDIO_EVENT_ID_INVALID` / `AUDIO_EVENT_DUPLICATE` | 事件标识非法或重复 |
| `AUDIO_EVENT_BUS_MISSING` / `AUDIO_EVENT_BUS_UNKNOWN` | 事件没有总线或总线不存在 |
| `AUDIO_EVENT_CONCURRENCY_INVALID` / `AUDIO_EVENT_NUMBER_INVALID` / `AUDIO_EVENT_FLAG_INVALID` | 事件字段类型或范围错误 |

## 改名与删除

- **改名**：内置总线、仍被事件引用、仍有子总线的总线，名称输入被锁定；即「拒绝改名并要求先改引用」。
- **删除**：同样三类总线不可删除；其余可直接删，删除后引用它的事件会因 `AUDIO_EVENT_BUS_UNKNOWN` 报错。
- 界面与资料工具（`MaterialUpdate`）走同一套校验，两条路径行为一致。

## 本阶段不做

- 生成引擎侧总线配置（Godot `bus_layout`）。
- 效果链、ducking、3D 定位曲线、分层音轨、多语言变体。
