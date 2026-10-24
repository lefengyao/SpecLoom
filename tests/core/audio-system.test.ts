import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { builtinAudioBuses, mergeBuiltinBuses, validateAudioSpec } from "../../src/shared/audio-system";
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
