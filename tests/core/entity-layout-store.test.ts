import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EntityLayoutStore } from "../../src/main/core/entity-layout-store";
import type { EntityLayout } from "../../src/shared/entity-layout";

const roots: string[] = [];
async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "specloom-entity-layout-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EntityLayoutStore", () => {
  test("saves and reads the project-local sidecar atomically", async () => {
    const directory = await root();
    const store = new EntityLayoutStore(directory);
    expect(await store.read()).toEqual({});
    const result = await store.save({ keeper: { health: { x: 12, y: 34 } } });
    expect(result).toEqual({ keeper: { health: { x: 12, y: 34 } } });
    expect(await store.read()).toEqual(result);
    const raw = await readFile(path.join(directory, ".specloom", "editor", "entity-layouts.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(result);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("persists custom anchors and explicit connection ends", async () => {
    const directory = await root();
    const store = new EntityLayoutStore(directory);
    const layout = {
      keeper: { health: { x: 12, y: 34, sourceAnchor: "left", targetAnchor: "custom-right", anchors: [{ id: "custom-right", side: "right", offset: 25 }] } },
    } as unknown as EntityLayout;
    expect(await store.save(layout)).toEqual(layout);
    expect(await store.read()).toEqual(layout);
  });

  test("persists measured card sizes and the entity row", async () => {
    const directory = await root();
    const store = new EntityLayoutStore(directory);
    const layout = {
      keeper: {
        __entity__: { x: 0, y: 0, size: { width: 220, height: 170 } },
        health: { x: 244, y: 0, size: { width: 196, height: 120 } },
      },
    } as unknown as EntityLayout;
    expect(await store.save(layout)).toEqual(layout);
    expect(await store.read()).toEqual(layout);
  });

  test("serializes a burst of saves and leaves no temporary files behind", async () => {
    const directory = await root();
    const store = new EntityLayoutStore(directory);
    const layouts = Array.from({ length: 12 }, (_, index) => ({ keeper: { health: { x: index, y: index } } } as unknown as EntityLayout));
    // Overlapping renames onto one file fail intermittently on Windows; the queue prevents that.
    const results = await Promise.all(layouts.map((layout) => store.save(layout)));
    expect(results).toHaveLength(12);
    expect(await readdir(path.join(directory, ".specloom", "editor"))).toEqual(["entity-layouts.json"]);
    expect(await store.read()).toEqual(layouts[layouts.length - 1]);
  });

  test("filters hostile points and tolerates corrupt JSON", async () => {
    const directory = await root();
    const store = new EntityLayoutStore(directory);
    expect(await store.save({ keeper: { health: { x: 1, y: 2 }, bad: { x: "1", y: 2 } } } as unknown as EntityLayout)).toEqual({
      keeper: { health: { x: 1, y: 2 } },
    });
    const file = path.join(directory, ".specloom", "editor", "entity-layouts.json");
    await writeFile(file, "{not json", "utf8");
    expect(await store.read()).toEqual({});
  });
});
