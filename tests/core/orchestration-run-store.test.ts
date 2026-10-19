import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAX_ORCHESTRATION_RUN_BYTES,
  MAX_ORCHESTRATION_RUN_ID_LENGTH,
  MAX_RUN_ERROR_LENGTH,
  MAX_STEP_SUMMARY_LENGTH,
  ORCHESTRATION_RUNS_DIRECTORY,
  OrchestrationRunStore,
} from "../../src/main/core/orchestration-run-store";
import { ProjectError } from "../../src/main/core/errors";
import type { OrchestrationRun, OrchestrationRunStep } from "../../src/shared/orchestration";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "specloom-orchestration-runs-"));
  roots.push(directory);
  return directory;
}

function runDirectory(directory: string): string {
  return path.join(directory, ...ORCHESTRATION_RUNS_DIRECTORY.split("/"));
}

function recordFile(directory: string, id: string): string {
  return path.join(runDirectory(directory), id + ".json");
}

function relativeRecord(id: string): string {
  return ORCHESTRATION_RUNS_DIRECTORY + "/" + id + ".json";
}

function makeStep(overrides: Partial<OrchestrationRunStep> = {}): OrchestrationRunStep {
  return {
    stepId: "s1",
    workflowId: "wf_official_development_review",
    approval: "inherit",
    status: "pending",
    ...overrides,
  };
}

function makeRun(id: string, overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    schemaVersion: 1,
    orchestrationRunId: id,
    orchestrationId: "orch_release",
    title: "Release " + id,
    inputs: { goal: "ship the release", readPaths: ["specs"], writePaths: ["src"] },
    steps: [makeStep()],
    currentStepIndex: 0,
    status: "queued",
    startedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function completedRun(id: string, startedAt: string, overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return makeRun(id, {
    status: "completed",
    startedAt,
    finishedAt: startedAt,
    steps: [makeStep({ status: "completed" })],
    ...overrides,
  });
}

async function failureOf(operation: () => Promise<unknown>): Promise<ProjectError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with a ProjectError");
}

describe("orchestration run store", () => {
  test("saves a run under the fixed directory and reads it back", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const record = completedRun("run-1", "2025-01-01T00:00:00.000Z", { title: "Release" });

    const saved = await store.save(record);
    expect(saved).toEqual(record);
    expect(ORCHESTRATION_RUNS_DIRECTORY).toBe(".specloom/workflows/orchestration-runs");
    expect(JSON.parse(await readFile(recordFile(directory, "run-1"), "utf8"))).toEqual(record);
    expect(await store.get("run-1")).toEqual(record);
    expect(await readdir(runDirectory(directory))).toEqual(["run-1.json"]);

    const updated = completedRun("run-1", "2025-01-01T00:00:00.000Z", { title: "Release updated" });
    await store.save(updated);
    expect(await store.get("run-1")).toEqual(updated);
  });

  test("lists runs newest first and skips records that are not readable run files", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    await store.save(completedRun("run-early", "2025-01-01T00:00:00.000Z"));
    await store.save(completedRun("run-b", "2025-01-02T00:00:00.000Z"));
    await store.save(completedRun("run-late", "2025-01-02T00:00:00.000Z"));

    await writeFile(path.join(runDirectory(directory), "broken.json"), "{ not json", "utf8");
    await writeFile(path.join(runDirectory(directory), "BAD NAME.json"), "{}", "utf8");
    await writeFile(path.join(runDirectory(directory), "notes.txt"), "ignored", "utf8");
    await mkdir(path.join(runDirectory(directory), "nested"), { recursive: true });

    expect((await store.list()).map((record) => record.orchestrationRunId)).toEqual([
      "run-late",
      "run-b",
      "run-early",
    ]);
  });

  test("loads queued and running records as interrupted and persists the normalized state", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const queued = makeRun("run-queued", { status: "queued" });
    const running = makeRun("run-running", {
      status: "running",
      steps: [makeStep({ status: "running" }), makeStep({ stepId: "s2", status: "pending" })],
      currentStepIndex: 0,
    });
    await store.save(queued);
    await store.save(running);

    const hydratedQueued = await store.get("run-queued");
    expect(hydratedQueued.status).toBe("interrupted");
    expect(hydratedQueued.error).toMatch(/interrupted/i);
    expect(hydratedQueued.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(await readFile(recordFile(directory, "run-queued"), "utf8")).status).toBe("interrupted");

    const hydratedRunning = await store.get("run-running");
    expect(hydratedRunning.status).toBe("interrupted");
    expect(hydratedRunning.steps[0]?.status).toBe("failed");
    expect(hydratedRunning.steps[0]?.error).toMatch(/interrupted/i);
    expect(hydratedRunning.steps[1]?.status).toBe("pending");
    expect(JSON.parse(await readFile(recordFile(directory, "run-running"), "utf8")).status).toBe("interrupted");
  });

  test("preserves waiting_approval records without rewriting them", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const waiting = makeRun("run-waiting", {
      status: "waiting_approval",
      steps: [makeStep({ status: "waiting_approval", runId: "run-child" })],
    });
    const saved = await store.save(waiting);
    const before = await readFile(recordFile(directory, "run-waiting"), "utf8");

    const loaded = await store.get("run-waiting");
    expect(loaded).toEqual(saved);
    expect(loaded.status).toBe("waiting_approval");
    expect(loaded.finishedAt).toBeUndefined();
    expect(await readFile(recordFile(directory, "run-waiting"), "utf8")).toBe(before);
  });

  test("rejects malformed records with a bounded ProjectError that names the file", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    await mkdir(runDirectory(directory), { recursive: true });
    await writeFile(recordFile(directory, "run-json"), "{ not json", "utf8");

    const jsonFailure = await failureOf(() => store.get("run-json"));
    expect(jsonFailure.code).toBe("INTERNAL_ERROR");
    expect(jsonFailure.details).toMatchObject({ path: relativeRecord("run-json") });
    expect(jsonFailure.message.length).toBeLessThanOrEqual(MAX_RUN_ERROR_LENGTH);
    expect(jsonFailure.message).not.toContain("not json");

    const badStatus = { ...completedRun("run-bad", "2025-01-01T00:00:00.000Z"), status: "bogus" };
    await writeFile(recordFile(directory, "run-bad"), JSON.stringify(badStatus), "utf8");
    const shapeFailure = await failureOf(() => store.get("run-bad"));
    expect(shapeFailure.code).toBe("INTERNAL_ERROR");
    expect(shapeFailure.message).toContain("status");
    expect(shapeFailure.details).toMatchObject({ path: relativeRecord("run-bad") });

    const mismatch = {
      ...completedRun("run-mismatch", "2025-01-01T00:00:00.000Z"),
      orchestrationRunId: "run-other",
    };
    await writeFile(recordFile(directory, "run-mismatch"), JSON.stringify(mismatch), "utf8");
    const mismatchFailure = await failureOf(() => store.get("run-mismatch"));
    expect(mismatchFailure.code).toBe("INTERNAL_ERROR");
    expect(mismatchFailure.message).toMatch(/different orchestrationRunId/i);
    expect(mismatchFailure.details).toMatchObject({ path: relativeRecord("run-mismatch") });
  });

  test("rejects invalid run shapes on save with VALIDATION_FAILED and the record path", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const candidates: unknown[] = [
      { ...makeRun("run-bad"), status: "bogus" },
      { ...makeRun("run-bad"), steps: [] },
      { ...makeRun("run-bad"), steps: [makeStep({ workflowId: "Bad" })] },
      { ...makeRun("run-bad"), steps: [{ ...makeStep(), approval: "sometimes" }] },
      { ...makeRun("run-bad"), currentStepIndex: 5 },
      { ...makeRun("run-bad"), orchestrationId: "Bad" },
      { ...makeRun("run-bad"), extra: true },
    ];

    for (const candidate of candidates) {
      const failure = await failureOf(() => store.save(candidate as OrchestrationRun));
      expect(failure.code).toBe("VALIDATION_FAILED");
      expect(failure.details).toMatchObject({ path: relativeRecord("run-bad") });
      expect(failure.message.length).toBeLessThanOrEqual(MAX_RUN_ERROR_LENGTH);
    }

    expect(await store.list()).toEqual([]);
  });

  test("rejects ids that could escape the run directory before touching the project", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const invalidIds = [
      "../escape",
      "..",
      "sub/run",
      "sub\\run",
      ".hidden",
      "",
      "a".repeat(MAX_ORCHESTRATION_RUN_ID_LENGTH + 1),
    ];

    for (const id of invalidIds) {
      const readFailure = await failureOf(() => store.get(id));
      expect(readFailure.code).toBe("VALIDATION_FAILED");
      expect(readFailure.details).toMatchObject({ path: relativeRecord(id) });

      const saveFailure = await failureOf(() => store.save(makeRun(id)));
      expect(saveFailure.code).toBe("VALIDATION_FAILED");
      expect(saveFailure.details).toMatchObject({ path: relativeRecord(id) });
    }

    expect(await readdir(directory)).toEqual([]);
  });

  test("redacts and bounds persisted errors and summaries", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    const secret = "super-secret-token-123";
    const longSummary = "s".repeat(MAX_STEP_SUMMARY_LENGTH + 100);
    const record = makeRun("run-bounded", {
      status: "failed",
      error: "apiKey=" + secret + " Bearer abcdef " + "x".repeat(5000),
      finishedAt: "2025-01-01T00:00:01.000Z",
      steps: [
        makeStep({
          status: "failed",
          error: "password=" + secret + " " + "y".repeat(5000),
          summary: longSummary,
        }),
      ],
    });

    const saved = await store.save(record);
    expect(saved.error).not.toContain(secret);
    expect(saved.error).not.toContain("abcdef");
    expect(saved.error).toContain("[redacted]");
    expect(saved.error?.length).toBeLessThanOrEqual(MAX_RUN_ERROR_LENGTH);
    expect(saved.steps[0]?.error).not.toContain(secret);
    expect(saved.steps[0]?.error).toContain("[redacted]");
    expect(saved.steps[0]?.error?.length).toBeLessThanOrEqual(MAX_RUN_ERROR_LENGTH);
    expect(saved.steps[0]?.summary?.length).toBe(MAX_STEP_SUMMARY_LENGTH);
    expect(JSON.parse(await readFile(recordFile(directory, "run-bounded"), "utf8"))).toEqual(saved);
  });

  test("rejects a record larger than the maximum record size", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    await mkdir(runDirectory(directory), { recursive: true });
    await writeFile(recordFile(directory, "run-huge"), "x".repeat(MAX_ORCHESTRATION_RUN_BYTES + 1), "utf8");

    const failure = await failureOf(() => store.get("run-huge"));
    expect(failure.code).toBe("INTERNAL_ERROR");
    expect(failure.message).toMatch(/maximum record size/i);
    expect(failure.details).toMatchObject({ path: relativeRecord("run-huge") });
  });

  test("writes atomically: concurrent saves leave one complete record and no temporary files", async () => {
    const directory = await root();
    const store = new OrchestrationRunStore(directory);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.save(completedRun("run-race", "2025-01-01T00:00:00.000Z", { title: "Race " + index })),
      ),
    );

    expect(await readdir(runDirectory(directory))).toEqual(["run-race.json"]);
    const loaded = await store.get("run-race");
    expect(loaded.title).toMatch(/^Race \d$/);
    expect(loaded.steps).toHaveLength(1);
  });
});
