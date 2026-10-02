import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { ModelProfileSchema, TaskScopeSpecSchema, VersionTokenSchema } from "../shared/contracts";
import { ProjectError, serializeError } from "./core/errors";
import type { DesktopController } from "./desktop-controller";

const id = z.string().min(1).max(256);
const operations = {
  state: z.object({}).strict(), selectProject: z.object({}).strict(), createExample: z.object({}).strict(),
  openProject: z.object({ path: z.string().min(1).max(4096) }).strict(),
  createTask: z.object({ scope: TaskScopeSpecSchema.omit({ id: true }) }).strict(),
  tool: z.object({ taskId: id, name: id, input: z.record(z.string(), z.unknown()) }).strict(),
  preview: z.object({ taskId: id }).strict(), approve: z.object({ taskId: id, digest: id }).strict(),
  reject: z.object({ taskId: id }).strict(), validate: z.object({ taskId: id }).strict(),
  agent: z.object({ taskId: id, modelId: id, prompt: z.string().min(1).max(131072) }).strict(),
  cancel: z.object({ taskId: id }).strict(), saveModel: z.object({ profile: ModelProfileSchema, secret: z.string().max(8192).optional() }).strict(),
  removeModel: z.object({ id }).strict(), documents: z.object({}).strict(),
  readDocument: z.object({ path: z.string().min(1).max(2048), expectedVersion: VersionTokenSchema }).strict(),
};

export function isTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow, rendererUrl: string): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererUrl;
}

export function registerIpc(ipc: IpcMain, controller: DesktopController, window: () => BrowserWindow | undefined, rendererUrl: string, selectDirectory: () => Promise<string | undefined>): void {
  ipc.handle("specloom:invoke", async (event, operation: unknown, payload: unknown) => {
    try {
      const target = window();
      if (!target || !isTrustedSender(event, target, rendererUrl)) throw new ProjectError("TASK_SCOPE_DENIED", "Untrusted IPC sender");
      if (typeof operation !== "string" || !Object.hasOwn(operations, operation)) throw new ProjectError("VALIDATION_FAILED", "Unknown desktop operation");
      if (JSON.stringify(payload)?.length > 1_048_576) throw new ProjectError("VALIDATION_FAILED", "IPC payload exceeds the size limit");
      const schema = operations[operation as keyof typeof operations];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Invalid desktop operation arguments");
      const data = parsed.data as Record<string, unknown>;
      const result = await dispatch(operation, data, controller, selectDirectory);
      return { ok: true, data: result };
    } catch (error) { return { ok: false, error: serializeError(error) }; }
  });
}

async function dispatch(operation: string, input: Record<string, unknown>, controller: DesktopController, selectDirectory: () => Promise<string | undefined>): Promise<unknown> {
  switch (operation) {
    case "state": return controller.state();
    case "selectProject": { const root = await selectDirectory(); return root ? controller.openProject(root) : controller.state(); }
    case "openProject": return controller.openProject(input.path as string);
    case "createExample": return controller.createExample();
    case "createTask": return controller.createTask(input.scope as z.infer<typeof TaskScopeSpecSchema>);
    case "tool": return controller.currentCore().executeTool(input.taskId as string, input.name as string, input.input as Record<string, unknown>);
    case "preview": return controller.currentCore().previewChanges(input.taskId as string);
    case "approve": return controller.currentCore().approveChanges(input.taskId as string, input.digest as string);
    case "reject": return controller.currentCore().rejectChanges(input.taskId as string);
    case "validate": return controller.currentCore().validate(input.taskId as string);
    case "agent": return controller.agent(input.taskId as string, input.modelId as string, input.prompt as string);
    case "cancel": return controller.cancel(input.taskId as string);
    case "saveModel": return controller.saveModel(input.profile as z.infer<typeof ModelProfileSchema>, input.secret as string | undefined);
    case "removeModel": return controller.vault.remove(input.id as string);
    case "documents": return controller.currentCore().documents();
    case "readDocument": return controller.readDocument(input.path as string, input.expectedVersion as z.infer<typeof VersionTokenSchema>);
    default: throw new ProjectError("VALIDATION_FAILED", "Unknown operation");
  }
}
