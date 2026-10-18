import type { BrowserWindow, IpcMain, OpenDialogOptions } from "electron";
import type { EncryptionAdapter } from "../main/core/model-vault";

/** Trailblazer Hub API 2 runtime context; contains no app/window ownership. */
export interface HubRuntimeContext {
  apiVersion: 1;
  moduleRoot: string;
  dataDirectory: string;
  window: BrowserWindow;
  rendererUrl: string;
  ipc: Pick<IpcMain, "handle">;
  selectFiles(options: OpenDialogOptions): Promise<string[]>;
  encryption: EncryptionAdapter;
}
