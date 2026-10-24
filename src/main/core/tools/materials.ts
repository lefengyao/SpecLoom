import { categoryForPath, referenceId, summarizeMaterial, type DocumentCategory } from "../../../shared/material-catalog";
import { createMaterialId, parseMaterial, readFields, writeMaterial, type ComponentField } from "../../../shared/project-materials";
import { groupIncludes, importMissingLegacyGroups, materialGroupCategories, materialGroupPath, normalizeMaterialGroups, validateMaterialGroupRegistry, type MaterialGroup, type MaterialGroupCategory, type MaterialGroupRegistry } from "../../../shared/material-groups";
import { createHash } from "node:crypto";
import type { FileReadResult, VersionToken } from "../../../shared/contracts";
import { FileStore } from "../file-store";
import { ProjectDocuments, type ImageCrop } from "../project-documents";
import { componentValueMatches } from "../validator-markdown";
import { ProjectError } from "../errors";
import { digestBytes } from "../store-fs";
import { resolveComponentFields, type ComponentDefinition } from "../../../shared/component-inheritance";
import { StateMachineSchema } from "../../../shared/state-machine";

const mimeTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const folders: Record<Exclude<DocumentCategory, "all">, string> = {
  entity: "entities/", component: "components/", map: "maps/", setting: "settings/", ui: "ui/",
  system: "systems/", feature: "features/", decision: "decisions/", spec: "",
};
interface MaterialGroupTreeNode extends MaterialGroup { category: MaterialGroupCategory; path: string; children: MaterialGroupTreeNode[] }
const stableGroupId = (category: string, name: string): string => `group_${category}_${createHash("sha256").update(`${category}\u0000${name.trim()}`).digest("hex").slice(0, 10)}`;

/** Agent-facing material operations share the desktop document service and never create tasks. */
export class WorkMaterials {
  private readonly documents: ProjectDocuments;
  constructor(private readonly store: FileStore) { this.documents = new ProjectDocuments(store); }
  private path(relative: string) {
    const normalized = this.store.normalizePath(relative);
    if (!normalized.toLowerCase().startsWith("specs/") || !normalized.toLowerCase().endsWith(".md")) throw new ProjectError("TASK_SCOPE_DENIED", "资料工具仅支持 specs 内的 Markdown 文件");
    return normalized;
  }
  private async componentDefinitions(): Promise<ComponentDefinition[]> {
    const definitions: ComponentDefinition[] = [];
    for (const version of await this.store.listFiles("specs/components")) {
      if (!version.path.toLowerCase().endsWith(".md")) continue;
      const file = await this.store.read(version.path, version.version);
      const parsed = parseMaterial(file.content);
      if (!parsed || typeof parsed.data.id !== "string" || !parsed.data.id.trim()) continue;
      definitions.push({ path: file.path, id: parsed.data.id.trim(), data: parsed.data });
    }
    return definitions;
  }
  private async definitionsWith(current: ComponentDefinition): Promise<ComponentDefinition[]> {
    const definitions = await this.componentDefinitions();
    const identity = current.path.toLowerCase();
    return [...definitions.filter((definition) => definition.path.toLowerCase() !== identity), current];
  }
  private async validateComponentExtends(current: ComponentDefinition, definitions: ComponentDefinition[]): Promise<void> {
    const reference = referenceId(current.data.extends);
    if (reference === undefined) return;
    const normalize = (value: string) => value.replace(/^res:\/\//i, "").replaceAll("\\", "/").replace(/\.md$/i, "").toLowerCase();
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const byPath = new Map(definitions.map((definition) => [normalize(definition.path), definition]));
    const resolve = (value: string) => byId.get(value) ?? byPath.get(normalize(value));
    const base = resolve(reference);
    if (!base) throw new ProjectError("VALIDATION_FAILED", "继承的组件不存在", { path: current.path, extends: reference });
    const seen = new Set<string>([current.id, normalize(current.path)]);
    let cursor: ComponentDefinition | undefined = base;
    while (cursor) {
      if (seen.has(cursor.id) || seen.has(normalize(cursor.path))) throw new ProjectError("VALIDATION_FAILED", "组件继承不能成环", { path: current.path });
      seen.add(cursor.id); seen.add(normalize(cursor.path));
      const next = referenceId(cursor.data.extends);
      cursor = next ? resolve(next) : undefined;
    }
  }
  async read(relative: string) {
    const path = this.path(relative); const version = await this.store.listVersion(path);
    const file = await this.store.read(path, version.version); const parsed = parseMaterial(file.content);
    const data = parsed?.data ?? null;
    const fields = data && typeof data.id === "string" && categoryForPath(path) === "component"
      ? resolveComponentFields(await this.componentDefinitions(), { path, id: data.id, data }).fields
      : [];
    return { ...file, data, body: parsed?.body ?? file.content, ...(fields.length ? { fields } : {}) };
  }
  async list(input: Record<string, unknown>) {
    if (input.entityType !== undefined && input.category !== "entity") throw new ProjectError("VALIDATION_FAILED", "entityType 筛选仅适用于 entity 分类");
    const allVersions = (await this.store.listFiles("specs")).filter(file => file.path.toLowerCase().endsWith(".md"));
    const versions = allVersions.filter(file => !input.category || categoryForPath(file.path) === input.category || file.path.toLowerCase() === "specs/project.md");
    const files = [];
    for (const version of versions) files.push(await this.store.read(version.path, version.version));
    const projectFile = files.find((file) => file.path.toLowerCase() === "specs/project.md");
    const legacyLabels: Partial<Record<MaterialGroupCategory, string[]>> = {};
    for (const file of files) {
      const category = categoryForPath(file.path);
      const group = parseMaterial(file.content)?.data.group;
      if (category && typeof group === "string" && group.trim()) legacyLabels[category] = [...(legacyLabels[category] ?? []), group.trim()];
    }
    const registry = importMissingLegacyGroups(parseMaterial(projectFile?.content ?? "")?.data.materialGroups, legacyLabels);
    const summaries = files.filter((file) => !input.category || categoryForPath(file.path) === input.category).map((file) => summarizeMaterial(file, registry));
    const query = String(input.query ?? "").trim().toLocaleLowerCase();
    const matches = summaries.filter(item => {
      const category = categoryForPath(item.path);
      const categoryGroups = category ? registry[category] ?? [] : [];
      const groupMatches = input.groupId === undefined || Boolean(item.groupId && groupIncludes(categoryGroups, String(input.groupId), item.groupId));
      const groupTextMatches = input.group === undefined || (item.group ?? "") === input.group;
      const typeMatches = input.entityType === undefined || item.type === input.entityType;
      return groupMatches && groupTextMatches && typeMatches && `${item.title} ${item.description ?? ""} ${item.id} ${item.path} ${item.groupPath ?? item.group ?? ""}`.toLocaleLowerCase().includes(query);
    });
    const offset = Number(input.offset ?? 0); const limit = Number(input.limit ?? 50);
    const categories: MaterialGroupCategory[] = input.category ? [input.category as MaterialGroupCategory] : materialGroupCategories;
    const groupTree = categories.flatMap((category) => this.groupTree(category, registry[category] ?? []));
    const groupNames = groupTree.flatMap((group) => this.groupNames(group));
    return { total: matches.length, offset, limit, groups: [...new Set([...summaries.map(item => item.group).filter((group): group is string => Boolean(group)), ...groupNames])].sort((a, b) => a.localeCompare(b)), groupTree,
      items: matches.slice(offset, offset + limit).map(item => ({ id: item.id, title: item.title, type: item.type, category: categoryForPath(item.path), path: item.path, version: item.version,
        description: item.description ?? "", group: item.group ?? "", ...(item.groupId ? { groupId: item.groupId } : {}), ...(item.groupPath ? { groupPath: item.groupPath } : {}), ...(item.scope ? { scope: item.scope } : {}), ...(item.parent ? { parent: item.parent } : {}), ...(item.extends ? { extends: item.extends } : {}), ...(item.image ? { image: item.image } : {}), ...(item.invalid ? { invalid: true } : {}) })) };
  }
  private groupTree(category: MaterialGroupCategory, groups: MaterialGroup[]) {
    const nodes = new Map<string, MaterialGroupTreeNode>();
    for (const group of groups) nodes.set(group.id, { ...group, category, path: materialGroupPath(groups, group.id), children: [] });
    const roots: MaterialGroupTreeNode[] = [];
    for (const group of groups) {
      const node = nodes.get(group.id)!;
      const parent = group.parentId ? nodes.get(group.parentId) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    const sort = (items: MaterialGroupTreeNode[]) => { items.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)); for (const item of items) sort(item.children); };
    sort(roots);
    return roots;
  }
  private groupNames(group: MaterialGroupTreeNode): string[] {
    return [group.name, ...group.children.flatMap((child) => this.groupNames(child))];
  }
  private assertProperties(category: string, properties: Record<string, unknown>) {
    if (properties.fields !== undefined && category !== "component") throw new ProjectError("VALIDATION_FAILED", "仅组件资料可定义 fields");
    if (properties.scope !== undefined && category !== "component") throw new ProjectError("VALIDATION_FAILED", "仅组件资料可定义 scope");
    if (properties.extends !== undefined && !["entity", "map", "component"].includes(category)) throw new ProjectError("VALIDATION_FAILED", "仅实体、地图或组件可继承");
    if (properties.components !== undefined && !["entity", "map", "system"].includes(category)) throw new ProjectError("VALIDATION_FAILED", "仅实体、地图或系统可声明组件");
    if (properties.entities !== undefined && category !== "system") throw new ProjectError("VALIDATION_FAILED", "仅系统资料可声明实体引用");
    if (properties.dependsOn !== undefined && category !== "system") throw new ProjectError("VALIDATION_FAILED", "仅系统资料可声明依赖");
    if (properties.systems !== undefined && category !== "feature") throw new ProjectError("VALIDATION_FAILED", "仅功能资料可关联系统");
    if (properties.affectedSystems !== undefined && category !== "decision") throw new ProjectError("VALIDATION_FAILED", "仅架构决策可声明影响的系统");
    if (properties.supersedes !== undefined && category !== "decision") throw new ProjectError("VALIDATION_FAILED", "仅架构决策可声明取代关系");
    if (properties.stateMachine !== undefined) {
      if (category !== "entity") throw new ProjectError("VALIDATION_FAILED", "仅实体资料可配置状态机");
      if (properties.stateMachine !== null && !StateMachineSchema.safeParse(properties.stateMachine).success) throw new ProjectError("VALIDATION_FAILED", "状态机配置无效");
    }
    if (properties.type !== undefined && (category === "entity" ? !["entity", "character", "enemy", "map", "system", "item", "event"].includes(String(properties.type)) : properties.type !== category)) throw new ProjectError("VALIDATION_FAILED", "资料类型与分类不匹配");
  }
  async create(input: Record<string, unknown>) {
    const category = input.category as Exclude<DocumentCategory, "all">; const title = String(input.title);
    const id = input.id as string ?? createMaterialId(category, title); const properties = input.properties as Record<string, unknown> ?? {};
    this.assertProperties(category, properties);
    const data: Record<string, unknown> = { schemaVersion: 1, id, title, type: category, description: "",
      ...(category === "entity" || category === "map" ? { status: "draft", version: 1, relations: [], source: "agent", components: [] } : {}),
      ...(category === "feature" ? { status: "planned" } : {}),
      ...(category === "decision" ? { status: "proposed" } : {}),
      ...(category === "component" ? { fields: [], scope: "user" } : {}), ...properties };
    for (const key of ["group", "groupId", "parent", "extends"]) if (data[key] === null || data[key] === "") delete data[key];
    if (data.groupId !== undefined) delete data.group;
    const path = `specs/${folders[category]}${id}.md`;
    if (category === "component" && data.extends !== undefined) await this.validateComponentExtends({ path, id, data }, await this.definitionsWith({ path, id, data }));
    return this.documents.save(path, writeMaterial(data, input.body as string ?? `\n# ${title}\n`), "absent");
  }
  private async existing(input: Record<string, unknown>) {
    const file = await this.read(String(input.path)); this.store.assertVersion(file.path, file.version, input.expectedVersion as VersionToken);
    if (!file.data) throw new ProjectError("VALIDATION_FAILED", "该资料缺少有效元数据，请先修复 YAML front matter");
    return { ...file, data: { ...file.data } };
  }
  private save(file: FileReadResult & { data: Record<string, unknown>; body: string }) {
    return this.documents.save(file.path, writeMaterial(file.data, file.body), file.version);
  }
  async update(input: Record<string, unknown>) {
    const file = await this.existing(input); const changes = input.changes as Record<string, unknown> ?? {};
    const { materialGroups, ...properties } = changes as { materialGroups?: Partial<Record<MaterialGroupCategory, { id?: string; name: string; parentId?: string; order?: number }[]>> } & Record<string, unknown>;
    this.assertProperties(categoryForPath(file.path)!, properties);
    if (materialGroups !== undefined) {
      if (file.path.toLowerCase() !== "specs/project.md") throw new ProjectError("VALIDATION_FAILED", "materialGroups 只能在项目资料 specs/project.md 上编辑");
      const registry: MaterialGroupRegistry = { ...normalizeMaterialGroups(file.data.materialGroups) };
      for (const [category, groups] of Object.entries(materialGroups)) {
        if (!groups) continue;
        registry[category as MaterialGroupCategory] = groups.map((group, index) => ({ id: group.id ?? stableGroupId(category, group.name), name: group.name, ...(group.parentId ? { parentId: group.parentId } : {}), order: group.order ?? index }));
      }
      const errors = validateMaterialGroupRegistry(registry);
      if (errors.length) throw new ProjectError("VALIDATION_FAILED", `项目分组登记表无效：${errors[0]}`, { path: file.path, diagnostics: errors });
      file.data.materialGroups = registry;
    }
    for (const [key, value] of Object.entries(properties)) {
      if (key === "groupId") {
        if (value === null) { delete file.data.groupId; delete file.data.group; }
        else { file.data.groupId = value; delete file.data.group; }
      } else if (key === "group") {
        if (value === null || value === "") { delete file.data.group; delete file.data.groupId; }
        else { file.data.group = value; delete file.data.groupId; }
      } else if (value === null) delete file.data[key]; else file.data[key] = value;
    }
    if (categoryForPath(file.path) === "component" && file.data.extends !== undefined && typeof file.data.id === "string") {
      const current: ComponentDefinition = { path: file.path, id: file.data.id, data: file.data };
      await this.validateComponentExtends(current, await this.definitionsWith(current));
    }
    if (input.body !== undefined) file.body = String(input.body);
    return this.save(file);
  }
  private async owner(input: Record<string, unknown>) {
    const file = await this.existing(input);
    if (!["entity", "map"].includes(categoryForPath(file.path)!)) throw new ProjectError("VALIDATION_FAILED", "仅实体或地图可绑定组件");
    if (file.data.components !== undefined && !Array.isArray(file.data.components)) throw new ProjectError("VALIDATION_FAILED", "components 必须为数组");
    return { ...file, bindings: [...(file.data.components as unknown[] ?? [])] };
  }
  private matchesComponent(binding: unknown, id: string, componentPath?: string) {
    const reference = referenceId(binding);
    if (reference === id) return true;
    if (!reference || !componentPath || !reference.includes("/")) return false;
    try { return this.store.pathIdentity(reference.replace(/^res:\/\//, "")) === this.store.pathIdentity(componentPath); } catch { return false; }
  }
  async bind(input: Record<string, unknown>) {
    const file = await this.owner(input); const component = await this.read(String(input.componentPath));
    if (categoryForPath(component.path) !== "component" || component.data?.type !== "component" || typeof component.data.id !== "string") throw new ProjectError("VALIDATION_FAILED", "componentPath 必须指向有效组件");
    const ownFields = readFields(component.data);
    if (!Array.isArray(component.data.fields) || ownFields.length !== component.data.fields.length) throw new ProjectError("VALIDATION_FAILED", "组件字段定义无效");
    const fields: ComponentField[] = component.fields ?? ownFields;
    const id = component.data.id;
    const matching = (binding: unknown) => this.matchesComponent(binding, id, component.path);
    const existing = file.bindings.find(matching);
    const previous = existing && typeof existing === "object" && "values" in existing ? existing.values as Record<string, unknown> : {};
    const values = { ...Object.fromEntries(fields.map(field => [field.key, field.default])), ...previous, ...(input.values as Record<string, unknown> ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find(field => field.key === key);
      if (!field || !componentValueMatches(field.type, value)) throw new ProjectError("VALIDATION_FAILED", `组件字段 ${key} 不存在或类型不正确`);
    }
    const index = file.bindings.findIndex(matching);
    // Keep the declared mount and notes when only the field values change.
    const kept = index >= 0 && existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
    const mount = input.mount && typeof input.mount === "object" ? input.mount : kept.mount;
    const binding = { ...kept, id, values, ...(mount ? { mount } : {}) };
    if (index < 0) file.bindings.push(binding); else file.bindings[index] = binding;
    file.data.components = file.bindings; return this.save(file);
  }
  async unbind(input: Record<string, unknown>) {
    const file = await this.owner(input);
    const id = String(input.componentId);
    let componentPath: string | undefined;
    if (!file.bindings.some(binding => referenceId(binding) === id)) {
      const component = await this.read(id.includes("/") ? id.replace(/^res:\/\//, "") : `specs/components/${id}.md`);
      if (component.data?.type !== "component") throw new ProjectError("VALIDATION_FAILED", "目标不是组件资料");
      componentPath = component.path;
    }
    const matches = (binding: unknown) => this.matchesComponent(binding, id, componentPath);
    if (!file.bindings.some(matches)) throw new ProjectError("FILE_NOT_FOUND", "资料未绑定该组件");
    file.data.components = file.bindings.filter(binding => !matches(binding)); return this.save(file);
  }
  private async importFile(relative: string, crop?: ImageCrop) {
    const source = this.store.normalizePath(relative); const target = await this.store.policy.resolve(source);
    const version = await this.store.listVersion(source); const mime = mimeTypes[source.split(".").pop()!.toLowerCase()];
    const sourceLimit = 32 * 1024 * 1024;
    if (!version.exists) throw new ProjectError("FILE_NOT_FOUND", "配图源文件不存在");
    if (!mime || version.size > sourceLimit) throw new ProjectError("VALIDATION_FAILED", "配图必须为 PNG/JPEG/WebP/GIF 且源文件不超过 32 MiB");
    const handle = await this.store.fs.open(target, "r");
    let bytes: Buffer;
    try {
      const stats = await handle.stat(); if (!stats.isFile() || stats.size > sourceLimit) throw new ProjectError("VALIDATION_FAILED", "配图源文件超过限制");
      bytes = Buffer.alloc(stats.size); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) throw new ProjectError("VERSION_CONFLICT", "配图源文件已变化"); offset += bytesRead; }
      await this.store.policy.assertSafe(target); this.store.assertVersion(source, digestBytes(bytes), version.version);
    } finally { await handle.close(); }
    return this.documents.importImage(`data:${mime};base64,${bytes.toString("base64")}`, crop);
  }
  async setImage(input: Record<string, unknown>) {
    const file = await this.existing(input);
    const crop = input.crop as ImageCrop | undefined;
    if (input.remove) delete file.data.image;
    else if (input.sourcePath) file.data.image = await this.importFile(String(input.sourcePath), crop);
    else {
      const dataUrl = await this.documents.readImage(String(input.imagePath));
      file.data.image = crop ? await this.documents.importImage(dataUrl, crop) : input.imagePath;
    }
    return this.save(file);
  }
  execute(name: string, input: Record<string, unknown>) {
    switch (name) {
      case "MaterialsList": return this.list(input);
      case "MaterialRead": return this.read(String(input.path));
      case "MaterialCreate": return this.create(input);
      case "MaterialUpdate": return this.update(input);
      case "MaterialBindComponent": return this.bind(input);
      case "MaterialUnbindComponent": return this.unbind(input);
      case "MaterialSetImage": return this.setImage(input);
      default: throw new ProjectError("MODEL_ERROR", "未知资料工具");
    }
  }
}
