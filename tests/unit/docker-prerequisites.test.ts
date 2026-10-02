import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DockerExecutionResult, DockerExecutor } from "../../src/main/core/docker-process";
import { ProjectError } from "../../src/main/core/errors";
import { BASH_IMAGE, GODOT_IMAGE } from "../../src/main/core/snapshot-runner";
import { dockerPrerequisites, type DockerPrerequisiteReason } from "../integration/docker-prerequisites";

const suite = "prerequisite-fixture";
const infoCommand = ["info", "--format", "{{.OSType}}"];
const imageCommand = (image: string) => ["image", "inspect", "--format", "{{.Id}}", image];
const probeOptions = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };
let warnings: MockInstance<typeof console.warn>;

beforeEach(() => { warnings = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warnings.mockRestore(); });

function execution(stdout = "", stderr = "", exitCode = 0): DockerExecutionResult {
  return { stdout, stderr, exitCode, durationMs: 1 };
}

function warningFor(reason: DockerPrerequisiteReason): Record<string, unknown> {
  expect(warnings).toHaveBeenCalledOnce();
  const entry = warnings.mock.calls[0]![0] as string;
  expect(typeof entry).toBe("string");
  const warning = JSON.parse(entry) as Record<string, unknown>;
  expect(warning).toMatchObject({ event: "docker-integration-skipped", suite, available: false, reason });
  return warning;
}

describe("Docker integration prerequisites", () => {
  it("reports an unavailable daemon before inspecting any image", async () => {
    const docker = vi.fn<DockerExecutor>().mockResolvedValue(execution("", "Cannot connect to the Docker daemon", 1));

    const availability = await dockerPrerequisites(suite, [BASH_IMAGE], docker);

    expect(availability).toMatchObject({ available: false, reason: "DOCKER_DAEMON_UNAVAILABLE", details: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" } });
    expect(docker).toHaveBeenCalledExactlyOnceWith(infoCommand, probeOptions);
    expect(warningFor("DOCKER_DAEMON_UNAVAILABLE")).toMatchObject({ details: { command: infoCommand, exitCode: 1 } });
  });

  it("reports an executable that cannot start", async () => {
    const docker = vi.fn<DockerExecutor>().mockRejectedValue(new ProjectError("BACKEND_UNAVAILABLE", "Docker could not be started"));

    const availability = await dockerPrerequisites(suite, [BASH_IMAGE], docker);

    expect(availability).toMatchObject({ available: false, reason: "DOCKER_EXECUTABLE_UNAVAILABLE", details: { error: { code: "BACKEND_UNAVAILABLE" } } });
    expect(docker).toHaveBeenCalledExactlyOnceWith(infoCommand, probeOptions);
    expect(warningFor("DOCKER_EXECUTABLE_UNAVAILABLE")).toMatchObject({ details: { command: infoCommand } });
  });

  it("requires a Linux engine before inspecting any image", async () => {
    const docker = vi.fn<DockerExecutor>().mockResolvedValue(execution("windows\n"));

    const availability = await dockerPrerequisites(suite, [BASH_IMAGE], docker);

    expect(availability).toMatchObject({ available: false, reason: "DOCKER_LINUX_ENGINE_REQUIRED", details: { osType: "windows" } });
    expect(docker).toHaveBeenCalledExactlyOnceWith(infoCommand, probeOptions);
    expect(warningFor("DOCKER_LINUX_ENGINE_REQUIRED")).toMatchObject({ details: { osType: "windows" } });
  });

  it("identifies the unavailable pinned image and stops before later images", async () => {
    const docker = vi.fn<DockerExecutor>()
      .mockResolvedValueOnce(execution("linux\n"))
      .mockResolvedValueOnce(execution("", "No such image", 1));

    const availability = await dockerPrerequisites(suite, [BASH_IMAGE, GODOT_IMAGE], docker);

    expect(availability).toMatchObject({ available: false, reason: "DOCKER_IMAGE_UNAVAILABLE", details: { image: BASH_IMAGE, exitCode: 1, stderr: "No such image" } });
    expect(docker).toHaveBeenCalledTimes(2);
    expect(docker).toHaveBeenNthCalledWith(1, infoCommand, probeOptions);
    expect(docker).toHaveBeenNthCalledWith(2, imageCommand(BASH_IMAGE), probeOptions);
    expect(warningFor("DOCKER_IMAGE_UNAVAILABLE")).toMatchObject({ details: { image: BASH_IMAGE, command: imageCommand(BASH_IMAGE) } });
  });

  it("returns the inspected image IDs without warning when every prerequisite is ready", async () => {
    const docker = vi.fn<DockerExecutor>()
      .mockResolvedValueOnce(execution("linux\n"))
      .mockResolvedValueOnce(execution("sha256:bash-fixture\n"))
      .mockResolvedValueOnce(execution("sha256:godot-fixture\n"));

    const availability = await dockerPrerequisites(suite, [BASH_IMAGE, GODOT_IMAGE], docker);

    expect(availability).toEqual({ available: true, osType: "linux", imageIds: { [BASH_IMAGE]: "sha256:bash-fixture", [GODOT_IMAGE]: "sha256:godot-fixture" } });
    expect(docker).toHaveBeenCalledTimes(3);
    expect(docker).toHaveBeenNthCalledWith(1, infoCommand, probeOptions);
    expect(docker).toHaveBeenNthCalledWith(2, imageCommand(BASH_IMAGE), probeOptions);
    expect(docker).toHaveBeenNthCalledWith(3, imageCommand(GODOT_IMAGE), probeOptions);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([new TypeError("Unexpected probe failure"), new ProjectError("INTERNAL_ERROR", "Unexpected project failure")])("does not turn an unexpected error into a skipped test: %s", async (error) => {
    const docker = vi.fn<DockerExecutor>().mockRejectedValue(error);

    await expect(dockerPrerequisites(suite, [BASH_IMAGE], docker)).rejects.toBe(error);

    expect(docker).toHaveBeenCalledExactlyOnceWith(infoCommand, probeOptions);
    expect(warnings).not.toHaveBeenCalled();
  });
});
