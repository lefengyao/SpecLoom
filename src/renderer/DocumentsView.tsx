import { ChevronDown, ChevronRight, FileAudio, FileImage, FilePlus2, FileText, FileVideo, Folder, FolderOpen, PanelLeft, PanelRight, RefreshCw, Save, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopApi, ProjectTreeEntry } from "../shared/desktop-api";
import type { FileReadResult } from "../shared/contracts";
import { parseMaterial, readFields, writeMaterial } from "../shared/project-materials";
import { importMissingLegacyGroups, normalizeMaterialGroups, validateMaterialGroupRegistry, type MaterialGroup, type MaterialGroupCategory, type MaterialGroupRegistry } from "../shared/material-groups";
import { NewComponent, NewEntity, NewSpec } from "./AuthoringForms";
import { MaterialDetails } from "./MaterialDetails";
import { MaterialExplorer } from "./MaterialExplorer";
import { MaterialImageEditor } from "./MaterialImage";
import { ProjectMediaPreview, ProjectTextPreview } from "./ProjectMediaPreview";
import { canonicalProjectPreferencePath, isImportFile, readHideImportPreference, writeHideImportPreference } from "./project-file-preferences";
import { categoryForPath, categoryLabels, categoryRoots, materialTree, summarizeMaterial, type DocumentCategory, type MaterialNode } from "./materials-model";
import { IconButton } from "./ui";
import "./materials.css";

export { categoryForPath, type DocumentCategory } from "./materials-model";
export interface MaterialDraft extends FileReadResult { baseline: string }
const treePreferenceKey = "specloom.documents.tree";
function readTreePreference(): boolean {
  try { return window.localStorage.getItem(treePreferenceKey) === "open"; } catch { return false; }
}
function writeTreePreference(open: boolean): void {
  try { window.localStorage.setItem(treePreferenceKey, open ? "open" : "closed"); } catch { /* best effort */ }
}
interface DocumentVersion { path: string; version: string; size: number }
interface TreeNode extends ProjectTreeEntry { name: string; children: TreeNode[] }

type ResourceKind = "image" | "text" | "font" | "audio" | "video";
const resourceLabels: Record<ResourceKind, string> = { image: "图片", text: "文本", font: "字体", audio: "音频", video: "视频" };
const resourceExtensions: Record<ResourceKind, Set<string>> = {
  image: new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif"]),
  text: new Set(["md", "txt", "json", "csv", "yaml", "yml", "xml", "tscn", "gd", "shader", "cfg", "ini", "toml", "css", "js", "ts", "jsx", "tsx", "html"]),
  font: new Set(["ttf", "otf", "woff", "woff2"]),
  audio: new Set(["wav", "ogg", "oga", "opus", "mp3", "flac", "aac", "m4a"]),
  video: new Set(["mp4", "webm", "ogv", "mov", "m4v"]),
};
function resourceKind(path: string): ResourceKind | undefined {
  const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return (Object.keys(resourceExtensions) as ResourceKind[]).find((kind) => resourceExtensions[kind].has(extension));
}

function isGodotProject(projectPath: string, entries: ProjectTreeEntry[]): boolean {
  return entries.some((entry) => entry.path.toLowerCase() === "project.godot") || projectPath.toLowerCase().endsWith(".godot");
}

function isUidPath(path: string): boolean {
  return path.toLowerCase().endsWith(".uid");
}

function ResourceExplorer({ entries, selectedPath, onSelect }: { entries: ProjectTreeEntry[]; selectedPath: string | undefined; onSelect: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ResourceKind | "*">("*");
  const resources = useMemo(() => entries
    .filter((entry): entry is ProjectTreeEntry & { kind: "file" } => entry.kind === "file")
    .map((entry) => ({ ...entry, resourceKind: resourceKind(entry.path) }))
    .filter((entry): entry is typeof entry & { resourceKind: ResourceKind } => Boolean(entry.resourceKind))
    .filter((entry) => kind === "*" || entry.resourceKind === kind)
    .filter((entry) => entry.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => left.path.localeCompare(right.path)), [entries, kind, query]);
  const counts = useMemo(() => (Object.keys(resourceLabels) as ResourceKind[]).map((value) => ({ value, count: entries.filter((entry) => entry.kind === "file" && resourceKind(entry.path) === value).length })), [entries]);
  return <section className="resource-explorer" aria-label="资源管理器">
    <header className="section-heading"><h3>资源管理器</h3><span className="subtle">{resources.length} 项</span></header>
    <div className="resource-toolbar">
      <input aria-label="搜索资源" placeholder="搜索资源路径" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="筛选资源类型" value={kind} onChange={(event) => setKind(event.target.value as ResourceKind | "*")}>
        <option value="*">全部类型</option>
        {(Object.keys(resourceLabels) as ResourceKind[]).map((value) => <option key={value} value={value}>{resourceLabels[value]} ({counts.find((item) => item.value === value)?.count ?? 0})</option>)}
      </select>
    </div>
    <ul className="resource-list" aria-label="项目资源列表">
      {resources.map((entry) => {
        const Icon = entry.resourceKind === "image" ? FileImage : entry.resourceKind === "audio" ? FileAudio : entry.resourceKind === "video" ? FileVideo : entry.resourceKind === "font" ? Type : FileText;
        return <li key={entry.path}><button type="button" title={entry.path} aria-pressed={selectedPath === entry.path} className="resource-row" onClick={() => onSelect(entry.path)}><Icon size={14} /><span>{entry.path}</span><small>{resourceLabels[entry.resourceKind]}</small></button></li>;
      })}
    </ul>
    {!resources.length && <p className="empty-state">暂无匹配资源</p>}
  </section>;
}

function treeFor(entries: ProjectTreeEntry[], documents: DocumentVersion[], category: DocumentCategory): TreeNode[] {
  const known = new Set(documents.map((item) => item.path));
  const listed = new Set(entries.map((item) => item.path));
  let visible = [...entries, ...documents.filter((item) => !listed.has(item.path)).map((item) => ({ path: item.path, kind: "file" as const }))];
  if (category !== "all") {
    const files = new Set(visible.filter((item) => item.kind === "file" && known.has(item.path) && categoryForPath(item.path) === category).map((item) => item.path));
    const directories = new Set<string>();
    for (const path of [...categoryRoots[category], ...files]) {
      const parts = path.split("/");
      for (let index = 1; index <= parts.length; index++) directories.add(parts.slice(0, index).join("/"));
    }
    visible = visible.filter((item) => item.kind === "file" ? files.has(item.path) : directories.has(item.path));
  }
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of visible) {
    const parts = entry.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      if (nodes.has(path)) continue;
      const node: TreeNode = { path, name: parts[index]!, kind: index === parts.length - 1 ? entry.kind : "directory", children: [] };
      nodes.set(path, node);
      const parent = nodes.get(parts.slice(0, index).join("/"));
      if (parent) parent.children.push(node); else roots.push(node);
    }
  }
  const sort = (items: TreeNode[]): void => {
    items.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1);
    items.forEach((item) => sort(item.children));
  };
  sort(roots); return roots;
}

export function DocumentsView({ api, projectPath, onError, busy, revision, category, mode, active = true, drafts: suppliedDrafts, onDraftsChange, reloadRequest, onReloadHandled, openFileRequest, onOpenFileHandled, onSavingChange }: {
  api: DesktopApi; projectPath: string; onError: (value: unknown) => void;
  busy: boolean; revision: number; category: DocumentCategory;
  /** Force the entity detail/source surface when the workbench mode is outside DocumentsView. */
  mode?: "detail" | "source";
  active?: boolean;
  drafts?: MaterialDraft[];
  onDraftsChange?: Dispatch<SetStateAction<MaterialDraft[]>>;
  reloadRequest?: { path: string; sequence: number };
  onReloadHandled?: (sequence: number) => void;
  openFileRequest?: { path: string; sequence: number };
  onOpenFileHandled?: (sequence: number) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [documents, setDocuments] = useState<DocumentVersion[]>([]);
  const [entries, setEntries] = useState<ProjectTreeEntry[]>([]);
  const [loadedProject, setLoadedProject] = useState<string>();
  const [catalogFiles, setCatalogFiles] = useState<FileReadResult[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [file, setFile] = useState<FileReadResult>();
  const [localDrafts, setLocalDrafts] = useState<MaterialDraft[]>([]);
  const drafts = suppliedDrafts ?? localDrafts;
  const setDrafts = useCallback((value: SetStateAction<MaterialDraft[]>) => { setLocalDrafts(value); onDraftsChange?.(value); }, [onDraftsChange]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [projectPreview, setProjectPreview] = useState<string>();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [groupRegistrySaving, setGroupRegistrySaving] = useState(false);
  function setSavePending(value: boolean) { setSaving(value); onSavingChange?.(value); }
  const [createForm, setCreateForm] = useState(false);
  const [initialParent, setInitialParent] = useState<string>();
  const [sourceMode, setSourceMode] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [treeOpen, setTreeOpen] = useState(readTreePreference);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const preferenceProject = canonicalProjectPreferencePath(projectPath);
  const [hideImport, setHideImport] = useState(() => readHideImportPreference(projectPath));
  useEffect(() => { setHideImport(readHideImportPreference(projectPath)); }, [preferenceProject]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["specs", "__relations__", "__unparsed__"]));
  const requestedPath = useRef<string>(undefined);
  const handledOpenFile = useRef<{ projectPath: string; sequence: number }>(undefined);
  const readRequest = useRef(0);
  const refreshRequest = useRef(0);
  const activePage = useRef(active); activePage.current = active;
  const pendingChanges = useRef(new Set<string>());
  const registryMigrationAttempt = useRef("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshing = useRef(false);
  useEffect(() => {
    activePage.current = active;
    return () => { readRequest.current++; refreshRequest.current++; activePage.current = false; clearTimeout(refreshTimer.current); refreshTimer.current = undefined; };
  }, []);
  const catalogReads = useRef(new Map<string, { version: string; read: Promise<FileReadResult> }>());
  const readCatalogDocument = useCallback((document: DocumentVersion) => {
    const cached = catalogReads.current.get(document.path);
    if (cached?.version === document.version) return cached.read;
    const read = api.readDocument(document.path, document.version);
    catalogReads.current.set(document.path, { version: document.version, read });
    // A failed read must remain retryable without dropping a newer in-flight version.
    void read.catch(() => { if (catalogReads.current.get(document.path)?.read === read) catalogReads.current.delete(document.path); });
    return read;
  }, [api]);
  const editorState = useRef<{ file: FileReadResult | undefined; text: string }>({ file: undefined, text: "" });
  useEffect(() => { editorState.current = { file, text }; }, [file, text]);
  const dirty = Boolean(file && (file.version === "absent" || file.content !== text));
  const usesCatalog = category !== "all";
  const refresh = useCallback(async (changedPath?: string) => {
    if (changedPath) catalogReads.current.delete(changedPath);
    const request = ++refreshRequest.current;
    // Keep the complete project tree available for the resource manager even
    // while a semantic document category is selected.
    const [nextDocuments, nextEntries] = await Promise.all([api.documents(), api.projectTree()]);
    if (request !== refreshRequest.current) return;
    const paths = new Set(nextDocuments.map(document => document.path));
    for (const path of catalogReads.current.keys()) if (!paths.has(path)) catalogReads.current.delete(path);
    setDocuments(nextDocuments); setEntries(nextEntries); setLoadedProject(projectPath);
    const path = requestedPath.current;
    const current = editorState.current;
    if (!path || current.file?.version === "absent" || (current.file && current.file.content !== current.text)) return;
    if (["image", "audio", "video"].includes(resourceKind(path) ?? "")) return;
    const updated = nextDocuments.find((item) => item.path === path);
    if (!updated || (current.file?.path === path && current.file.version === updated.version)) return;
    const reading = ++readRequest.current;
    setLoading(true);
    try {
      const result = await api.readDocument(updated.path, updated.version);
      if (reading === readRequest.current && requestedPath.current === path) { setFile(result); setText(result.content); }
    } finally { if (reading === readRequest.current) setLoading(false); }
  }, [api, projectPath]);
  const queueRefresh = useCallback(function schedule() {
    if (!activePage.current || !pendingChanges.current.size || refreshing.current || refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      if (!activePage.current || !pendingChanges.current.size) return;
      pendingChanges.current.clear(); refreshing.current = true;
      void refresh().catch(onError).finally(() => { refreshing.current = false; schedule(); });
    }, 60);
  }, [refresh, onError]);
  useEffect(() => {
    if (activePage.current) void refresh().catch(onError);
    else pendingChanges.current.add("revision");
  }, [refresh, onError, revision]);
  useEffect(() => { if (active) queueRefresh(); }, [active, queueRefresh]);
  useEffect(() => api.onMaterialChanged?.((event) => {
    if (event.projectPath !== projectPath) return;
    catalogReads.current.delete(event.path); pendingChanges.current.add(event.path); queueRefresh();
  }), [api, projectPath, queueRefresh]);
  useEffect(() => {
    if (mode === "source") setSourceMode(true);
    else if (mode === "detail") setSourceMode(false);
  }, [mode]);
  useEffect(() => {
    setExpanded(new Set(["specs", "__relations__", "__unparsed__", ...(category === "all" ? [] : categoryRoots[category])]));
    requestedPath.current = undefined; readRequest.current++;
    setSelectedPath(undefined); setProjectPreview(undefined); setFile(undefined); setText(""); setLoading(false); setCreateForm(false); setSourceMode(modeRef.current === "source");
  }, [category, projectPath]);
  useEffect(() => {
    if (!hideImport || !projectPreview || !isImportFile(projectPreview)) return;
    if (requestedPath.current === projectPreview) { requestedPath.current = undefined; readRequest.current++; }
    setSelectedPath((current) => current === projectPreview ? undefined : current);
    setProjectPreview(undefined); setLoading(false);
  }, [hideImport, projectPreview]);
  useEffect(() => {
    if (!reloadRequest) return;
    const { path, sequence } = reloadRequest;
    catalogReads.current.delete(path);
    const request = ++readRequest.current;
    refreshRequest.current++;
    let cancelled = false;
    setDrafts((current) => current.filter((draft) => draft.path !== path));
    requestedPath.current = path;
    setSelectedPath(path); setProjectPreview(undefined); setFile(undefined); setText(""); setSourceMode(false); setLoading(true);
    void api.documents().then(async (latest) => {
      if (cancelled || request !== readRequest.current) return;
      setDocuments(latest);
      const updated = latest.find((document) => document.path === path);
      if (!updated) throw Object.assign(new Error("文档已不存在，请选择其他资料。"), { code: "FILE_NOT_FOUND", details: { path } });
      const result = await api.readDocument(updated.path, updated.version);
      if (!cancelled && request === readRequest.current && requestedPath.current === path) { setFile(result); setText(result.content); }
    }).catch((error) => { if (!cancelled && request === readRequest.current) onError(error); })
      .finally(() => {
        if (!cancelled && request === readRequest.current) setLoading(false);
        onReloadHandled?.(sequence);
      });
    return () => { cancelled = true; };
  }, [api, onError, reloadRequest, onReloadHandled, setDrafts]);
  useEffect(() => {
    if (!usesCatalog) { setCatalogFiles([]); setCatalogLoading(false); setCatalogError(false); return; }
    let cancelled = false;
    let failed = false;
    setCatalogLoading(true);
    setCatalogError(false);
    const relevant = documents.filter((item) => {
      const kind = categoryForPath(item.path);
      return item.path.toLowerCase() === "specs/project.md" || kind === category || (category === "entity" && kind === "component") || (category === "component" && (kind === "entity" || kind === "map"));
    });
    void Promise.all(relevant.map(async (document) => {
      try { return await readCatalogDocument(document); }
      catch (error) {
        failed = true;
        if (!cancelled) onError(error);
        return { path: document.path, version: document.version, content: "" };
      }
    })).then((files) => { if (!cancelled) { setCatalogFiles(files); setCatalogLoading(false); setCatalogError(failed); } });
    return () => { cancelled = true; };
  }, [readCatalogDocument, category, documents, onError, usesCatalog]);
  useEffect(() => {
    if (!dirty && !drafts.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, drafts.length]);
  const groupRegistry = useMemo(() => {
    const project = catalogFiles.find((item) => item.path.toLowerCase() === "specs/project.md");
    const registry = parseMaterial(project?.content ?? "")?.data.materialGroups;
    const labels: Partial<Record<MaterialGroupCategory, string[]>> = {};
    const legacyFiles = [...catalogFiles, ...drafts, ...(file && selectedPath ? [{ ...file, content: text }] : [])];
    for (const item of legacyFiles) {
      const kind = categoryForPath(item.path);
      const label = parseMaterial(item.content)?.data.group;
      if (kind && typeof label === "string" && label.trim()) labels[kind] = [...(labels[kind] ?? []), label.trim()];
    }
    return importMissingLegacyGroups(registry, labels);
  }, [catalogFiles, drafts, file, selectedPath, text]);
  const savedCatalog = useMemo(() => catalogFiles.map((item) => summarizeMaterial(item, groupRegistry)), [catalogFiles, groupRegistry]);
  const catalog = useMemo(() => {
    const source = new Map(savedCatalog.map((item) => [item.path, item]));
    for (const draft of drafts) source.set(draft.path, summarizeMaterial(draft, groupRegistry));
    if (file && selectedPath) source.set(file.path, summarizeMaterial({ ...file, content: text }, groupRegistry));
    return [...source.values()];
  }, [savedCatalog, drafts, file, selectedPath, text, groupRegistry]);
  const projectCatalogFile = catalogFiles.find((item) => item.path.toLowerCase() === "specs/project.md");
  useEffect(() => {
    if (!usesCatalog || catalogLoading || catalogError || groupRegistrySaving || busy || saving || !projectCatalogFile) return;
    if (selectedPath?.toLowerCase() === "specs/project.md" && dirty) return;
    const rawRegistry = parseMaterial(projectCatalogFile.content)?.data.materialGroups;
    if (validateMaterialGroupRegistry(rawRegistry).length) return;
    if (JSON.stringify(normalizeMaterialGroups(rawRegistry)) === JSON.stringify(groupRegistry)) return;
    const attempt = `${projectCatalogFile.version}:${JSON.stringify(groupRegistry)}`;
    if (registryMigrationAttempt.current === attempt) return;
    registryMigrationAttempt.current = attempt;
    void saveMaterialGroupRegistry(groupRegistry).catch(onError);
  }, [usesCatalog, catalogLoading, catalogError, groupRegistrySaving, busy, saving, projectCatalogFile, selectedPath, dirty, groupRegistry, onError]);
  const visibleMaterials = catalog.filter((item) => categoryForPath(item.path) === category);
  const semantic = usesCatalog ? materialTree(visibleMaterials) : [];
  const draftPaths = new Set(drafts.map((item) => item.path));
  const documentVersions = [...documents.filter((item) => !draftPaths.has(item.path)), ...drafts.map((item) => ({ path: item.path, version: item.version, size: item.content.length }))];
  const godotProject = isGodotProject(projectPath, entries);
  const visibleEntries = entries.filter((entry) => entry.kind !== "file" || ((!godotProject || !isUidPath(entry.path)) && (!hideImport || !isImportFile(entry.path))));
  const visibleDocuments = documentVersions.filter((item) => (!godotProject || !isUidPath(item.path)) && (!hideImport || !isImportFile(item.path)));
  const tree = treeFor(visibleEntries, visibleDocuments, category);
  const material = parseMaterial(text);
  const structured = material && usesCatalog && typeof material.data.id === "string";
  const selectedMeta = catalog.find((item) => item.path === selectedPath);
  const selectable = catalog.filter((item) => item.version !== "absent" || item.path === file?.path);
  const toggleTree = () => setTreeOpen((open) => { writeTreePreference(!open); return !open; });
  const toggleNode = (key: string) => setExpanded((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const updateText = (content: string) => {
    setText(content);
    if (file) setDrafts((current) => [...current.filter((item) => item.path !== file.path), ...(file.version !== "absent" && content === file.content ? [] : [{ ...file, content, baseline: file.content }])]);
  };
  async function selectFile(path: string) {
    if (path === selectedPath && requestedPath.current === path) return;
    const request = ++readRequest.current;
    requestedPath.current = path; setSelectedPath(path); setProjectPreview(undefined); setFile(undefined); setText(""); setSourceMode(false);
    const draft = drafts.find((item) => item.path === path);
    if (draft) { setFile({ path: draft.path, version: draft.version, content: draft.baseline }); setText(draft.content); setLoading(false); return; }
    const kind = resourceKind(path);
    const document = documents.find((item) => item.path === path);
    if (kind === "image" || kind === "audio" || kind === "video" || !document) { setProjectPreview(path); setLoading(false); return; }
    setLoading(true);
    try {
      const result = await api.readDocument(document.path, document.version);
      if (request === readRequest.current) { setFile(result); setText(result.content); }
    } catch (error) { if (request === readRequest.current) onError(error); }
    finally { if (request === readRequest.current) setLoading(false); }
  }
  useEffect(() => {
    if (!active || !openFileRequest || loadedProject !== projectPath) return;
    if (handledOpenFile.current?.projectPath === projectPath && handledOpenFile.current.sequence === openFileRequest.sequence) return;
    handledOpenFile.current = { projectPath, sequence: openFileRequest.sequence };
    void selectFile(openFileRequest.path);
    onOpenFileHandled?.(openFileRequest.sequence);
  }, [active, openFileRequest, onOpenFileHandled, loadedProject, projectPath]);
  async function recordSaved(saved: FileReadResult) {
    const request = ++refreshRequest.current;
    let latest: DocumentVersion[] | undefined;
    try { latest = await api.documents(); } catch (error) { onError(error); }
    if (request !== refreshRequest.current) return;
    setDocuments((current) => [...(latest ?? current).filter((item) => item.path !== saved.path), { path: saved.path, version: saved.version, size: saved.content.length }]);
    catalogReads.current.set(saved.path, { version: saved.version, read: Promise.resolve(saved) });
    setCatalogFiles((current) => [...current.filter((item) => item.path !== saved.path), saved]);
  }
  async function saveMaterialGroupRegistry(registry: MaterialGroupRegistry): Promise<void> {
    if (groupRegistrySaving) throw new Error("正在保存分组登记表，请稍后再试。");
    setGroupRegistrySaving(true);
    try {
      const latest = await api.documents();
      const project = latest.find((item) => item.path.toLowerCase() === "specs/project.md");
      if (!project) throw new Error("项目概览文件 specs/project.md 不存在，无法保存分组。");
      const current = await api.readDocument(project.path, project.version);
      const parsed = parseMaterial(current.content);
      if (!parsed) throw new Error("项目概览文件 front matter 无法解析，分组没有保存。");
      const content = writeMaterial({ ...parsed.data, materialGroups: registry }, parsed.body);
      const saved = await api.saveDocument(projectPath, project.path, content, current.version);
      await recordSaved(saved);
    } finally { setGroupRegistrySaving(false); }
  }
  async function saveMaterialGroupsForCategory(category: Exclude<DocumentCategory, "all">, groups: MaterialGroup[]): Promise<void> {
    const next = { ...groupRegistry, [category]: groups };
    const errors = validateMaterialGroupRegistry(next);
    if (errors.length) throw new Error(`分组结构无效：${errors[0]}`);
    await saveMaterialGroupRegistry(next);
  }
  async function createDocument(path: string, content: string): Promise<boolean> {
    if (saving || busy) return false;
    const request = ++readRequest.current;
    refreshRequest.current++;
    setSavePending(true);
    try {
      const saved = await api.saveDocument(projectPath, path, content, "absent");
      await recordSaved(saved);
      if (request === readRequest.current) {
        requestedPath.current = path;
        setFile(saved); setText(saved.content); setSelectedPath(path); setProjectPreview(undefined); setSourceMode(false); setLoading(false);
      }
      return true;
    } catch (error) { onError(error); return false; }
    finally { setSavePending(false); }
  }
  async function saveDocument() {
    if (!file || busy || saving || loading || (usesCatalog && catalogLoading) || (structured && !sourceMode && catalogError) || !dirty) return;
    setSavePending(true);
    refreshRequest.current++;
    try {
      const saved = await api.saveDocument(projectPath, file.path, text, file.version);
      await recordSaved(saved);
      if (requestedPath.current === file.path) setFile(saved);
      setDrafts((current) => current.flatMap((item) => item.path !== saved.path ? [item] : item.content === saved.content ? [] : [{ ...item, version: saved.version, baseline: saved.content }]));
    } catch (error) { onError(error); }
    finally { setSavePending(false); }
  }
  function beginCreation(parent?: string) { setInitialParent(parent); setCreateForm(true); }
  const renderPhysicalNodes = (nodes: TreeNode[], depth = 0) => nodes.map((node) => {
    const folder = node.kind === "directory"; const open = expanded.has(node.path);
    return <li key={node.path} role="treeitem" aria-expanded={folder ? open : undefined}>
      <button className={`tree-row ${selectedPath === node.path ? "selected" : ""}`} style={{ paddingLeft: 8 + depth * 16 }} title={node.path} onClick={() => folder ? toggleNode(node.path) : void selectFile(node.path)}>
        {folder ? <>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={15} /> : <Folder size={15} />}</> : <><span className="tree-spacer" /><FileText size={15} /></>}<span>{node.name}</span>
      </button>
      {folder && open && Boolean(node.children.length) && <ul role="group">{renderPhysicalNodes(node.children, depth + 1)}</ul>}
    </li>;
  });
  const renderMaterialNodes = (nodes: MaterialNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const open = expanded.has(node.key); const branch = node.children.length > 0;
    return <li key={node.key} role="treeitem" aria-expanded={branch ? open : undefined} aria-selected={node.material ? selectedPath === node.material.path : undefined}>
      <div className={`material-tree-row ${node.material && selectedPath === node.material.path ? "selected" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {branch ? <button className="tree-disclosure" aria-label={`${open ? "收起" : "展开"} ${node.label}`} onClick={() => toggleNode(node.key)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-spacer" />}
        <button className="tree-row" title={node.material?.path ?? node.label} onClick={() => node.material ? void selectFile(node.material.path) : toggleNode(node.key)}>{node.material ? <FileText size={15} /> : <Folder size={15} />}<span>{node.label}</span></button>
      </div>
      {branch && open && <ul role="group">{renderMaterialNodes(node.children, depth + 1)}</ul>}
    </li>;
  });
  const creationLabel = category === "all" ? "" : `新建${categoryLabels[category]}`;
  const editorTitle = structured ? selectedMeta?.title ?? file?.path ?? categoryLabels[category] : file?.path ?? selectedPath ?? categoryLabels[category];
  const treeTitle = category === "entity" || category === "setting" ? `${categoryLabels[category]}关系树` : category === "component" ? "组件库" : "项目树";
  const detailContent = (
    <>
      {catalogError && usesCatalog && <p role="alert" className="field-hint">部分资料读取失败，详情编辑暂不可用。可切换源码编辑或刷新项目树重试。</p>}
      {projectPreview ? ["image", "audio", "video"].includes(resourceKind(projectPreview) ?? "") ? <ProjectMediaPreview api={api} projectPath={projectPath} path={projectPreview} active={active} /> : <ProjectTextPreview api={api} projectPath={projectPath} path={projectPreview} active={active} /> : file ? structured && !sourceMode ? <form id="material-edit-form" onSubmit={(event) => { event.preventDefault(); void saveDocument(); }}>
        <MaterialImageEditor key={`image:${file.path}`} api={api} projectPath={projectPath} title={selectedMeta?.title ?? "资料"} path={typeof material.data.image === "string" ? material.data.image : undefined} disabled={busy || saving || loading} onError={onError} onChange={(image) => {
          const data = { ...material.data };
          if (image) data.image = image; else delete data.image;
          updateText(writeMaterial(data, material.body));
        }} />
        <MaterialDetails key={file.path} material={material} catalog={selectable} groups={groupRegistry[category] ?? []} originalFields={readFields(parseMaterial(file.content)?.data ?? {}).map((field) => field.key)} disabled={busy || saving || loading || (usesCatalog && (catalogLoading || catalogError || groupRegistrySaving))} onChange={(data, body = material.body) => updateText(writeMaterial(data, body))} />
      </form> : <textarea aria-label="文档内容" className="markdown-editor" spellCheck={false} value={text} onChange={(event) => updateText(event.target.value)} disabled={busy || loading || saving} />
      : <div className="empty-state">{loading ? "读取中…" : selectedPath ? <><FileText size={24} /><span className="subtle">该文件不在可编辑的项目资料目录中</span></> : <span>{category === "component" ? "创建可复用组件，或选择组件编辑字段" : "选择资料或新建资料"}</span>}</div>}
    </>
  );

  return <div className={`documents-layout ${treeOpen ? "is-tree-open" : "is-tree-closed"}`}>
    <aside id="document-tree" className="document-sidebar" inert={!treeOpen}>
      <header className="section-heading"><h2>{treeTitle}</h2><div className="toolbar"><IconButton label="刷新项目树" onClick={() => { void refresh().catch(onError); }}><RefreshCw size={16} /></IconButton></div></header>
      {category === "all" && <label className="project-file-filter"><input type="checkbox" checked={hideImport} onChange={(event) => { setHideImport(event.target.checked); writeHideImportPreference(projectPath, event.target.checked); }} />隐藏 .import 文件</label>}
      <ul className="project-tree" role="tree" aria-label={treeTitle}>{usesCatalog && (visibleMaterials.length || !catalogLoading) && semantic.length ? renderMaterialNodes(semantic) : renderPhysicalNodes(tree)}</ul>
      {catalogLoading && <p className="subtle">读取资料…</p>}
      {!catalogLoading && !(usesCatalog ? semantic.length : tree.length) && <p className="empty-state">暂无{categoryLabels[category]}</p>}
      <ResourceExplorer entries={visibleEntries} selectedPath={selectedPath} onSelect={(path) => { void selectFile(path); }} />
    </aside>
    <section className={"document-editor" + (usesCatalog ? " has-explorer" : "") + (usesCatalog && !explorerOpen ? " is-explorer-closed" : "")}>
      <header className="section-heading">
        <div><h2>{editorTitle}</h2>{file && <code className="version-text" title={file.path}>{dirty ? "有未保存修改" : "已保存"} · {file.path}</code>}</div>
        <div className="toolbar">
          <button className="tree-toggle" aria-controls="document-tree" aria-expanded={treeOpen} onClick={toggleTree}><PanelRight size={16} />项目树</button>
          {usesCatalog && <button className="tree-toggle" aria-controls="material-explorer" aria-expanded={explorerOpen} onClick={() => setExplorerOpen((open) => !open)}><PanelLeft size={16} />{explorerOpen ? "收起资料" : "资料列表"}</button>}
          {category !== "all" && <button disabled={busy || saving} onClick={() => beginCreation()}><FilePlus2 size={16} />{creationLabel}</button>}
          {file && category === "entity" && file.version !== "absent" && selectedMeta && <button disabled={busy || saving} onClick={() => beginCreation(selectedMeta.id)}><FilePlus2 size={16} />新建子实体</button>}
          {structured && <button onClick={() => setSourceMode((value) => !value)}>{sourceMode ? "详情编辑" : "源码编辑"}</button>}
          {file && <button className="primary" type={structured && !sourceMode ? "submit" : "button"} form={structured && !sourceMode ? "material-edit-form" : undefined} disabled={busy || saving || loading || (usesCatalog && catalogLoading) || (structured && !sourceMode && catalogError) || !dirty} onClick={structured && !sourceMode ? undefined : () => { void saveDocument(); }}><Save size={16} />{saving ? "保存中…" : "保存资料"}</button>}
        </div>
      </header>
      {usesCatalog ? (
        <div className="document-workspace">
          <div id="material-explorer" className="document-explorer-pane" hidden={!explorerOpen} inert={!explorerOpen}>
            {usesCatalog && <MaterialExplorer key={category} api={api} projectPath={projectPath} category={category} materials={visibleMaterials} groups={groupRegistry[category] ?? []} groupsSaving={groupRegistrySaving} onGroupsChange={(groups) => saveMaterialGroupsForCategory(category, groups)} selectedPath={selectedPath} loading={catalogLoading} onSelect={(path) => { void selectFile(path); }} />}
          </div>
          <div className="document-detail-pane">{detailContent}</div>
        </div>
      ) : detailContent}
    </section>
    {createForm && category === "entity" && <NewEntity busy={busy || saving} onClose={() => setCreateForm(false)} onSave={createDocument} {...(initialParent ? { initialParent } : {})} />}
    {createForm && category === "component" && <NewComponent busy={busy || saving} onClose={() => setCreateForm(false)} onSave={createDocument} />}
    {createForm && category === "map" && <NewEntity kind="map" busy={busy || saving} onClose={() => setCreateForm(false)} onSave={createDocument} />}
    {createForm && (category === "setting" || category === "ui" || category === "spec") && <NewSpec kind={category} busy={busy || saving} onClose={() => setCreateForm(false)} onSave={createDocument} />}
  </div>;
}