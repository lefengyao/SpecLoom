import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { FileStore } from "../file-store";
import { digestBytes } from "../store-fs";
import { ProjectError } from "../errors";
const TodoSchema = z.object({ id: z.string().max(256), title: z.string().max(200), description: z.string().max(4000), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) }).strict();
const StateSchema = z.object({ tasks: z.array(TodoSchema).max(256), memory: z.record(z.string().max(200), z.string().max(32768)) }).strict();
type State = z.infer<typeof StateSchema>;
/** Per-conversation state with atomic writes, inaccessible through project file tools. */
export class WorkState {
  private pending = Promise.resolve();
  private readonly relative: string;
  constructor(private readonly files: FileStore, sessionId: string) { this.relative = `.specloom/state/sessions/${digestBytes(sessionId).slice(7)}.json`; }
  private async read(): Promise<State> {
    const target = await this.files.policy.resolve(this.relative, true);
    try { const stat = await this.files.fs.lstat(target); if (stat.size > 1048576) throw new ProjectError("VALIDATION_FAILED", "会话工作状态过大"); return StateSchema.parse(JSON.parse(await readFile(target, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], memory: {} }; throw error; }
  }
  run<T>(action: (state: State) => T | Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      const state = await this.read(); const result = await action(state); const json = JSON.stringify(StateSchema.parse(state));
      if (Buffer.byteLength(json) > 1048576) throw new ProjectError("VALIDATION_FAILED", "会话工作状态过大");
      const target = await this.files.policy.resolve(this.relative, true); await this.files.policy.ensureParent(target); const temp = `${target}.${randomUUID()}.tmp`;
      try { await this.files.policy.assertSafe(temp, true); await writeFile(temp, json, { flag: "wx" }); await this.files.policy.assertSafe(target, true); await this.files.fs.rename(temp, target); }
      finally { await this.files.fs.unlink(temp).catch(() => undefined); }
      return result;
    }); this.pending = work.then(() => undefined, () => undefined); return work;
  }
}
