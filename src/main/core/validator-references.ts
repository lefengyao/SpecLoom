import type { ValidationDiagnostic } from "../../shared/contracts";
import { VersionTokenSchema } from "../../shared/contracts";
import { diagnostic, nonempty, record, validationPathIdentity, type ParsedSpec } from "./validator-markdown";
import { ValidationSource } from "./validator-source";
import { normalizeProjectPath } from "./path-policy";

export async function validateReferences(specs: ParsedSpec[], source: ValidationSource, diagnostics: ValidationDiagnostic[]): Promise<void> {
  const ids = new Map<string, ParsedSpec>();
  const paths = new Map(specs.map((spec) => [validationPathIdentity(spec.path), spec]));
  for (const spec of specs) {
    if (!nonempty(spec.data.id)) continue;
    const existing = ids.get(spec.data.id);
    if (existing) diagnostics.push(diagnostic(spec.path, "SPEC_ID_DUPLICATE", `ID '${spec.data.id}' is already defined in ${existing.path}`));
    else ids.set(spec.data.id, spec);
  }

  async function reference(value: unknown, owner: string, code: string, relation = false): Promise<void> {
    const target = typeof value === "string" ? value : record(value) ? value.path ?? value.id : undefined;
    if (!nonempty(target)) {
      diagnostics.push(diagnostic(owner, "REFERENCE_INVALID", "References require a nonempty path or ID"));
      return;
    }
    const isPath = target.startsWith("res://") || target.includes("/") || /\.(?:md|gd|tscn|tres|godot|json|yaml|yml)$/i.test(target) || (record(value) && value.path !== undefined);
    if (isPath) {
      try {
        const relative = normalizeProjectPath(target.replace(/^res:\/\//, ""));
        if (!(await source.exists(relative))) diagnostics.push(diagnostic(owner, code, `Referenced file '${relative}' does not exist`));
        const identity = validationPathIdentity(relative);
        const referencedSpec = paths.get(identity);
        if (relation && (!identity.startsWith("specs/entities/") || !referencedSpec)) diagnostics.push(diagnostic(owner, "RELATION_TARGET_INVALID", `Relation '${relative}' must reference an entity specification`));
        else if (record(value) && value.type !== undefined && referencedSpec && referencedSpec.data.type !== value.type) diagnostics.push(diagnostic(owner, "RELATION_TYPE_MISMATCH", `Referenced file '${relative}' does not have type '${String(value.type)}'`));
        if (record(value) && value.version !== undefined) {
          if (!VersionTokenSchema.safeParse(value.version).success) diagnostics.push(diagnostic(owner, "REFERENCE_VERSION_INVALID", `Reference '${relative}' requires a file version token`));
          else if (await source.effectiveVersion(relative) !== value.version) diagnostics.push(diagnostic(owner, "REFERENCE_VERSION_STALE", `Referenced file '${relative}' has changed`));
        }
      } catch {
        diagnostics.push(diagnostic(owner, "REFERENCE_PATH_INVALID", `Reference '${target}' is not a safe project path`));
      }
    } else {
      const found = ids.get(target);
      if (!found || (relation && !validationPathIdentity(found.path).startsWith("specs/entities/"))) diagnostics.push(diagnostic(owner, code, `Referenced ID '${target}' does not exist`));
      else if (record(value) && value.type !== undefined && found.data.type !== value.type) diagnostics.push(diagnostic(owner, "RELATION_TYPE_MISMATCH", `Referenced ID '${target}' does not have type '${String(value.type)}'`));
    }
  }

  for (const spec of specs) {
    if (Array.isArray(spec.data.relations)) for (const value of spec.data.relations) await reference(value, spec.path, "RELATION_NOT_FOUND", true);
    if (validationPathIdentity(spec.path).startsWith("specs/tasks/") && Array.isArray(spec.data.inputs)) for (const value of spec.data.inputs) await reference(value, spec.path, "TASK_INPUT_NOT_FOUND");
    if (Array.isArray(spec.data.source)) for (const value of spec.data.source) await reference(value, spec.path, "SOURCE_NOT_FOUND");
    else if (record(spec.data.source)) await reference(spec.data.source, spec.path, "SOURCE_NOT_FOUND");
  }

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
