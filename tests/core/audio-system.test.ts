import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { builtinAudioBuses, mergeBuiltinBuses, validateAudioSpec } from "../../src/shared/audio-system";
import { normalizeMaterialGroups, validateMaterialGroupRegistry } from "../../src/shared/material-groups";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { Validator } from "../../src/main/core/validator";
import { WorkMaterials } from "../../src/main/core/tools/materials";

const roots: string[] = [];
const md = (data: Record<string, unknown>, body = "\n# Doc\n") => `---\n${stringify(data)}---\n${body}`;
const AUDIO = "specs/systems/audio.md";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-audio-"));
  roots.push(root);
  const layout = new ProjectLayout();
  await layout.initialize(root);
  return { root, layout, validator: new Validator(new FileStore(root)) };
}

async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("audio spec validation", () => {
  it("accepts the default buses", () => {
    expect(validateAudioSpec({ buses: builtinAudioBuses(), events: [] })).toEqual([]);
  });

  it("rejects duplicate names, bad names, missing builtins and master parents", () => {
    const duplicate = validateAudioSpec({ buses: [...builtinAudioBuses(), { name: "sfx" }], events: [] });
    expect(duplicate).toContainEqual(expect.objectContaining({ code: "AUDIO_BUS_DUPLICATE" }));
    const badName = validateAudioSpec({ buses: [...builtinAudioBuses(), { name: "UI Bus" }], events: [] });
    expect(badName).toContainEqual(expect.objectContaining({ code: "AUDIO_BUS_NAME_INVALID" }));
    const missing = validateAudioSpec({ buses: builtinAudioBuses().filter((bus) => bus.name !== "sfx"), events: [] });
    expect(missing).toContainEqual(expect.objectContaining({ code: "AUDIO_BUS_BUILTIN_MISSING" }));
    const masterParent = validateAudioSpec({ buses: builtinAudioBuses().map((bus) => bus.name === "master" ? { ...bus, parent: "music" } : bus), events: [] });
    expect(masterParent).toContainEqual(expect.objectContaining({ code: "AUDIO_MASTER_PARENT_INVALID" }));
  });

  it("detects unknown parents and routing cycles", () => {
    const unknown = validateAudioSpec({ buses: [...builtinAudioBuses(), { name: "ui", parent: "nope" }], events: [] });
    expect(unknown).toContainEqual(expect.objectContaining({ code: "AUDIO_BUS_PARENT_UNKNOWN" }));
    const cycle = validateAudioSpec({
      buses: [...builtinAudioBuses(), { name: "a", parent: "b" }, { name: "b", parent: "a" }],
      events: [],
    });
    expect(cycle).toContainEqual(expect.objectContaining({ code: "AUDIO_BUS_PARENT_CYCLE" }));
  });

  it("checks events against declared buses", () => {
    const unknownBus = validateAudioSpec({
      buses: builtinAudioBuses(),
      events: [{ id: "ui_click", bus: "ui" }],
    });
    expect(unknownBus).toContainEqual(expect.objectContaining({ code: "AUDIO_EVENT_BUS_UNKNOWN" }));
    const duplicate = validateAudioSpec({
      buses: builtinAudioBuses(),
      events: [{ id: "ui_click", bus: "sfx" }, { id: "ui_click", bus: "music" }],
    });
    expect(duplicate).toContainEqual(expect.objectContaining({ code: "AUDIO_EVENT_DUPLICATE" }));
    const badNumbers = validateAudioSpec({
      buses: builtinAudioBuses(),
      events: [{ id: "ui_click", bus: "sfx", max_concurrent: 0, pitch: -1 }],
    });
    expect(badNumbers).toContainEqual(expect.objectContaining({ code: "AUDIO_EVENT_CONCURRENCY_INVALID" }));
    expect(badNumbers).toContainEqual(expect.objectContaining({ code: "AUDIO_EVENT_NUMBER_INVALID" }));
  });

  it("merges missing built-in buses without touching existing values", () => {
    const existing = [{ name: "master", volume: 0.4, muted: true }, { name: "ui", parent: "master", volume: 0.7 }];
    const merged = mergeBuiltinBuses(existing);
    expect(merged.changed).toBe(true);
    expect(merged.buses[0]).toEqual({ name: "master", volume: 0.4, muted: true });
    expect(merged.buses.map((bus) => bus.name)).toEqual(["master", "ui", "music", "sfx"]);
    expect(mergeBuiltinBuses(merged.buses).changed).toBe(false);
  });
});

describe("official scope", () => {
  it("seeds official groups and keeps their scope through normalization", async () => {
    const { root } = await fixture();
    const data = parse((await readFile(path.join(root, "specs/project.md"), "utf8")).split("---")[1]!) as {
      materialGroups: { component?: { scope?: string }[]; system?: { scope?: string }[] };
    };
    expect(data.materialGroups.component?.[0]?.scope).toBe("system");
    expect(data.materialGroups.system?.[0]?.scope).toBe("system");
    const registry = normalizeMaterialGroups(data.materialGroups);
    expect(registry.component?.[0]?.scope).toBe("system");
    expect(validateMaterialGroupRegistry(data.materialGroups)).toEqual([]);
    expect(validateMaterialGroupRegistry({ component: [{ id: "g", name: "组", order: 0, scope: "owner" }] }))
      .toContainEqual("GROUP_NODE_INVALID");
  });

  it("marks the seeded audio system as official and grouped", async () => {
    const { root } = await fixture();
    const data = parse((await readFile(path.join(root, AUDIO), "utf8")).split("---")[1]!) as { scope?: string; groupId?: string };
    expect(data.scope).toBe("system");
    expect(data.groupId).toBe("group_audio");
  });
});

describe("audio system seeding", () => {
  it("creates the audio system with the three built-in buses", async () => {
    const { root, validator } = await fixture();
    const content = await readFile(path.join(root, AUDIO), "utf8");
    const data = parse(content.split("---")[1]!) as { id: string; buses: { name: string }[] };
    expect(data.id).toBe("audio");
    expect(data.buses.map((bus) => bus.name)).toEqual(["master", "music", "sfx"]);
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("is idempotent across reopens", async () => {
    const { root, layout } = await fixture();
    const first = await readFile(path.join(root, AUDIO), "utf8");
    await layout.initialize(root);
    expect(await readFile(path.join(root, AUDIO), "utf8")).toBe(first);
  });

  it("backfills missing built-ins into an existing audio system", async () => {
    const { root, layout, validator } = await fixture();
    await writeFile(path.join(root, AUDIO), md({
      schemaVersion: 1, id: "audio", title: "音频", type: "system", description: "",
      buses: [{ name: "master", volume: 0.4 }, { name: "ui", parent: "master", volume: 0.6 }],
      events: [],
    }));
    await layout.initialize(root);
    const data = parse((await readFile(path.join(root, AUDIO), "utf8")).split("---")[1]!) as { buses: { name: string; volume?: number }[] };
    expect(data.buses.map((bus) => bus.name)).toEqual(["master", "ui", "music", "sfx"]);
    expect(data.buses[0]!.volume).toBe(0.4);
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("seeds the audio capability components and their initial mounts", async () => {
    const { root, validator } = await fixture();
    const source = parse((await readFile(path.join(root, "specs/components/audio_source.md"), "utf8")).split("---")[1]!) as {
      id: string; scope?: string; groupId?: string; fields: { key: string; default: unknown }[];
    };
    expect(source.id).toBe("audio_source");
    expect(source.scope).toBe("system");
    expect(source.groupId).toBe("group_audio_components");
    expect(source.fields.map((field) => field.key)).toContain("positional");

    const listener = parse((await readFile(path.join(root, "specs/components/audio_listener.md"), "utf8")).split("---")[1]!) as { id: string; scope?: string };
    expect(listener).toMatchObject({ id: "audio_listener", scope: "system" });

    const audio = parse((await readFile(path.join(root, AUDIO), "utf8")).split("---")[1]!) as {
      components?: string[]; mounts?: { id: string; key?: string }[];
    };
    expect(audio.components).toEqual(["audio_source", "audio_listener"]);
    expect(audio.mounts?.map((mount) => mount.key)).toEqual(["listener", "music", "sfx"]);

    const project = parse((await readFile(path.join(root, "specs/project.md"), "utf8")).split("---")[1]!) as {
      materialGroups?: { component?: { id: string; scope?: string }[] };
    };
    expect(project.materialGroups?.component).toContainEqual(expect.objectContaining({ id: "group_audio_components", scope: "system" }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("backfills components and mounts without rewriting custom ones", async () => {
    const { root, layout, validator } = await fixture();
    await writeFile(path.join(root, AUDIO), md({
      schemaVersion: 1, id: "audio", title: "音频", type: "system", description: "",
      buses: builtinAudioBuses(), events: [],
      mounts: [{ id: "audio_source", key: "ui", values: { bus: "sfx" } }],
    }));
    await layout.initialize(root);
    const data = parse((await readFile(path.join(root, AUDIO), "utf8")).split("---")[1]!) as {
      components?: string[]; mounts?: { id: string; key?: string }[];
    };
    expect(data.components).toEqual(["audio_source", "audio_listener"]);
    expect(data.mounts?.map((mount) => mount.key)).toEqual(["ui"]);
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);

    await layout.initialize(root);
    const again = parse((await readFile(path.join(root, AUDIO), "utf8")).split("---")[1]!) as { mounts?: unknown[] };
    expect(again.mounts).toHaveLength(1);
  });

  it("reports structural problems in the audio system", async () => {
    const { root, validator } = await fixture();
    await writeFile(path.join(root, AUDIO), md({
      schemaVersion: 1, id: "audio", title: "音频", type: "system", description: "",
      buses: [{ name: "master", volume: 1 }, { name: "music", parent: "master", volume: 1 }],
      events: [{ id: "ui_click", bus: "missing" }],
    }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: AUDIO, code: "AUDIO_BUS_BUILTIN_MISSING" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: AUDIO, code: "AUDIO_EVENT_BUS_UNKNOWN" }));
  });

  it("keeps audio fields on the audio system only", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/systems/combat.md", md({
      schemaVersion: 1, id: "combat", title: "战斗", type: "system", description: "", buses: builtinAudioBuses(),
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/systems/combat.md", code: "AUDIO_SYSTEM_INVALID" }));
  });

  it("applies the same rules through the material tools", async () => {
    const { root } = await fixture();
    const materials = new WorkMaterials(new FileStore(root));
    const audio = await materials.read(AUDIO) as { version: string };
    await expect(materials.update({
      path: AUDIO, expectedVersion: audio.version,
      changes: { events: [{ id: "ui_click", bus: "missing" }] },
    })).rejects.toThrow(/unknown bus/);

    const component = await materials.create({ category: "component", title: "生命" }) as { path: string };
    const created = await materials.read(component.path) as { version: string };
    await expect(materials.update({
      path: component.path, expectedVersion: created.version,
      changes: { buses: builtinAudioBuses() },
    })).rejects.toThrow(/系统/);

    await materials.update({
      path: AUDIO, expectedVersion: audio.version,
      changes: { buses: [...builtinAudioBuses(), { name: "ui", parent: "master", volume: 1 }] },
    });
    expect(await readFile(path.join(root, AUDIO), "utf8")).toContain("name: ui");
  });
});
