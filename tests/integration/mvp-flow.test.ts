import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import { BASH_IMAGE, GODOT_IMAGE } from "../../src/main/core/snapshot-runner";
import type { FileReadResult, FileVersion, ModelProfile } from "../../src/shared/contracts";
import { dockerPrerequisites } from "./docker-prerequisites";

const [bashPrerequisites, godotPrerequisites] = await Promise.all([
  dockerPrerequisites("mvp-flow/bash", [BASH_IMAGE]),
  dockerPrerequisites("mvp-flow/godot", [GODOT_IMAGE]),
]);
test.skipIf(!bashPrerequisites.available)("Bash complete snapshot diff can cancel a previously staged create", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-bash-overlay-"));
  try {
    await cp(path.resolve("tests/fixtures/godot-minimal"), root, { recursive: true });
    const core = await ProjectCore.open(root);
    await core.createTask({ id: "shell", title: "Revise staged output", readPaths: ["*"], writePaths: ["scripts/**"], allowDelete: true, mode: "manual" });
    await core.executeTool("shell", "files.write", { path: "scripts/cancelled.gd", expectedVersion: "absent", content: "extends Node\n" });
    await core.executeTool("shell", "bash.exec", { command: "rm scripts/cancelled.gd; printf 'extends Node\\n' > scripts/result.gd" });
    const review = await core.previewChanges("shell");
    expect(review.changeSet.entries.map((entry) => entry.path)).toEqual(["scripts/result.gd"]);
    await core.approveChanges("shell", review.changeSet.digest);
    await expect(readFile(path.join(root, "scripts/cancelled.gd"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "scripts/result.gd"), "utf8")).toBe("extends Node\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
test.skipIf(!godotPrerequisites.available)("MVP: entity Skill -> compatible model -> staged scene -> UI approval -> real Godot -> stale conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-mvp-"));
  await cp(path.resolve("tests/fixtures/godot-minimal"), root, { recursive: true });
  let rounds = 0;
  let sequence = 0;
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[] };
    requests.push(body);
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer fixture-secret");
    const call = (name: string, input: Record<string, unknown>) => ({ id: `call-${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(input) } });
    let calls: ReturnType<typeof call>[] = [];
    if (rounds === 0) calls = [call("skills_list", {})];
    if (rounds === 1) {
      const skills = JSON.parse(body.messages.at(-1)!.content).result as { id: string; version: string }[];
      const skill = skills.find((skill) => skill.id === "entity-catalog")!;
      calls = [call("skills_load", { id: skill.id, expectedVersion: skill.version })];
    }
    if (rounds === 2) calls = [
      call("files_write", { path: "scripts/keeper.gd", expectedVersion: "absent", content: "extends CharacterBody2D\n\n@export var speed: float = 180.0\n\nfunc _physics_process(_delta: float) -> void:\n\tvelocity.x = Input.get_axis(\"ui_left\", \"ui_right\") * speed\n\tmove_and_slide()\n" }),
      call("files_write", { path: "scenes/keeper.tscn", expectedVersion: "absent", content: '[gd_scene load_steps=3 format=3]\n\n[ext_resource type="Script" path="res://scripts/keeper.gd" id="1"]\n\n[sub_resource type="RectangleShape2D" id="Body"]\nsize = Vector2(24, 40)\n\n[node name="Keeper" type="CharacterBody2D"]\nscript = ExtResource("1")\n\n[node name="Collision" type="CollisionShape2D" parent="."]\nshape = SubResource("Body")\n' }),
    ];
    if (rounds === 3) calls = [call("changes_preview", {})];
    rounds++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: calls.length ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "已根据守灯人实体暂存脚本与场景，等待人工审查。" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const core = await ProjectCore.open(root, { bundledSkillsDirectory: path.resolve("skills"), resolveCredential: async () => "fixture-secret" });
    await writeFile(path.join(root, "specs/entities/characters/keeper.md"), "---\nid: keeper\ntype: character\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\n---\n\n# Keeper\nMove horizontally at180. Keep character control separate from map state.\n");
    await core.createTask({ id: "generate", title: "守灯人", readPaths: ["*"], writePaths: ["scripts/keeper.gd", "scenes/keeper.tscn"], allowDelete: false, mode: "manual" });
    const profile: ModelProfile = { id: "fixture", name: "Fixture", provider: "openai-compatible", model: "mock", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, approved: true, timeoutMs: 10000, maxToolRounds: 8 };
    const result = await core.agentMessage("generate", profile, "根据守灯人实体生成角色脚本和场景");
    expect(result.toolCalls).toBe(5);
    expect(requests).toHaveLength(5);
    await expect(readFile(path.join(root, "scripts/keeper.gd"))).rejects.toMatchObject({ code: "ENOENT" });
    const validation = await core.validate("generate");
    expect(validation.status).toBe("pass");
    const review = await core.previewChanges("generate");
    await expect(core.executeTool("generate", "changes.commit", { digest: review.changeSet.digest })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await core.approveChanges("generate", review.changeSet.digest);
    expect((await core.validate("generate")).status).toBe("pass");
    expect(await readFile(path.join(root, "scripts/keeper.gd"), "utf8")).toContain("move_and_slide");
    await core.createTask({ id: "stale", title: "过期任务", readPaths: ["*"], writePaths: ["scripts/**"], allowDelete: false, mode: "manual" });
    const versions = await core.executeTool("stale", "files.list_versions", { paths: ["scripts/keeper.gd"] }) as FileVersion[];
    const file = await core.executeTool("stale", "files.read", { path: versions[0]!.path, expectedVersion: versions[0]!.version }) as FileReadResult;
    await core.executeTool("stale", "files.write", { path: file.path, expectedVersion: file.version, content: file.content.replace("180.0", "200.0") });
    await core.executeTool("stale", "files.write", { path: "scripts/uncommitted.gd", expectedVersion: "absent", content: "extends Node\n" });
    const stale = await core.previewChanges("stale");
    await writeFile(path.join(root, file.path), file.content.replace("180.0", "190.0"));
    await expect(core.approveChanges("stale", stale.changeSet.digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, file.path), "utf8")).toContain("190.0");
    await expect(readFile(path.join(root, "scripts/uncommitted.gd"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
