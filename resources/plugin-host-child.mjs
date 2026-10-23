import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [root, entry] = process.argv.slice(2);
const handlers = new Map();
let activated = false;
let sequence = 0;
const pending = new Map();
const log = (...args) => console.error("[plugin]", ...args);
for (const method of ["log", "info", "debug", "warn"]) console[method] = log;

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function hostRequest(method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = `c${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Host request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
}
const storage = {
  get: (key) => hostRequest("storage.get", { key }),
  set: (key, value) => hostRequest("storage.set", { key, value }),
  delete: (key) => hostRequest("storage.delete", { key }),
};

async function handle(message) {
  if (message.method === "activate") {
    if (activated) return { commands: [...handlers.keys()] };
    const module = await import(pathToFileURL(path.resolve(root, entry)).href);
    if (typeof module.activate !== "function") throw new Error("Plugin exports no activate()");
    await module.activate({
      commands: { register(name, handler) { handlers.set(name, handler); } },
      storage,
    });
    activated = true;
    return { commands: [...handlers.keys()] };
  }
  if (message.method === "deactivate") {
    if (activated) {
      const module = await import(pathToFileURL(path.resolve(root, entry)).href);
      await module.deactivate?.();
    }
    activated = false;
    handlers.clear();
    return { ok: true };
  }
  if (message.method === "invoke") {
    const command = message.params?.command;
    const handler = handlers.get(command);
    if (!handler) throw Object.assign(new Error(`Unknown plugin command: ${command}`), { code: "COMMAND_NOT_FOUND" });
    const projectPath = message.params?.projectPath;
    return await handler(message.params?.input, { projectPath });
  }
  throw Object.assign(new Error(`Unknown plugin method: ${message.method}`), { code: "METHOD_NOT_FOUND" });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { log("invalid protocol JSON"); return; }
  if (message.method) {
    void handle(message).then(
      (result) => write({ id: message.id, ok: true, result }),
      (error) => write({ id: message.id, ok: false, error: { code: error?.code ?? "COMMAND_FAILED", message: error?.message ?? String(error) } }),
    );
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  clearTimeout(waiting.timer);
  if (message.ok) waiting.resolve(message.result);
  else waiting.reject(new Error(message.error?.message ?? "Host request failed"));
});
