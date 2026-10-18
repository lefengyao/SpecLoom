import type { VersionToken } from "./contracts";

export type ProjectMediaKind = "image" | "audio" | "video";
export interface ProjectMediaLease {
  id: string;
  url: string;
  kind: ProjectMediaKind;
  mimeType: string;
  size: number;
  generation: string;
}
export interface ProjectTextFile {
  path: string;
  version: VersionToken;
  size: number;
  content: string;
}
