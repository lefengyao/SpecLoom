import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/desktop-api";

async function invoke<T>(operation: string, payload: unknown = {}): Promise<T> {
  const reply = await ipcRenderer.invoke("specloom:invoke", operation, payload) as { ok: true; data: T } | { ok: false; error: { message: string; code: string; details?: Record<string, unknown> } };
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, details: reply.error.details });
  return reply.data;
}

const api: DesktopApi = {
  state: () => invoke("state"), selectProject: () => invoke("selectProject"), openProject: (path) => invoke("openProject", { path }), createExample: () => invoke("createExample"),
  createTask: (scope) => invoke("createTask", { scope }), tool: (taskId, name, input) => invoke("tool", { taskId, name, input }),
  preview: (taskId) => invoke("preview", { taskId }), approve: (taskId, digest) => invoke("approve", { taskId, digest }),
  reject: (taskId) => invoke("reject", { taskId }), validate: (taskId) => invoke("validate", { taskId }),
  agent: (taskId, modelId, prompt) => invoke("agent", { taskId, modelId, prompt }), cancel: (taskId) => invoke("cancel", { taskId }),
  saveModel: (profile, secret) => invoke("saveModel", { profile, ...(secret === undefined ? {} : { secret }) }), removeModel: (id) => invoke("removeModel", { id }),
  readDocument: (path, expectedVersion) => invoke("readDocument", { path, expectedVersion }), documents: () => invoke("documents"),
};
contextBridge.exposeInMainWorld("specloom", Object.freeze(api));
