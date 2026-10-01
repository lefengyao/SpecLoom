import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("specloom", Object.freeze({}));
