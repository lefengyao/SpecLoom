import { Image as ImageIcon, ImageOff, LayoutGrid, Plus, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { FileReadResult } from "../shared/contracts";
import { parseMaterial, readAnchors, readBindings, readFields, writeMaterial, type ComponentBinding, type ComponentField, type ComponentMount, type ComponentValue } from "../shared/project-materials";
import { materialGroupPath, normalizeMaterialGroups } from "../shared/material-groups";
import { resolveComponentAnchors, resolveComponentFields } from "../shared/component-inheritance";
import { categoryForPath, referenceId } from "./materials-model";
import { ComponentBrowserDialog, type BrowserEntry } from "./ComponentBrowserDialog";
import { useI18n } from "./i18n";
import "./component-browser.css";
import {
  createLayoutSaver,
  loadEntityLayout,
  type EntityLayout,
} from "./entity-layout";
import "./entity-workbench.css";

import { EntityComponentBoard } from "./entity-workbench/canvas";
import { ComponentFillPanel, EntityDetailsPanel, type EntityWorkbenchProps } from "./entity-workbench/inspectors";
import { useEntityLayout } from "./entity-workbench/useEntityLayout";
import { EMPTY_POSITIONS, IMAGE_SIZE_MAX, IMAGE_SIZE_MIN, cleanBindingNotes, describeError, isAnchorSide, loadImageSettings, matchesQuery, normalizeReference, readFieldValue, resolveEntityBindings, resolveEntityReference, resolveComponentReference, saveImageSettings, type ComponentEntry, type EntityEntry, type MaterialLookup, type ResolvedBinding, type WorkbenchImageSettings } from "./entity-workbench/model";

export { ComponentFillPanel, type ComponentFillPanelProps } from "./entity-workbench/inspectors";
export { EntityComponentBoard, type EntityComponentBoardProps } from "./entity-workbench/canvas";
export type { EntityEntry, ResolvedBinding } from "./entity-workbench/model";

export function EntityWorkbench({ api, projectPath, onError, onOpenDetail }: EntityWorkbenchProps) {
  const tr = useI18n();
  const [files, setFiles] = useState<FileReadResult[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState<EntityLayout>(() => loadEntityLayout(projectPath));
  const [imageSettings, setImageSettings] = useState<WorkbenchImageSettings>(() => loadImageSettings(projectPath));
  const [entityImages, setEntityImages] = useState<Record<string, string>>({});
  const [selectedEntityPath, setSelectedEntityPath] = useState<string | undefined>(undefined);
  const [selectedBindingId, setSelectedBindingId] = useState<string | undefined>(undefined);
  const [componentDrawerOpen, setComponentDrawerOpen] = useState(false);
  const [componentBrowserOpen, setComponentBrowserOpen] = useState(false);
  useEffect(() => {
    if (selectedBindingId) setComponentDrawerOpen(true);
  }, [selectedBindingId]);
  useEffect(() => {
    if (!componentBrowserOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setComponentBrowserOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [componentBrowserOpen]);
  const [entityQuery, setEntityQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedNotice, setSavedNotice] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Measurements and drops can fire several saves in a burst; the sidecar is written one at a time.
  const saveLayout = useMemo(() => {
    const target = api.entityLayout;
    return target ? createLayoutSaver((next) => target.save(next), (error) => onErrorRef.current?.(error)) : undefined;
  }, [api.entityLayout]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current++;
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(undefined);
    setSaveError(undefined);
    setSavedNotice(false);
    try {
      const listed = await api.documents();
      const targets = listed.filter((document) => {
        const category = categoryForPath(document.path);
        return category === "entity" || category === "component" || document.path.toLowerCase() === "specs/project.md";
      });
      const failed: string[] = [];
      const reads = await Promise.all(
        targets.map(async (document) => {
          try {
            return await api.readDocument(document.path, document.version);
          } catch {
            failed.push(document.path);
            return undefined;
          }
        }),
      );
      if (!mountedRef.current || request !== requestRef.current) return;
      const nextFiles = reads.filter((item): item is FileReadResult => item !== undefined);
      setFiles(nextFiles);
      setDrafts((current) => {
        const available = new Set(nextFiles.map((file) => file.path));
        const kept = Object.entries(current).filter(([path]) => available.has(path));
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
      });
      if (failed.length) setLoadError(tr("有 {count} 份资料读取失败，请刷新重试。", { count: failed.length }));
    } catch (error) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setLoadError(describeError(error, tr("读取项目资料失败，请刷新重试。")));
      onError?.(error);
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [api, onError, tr]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current++;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setLayout(loadEntityLayout(projectPath));
    setImageSettings(loadImageSettings(projectPath));
    setComponentBrowserOpen(false);
    setDrafts({});
    setSelectedEntityPath(undefined);
    setSelectedBindingId(undefined);
    if (!api.entityLayout) return;
    void api.entityLayout.read()
      .then((next) => { if (!cancelled) setLayout(next); })
      .catch((error) => { if (!cancelled) onError?.(error); });
    return () => { cancelled = true; };
  }, [api, projectPath, onError]);

  const parsedFiles = useMemo(() => {
    return files.flatMap((file) => {
      const category = categoryForPath(file.path);
      if (category !== "entity" && category !== "component") return [];
      const content = drafts[file.path] ?? file.content;
      const parsed = parseMaterial(content);
      if (!parsed || typeof parsed.data.id !== "string" || !parsed.data.id.trim()) return [];
      const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim();
      const title =
        typeof parsed.data.title === "string" && parsed.data.title.trim()
          ? parsed.data.title.trim()
          : heading && heading.length > 0
            ? heading
            : (file.path.split("/").pop() ?? file.path);
      return [{ file, content, parsed, category, id: parsed.data.id.trim(), title }];
    });
  }, [files, drafts]);

  const entityEntries = useMemo(() => {
    return parsedFiles
      .filter((item) => item.category === "entity")
      .map((item): EntityEntry => {
        const extendsRef = referenceId(item.parsed.data.extends);
        return {
          path: item.file.path,
          version: item.file.version,
          id: item.id,
          title: item.title,
          ...(extendsRef ? { extendsRef } : {}),
          data: item.parsed.data,
          body: item.parsed.body,
          content: item.content,
          baseline: item.file.content,
          bindings: readBindings(item.parsed.data),
          anchors: readAnchors(item.parsed.data),
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

  const imageKey = useMemo(
    () => [...new Set(entityEntries.flatMap((entry) => typeof entry.data.image === "string" && entry.data.image ? [entry.data.image] : []))].sort().join("|"),
    [entityEntries],
  );
  const imagePaths = useMemo(() => imageKey ? imageKey.split("|") : [], [imageKey]);
  useEffect(() => {
    if (!imagePaths.length || typeof api.readMaterialImage !== "function") { setEntityImages({}); return; }
    let cancelled = false;
    void Promise.all(imagePaths.map(async (path) => {
      try { return [path, await api.readMaterialImage(projectPath, path)] as const; }
      catch { return undefined; }
    })).then((pairs) => {
      if (!cancelled) setEntityImages(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== undefined)));
    });
    return () => { cancelled = true; };
  }, [api, projectPath, imagePaths]);

  const componentEntries = useMemo(() => {
    const entries = parsedFiles
      .filter((item) => item.category === "component")
      .map((item): ComponentEntry => {
        const extendsRef = referenceId(item.parsed.data.extends);
        const notes = Array.isArray(item.parsed.data.notes)
          ? item.parsed.data.notes.filter((note): note is string => typeof note === "string").map((note) => note.trim()).filter(Boolean).slice(0, 32)
          : [];
        return {
          path: item.file.path,
          id: item.id,
          title: item.title,
          fields: readFields(item.parsed.data),
          anchors: readAnchors(item.parsed.data),
          scope: item.parsed.data.scope === "system" ? "system" : "user",
          ...(typeof item.parsed.data.description === "string" ? { description: item.parsed.data.description } : {}),
          ...(notes.length ? { notes } : {}),
          ...(item.parsed.body.trim() ? { body: item.parsed.body.trim() } : {}),
          ...(typeof item.parsed.data.group === "string" && item.parsed.data.group.trim() ? { group: item.parsed.data.group.trim() } : {}),
          ...(typeof item.parsed.data.groupId === "string" && item.parsed.data.groupId.trim() ? { groupId: item.parsed.data.groupId.trim() } : {}),
          ...(extendsRef ? { extendsRef } : {}),
        };
      });
    const definitions = entries.map((entry) => ({ path: entry.path, id: entry.id, data: { extends: entry.extendsRef, fields: entry.fields, anchors: entry.anchors } }));
    const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
    const effective = entries.map((entry) => {
      const definition = byPath.get(normalizeReference(entry.path));
      return definition ? { ...entry, fields: resolveComponentFields(definitions, definition).fields, anchors: resolveComponentAnchors(definitions, definition).anchors } : entry;
    });
    return effective.sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

  const componentGroups = useMemo(() => {
    const project = files.find((file) => file.path.toLowerCase() === "specs/project.md");
    if (!project) return [];
    return normalizeMaterialGroups(parseMaterial(project.content)?.data.materialGroups).component ?? [];
  }, [files]);

  const lookup = useMemo<MaterialLookup>(() => {
    const entitiesById = new Map<string, EntityEntry>();
    const entitiesByPath = new Map<string, EntityEntry>();
    for (const entry of entityEntries) {
      if (!entitiesById.has(entry.id)) entitiesById.set(entry.id, entry);
      entitiesByPath.set(normalizeReference(entry.path), entry);
      entitiesByPath.set(normalizeReference(entry.path).replace(/\.md$/, ""), entry);
    }
    const componentsById = new Map<string, ComponentEntry>();
    const componentsByPath = new Map<string, ComponentEntry>();
    for (const entry of componentEntries) {
      if (!componentsById.has(entry.id)) componentsById.set(entry.id, entry);
      componentsByPath.set(normalizeReference(entry.path), entry);
      componentsByPath.set(normalizeReference(entry.path).replace(/\.md$/, ""), entry);
    }
    return { entitiesById, entitiesByPath, componentsById, componentsByPath };
  }, [entityEntries, componentEntries]);

  const entity = entityEntries.find((item) => item.path === selectedEntityPath) ?? entityEntries[0];
  const inheritsFrom = entity?.extendsRef ? (resolveEntityReference(entity.extendsRef, lookup)?.title ?? entity.extendsRef) : undefined;
  const selectedImage = entity && typeof entity.data.image === "string" ? entityImages[entity.data.image] : undefined;
  const imageUrl = imageSettings.show ? selectedImage : undefined;
  const bindings = useMemo(() => (entity ? resolveEntityBindings(entity, lookup) : []), [entity, lookup]);
  const { pruneBindings, moveBinding, measureNode, arrangeComponents, setConnection, addAnchor, removeAnchor, connectAnchor } =
    useEntityLayout({ entity, bindings, projectPath, setLayout, saveLayout });
  /** Anchor-bearing parents a component can mount on: the entity itself plus bound components. */
  const mountParents = useMemo(() => {
    if (!entity) return [];
    const options: { id: string; label: string; anchors: { name: string; label?: string }[] }[] = [];
    const entityAnchors = readAnchors(entity.data);
    if (entityAnchors.length) options.push({ id: "__entity__", label: entity.title, anchors: entityAnchors });
    const selectedIdentity = selectedBindingId;
    for (const binding of bindings) {
      // A component cannot mount on itself.
      if (selectedIdentity && binding.id === selectedIdentity) continue;
      const anchors = binding.component?.anchors ?? [];
      if (!anchors.length) continue;
      options.push({ id: binding.component?.id ?? binding.id, label: binding.component?.title ?? binding.id, anchors });
    }
    return options;
  }, [entity, bindings, selectedBindingId]);
  const bindingIdentity = useCallback(
    (reference: string): string => resolveComponentReference(reference, lookup)?.id ?? normalizeReference(reference),
    [lookup],
  );

  const draft = entity ? drafts[entity.path] : undefined;
  const dirty = Boolean(entity && draft !== undefined && draft !== entity.baseline);
  const errorMessage = saveError ?? loadError;

  const filteredEntities = useMemo(
    () => entityEntries.filter((item) => matchesQuery(entityQuery, [item.title, item.id, item.path])),
    [entityEntries, entityQuery],
  );
  const entityGroups = useMemo(() => {
    const groups = new Map<string, EntityEntry[]>();
    for (const item of filteredEntities) {
      const directory = item.path.split("/").slice(0, -1).join("/") || "specs";
      groups.set(directory, [...(groups.get(directory) ?? []), item]);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, entries]) => ({
        directory,
        entries: [...entries].sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path)),
      }));
  }, [filteredEntities]);

  const selectedBinding = selectedBindingId ? bindings.find((item) => item.id === selectedBindingId) : undefined;
  const selectedEntry = entity && selectedBinding ? layout[entity.id]?.[selectedBinding.id] : undefined;
  const selectedAnchors = selectedEntry?.anchors ?? [];
  const selectedSourceAnchor = isAnchorSide(selectedEntry?.sourceAnchor) ? selectedEntry.sourceAnchor : undefined;
  const selectedTargetAnchor = selectedEntry?.targetAnchor && (isAnchorSide(selectedEntry.targetAnchor) || selectedAnchors.some((anchor) => anchor.id === selectedEntry.targetAnchor)) ? selectedEntry.targetAnchor : undefined;
  const selectedComponent = selectedBinding?.component;
  const componentFields = selectedComponent?.fields ?? [];
  const currentField = componentFields.find((field) => field.key === "current" && field.type === "number");
  const maxField = componentFields.find((field) => field.key === "max" && field.type === "number");
  const rangeEnabled = Boolean(currentField && maxField);
  const rangeMax = selectedBinding && maxField ? Number(readFieldValue(selectedBinding, maxField)) : 0;
  const rangeCurrent = selectedBinding && currentField ? Number(readFieldValue(selectedBinding, currentField)) : 0;
  const progressMax = Number.isFinite(rangeMax) && rangeMax > 0 ? rangeMax : 1;

  const effectiveBindingFor = (component: ComponentEntry): ResolvedBinding | undefined =>
    bindings.find((item) => item.component?.id === component.id || item.id === component.id);

  function selectBinding(bindingId: string | undefined): void {
    setSelectedBindingId(bindingId);
    if (bindingId === undefined) setComponentDrawerOpen(true);
  }

  const componentStatus = (component: ComponentEntry): "added" | "inherited" | "available" => {
    const binding = effectiveBindingFor(component);
    return binding?.own ? "added" : binding ? "inherited" : "available";
  };
  /** The shared browser only needs flat entries; grouping and nesting happen inside it. */
  const browserEntries = useMemo<BrowserEntry[]>(() => componentEntries.map((component) => {
    const registry = component.groupId ? componentGroups.find((group) => group.id === component.groupId) : undefined;
    const groupLabel = component.groupId
      ? materialGroupPath(componentGroups, component.groupId) || component.group || component.groupId
      : component.group;
    return {
      path: component.path,
      id: component.id,
      title: component.title,
      ...(component.description ? { description: component.description } : {}),
      ...(component.body ? { body: component.body } : {}),
      ...(component.notes?.length ? { notes: component.notes } : {}),
      ...(component.extendsRef ? { extendsRef: component.extendsRef } : {}),
      ...(component.scope ? { scope: component.scope } : {}),
      fields: component.fields,
      ...(groupLabel ? { groupLabel } : {}),
      ...(registry ? { groupOrder: componentGroups.indexOf(registry) } : {}),
      status: componentStatus(component),
    } as BrowserEntry;
  }), [componentEntries, componentGroups, bindings]);

  function openComponentBrowser(): void {
    setComponentBrowserOpen(true);
    setComponentDrawerOpen(false);
  }

  function createBrowserComponent(component: ComponentEntry | undefined): void {
    if (!component || componentStatus(component) === "added") return;
    addComponent(component);
    setComponentBrowserOpen(false);
  }


  function writeEntityBindings(nextBindings: ComponentBinding[]) {
    if (!entity) return;
    const components = nextBindings.map((binding) => ({
      id: binding.id,
      values: binding.values,
      ...(binding.notes && binding.notes.length ? { notes: binding.notes } : {}),
      ...(binding.mount ? { mount: binding.mount } : {}),
    }));
    const content = writeMaterial({ ...entity.data, components }, entity.body);
    setDrafts((current) => ({ ...current, [entity.path]: content }));
  }

  function addComponent(component: ComponentEntry) {
    if (!entity) return;
    const existing = effectiveBindingFor(component);
    if (existing?.own) return;
    const defaults: Record<string, ComponentValue> = {};
    for (const field of component.fields) defaults[field.key] = field.default;
    const values: Record<string, ComponentValue> = { ...defaults, ...(existing?.values ?? {}) };
    const identity = component.id;
    const remaining = entity.bindings.filter((binding) => bindingIdentity(binding.id) !== identity);
    writeEntityBindings([...remaining, { id: identity, values }]);
    setSelectedBindingId(identity);
  }

  function overrideBinding(binding: ResolvedBinding) {
    if (!entity) return;
    const component = binding.component;
    const defaults: Record<string, ComponentValue> = {};
    if (component) for (const field of component.fields) defaults[field.key] = field.default;
    const values: Record<string, ComponentValue> = { ...defaults, ...binding.values };
    const identity = component?.id ?? bindingIdentity(binding.id);
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    writeEntityBindings([...remaining, { id: identity, values, ...(binding.notes.length ? { notes: binding.notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(identity);
  }

  function updateBindingValue(binding: ResolvedBinding, field: ComponentField, value: ComponentValue) {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    if (binding.own) {
      const nextBindings = entity.bindings.map((ownBinding) =>
        bindingIdentity(ownBinding.id) === identity
          ? { ...ownBinding, values: { ...ownBinding.values, [field.key]: value } }
          : ownBinding,
      );
      writeEntityBindings(nextBindings);
      return;
    }
    // Editing an inherited field materializes an explicit override for this entity.
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, { id, values: { ...defaults, ...binding.values, [field.key]: value }, ...(binding.notes.length ? { notes: binding.notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(id);
  }

  function updateBindingNotes(binding: ResolvedBinding, notes: string[]): void {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    if (binding.own) {
      writeEntityBindings(entity.bindings.map((ownBinding) =>
        bindingIdentity(ownBinding.id) === identity ? { ...ownBinding, notes } : ownBinding,
      ));
      return;
    }
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, { id, values: { ...defaults, ...binding.values }, ...(notes.length ? { notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(id);
  }

  function updateBindingMount(binding: ResolvedBinding, mount: ComponentMount | undefined): void {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    const rebound = (item: ComponentBinding): ComponentBinding => ({
      id: item.id,
      values: item.values,
      ...(item.notes?.length ? { notes: item.notes } : {}),
      ...(mount ? { mount } : {}),
    });
    if (binding.own) {
      writeEntityBindings(entity.bindings.map((ownBinding) => bindingIdentity(ownBinding.id) === identity ? rebound(ownBinding) : ownBinding));
      return;
    }
    // Editing an inherited mount materializes an explicit binding for this entity.
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, rebound({ id, values: { ...defaults, ...binding.values }, ...(binding.notes.length ? { notes: binding.notes } : {}) })]);
    setSelectedBindingId(id);
  }

  function updateImageSettings(next: WorkbenchImageSettings): void {
    setImageSettings(next);
    saveImageSettings(projectPath, next);
  }

  function removeBinding(binding: ResolvedBinding) {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    writeEntityBindings(remaining);
    setSelectedBindingId(undefined);
    const activeIds = resolveEntityBindings({ ...entity, bindings: remaining }, lookup).map((item) => item.id);
    pruneBindings(activeIds);
  }

  async function save() {
    if (!entity || !dirty || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await api.saveDocument(projectPath, entity.path, cleanBindingNotes(entity.content), entity.version);
      if (!mountedRef.current) return;
      setFiles((current) => current.map((file) => (file.path === saved.path ? saved : file)));
      setDrafts((current) => {
        const next = { ...current };
        delete next[saved.path];
        return next;
      });
      setSavedNotice(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveError(describeError(error, tr("保存资料失败，请重新读取后再试。")));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="entity-workbench" aria-label={tr("实体工作台")}>
      <header className="ewb-header">
        <div className="ewb-heading">
          <h1>{tr("实体工作台")}</h1>
          <p className="ewb-subtitle subtle">
            {entity ? (
              <>
                <strong>{entity.title}</strong>
                {entity.extendsRef && (
                  <span className="ewb-subtitle-inherit">
                    {tr("继承自 {source}", { source: resolveEntityReference(entity.extendsRef, lookup)?.title ?? entity.extendsRef })}
                  </span>
                )}
                <code>{entity.path}</code>
              </>
            ) : (
              tr("选择实体后编辑它的组件绑定")
            )}
          </p>
        </div>
        <div className="ewb-toolbar">
          {savedNotice && !dirty && <span className="ewb-saved">{tr("已保存")}</span>}
          {dirty && <span className="ewb-dirty">{tr("未保存")}</span>}
          <button
            type="button"
            disabled={!entity}
            aria-label={tr("自动整理组件")}
            title={tr("按挂载层级重新摆放组件")}
            onClick={arrangeComponents}
          >
            <LayoutGrid size={15} />{tr("自动整理")}
          </button>
          <div className="ewb-image-controls" role="group" aria-label={tr("配图显示")}>
            <button
              type="button"
              aria-pressed={imageSettings.show}
              title={imageSettings.show ? tr("隐藏配图") : tr("显示配图")}
              onClick={() => updateImageSettings({ ...imageSettings, show: !imageSettings.show })}
            >
              {imageSettings.show ? <ImageIcon size={15} /> : <ImageOff size={15} />}
              {tr("配图")}
            </button>
            {imageSettings.show && (
              <label className="ewb-image-size">
                <span>{tr("大小")}</span>
                <input
                  type="range"
                  min={IMAGE_SIZE_MIN}
                  max={IMAGE_SIZE_MAX}
                  step={20}
                  value={imageSettings.size}
                  aria-label={tr("配图大小")}
                  onChange={(event) => updateImageSettings({ ...imageSettings, size: Number(event.target.value) })}
                />
              </label>
            )}
          </div>
          <button
            type="button"
            className="primary"
            disabled={!entity || !dirty || saving || loading}
            onClick={() => {
              void save();
            }}
          >
            <Save size={15} />
            {saving ? tr("保存中…") : tr("保存资料")}
          </button>
          <button
            type="button"
            disabled={loading || saving}
            title={tr("重新读取实体和组件")}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={15} />
            {tr("刷新")}
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="ewb-error" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => {
              setSaveError(undefined);
              setLoadError(undefined);
            }}
          >
            {tr("关闭")}
          </button>
        </div>
      )}

      <div className={"ewb-layout" + (componentDrawerOpen ? " is-drawer-open" : "")}>
        <aside className="ewb-panel ewb-entities" aria-label={tr("实体列表")}>
          <header className="ewb-panel-head">
            <h2>{tr("实体")}</h2>
            <span className="subtle">
              {tr("实体 {entities} · 组件 {components}", { entities: entityEntries.length, components: componentEntries.length })}
            </span>
          </header>
          <input
            type="search"
            aria-label={tr("搜索实体")}
            placeholder={tr("搜索实体")}
            value={entityQuery}
            onChange={(event) => setEntityQuery(event.target.value)}
          />
          {filteredEntities.length === 0 ? (
            <p className="ewb-empty">
              {loading
                ? tr("正在读取资料…")
                : entityEntries.length
                  ? tr("没有匹配的实体")
                  : tr("还没有实体。可在项目资料的实体页新建实体。")}
            </p>
          ) : (
            <div className="ewb-tree">
              {entityGroups.map((group) => (
                <section key={group.directory} className="ewb-tree-group" aria-label={tr("分组 {name}", { name: group.directory })}>
                  <h3 className="ewb-group-heading">
                    <code>{group.directory}</code>
                    <span>{group.entries.length}</span>
                  </h3>
                  <ul>
                    {group.entries.map((item) => {
                      const itemDraft = drafts[item.path];
                      const itemDirty = itemDraft !== undefined && itemDraft !== item.baseline;
                      const base = item.extendsRef ? resolveEntityReference(item.extendsRef, lookup) : undefined;
                      const inheritance = item.extendsRef ? tr("继承自 {source}", { source: base?.title ?? item.extendsRef }) : undefined;
                      return (
                        <li key={item.path}>
                          <button
                            type="button"
                            className="ewb-entity-item"
                            aria-pressed={entity?.path === item.path}
                            title={inheritance ? `${item.path}\n${inheritance}` : item.path}
                            onClick={() => {
                              setSelectedEntityPath(item.path);
                              selectBinding(undefined);
                            }}
                          >
                            <span className="ewb-item-title">{item.title}</span>
                            <span className="ewb-item-meta">
                              {item.id}
                              {inheritance ? " · " + inheritance : ""}
                              {itemDirty && <span className="ewb-badge is-own">{tr("未保存")}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </aside>

        <section className="ewb-canvas" aria-label={tr("实体画布")}>
          {entity && (
            <button
              type="button"
              className="ewb-canvas-add"
              aria-label={tr("添加组件")}
              title={tr("添加组件")}
              onClick={openComponentBrowser}
            >
              <Plus size={18} />
            </button>
          )}
          {entity ? (
            <EntityComponentBoard
              key={componentDrawerOpen ? "drawer-open" : "drawer-closed"}
              entity={entity}
              bindings={bindings}
              storedPositions={layout[entity.id] ?? EMPTY_POSITIONS}
              selectedBindingId={selectedBindingId}
              imageUrl={imageUrl}
              imageMaxHeight={imageSettings.size}
              inheritsFrom={inheritsFrom}
              onSelectBinding={selectBinding}
              onMoveBinding={moveBinding}
              onMeasure={measureNode}
              onConnectAnchor={connectAnchor}
            />
          ) : (
            <p className="ewb-empty">
              {loading ? tr("正在读取资料…") : tr("还没有实体。可在项目资料的实体页新建实体，再回来挂载组件。")}
            </p>
          )}
        </section>

        {componentDrawerOpen && (
          <aside className="ewb-drawer" aria-label={tr("详情")}>
            {selectedBinding ? (
              <ComponentFillPanel
                binding={selectedBinding}
                component={selectedBinding?.component}
                fields={componentFields}
                anchors={selectedAnchors}
                mount={selectedBinding.mount}
                mountParents={mountParents}
                onMountChange={(nextMount) => {
                  if (selectedBinding) updateBindingMount(selectedBinding, nextMount);
                }}
                sourceAnchor={selectedSourceAnchor}
                targetAnchor={selectedTargetAnchor}
                onConnectionChange={(patch) => {
                  if (selectedBinding) setConnection(selectedBinding.id, patch);
                }}
                onAddAnchor={(side, offset) => {
                  if (selectedBinding) addAnchor(selectedBinding.id, side, offset);
                }}
                onRemoveAnchor={(id) => {
                  if (selectedBinding) removeAnchor(selectedBinding.id, id);
                }}
                rangeEnabled={rangeEnabled}
                currentFieldKey={currentField?.key}
                range={rangeEnabled ? { current: rangeCurrent, max: progressMax } : undefined}
                onChange={updateBindingValue}
                onRemove={removeBinding}
                onOverride={overrideBinding}
                onNotesChange={(notes) => {
                  if (selectedBinding) updateBindingNotes(selectedBinding, notes);
                }}
                onClose={() => setComponentDrawerOpen(false)}
                {...(onOpenDetail ? { onOpenDetail } : {})}
              />
            ) : entity ? (
              <EntityDetailsPanel
                entity={entity}
                inheritsFrom={inheritsFrom}
                imageUrl={imageUrl}
                imageMaxHeight={imageSettings.size}
                onClose={() => setComponentDrawerOpen(false)}
                {...(onOpenDetail ? { onOpenDetail } : {})}
              />
            ) : null}
          </aside>
        )}
      </div>

      {componentBrowserOpen && entity && <ComponentBrowserDialog
        title="创建组件"
        pickLabel="创建"
        entries={browserEntries}
        projectPath={projectPath}
        recentPrefix="specloom.entity-workbench.recent-components."
        favoritePrefix="specloom.entity-workbench.favorite-components."
        onPick={(entry) => createBrowserComponent(componentEntries.find((component) => component.path === entry.path))}
        onClose={() => setComponentBrowserOpen(false)}
        disabled={saving}
      />}
    </section>
  );
}
