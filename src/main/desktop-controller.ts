import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProfile, TaskScopeSpec, VersionToken } from "../shared/contracts";
import type { McpConnection, WorkspaceState } from "../shared/desktop-api";
import { ProjectCore } from "./core/project-core";
import { ProjectError } from "./core/errors";
import { ModelVault } from "./core/model-vault";
import { ProjectLayout } from "./core/project-layout";

export class DesktopController {
  private core?: ProjectCore;
  private readonly runs = new Map<string, AbortController>();
  private opening = false;
  mcp: McpConnection | undefined;

  constructor(readonly vault: ModelVault, private readonly userData: string, private readonly skillsDirectory: string) {}

  currentCore(): ProjectCore {
    if (this.opening) throw new ProjectError("MODEL_ERROR", "项目正在切换，请等待打开完成");
    if (!this.core) throw new ProjectError("INVALID_PROJECT", "先打开一个 Godot 项目");
    return this.core;
  }
  async state(): Promise<WorkspaceState> {
    return { tasks: this.core?.listTasks() ?? [], models: await this.vault.list(), ...(this.core ? { project: this.core.metadata, recoveryIssues: structuredClone(this.core.recoveryIssues) } : {}), ...(this.mcp ? { mcp: this.mcp } : {}) };
  }
  openProject(root: string): Promise<WorkspaceState> { return this.transition(async () => root); }
  private async transition(prepare: () => Promise<string>): Promise<WorkspaceState> {
    if (this.runs.size || this.opening) throw new ProjectError("MODEL_ERROR", "先等待当前操作结束，再切换项目");
    this.opening = true;
    try {
      const root = await prepare();
      this.core = await ProjectCore.open(root, { bundledSkillsDirectory: this.skillsDirectory, resolveCredential: (profile) => this.vault.resolveCredential(profile) });
      return await this.state();
    } finally { this.opening = false; }
  }
  async createExample(): Promise<WorkspaceState> {
    return this.transition(async () => {
    const root = path.join(this.userData, "examples", `lantern-${randomUUID().slice(0, 8)}`);
    await mkdir(path.join(root, "scenes"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="灯塔守望"\nconfig/description="探索海岛与修复灯塔的 2D 游戏"\nrun/main_scene="res://scenes/main.tscn"\nconfig/features=PackedStringArray("4.4", "GL Compatibility")\n\n[display]\nwindow/size/viewport_width=960\nwindow/size/viewport_height=540\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.08, 0.12, 0.13, 1)\n');
    await writeFile(path.join(root, "scenes/main.tscn"), '[gd_scene format=3]\n\n[node name="Island" type="Node2D"]\n\n[node name="Ground" type="Polygon2D" parent="."]\npolygon = PackedVector2Array(120, 420, 840, 420, 840, 540, 120, 540)\ncolor = Color(0.28, 0.53, 0.42, 1)\n\n[node name="Lighthouse" type="Polygon2D" parent="."]\npolygon = PackedVector2Array(670, 420, 690, 200, 745, 200, 765, 420)\ncolor = Color(0.85, 0.88, 0.82, 1)\n');
    await new ProjectLayout({ bundledSkillsDirectory: this.skillsDirectory }).initialize(root);
    await writeFile(path.join(root, "specs/project.md"), '---\nschemaVersion: 1\nid: project\ntitle: 灯塔守望\ndescription: 探索海岛与修复灯塔的 2D 游戏\nconstraints:\n  maxScriptLines: 250\n  maxSceneNodes: 80\n---\n\n# 灯塔守望\n\n## 开发约束\n\n- Godot 4.4，2D，GDScript。\n- 场景按实体组织，节点使用 PascalCase，脚本使用 snake_case。\n- 每个脚本只承担一个职责，跨实体通信使用信号。\n- MVP 只包含移动、探索和灯塔交互。\n');
    await writeFile(path.join(root, "specs/outline.md"), '---\nschemaVersion: 1\nid: outline\ntitle: 游戏大纲\ndescription: 灯塔守望首版里程碑\n---\n\n# 游戏大纲\n\n## 第一阶段：可玩原型\n\n玩家在海岛移动，靠近灯塔后触发修复交互。\n\n## 第二阶段：探索循环\n\n收集零件，修复灯塔，开启新区域。\n');
    await writeFile(path.join(root, "specs/entities/characters/keeper.md"), '---\nid: keeper\ntype: character\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\n---\n\n# 守灯人\n\n## 职责\n\n玩家控制角色，只负责移动和交互请求。\n\n## 行为\n\n- 使用 CharacterBody2D。\n- 水平移动速度 180，禁止增加战斗系统。\n- 使用信号通知交互，不能直接操作地图状态。\n\n## 生成边界\n\n- scenes/keeper.tscn\n- scripts/keeper.gd\n');
    return root;
    });
  }
  async createTask(scope: Omit<TaskScopeSpec, "id">) { return this.currentCore().createTask({ ...scope, id: randomUUID() }); }
  async agent(taskId: string, modelId: string, prompt: string) {
    const core = this.currentCore();
    if (this.runs.has(taskId)) throw new ProjectError("MODEL_ERROR", "该任务已有运行中的智能体");
    const controller = new AbortController();
    this.runs.set(taskId, controller);
    try {
      const profile = await this.vault.get(modelId);
      if (!profile) throw new ProjectError("MODEL_ERROR", "先配置并选择一个模型");
      const result = await core.agentMessage(taskId, profile, prompt, controller.signal);
      return { summary: result.summary, toolCalls: result.toolCalls };
    } finally { this.runs.delete(taskId); }
  }
  cancel(taskId: string): void { this.runs.get(taskId)?.abort(); }
  cancelAll(): void { for (const run of this.runs.values()) run.abort(); }
  saveModel(profile: ModelProfile, secret?: string) { return this.vault.save(profile, secret); }
  readDocument(path: string, version: VersionToken) { return this.currentCore().readDocument(path, version); }
}
