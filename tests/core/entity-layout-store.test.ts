import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
