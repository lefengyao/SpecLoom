import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FileReadResult, VersionToken } from "../../shared/contracts";
import { workspacePromptLimit, workspacePromptPath } from "../../shared/workspace-prompt";
import { ProjectError } from "./errors";
import type { FileStore } from "./file-store";
import { digestBytes, encodeText, hasCode, removeTemporary } from "./store-fs";

function validatePrompt(content: string): void {
  if (typeof content !== "string" || content.length > workspacePromptLimit) {
    throw new ProjectError("VALIDATION_FAILED", `项目提示词最多 ${workspacePromptLimit} 字符`);
  }
}

export async function readWorkspacePrompt(store: FileStore): Promise<FileReadResult> {
  const current = await store.listVersion(workspacePromptPath);
  if (!current.exists) return { path: workspacePromptPath, version: "absent", content: "" };
  const result = await store.read(workspacePromptPath, current.version);
  validatePrompt(result.content);
  return result;
}

export async function saveWorkspacePrompt(store: FileStore, content: string, expectedVersion: VersionToken): Promise<FileReadResult> {
  validatePrompt(content);
  const bytes = encodeText(content, store.maxTextBytes);
  await store.withLock(async (access) => {
    if (expectedVersion !== "absent") {
      await access.write(workspacePromptPath, content, expectedVersion);
      return;
    }
    const target = await store.policy.resolve(workspacePromptPath);
    store.assertVersion(workspacePromptPath, (await store.listVersion(workspacePromptPath)).version, expectedVersion);
    await store.policy.ensureParent(target);
    const temporary = path.join(path.dirname(target), `.specloom-tmp-${randomUUID()}`);
    try {
      await store.policy.assertSafe(temporary, true);
      const handle = await store.fs.open(temporary, "wx");
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await store.policy.assertSafe(temporary);
      await store.policy.assertSafe(target, true);
      // Publish a complete file atomically, without replacing an external creation.
      try { await store.fs.link(temporary, target); }
      catch (error) {
        if (hasCode(error, "EEXIST")) throw new ProjectError("VERSION_CONFLICT", "项目提示词已被外部创建，请重新加载后保存");
        throw error;
      }
    } finally { await removeTemporary(store.fs, temporary); }
  });
  return { path: workspacePromptPath, content, version: digestBytes(bytes) };
}
