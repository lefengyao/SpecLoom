# SpecLoom 2.9.0 更新

音频成为系统资料的一部分：总线与事件写在音频系统里，随项目存在并被统一校验。

## 模型

- `specs/systems/audio.md`（`type: system`、`id: audio`）持有 `buses` 与 `events`。
- 内置总线：`master`、`music`、`sfx`；`master` 不能设置父总线，内置项不能删除。
- 自定义总线直接追加，`parent` 指向已有总线，缺省汇入 `master`。
- 事件字段：`id`、`bus`、`streams`、`volume_db`、`pitch`、`max_concurrent`、`cooldown`、`priority`、`loop`、`positional`。

## 生成与补齐

- 新项目初始化时创建音频系统与三条内置总线。
- 打开已有项目时补建音频系统；已有总线保留原值，只补缺失的内置项，重复打开不产生改动。

## 校验

- 新增 `AUDIO_BUS_*` 与 `AUDIO_EVENT_*` 诊断码，覆盖命名、重名、内置缺失、`master` 父级、父级缺失/成环、事件总线引用、字段类型与范围。
- 其它系统声明 `buses` / `events` 报 `AUDIO_SYSTEM_INVALID`。
- 界面保存前先跑同一套校验，失败时直接报字段位置；资料工具的 `buses` / `events` 走同一函数。

## 界面

- 音频系统详情新增「音频」区：总线行（名称、父总线、线性音量、静音、内置/自定义标记、被多少事件引用）与事件行（标识、总线、音量、音高、并发、冷却、循环、定位、采样路径）。
- 内置、被事件引用或有子总线的总线，名称与删除都被锁定——即「拒绝改名，先改引用」。

## 文档

新增 `docs/audio-model.md`，记录数据契约、补齐规则、诊断码与改名/删除策略。

## 本阶段不做（按规范）

- 生成引擎侧总线配置（Godot `bus_layout`）。
- 效果链、ducking、3D 定位曲线、分层音轨、多语言变体。
