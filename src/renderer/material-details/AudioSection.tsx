import { Plus, Trash2 } from "lucide-react";
import {
  audioBusUsage, isBuiltinBus, readAudioBuses, readAudioEvents,
  type AudioBus, type AudioEvent,
} from "../../shared/audio-system";
import { useI18n } from "../i18n";

export interface AudioSectionProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  disabled: boolean;
}

/** Audio buses and events of the audio system, split out of the generic material form. */
export function AudioSection({ data, onChange, disabled }: AudioSectionProps) {
  const tr = useI18n();
  const buses: AudioBus[] = readAudioBuses(data);
  const events: AudioEvent[] = readAudioEvents(data);
  const usage = audioBusUsage(events);
  /** Built-in buses, buses with events and buses with children keep their name; rename is refused. */
  const busLocked = (bus: AudioBus) => isBuiltinBus(bus.name) || (usage.get(bus.name)?.length ?? 0) > 0 || buses.some((item) => item.parent === bus.name);
  const write = (nextBuses: AudioBus[], nextEvents: AudioEvent[]) => onChange({ ...data, buses: nextBuses, events: nextEvents });
  const normalizeBus = (bus: AudioBus): AudioBus => ({
    name: bus.name,
    ...(bus.parent ? { parent: bus.parent } : {}),
    ...(bus.volume !== undefined ? { volume: bus.volume } : {}),
    ...(bus.muted !== undefined ? { muted: bus.muted } : {}),
    ...(bus.description ? { description: bus.description } : {}),
  });
  const normalizeEvent = (event: AudioEvent): AudioEvent => ({
    id: event.id,
    bus: event.bus,
    ...(event.streams?.length ? { streams: event.streams } : {}),
    ...(event.volume_db !== undefined ? { volume_db: event.volume_db } : {}),
    ...(event.pitch !== undefined ? { pitch: event.pitch } : {}),
    ...(event.max_concurrent !== undefined ? { max_concurrent: event.max_concurrent } : {}),
    ...(event.cooldown !== undefined ? { cooldown: event.cooldown } : {}),
    ...(event.priority !== undefined ? { priority: event.priority } : {}),
    ...(event.loop !== undefined ? { loop: event.loop } : {}),
    ...(event.positional !== undefined ? { positional: event.positional } : {}),
  });
  const updateBus = (index: number, change: Partial<Omit<AudioBus, "parent">> & { parent?: string | null }) => write(buses.map((bus, position) => {
    if (position !== index) return bus;
    const merged: AudioBus = { ...bus, ...change } as AudioBus;
    if (change.parent === null) delete merged.parent;
    return normalizeBus(merged);
  }), events);
  const removeBus = (index: number) => write(buses.filter((_, position) => position !== index), events);
  const addBus = () => {
    const used = new Set(buses.map((bus) => bus.name));
    let index = buses.length + 1;
    let name = `bus_${index}`;
    while (used.has(name)) { index++; name = `bus_${index}`; }
    write([...buses, { name, parent: "master", volume: 1, muted: false }], events);
  };
  const updateEvent = (index: number, change: Partial<AudioEvent>) => write(buses, events.map((event, position) => position === index ? normalizeEvent({ ...event, ...change }) : event));
  const removeEvent = (index: number) => write(buses, events.filter((_, position) => position !== index));
  const addEvent = () => {
    const used = new Set(events.map((event) => event.id));
    let index = events.length + 1;
    let id = `event_${index}`;
    while (used.has(id)) { index++; id = `event_${index}`; }
    write(buses, [...events, { id, bus: buses[2]?.name ?? "sfx", volume_db: 0, pitch: 0, max_concurrent: 3, cooldown: 0, priority: 0, loop: false, positional: false }]);
  };

  return <section className="material-section" aria-label={tr("音频")}>
    <header><div><h3>{tr("音频总线")}</h3><span className="subtle">{tr("master、music、sfx 为内置总线；内置、被事件引用或有子总线的总线不能改名或删除。")}</span></div>
      <button type="button" disabled={disabled} onClick={addBus}><Plus size={16} />{tr("添加总线")}</button></header>
    <ul className="audio-bus-list">{buses.map((bus, index) => {
      const busEvents = usage.get(bus.name) ?? [];
      const children = buses.filter((item) => item.parent === bus.name);
      return <li key={`${bus.name}:${index}`}>
        <input aria-label={tr("总线名称 {index}", { index: index + 1 })} maxLength={64} value={bus.name} disabled={disabled || busLocked(bus)} onChange={(event) => updateBus(index, { name: event.target.value.trim().toLowerCase() })} />
        <select aria-label={tr("父总线 {index}", { index: index + 1 })} value={bus.parent ?? ""} disabled={disabled || bus.name === "master"} onChange={(event) => updateBus(index, { parent: event.target.value || null })}>
          <option value="">{tr("汇入 master")}</option>
          {buses.filter((item) => item.name !== bus.name).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <input aria-label={tr("音量 {index}", { index: index + 1 })} type="number" min={0} max={1} step={0.05} value={bus.volume ?? 1} disabled={disabled} onChange={(event) => updateBus(index, { volume: Math.min(1, Math.max(0, Number(event.target.value))) })} />
        <label className="audio-bus-muted"><input aria-label={tr("静音 {index}", { index: index + 1 })} type="checkbox" checked={bus.muted ?? false} disabled={disabled} onChange={(event) => updateBus(index, { muted: event.target.checked })} />{tr("静音")}</label>
        <button type="button" aria-label={tr("删除总线 {index}", { index: index + 1 })} disabled={disabled || busLocked(bus)} title={busLocked(bus) ? tr("内置总线、仍被事件引用或有子总线的总线不能删除") : undefined} onClick={() => removeBus(index)}><Trash2 size={15} /></button>
        <small>{isBuiltinBus(bus.name) ? tr("内置") : tr("自定义")}{busEvents.length ? ` · ${tr("被 {count} 个事件使用", { count: busEvents.length })}` : ""}{children.length ? ` · ${tr("{count} 条子总线", { count: children.length })}` : ""}</small>
      </li>;
    })}</ul>
    <header><div><h3>{tr("音频事件")}</h3><span className="subtle">{tr("事件通过 bus 引用总线；标识在项目内唯一。")}</span></div>
      <button type="button" disabled={disabled} onClick={addEvent}><Plus size={16} />{tr("添加事件")}</button></header>
    {events.length ? <ul className="audio-event-list">{events.map((event, index) => <li key={`${event.id}:${index}`}>
      <input aria-label={tr("事件标识 {index}", { index: index + 1 })} maxLength={64} value={event.id} disabled={disabled} onChange={(e) => updateEvent(index, { id: e.target.value.trim().toLowerCase() })} />
      <select aria-label={tr("事件总线 {index}", { index: index + 1 })} value={event.bus} disabled={disabled} onChange={(e) => updateEvent(index, { bus: e.target.value })}>
        <option value="">{tr("选择总线")}</option>
        {buses.map((bus) => <option key={bus.name} value={bus.name}>{bus.name}</option>)}
      </select>
      <input aria-label={tr("事件音量 {index}", { index: index + 1 })} type="number" step={0.5} value={event.volume_db ?? 0} disabled={disabled} onChange={(e) => updateEvent(index, { volume_db: Number(e.target.value) })} />
      <input aria-label={tr("事件音高 {index}", { index: index + 1 })} type="number" min={0} step={0.05} value={event.pitch ?? 0} disabled={disabled} onChange={(e) => updateEvent(index, { pitch: Number(e.target.value) })} />
      <input aria-label={tr("事件并发 {index}", { index: index + 1 })} type="number" min={1} max={64} step={1} value={event.max_concurrent ?? 3} disabled={disabled} onChange={(e) => updateEvent(index, { max_concurrent: Math.max(1, Math.round(Number(e.target.value))) })} />
      <input aria-label={tr("事件冷却 {index}", { index: index + 1 })} type="number" min={0} step={0.05} value={event.cooldown ?? 0} disabled={disabled} onChange={(e) => updateEvent(index, { cooldown: Math.max(0, Number(e.target.value)) })} />
      <label className="audio-event-flag"><input aria-label={tr("循环 {index}", { index: index + 1 })} type="checkbox" checked={event.loop ?? false} disabled={disabled} onChange={(e) => updateEvent(index, { loop: e.target.checked })} />{tr("循环")}</label>
      <label className="audio-event-flag"><input aria-label={tr("定位 {index}", { index: index + 1 })} type="checkbox" checked={event.positional ?? false} disabled={disabled} onChange={(e) => updateEvent(index, { positional: e.target.checked })} />{tr("定位")}</label>
      <button type="button" aria-label={tr("删除事件 {index}", { index: index + 1 })} disabled={disabled} onClick={() => removeEvent(index)}><Trash2 size={15} /></button>
      <input className="audio-event-streams" aria-label={tr("采样路径 {index}", { index: index + 1 })} placeholder="res://audio/ui_click.ogg, res://audio/ui_click_2.ogg" value={(event.streams ?? []).join(", ")} disabled={disabled} onChange={(e) => updateEvent(index, { streams: e.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
    </li>)}</ul> : <p className="subtle">{tr("还没有音频事件。")}</p>}
  </section>;
}
