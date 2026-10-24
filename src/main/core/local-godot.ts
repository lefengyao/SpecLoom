import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeProcess, type DockerExecutionResult, type ProcessExecutor } from "./docker-process";

export interface LocalGodotOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  process?: ProcessExecutor;
}

/**
 * Runs a headless Godot process against `cwd` with a disposable user profile.
 * `/workspace` arguments are mapped to `cwd`, so callers can share container-shaped commands.
 */
export async function runLocalGodot(executable: string, args: string[], options: LocalGodotOptions): Promise<DockerExecutionResult & { command: string[] }> {
  const home = await mkdtemp(path.join(tmpdir(), "specloom-godot-home-"));
  try {
    if (process.platform === "win32") {
      await mkdir(path.join(home, "AppData", "Roaming"), { recursive: true });
      await mkdir(path.join(home, "AppData", "Local"), { recursive: true });
    } else {
      await mkdir(path.join(home, ".config"), { recursive: true });
      await mkdir(path.join(home, ".cache"), { recursive: true });
      await mkdir(path.join(home, ".local", "share"), { recursive: true });
    }
    await mkdir(path.join(home, "tmp"), { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(process.platform === "win32"
        ? { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp") }
        : { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local", "share"), TMPDIR: path.join(home, "tmp") }),
    };
    const localArgs = args.map((argument) => argument === "/workspace" ? options.cwd : argument);
    const result = await (options.process ?? executeProcess)(executable, localArgs, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cwd: options.cwd,
      env: environment,
      label: "Godot",
    });
    return { ...result, command: [executable, ...localArgs] };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
