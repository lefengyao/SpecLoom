import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("shares the user-data diagnostics store with sessions and project runtimes, then flushes on shutdown", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-diagnostics-controller-"));
  roots.push(userData);
  const project = path.join(userData, "project");
  await mkdir(project);
  await writeFile(path.join(project, "project.godot"), '[application]\nconfig/name="Diagnostics test"\n');
  const controller = new DesktopController({ list: async () => [] } as unknown as ModelVault, userData, path.resolve("skills"));
  const sessions = controller.sessions as unknown as { diagnostics?: unknown };
  expect(sessions.diagnostics).toBe(controller.diagnosticsLog);

  await controller.openProject(project);
  const core = controller.currentCore() as unknown as { options: { diagnostics?: unknown } };
  expect(core.options.diagnostics).toBe(controller.diagnosticsLog);

  const pending = controller.diagnosticsLog.record({
    type: "request_started", diagnosticId: "9c1c7c73-ec83-41bb-8e1f-6d4770039f56",
    attempt: 1, providerId: "provider", modelId: "model", protocol: "openai",
  });
  await controller.shutdown();
  await pending;
  expect(await controller.diagnosticsSummary()).toMatchObject({ files: 1, events: 1 });
  expect((await controller.diagnosticsList({ limit: 20 })).events[0]).toMatchObject({ type: "request_started", severity: "info" });
  expect(await controller.diagnosticsClearAll()).toBe(1);
  expect(await controller.diagnosticsSummary()).toMatchObject({ files: 0, events: 0 });
});
