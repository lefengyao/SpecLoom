import { executeDocker, type DockerExecutor } from "../../src/main/core/docker-process";
import { ProjectError, serializeError } from "../../src/main/core/errors";

export type DockerPrerequisiteReason =
  | "DOCKER_EXECUTABLE_UNAVAILABLE"
  | "DOCKER_DAEMON_UNAVAILABLE"
  | "DOCKER_LINUX_ENGINE_REQUIRED"
  | "DOCKER_IMAGE_UNAVAILABLE";

export type DockerPrerequisiteAvailability =
  | { available: true; osType: "linux"; imageIds: Record<string, string> }
  | { available: false; reason: DockerPrerequisiteReason; message: string; details: Record<string, unknown> };

const probeOptions = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };

export async function dockerPrerequisites(
  suite: string,
  images: readonly string[],
  docker: DockerExecutor = executeDocker,
): Promise<DockerPrerequisiteAvailability> {
  const unavailable = (reason: DockerPrerequisiteReason, message: string, details: Record<string, unknown>): DockerPrerequisiteAvailability => {
    const result = { available: false as const, reason, message, details };
    console.warn(JSON.stringify({ event: "docker-integration-skipped", suite, ...result }));
    return result;
  };
  const probeFailure = (error: unknown, command: string[], reason: DockerPrerequisiteReason, message: string): DockerPrerequisiteAvailability => {
    if (!(error instanceof ProjectError) || !["BACKEND_UNAVAILABLE", "COMMAND_FAILED"].includes(error.code)) throw error;
    return unavailable(
      error.code === "BACKEND_UNAVAILABLE" ? "DOCKER_EXECUTABLE_UNAVAILABLE" : reason,
      error.code === "BACKEND_UNAVAILABLE" ? "Docker executable could not be started." : message,
      { command, error: serializeError(error) },
    );
  };

  const infoCommand = ["info", "--format", "{{.OSType}}"];
  let info;
  try {
    info = await docker(infoCommand, probeOptions);
  } catch (error) {
    return probeFailure(error, infoCommand, "DOCKER_DAEMON_UNAVAILABLE", "Docker daemon could not be queried.");
  }
  if (info.exitCode !== 0) return unavailable("DOCKER_DAEMON_UNAVAILABLE", "Docker daemon is unavailable.", { command: infoCommand, ...info });
  const osType = info.stdout.trim();
  if (osType !== "linux") return unavailable("DOCKER_LINUX_ENGINE_REQUIRED", "Docker integration tests require a Linux container engine.", { osType, command: infoCommand, ...info });

  const imageIds: Record<string, string> = {};
  for (const image of images) {
    const imageCommand = ["image", "inspect", "--format", "{{.Id}}", image];
    let inspected;
    try {
      inspected = await docker(imageCommand, probeOptions);
    } catch (error) {
      return probeFailure(error, imageCommand, "DOCKER_IMAGE_UNAVAILABLE", `Required pinned Docker image could not be inspected: ${image}`);
    }
    const imageId = inspected.stdout.trim();
    if (inspected.exitCode !== 0 || imageId.length === 0) {
      return unavailable("DOCKER_IMAGE_UNAVAILABLE", "Required pinned Docker image is unavailable locally.", { image, command: imageCommand, ...inspected });
    }
    imageIds[image] = imageId;
  }
  return { available: true, osType: "linux", imageIds };
}
