/**
 * Audio belongs to the system specification: one audio system declares its buses
 * and the events routed through them. Nothing here is Godot specific — the same
 * data can drive any engine's mixer.
 */
export const BUILTIN_AUDIO_BUSES = ["master", "music", "sfx"] as const;
export type BuiltinAudioBus = (typeof BUILTIN_AUDIO_BUSES)[number];

export const AUDIO_IDENTITY = /^[a-z][a-z0-9_]{0,63}$/;

export interface AudioBus {
  name: string;
  parent?: string;
  volume?: number;
  muted?: boolean;
  description?: string;
}

export interface AudioEvent {
  id: string;
  bus: string;
  streams?: string[];
  volume_db?: number;
  pitch?: number;
  max_concurrent?: number;
  cooldown?: number;
  priority?: number;
  loop?: boolean;
  positional?: boolean;
}

export interface AudioIssue {
  path: string;
  code: string;
  message: string;
}

export function isBuiltinBus(name: string): boolean {
  return (BUILTIN_AUDIO_BUSES as readonly string[]).includes(name);
}

/** The three buses every project starts with; custom buses hang off master by default. */
export function builtinAudioBuses(): AudioBus[] {
  return [
    { name: "master", volume: 1, muted: false, description: "All audio routes through here." },
    { name: "music", parent: "master", volume: 1, muted: false },
    { name: "sfx", parent: "master", volume: 1, muted: false },
  ];
}

/** Add missing built-in buses without touching values the project already set. */
export function mergeBuiltinBuses(buses: readonly AudioBus[]): { buses: AudioBus[]; changed: boolean } {
  const existing = new Set(buses.map((bus) => bus.name));
  const missing = builtinAudioBuses().filter((bus) => !existing.has(bus.name));
  return { buses: missing.length ? [...buses, ...missing] : [...buses], changed: missing.length > 0 };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readAudioBuses(data: Record<string, unknown>): AudioBus[] {
  if (!Array.isArray(data.buses)) return [];
  return data.buses.filter(record).map((bus): AudioBus => {
    const parent = text(bus.parent);
    const description = text(bus.description);
    return {
      name: text(bus.name) ?? "",
      ...(parent !== undefined ? { parent } : {}),
      ...(typeof bus.volume === "number" ? { volume: bus.volume } : {}),
      ...(typeof bus.muted === "boolean" ? { muted: bus.muted } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  });
}

export function readAudioEvents(data: Record<string, unknown>): AudioEvent[] {
  if (!Array.isArray(data.events)) return [];
  return data.events.filter(record).map((event) => ({
    id: text(event.id) ?? "",
    bus: text(event.bus) ?? "",
    ...(Array.isArray(event.streams) ? { streams: event.streams.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof event.volume_db === "number" ? { volume_db: event.volume_db } : {}),
    ...(typeof event.pitch === "number" ? { pitch: event.pitch } : {}),
    ...(typeof event.max_concurrent === "number" ? { max_concurrent: event.max_concurrent } : {}),
    ...(typeof event.cooldown === "number" ? { cooldown: event.cooldown } : {}),
    ...(typeof event.priority === "number" ? { priority: event.priority } : {}),
    ...(typeof event.loop === "boolean" ? { loop: event.loop } : {}),
    ...(typeof event.positional === "boolean" ? { positional: event.positional } : {}),
  }));
}

/** Event ids grouped by the bus they play on, for reverse lookups. */
export function audioBusUsage(events: readonly AudioEvent[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const event of events) {
    if (!event.bus) continue;
    usage.set(event.bus, [...(usage.get(event.bus) ?? []), event.id]);
  }
  return usage;
}

/** Structural validation shared by the UI, the tools and the validator. */
export function validateAudioSpec(data: Record<string, unknown>): AudioIssue[] {
  const issues: AudioIssue[] = [];
  const declaredBuses = data.buses !== undefined;
  const declaredEvents = data.events !== undefined;
  if (!declaredBuses && !declaredEvents) return issues;

  const rawBuses: unknown[] = declaredBuses ? (Array.isArray(data.buses) ? data.buses : []) : [];
  if (declaredBuses && !Array.isArray(data.buses)) {
    issues.push({ path: "buses", code: "AUDIO_BUSES_INVALID", message: "buses must be a list" });
  }
  const names = new Set<string>();
  const parents = new Map<string, string>();
  rawBuses.forEach((raw, index) => {
    const at = `buses[${index}]`;
    if (!record(raw)) {
      issues.push({ path: at, code: "AUDIO_BUS_INVALID", message: "Each bus must be a mapping" });
      return;
    }
    const name = text(raw.name) ?? "";
    if (!AUDIO_IDENTITY.test(name)) {
      issues.push({ path: `${at}.name`, code: "AUDIO_BUS_NAME_INVALID", message: `Bus name '${name}' must match ${AUDIO_IDENTITY}` });
    } else if (names.has(name)) {
      issues.push({ path: `${at}.name`, code: "AUDIO_BUS_DUPLICATE", message: `Bus '${name}' is declared twice` });
    } else {
      names.add(name);
    }
    if (raw.parent !== undefined && text(raw.parent)) {
      if (!AUDIO_IDENTITY.test(text(raw.parent)!)) {
        issues.push({ path: `${at}.parent`, code: "AUDIO_BUS_NAME_INVALID", message: `Parent bus '${String(raw.parent)}' is not a valid name` });
      } else {
        parents.set(name, text(raw.parent)!);
      }
    }
    if (raw.volume !== undefined && !(typeof raw.volume === "number" && Number.isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 1)) {
      issues.push({ path: `${at}.volume`, code: "AUDIO_BUS_VOLUME_INVALID", message: "Bus volume must be a number between 0 and 1" });
    }
    if (raw.muted !== undefined && typeof raw.muted !== "boolean") {
      issues.push({ path: `${at}.muted`, code: "AUDIO_BUS_MUTED_INVALID", message: "Bus muted must be a boolean" });
    }
    if (raw.description !== undefined && typeof raw.description !== "string") {
      issues.push({ path: `${at}.description`, code: "AUDIO_BUS_DESCRIPTION_INVALID", message: "Bus description must be text" });
    }
  });

  if (declaredBuses) {
    for (const builtin of BUILTIN_AUDIO_BUSES) {
      if (!names.has(builtin)) {
        issues.push({ path: "buses", code: "AUDIO_BUS_BUILTIN_MISSING", message: `Built-in bus '${builtin}' cannot be removed` });
      }
    }
    if (parents.has("master")) {
      issues.push({ path: "buses", code: "AUDIO_MASTER_PARENT_INVALID", message: "master cannot have a parent bus" });
    }
    for (const [name, parent] of parents) {
      if (parent === name) {
        issues.push({ path: "buses", code: "AUDIO_BUS_PARENT_CYCLE", message: `Bus '${name}' cannot be its own parent` });
        continue;
      }
      if (!names.has(parent)) {
        issues.push({ path: "buses", code: "AUDIO_BUS_PARENT_UNKNOWN", message: `Bus '${name}' refers to unknown parent '${parent}'` });
      }
    }
    // Walk each parent chain; a visited repeat is a routing cycle.
    for (const start of names) {
      const seen = new Set<string>([start]);
      let cursor = parents.get(start);
      while (cursor && names.has(cursor)) {
        if (seen.has(cursor)) {
          issues.push({ path: "buses", code: "AUDIO_BUS_PARENT_CYCLE", message: `Bus routing cycle through '${cursor}'` });
          break;
        }
        seen.add(cursor);
        cursor = parents.get(cursor);
      }
    }
  }

  const rawEvents: unknown[] = declaredEvents ? (Array.isArray(data.events) ? data.events : []) : [];
  if (declaredEvents && !Array.isArray(data.events)) {
    issues.push({ path: "events", code: "AUDIO_EVENTS_INVALID", message: "events must be a list" });
  }
  const eventIds = new Set<string>();
  rawEvents.forEach((raw, index) => {
    const at = `events[${index}]`;
    if (!record(raw)) {
      issues.push({ path: at, code: "AUDIO_EVENT_INVALID", message: "Each audio event must be a mapping" });
      return;
    }
    const id = text(raw.id) ?? "";
    if (!AUDIO_IDENTITY.test(id)) {
      issues.push({ path: `${at}.id`, code: "AUDIO_EVENT_ID_INVALID", message: `Event id '${id}' must match ${AUDIO_IDENTITY}` });
    } else if (eventIds.has(id)) {
      issues.push({ path: `${at}.id`, code: "AUDIO_EVENT_DUPLICATE", message: `Audio event '${id}' is declared twice` });
    } else {
      eventIds.add(id);
    }
    const bus = text(raw.bus) ?? "";
    if (!bus) issues.push({ path: `${at}.bus`, code: "AUDIO_EVENT_BUS_MISSING", message: `Audio event '${id}' needs a bus` });
    else if (!names.has(bus)) issues.push({ path: `${at}.bus`, code: "AUDIO_EVENT_BUS_UNKNOWN", message: `Audio event '${id}' refers to unknown bus '${bus}'` });
    if (raw.streams !== undefined && !(Array.isArray(raw.streams) && raw.streams.every((item) => typeof item === "string" && item.trim().length > 0))) {
      issues.push({ path: `${at}.streams`, code: "AUDIO_EVENT_STREAMS_INVALID", message: "streams must be a list of resource paths" });
    }
    for (const key of ["volume_db", "pitch", "cooldown", "priority"] as const) {
      if (raw[key] !== undefined && !(typeof raw[key] === "number" && Number.isFinite(raw[key]))) {
        issues.push({ path: `${at}.${key}`, code: "AUDIO_EVENT_NUMBER_INVALID", message: `${key} must be a number` });
      }
    }
    if (raw.pitch !== undefined && typeof raw.pitch === "number" && raw.pitch < 0) {
      issues.push({ path: `${at}.pitch`, code: "AUDIO_EVENT_NUMBER_INVALID", message: "pitch must not be negative" });
    }
    if (raw.cooldown !== undefined && typeof raw.cooldown === "number" && raw.cooldown < 0) {
      issues.push({ path: `${at}.cooldown`, code: "AUDIO_EVENT_NUMBER_INVALID", message: "cooldown must not be negative" });
    }
    if (raw.max_concurrent !== undefined && !(typeof raw.max_concurrent === "number" && Number.isInteger(raw.max_concurrent) && raw.max_concurrent >= 1 && raw.max_concurrent <= 64)) {
      issues.push({ path: `${at}.max_concurrent`, code: "AUDIO_EVENT_CONCURRENCY_INVALID", message: "max_concurrent must be an integer between 1 and 64" });
    }
    for (const key of ["loop", "positional"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
        issues.push({ path: `${at}.${key}`, code: "AUDIO_EVENT_FLAG_INVALID", message: `${key} must be a boolean` });
      }
    }
  });

  return issues;
}

/** Only the audio system declares buses and events; other systems keep their fields. */
export const AUDIO_SYSTEM_ID = "audio";
export const AUDIO_SYSTEM_PATH = "specs/systems/audio.md";
