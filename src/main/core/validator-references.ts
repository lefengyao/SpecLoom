import type { ValidationDiagnostic } from "../../shared/contracts";
import { VersionTokenSchema } from "../../shared/contracts";
import { resolveComponentAnchors, resolveComponentFields, type ComponentDefinition } from "../../shared/component-inheritance";
import { sceneNodePaths } from "../../shared/godot-scene";
import { flattenDecisionTree, parseComparator } from "../../shared/decision-tree";
import { bindingIdentity, readAnchors, readBindingKey, readFields } from "../../shared/project-materials";
import { referenceId } from "../../shared/material-catalog";
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
    if (relative.startsWith("specs/decision_trees/")) return "decision_tree";
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
  // Decision files carry a four-digit number; two files may not share it.
  const decisionNumbers = new Map<string, ParsedSpec>();
  for (const spec of specs) {
    if (materialKind(spec) !== "decision") continue;
    const filename = validationPathIdentity(spec.path).split("/").pop() ?? "";
    const number = /^(\d{4})-/.exec(filename)?.[1];
    if (!number) continue;
    const existing = decisionNumbers.get(number);
    if (existing) diagnostics.push(diagnostic(spec.path, "DECISION_NUMBER_DUPLICATE", `Decision number ${number} is already used by ${existing.path}`));
    else decisionNumbers.set(number, spec);
  }
  const componentDefinitions: ComponentDefinition[] = specs
    .filter((spec) => materialKind(spec) === "component" && spec.data.type === "component" && nonempty(spec.data.id))
    .map((spec) => ({ path: spec.path, id: String(spec.data.id), data: spec.data }));
  const effectiveFields = new Map<string, ReturnType<typeof readFields>>(componentDefinitions.map((definition) => [validationPathIdentity(definition.path), resolveComponentFields(componentDefinitions, definition).fields]));
  // Mounts may target anchors a component inherits from its base definition.
  const effectiveAnchors = new Map<string, ReturnType<typeof readAnchors>>(componentDefinitions.map((definition) => [validationPathIdentity(definition.path), resolveComponentAnchors(componentDefinitions, definition).anchors]));
  const decisionTrees = new Map<string, ParsedSpec>(specs
    .filter((spec) => materialKind(spec) === "decision_tree" && nonempty(spec.data.id))
    .map((spec) => [String(spec.data.id), spec]));

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
    if (kind === "decision_tree") {
      for (const { node } of flattenDecisionTree(spec.data.root)) {
        if (node.kind !== "condition" || typeof node.comparator !== "string") continue;
        const parsed = parseComparator(node.comparator);
        if (!parsed) continue; // the structural validator already reports the syntax
        const ownerEntity = typeof node.owner === "string" && node.owner.trim() ? specs.find((candidate) => materialKind(candidate) === "entity" && candidate.data.id === node.owner) : undefined;
        if (typeof node.owner === "string" && node.owner.trim() && !ownerEntity) {
          diagnostics.push(diagnostic(spec.path, "TREE_OWNER_UNKNOWN", `Condition '${node.id}' references unknown entity '${node.owner}'`));
        }
        const component = componentDefinitions.find((definition) => definition.id === parsed.component);
        if (!component) {
          diagnostics.push(diagnostic(spec.path, "TREE_COMPARATOR_UNKNOWN_COMPONENT", `Condition '${node.id}' references unknown component '${parsed.component}'`));
          continue;
        }
        if (ownerEntity) {
          const attached = Array.isArray(ownerEntity.data.components) ? ownerEntity.data.components.map((entry) => referenceId(entry)).filter((entry): entry is string => Boolean(entry)) : [];
          if (!attached.includes(parsed.component)) {
            diagnostics.push(diagnostic(spec.path, "TREE_OWNER_COMPONENT_MISSING", `Entity '${node.owner}' does not mount component '${parsed.component}' used by condition '${node.id}'`));
          }
        }
        const declared = effectiveFields.get(validationPathIdentity(component.path)) ?? [];
        const field = declared.find((item) => item.key === parsed.field);
        if (!field) {
          diagnostics.push(diagnostic(spec.path, "TREE_COMPARATOR_UNKNOWN_FIELD", `Component '${parsed.component}' has no field '${parsed.field}'`));
          continue;
        }
        if (!comparatorLiteralMatches(field.type, parsed.literal)) {
          diagnostics.push(diagnostic(spec.path, "TREE_COMPARATOR_TYPE_MISMATCH", `Condition '${node.id}' compares ${parsed.component}.${parsed.field} (${field.type}) with '${parsed.literal}'`));
        }
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
    if (kind === "system" && Array.isArray(spec.data.mounts)) {
      const attached = new Set<string>();
      const keys = new Set<string>();
      const counts = new Map<string, number>();
      for (const value of spec.data.mounts) {
        const target = await semanticReference(value, spec, "SYSTEM_MOUNT", (candidate) => materialKind(candidate) === "component" && candidate.data.type === "component", true);
        if (!target) continue;
        const componentId = nonempty(target.data.id) ? String(target.data.id) : validationPathIdentity(target.path);
        const key = readBindingKey(value);
        const identity = bindingIdentity(componentId, key);
        if (attached.has(identity)) diagnostics.push(diagnostic(spec.path, "SYSTEM_MOUNT_DUPLICATE", `Mount '${identity}' is declared twice`));
        attached.add(identity);
        if (key) {
          if (keys.has(key)) diagnostics.push(diagnostic(spec.path, "BINDING_KEY_DUPLICATE", `Mount key '${key}' is used twice`));
          keys.add(key);
        }
        const count = (counts.get(componentId) ?? 0) + 1;
        counts.set(componentId, count);
        if (count > 1 && !key) diagnostics.push(diagnostic(spec.path, "BINDING_KEY_REQUIRED", `Component '${componentId}' is mounted twice; give each instance a key`));
        const values = record(value) && record(value.values) ? value.values : {};
        if (componentId === "decision_tree") {
          const tree = typeof values.tree === "string" ? values.tree.trim() : "";
          if (!tree || !decisionTrees.has(tree)) diagnostics.push(diagnostic(spec.path, "DECISION_TREE_MISSING", `Decision tree '${tree || "(empty)"}' does not exist`));
        }
        const fields = new Map((effectiveFields.get(validationPathIdentity(target.path)) ?? []).map((field) => [field.key, field] as const));
        for (const [fieldKey, override] of Object.entries(values)) {
          const field = fields.get(fieldKey);
          if (!field) diagnostics.push(diagnostic(spec.path, "SYSTEM_MOUNT_FIELD_UNKNOWN", `Component '${componentId}' has no field '${fieldKey}'`));
          else if (!componentValueMatches(field.type, override)) diagnostics.push(diagnostic(spec.path, "SYSTEM_MOUNT_VALUE_INVALID", `Component '${componentId}' field '${fieldKey}' requires a ${String(field.type)} value`));
        }
      }
    }
    if (!isEntitySpec(spec)) continue;
    if (spec.data.extends !== undefined) {
      const target = await semanticReference(spec.data.extends, spec, "ENTITY_INHERIT", (target) => materialKind(target) === "entity");
      if (target && nonempty(target.data.id)) inheritance.set(ownerId, [target.data.id]);
    }
    const bound = new Map<string, ParsedSpec>();
    if (spec.data.components !== undefined) {
      const attached = new Set<string>();
      const keys = new Set<string>();
      const counts = new Map<string, number>();
      const mounts: { parent: string; anchor: string }[] = [];
      for (const value of Array.isArray(spec.data.components) ? spec.data.components : []) {
        const target = await semanticReference(value, spec, "ENTITY_COMPONENT", (target) => materialKind(target) === "component" && target.data.type === "component", true);
        if (!target) continue;
        const targetIdentity = validationPathIdentity(target.path);
        const componentId = nonempty(target.data.id) ? String(target.data.id) : targetIdentity;
        const key = readBindingKey(value);
        const identity = bindingIdentity(componentId, key);
        if (attached.has(identity)) diagnostics.push(diagnostic(spec.path, "ENTITY_COMPONENT_DUPLICATE", `Component '${identity}' is already attached`));
        attached.add(identity);
        if (key) {
          if (keys.has(key)) diagnostics.push(diagnostic(spec.path, "BINDING_KEY_DUPLICATE", `Binding key '${key}' is used twice`));
          keys.add(key);
        }
        const count = (counts.get(componentId) ?? 0) + 1;
        counts.set(componentId, count);
        if (count > 1 && !key) diagnostics.push(diagnostic(spec.path, "BINDING_KEY_REQUIRED", `Component '${componentId}' is attached twice; give each instance a key`));
        if (nonempty(target.data.id)) bound.set(String(target.data.id), target);
        if (componentId === "decision_tree") {
          const values = record(value) && record(value.values) ? value.values : {};
          const tree = typeof values.tree === "string" ? values.tree.trim() : "";
          if (!tree || !decisionTrees.has(tree)) diagnostics.push(diagnostic(spec.path, "DECISION_TREE_MISSING", `Decision tree '${tree || "(empty)"}' does not exist`));
        }
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
    // Anchor node paths are checked even when the entity attaches no components.
    await validateSceneAnchors(spec, bound, effectiveAnchors, diagnostics);
  }

  /**
   * Anchor node paths are contracts on the entity's scene, so check them against the
   * `.tscn` the spec names. Specs without `scene` stay silent instead of guessing.
   */
  async function validateSceneAnchors(spec: ParsedSpec, bound: Map<string, ParsedSpec>, anchors: Map<string, ReturnType<typeof readAnchors>>, diagnostics: ValidationDiagnostic[]): Promise<void> {
    const declared = typeof spec.data.scene === "string" ? spec.data.scene.trim().replaceAll("\\", "/") : "";
    if (!declared) return;
    let text: string | undefined;
    try { text = await source.read(declared); } catch { text = undefined; }
    if (text === undefined) {
      diagnostics.push(diagnostic(spec.path, "SCENE_NOT_FOUND", `Scene '${declared}' does not exist`));
      return;
    }
    const nodes = sceneNodePaths(text);
    if (!nodes.size) {
      diagnostics.push(diagnostic(spec.path, "SCENE_INVALID", `Scene '${declared}' has no node sections`));
      return;
    }
    const candidates: { owner: string; anchor: { name: string; node?: string } }[] = readAnchors(spec.data).map((anchor) => ({ owner: spec.path, anchor }));
    for (const component of bound.values()) {
      const list = anchors.get(validationPathIdentity(component.path)) ?? readAnchors(component.data);
      for (const anchor of list) candidates.push({ owner: component.path, anchor });
    }
    for (const { owner, anchor } of candidates) {
      if (anchor.node === undefined) continue;
      const node = anchor.node.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
      if (nodes.has(node)) continue;
      diagnostics.push(diagnostic(owner, "ANCHOR_NODE_MISSING", `Anchor '${anchor.name}' points at '${node}', which ${declared} does not define`));
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

/** Comparators are typed loosely in YAML, so check the literal against the field type. */
function comparatorLiteralMatches(type: string, literal: string): boolean {
  if (type === "number") return literal.trim() !== "" && Number.isFinite(Number(literal));
  if (type === "boolean") return literal === "true" || literal === "false";
  return true;
}
