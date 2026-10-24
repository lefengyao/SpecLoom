import type { ValidationDiagnostic } from "../../shared/contracts";
import { VersionTokenSchema } from "../../shared/contracts";
import { resolveComponentAnchors, resolveComponentFields, type ComponentDefinition } from "../../shared/component-inheritance";
import { readAnchors, readFields } from "../../shared/project-materials";
import { componentValueMatches, diagnostic, nonempty, record, validReference, validationPathIdentity, type ParsedSpec } from "./validator-markdown";
import { ValidationSource } from "./validator-source";
import { normalizeProjectPath } from "./path-policy";

export async function validateReferences(specs: ParsedSpec[], source: ValidationSource, diagnostics: ValidationDiagnostic[]): Promise<void> {
  function materialKind(spec: ParsedSpec): string | undefined {
    const relative = validationPathIdentity(spec.path);
    if (relative.startsWith("specs/maps/") || (relative.startsWith("specs/entities/") && spec.data.type === "map")) return "map";
    if (relative.startsWith("specs/entities/")) return "entity";
    if (relative.startsWith("specs/components/")) return "component";
    if (relative.startsWith("specs/settings/")) return "setting";
    if (relative.startsWith("specs/ui/")) return "ui";
    if (relative.startsWith("specs/systems/")) return "system";
    if (relative.startsWith("specs/features/")) return "feature";
    if (relative.startsWith("specs/decisions/")) return "decision";
    if (/^specs\/[^/]+\.md$/i.test(relative)) return "spec";
    return undefined;
  }
  const isEntitySpec = (spec: ParsedSpec | undefined) => spec !== undefined && ["entity", "map"].includes(materialKind(spec) ?? "");
  const ids = new Map<string, ParsedSpec>();
  const paths = new Map(specs.map((spec) => [validationPathIdentity(spec.path), spec]));
  for (const spec of specs) {
    if (!nonempty(spec.data.id)) continue;
    const existing = ids.get(spec.data.id);
    if (existing) diagnostics.push(diagnostic(spec.path, "SPEC_ID_DUPLICATE", `ID '${spec.data.id}' is already defined in ${existing.path}`));
    else ids.set(spec.data.id, spec);
  }
  const componentDefinitions: ComponentDefinition[] = specs
    .filter((spec) => materialKind(spec) === "component" && spec.data.type === "component" && nonempty(spec.data.id))
    .map((spec) => ({ path: spec.path, id: String(spec.data.id), data: spec.data }));
  const effectiveFields = new Map<string, ReturnType<typeof readFields>>(componentDefinitions.map((definition) => [validationPathIdentity(definition.path), resolveComponentFields(componentDefinitions, definition).fields]));
  // Mounts may target anchors a component inherits from its base definition.
  const effectiveAnchors = new Map<string, ReturnType<typeof readAnchors>>(componentDefinitions.map((definition) => [validationPathIdentity(definition.path), resolveComponentAnchors(componentDefinitions, definition).anchors]));

  async function resolveReference(value: unknown, owner: string, missingCode: string, invalidCode = "REFERENCE_INVALID", componentBinding = false): Promise<{ spec?: ParsedSpec; path: string } | undefined> {
    const target = typeof value === "string" ? value : record(value) ? value.path ?? value.id : undefined;
    if (!validReference(value, componentBinding) || !nonempty(target)) {
      diagnostics.push(diagnostic(owner, invalidCode, "References require a single nonempty path or ID and valid reference fields"));
      return undefined;
    }
    const isPath = target.startsWith("res://") || target.includes("/") || /\.(?:md|gd|tscn|tres|godot|json|yaml|yml)$/i.test(target) || (record(value) && value.path !== undefined);
    let relative: string;
    let spec: ParsedSpec | undefined;
    if (isPath) {
      try {
        relative = normalizeProjectPath(target.replace(/^res:\/\//, ""));
        if (!(await source.exists(relative))) {
          diagnostics.push(diagnostic(owner, missingCode, `Referenced file '${relative}' does not exist`));
          return undefined;
        }
        spec = paths.get(validationPathIdentity(relative));
      } catch {
        diagnostics.push(diagnostic(owner, invalidCode === "REFERENCE_INVALID" ? "REFERENCE_PATH_INVALID" : invalidCode, `Reference '${target}' is not a safe project path`));
        return undefined;
      }
    } else {
      spec = ids.get(target);
      if (!spec) {
        diagnostics.push(diagnostic(owner, missingCode, `Referenced ID '${target}' does not exist`));
        return undefined;
      }
      relative = spec.path;
    }
    if (record(value) && value.version !== undefined) {
      if (!VersionTokenSchema.safeParse(value.version).success) diagnostics.push(diagnostic(owner, "REFERENCE_VERSION_INVALID", `Reference '${target}' requires a file version token`));
      else if (await source.effectiveVersion(relative) !== value.version) diagnostics.push(diagnostic(owner, "REFERENCE_VERSION_STALE", `Referenced file '${relative}' has changed`));
    }
    return { path: relative, ...(spec === undefined ? {} : { spec }) };
  }

  function checkType(value: unknown, spec: ParsedSpec | undefined, owner: string, code: string): void {
    if (record(value) && value.type !== undefined && spec && spec.data.type !== value.type) {
      diagnostics.push(diagnostic(owner, code, `Referenced file '${spec.path}' does not have type '${String(value.type)}'`));
    }
  }

  async function reference(value: unknown, owner: string, code: string, relation = false): Promise<void> {
    const resolved = await resolveReference(value, owner, code);
    if (!resolved) return;
    if (relation && !isEntitySpec(resolved.spec)) {
      diagnostics.push(diagnostic(owner, "RELATION_TARGET_INVALID", `Relation '${resolved.path}' must reference an entity specification`));
    } else checkType(value, resolved.spec, owner, "RELATION_TYPE_MISMATCH");
  }

  async function semanticReference(value: unknown, owner: ParsedSpec, code: string, accepts: (spec: ParsedSpec) => boolean, componentBinding = false): Promise<ParsedSpec | undefined> {
    const resolved = await resolveReference(value, owner.path, `${code}_NOT_FOUND`, `${code}_INVALID`, componentBinding);
    if (!resolved) return undefined;
    if (!resolved.spec || !accepts(resolved.spec)) {
      diagnostics.push(diagnostic(owner.path, `${code}_TARGET_INVALID`, `Reference '${resolved.path}' must target a compatible specification`));
      return undefined;
    }
    checkType(value, resolved.spec, owner.path, `${code}_TYPE_MISMATCH`);
    return resolved.spec;
  }

  const parents = new Map<string, string>();
  const inheritance = new Map<string, string[]>();
  const componentInheritance = new Map<string, string[]>();
  const systemDependencies = new Map<string, string[]>();
  for (const spec of specs) {
    if (Array.isArray(spec.data.relations)) for (const value of spec.data.relations) await reference(value, spec.path, "RELATION_NOT_FOUND", true);
    if (validationPathIdentity(spec.path).startsWith("specs/tasks/") && Array.isArray(spec.data.inputs)) for (const value of spec.data.inputs) await reference(value, spec.path, "TASK_INPUT_NOT_FOUND");
    if (Array.isArray(spec.data.source)) for (const value of spec.data.source) await reference(value, spec.path, "SOURCE_NOT_FOUND");
    else if (record(spec.data.source)) await reference(spec.data.source, spec.path, "SOURCE_NOT_FOUND");
    if (!nonempty(spec.data.id)) continue;
    const ownerId = spec.data.id;
    const kind = materialKind(spec);
    for (const anchor of readAnchors(spec.data)) {
      if (anchor.node !== undefined && (!anchor.node.trim() || anchor.node.startsWith("/") || anchor.node.split("/").includes(".."))) {
        diagnostics.push(diagnostic(spec.path, "ANCHOR_NODE_INVALID", `Anchor '${anchor.name}' needs a project-relative scene node path`));
      }
    }
    if (kind && spec.data.parent !== undefined) {
      const code = kind === "entity" ? "ENTITY_PARENT" : "MATERIAL_PARENT";
      const parent = await semanticReference(spec.data.parent, spec, code, (target) => materialKind(target) === kind);
      if (parent && nonempty(parent.data.id)) parents.set(ownerId, parent.data.id);
    }
    if (kind === "component" && spec.data.extends !== undefined) {
      const target = await semanticReference(spec.data.extends, spec, "COMPONENT_INHERIT", (target) => materialKind(target) === "component" && target.data.type === "component");
      if (target && nonempty(target.data.id)) componentInheritance.set(ownerId, [target.data.id]);
    }
    if (kind === "system") {
      for (const value of Array.isArray(spec.data.components) ? spec.data.components : []) {
        await semanticReference(value, spec, "SYSTEM_COMPONENT", (target) => materialKind(target) === "component");
      }
      for (const value of Array.isArray(spec.data.entities) ? spec.data.entities : []) {
        await semanticReference(value, spec, "SYSTEM_ENTITY", (target) => materialKind(target) === "entity");
      }
      const dependencies: string[] = [];
      for (const value of Array.isArray(spec.data.dependsOn) ? spec.data.dependsOn : []) {
        const target = await semanticReference(value, spec, "SYSTEM_DEPENDENCY", (target) => materialKind(target) === "system");
        if (target && nonempty(target.data.id)) dependencies.push(String(target.data.id));
      }
      if (dependencies.length) systemDependencies.set(ownerId, dependencies);
    }
    if (kind === "feature") {
      for (const value of Array.isArray(spec.data.systems) ? spec.data.systems : []) {
        await semanticReference(value, spec, "FEATURE_SYSTEM", (target) => materialKind(target) === "system");
      }
    }
    if (kind === "decision") {
      for (const value of Array.isArray(spec.data.affectedSystems) ? spec.data.affectedSystems : []) {
        await semanticReference(value, spec, "DECISION_SYSTEM", (target) => materialKind(target) === "system");
      }
      if (spec.data.supersedes !== undefined) {
        await semanticReference(spec.data.supersedes, spec, "DECISION_SUPERSEDES", (target) => materialKind(target) === "decision");
      }
    }
    if (!isEntitySpec(spec)) continue;
    if (spec.data.extends !== undefined) {
      const target = await semanticReference(spec.data.extends, spec, "ENTITY_INHERIT", (target) => materialKind(target) === "entity");
      if (target && nonempty(target.data.id)) inheritance.set(ownerId, [target.data.id]);
    }
    if (spec.data.components !== undefined) {
      const attached = new Set<string>();
      const bound = new Map<string, ParsedSpec>();
      const mounts: { parent: string; anchor: string }[] = [];
      for (const value of Array.isArray(spec.data.components) ? spec.data.components : []) {
        const target = await semanticReference(value, spec, "ENTITY_COMPONENT", (target) => materialKind(target) === "component" && target.data.type === "component", true);
        if (!target) continue;
        const targetIdentity = validationPathIdentity(target.path);
        if (attached.has(targetIdentity)) diagnostics.push(diagnostic(spec.path, "ENTITY_COMPONENT_DUPLICATE", `Component '${String(target.data.id)}' is already attached`));
        attached.add(targetIdentity);
        if (nonempty(target.data.id)) bound.set(String(target.data.id), target);
        // A mount names its parent component and one of that parent's declared anchors.
        if (record(value) && record(value.mount)) {
          const parent = nonempty(value.mount.parent) ? String(value.mount.parent).trim() : "";
          const anchor = nonempty(value.mount.anchor) ? String(value.mount.anchor).trim() : "";
          if (!parent || !anchor) diagnostics.push(diagnostic(spec.path, "MOUNT_INVALID", `Component '${String(target.data.id)}' has an incomplete mount target`));
          else mounts.push({ parent, anchor });
        }
        if (!record(value) || !record(value.values)) continue;
        const fields = new Map<string, ReturnType<typeof readFields>[number]>();
        for (const field of effectiveFields.get(targetIdentity) ?? []) fields.set(field.key, field);
        for (const [key, override] of Object.entries(value.values)) {
          const field = fields.get(key);
          if (!field) diagnostics.push(diagnostic(spec.path, "ENTITY_COMPONENT_FIELD_UNKNOWN", `Component '${String(target.data.id)}' has no field '${key}'`));
          else if (!componentValueMatches(field.type, override)) diagnostics.push(diagnostic(spec.path, "ENTITY_COMPONENT_VALUE_INVALID", `Component '${String(target.data.id)}' field '${key}' requires a ${String(field.type)} value`));
        }
      }
      validateMounts(spec, bound, mounts, effectiveAnchors, diagnostics);
    }
  }

  function reportCycles(graph: Map<string, string[]>, code: string | ((spec: ParsedSpec | undefined) => string)): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, stack: string[]) => {
      if (visiting.has(id)) {
        const index = stack.indexOf(id);
        const spec = ids.get(id);
        diagnostics.push(diagnostic(spec?.path ?? "specs/entities", typeof code === "string" ? code : code(spec), `Specification relationship cycle: ${[...stack.slice(index), id].join(" -> ")}`));
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const next of graph.get(id) ?? []) visit(next, [...stack, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of graph.keys()) visit(id, []);
  }
  reportCycles(new Map([...parents].map(([id, parent]) => [id, [parent]])), (spec) => spec && materialKind(spec) === "entity" ? "ENTITY_PARENT_CYCLE" : "MATERIAL_PARENT_CYCLE");
  reportCycles(inheritance, "ENTITY_INHERIT_CYCLE");
  reportCycles(componentInheritance, "COMPONENT_INHERIT_CYCLE");
  reportCycles(systemDependencies, "SYSTEM_DEPENDENCY_CYCLE");

  const manifestPath = ".specloom/generated-manifest.json";
  const content = await source.readManifest();
  if (content === undefined) {
    diagnostics.push(diagnostic(manifestPath, "GENERATED_MANIFEST_MISSING", "Generated manifest does not exist"));
    return;
  }
  let manifest: unknown;
  try { manifest = JSON.parse(content); } catch { diagnostics.push(diagnostic(manifestPath, "GENERATED_MANIFEST_INVALID", "Generated manifest is not valid JSON")); return; }
  if (!record(manifest) || manifest.schemaVersion !== 1 || !record(manifest.files)) {
    diagnostics.push(diagnostic(manifestPath, "GENERATED_MANIFEST_INVALID", "Generated manifest requires schemaVersion 1 and a files mapping"));
    return;
  }
  for (const [target, value] of Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))) {
    await reference({ path: target }, manifestPath, "GENERATED_TARGET_NOT_FOUND");
    if (!record(value)) { diagnostics.push(diagnostic(manifestPath, "GENERATED_MANIFEST_INVALID", `Generated entry '${target}' must be a mapping`)); continue; }
    for (const key of ["entityId", "sourceId"] as const) if (value[key] !== undefined) await reference({ id: value[key] }, manifestPath, "GENERATED_SOURCE_NOT_FOUND");
    if (value.source !== undefined) await reference(value.source, manifestPath, "GENERATED_SOURCE_NOT_FOUND");
    if (value.sources !== undefined) {
      if (!Array.isArray(value.sources)) diagnostics.push(diagnostic(manifestPath, "GENERATED_MANIFEST_INVALID", `Generated entry '${target}' sources must be an array`));
      else for (const input of value.sources) await reference(input, manifestPath, "GENERATED_SOURCE_NOT_FOUND");
    }
  }
}

/**
 * Mount targets must point at a component attached to the same entity (or at the
 * entity itself) and name one of that parent's declared anchors. Without this,
 * "which slot an armor class mounts to" stays an unchecked ordering convention.
 */
function validateMounts(spec: ParsedSpec, bound: Map<string, ParsedSpec>, mounts: { parent: string; anchor: string }[], anchors: Map<string, ReturnType<typeof readAnchors>>, diagnostics: ValidationDiagnostic[]): void {
  const entityAnchors = readAnchors(spec.data);
  const occupied = new Map<string, number>();
  for (const mount of mounts) {
    let declared = entityAnchors;
    if (mount.parent !== "__entity__") {
      const parent = bound.get(mount.parent);
      if (!parent) {
        diagnostics.push(diagnostic(spec.path, "MOUNT_PARENT_UNKNOWN", `Mount parent '${mount.parent}' is not attached to this entity`));
        continue;
      }
      declared = anchors.get(validationPathIdentity(parent.path)) ?? readAnchors(parent.data);
    }
    const anchor = declared.find((item) => item.name === mount.anchor);
    if (!anchor) {
      diagnostics.push(diagnostic(spec.path, "MOUNT_ANCHOR_UNKNOWN", mount.parent === "__entity__" ? `Entity has no anchor '${mount.anchor}'` : `Component '${mount.parent}' has no anchor '${mount.anchor}'`));
      continue;
    }
    const capacity = anchor.capacity ?? 1;
    const key = `${mount.parent}\\u0000${mount.anchor}`;
    const used = (occupied.get(key) ?? 0) + 1;
    occupied.set(key, used);
    if (used > capacity) diagnostics.push(diagnostic(spec.path, "MOUNT_ANCHOR_OCCUPIED", `Anchor '${mount.anchor}' on '${mount.parent}' already holds ${String(capacity)} component(s)`));
  }
}
