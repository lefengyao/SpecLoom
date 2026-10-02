import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

export interface ChildSnapshotRecord {
  schemaVersion: 1;
  id: string;
  ownerPid: number;
  instanceId: string;
  directory: string;
  containers: string[];
}

export function startSnapshotOwner(root: string, id: string) {
  const source = `
    import { mkdir, open, writeFile } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    const fixture = ${JSON.stringify({ root, id, instanceId: randomUUID(), container: `specloom-${randomUUID()}` })};
    const directory = path.join(os.tmpdir(), "specloom-snapshot-" + fixture.id);
    const registry = path.join(fixture.root, ".specloom", "runtime", "snapshots");
    const record = { schemaVersion: 1, id: fixture.id, ownerPid: process.pid, instanceId: fixture.instanceId, directory, containers: [fixture.container] };
    await mkdir(registry, { recursive: true });
    const handle = await open(path.join(registry, fixture.id + ".json"), "wx");
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await mkdir(directory);
    await writeFile(path.join(directory, "a.md"), "private child change");
    process.stdout.write(JSON.stringify(record) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const ready = new Promise<ChildSnapshotRecord>((resolve, reject) => {
    let stdout = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(stdout.slice(0, newline)) as ChildSnapshotRecord); } catch (error) { reject(error); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error(`Snapshot owner exited before registration: ${stderr}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Snapshot owner registration timed out: ${stderr}`)); }, 5_000);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return { child, ready };
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
