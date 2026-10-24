import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { groupIncludes, materialGroupPath, validateMaterialGroups, type MaterialGroup } from "../shared/material-groups";
import { useI18n } from "./i18n";
import type { MaterialSummary } from "./materials-model";

export type MaterialGroupSelection = { kind: "all" } | { kind: "ungrouped" } | { kind: "group"; id: string };

export function MaterialGroupTree({ groups, materials, selection, onSelect, selectedPath, onSelectMaterial, groupsSaving, onGroupsChange }: {
  groups: MaterialGroup[];
  materials: MaterialSummary[];
  selection: MaterialGroupSelection;
  onSelect: (selection: MaterialGroupSelection) => void;
  selectedPath?: string | undefined;
  onSelectMaterial?: ((path: string) => void) | undefined;
  groupsSaving: boolean;
  onGroupsChange: (groups: MaterialGroup[]) => Promise<void>;
}) {
  const tr = useI18n();
  const children = useMemo(() => {
    const result = new Map<string, MaterialGroup[]>();
    for (const group of groups) {
      const parent = group.parentId ?? "";
      result.set(parent, [...(result.get(parent) ?? []), group]);
    }
    for (const siblings of result.values()) siblings.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    return result;
  }, [groups]);
  /** Materials live inside their own group; a parent group's count still includes descendants. */
  const materialsOf = useMemo(() => {
    const result = new Map<string, MaterialSummary[]>();
    for (const item of materials) {
      const key = item.groupId ?? "";
      result.set(key, [...(result.get(key) ?? []), item]);
    }
    for (const siblings of result.values()) siblings.sort((left, right) => left.title.localeCompare(right.title));
    return result;
  }, [materials]);
  const ungroupedKey = "__ungrouped__";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menuGroup, setMenuGroup] = useState<string>();
  const [dialog, setDialog] = useState<{ mode: "create" | "rename" | "move"; parentId?: string; groupId?: string }>();
  const [name, setName] = useState("");
  const [moveParent, setMoveParent] = useState("");
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const group of groups) if ((children.get(group.id)?.length ?? 0) > 0) next.add(group.id);
      return next;
    });
  }, [groups, children]);
  const groupCount = (id: string) => materials.filter((item) => item.groupId && groupIncludes(groups, id, item.groupId)).length;
  const itemCount = materials.length;
  const ungroupedCount = materials.filter((item) => !item.groupId).length;
  const groupChildCount = (id: string) => children.get(id)?.length ?? 0;
  const selected = (candidate: MaterialGroupSelection) => candidate.kind === selection.kind
    && (candidate.kind !== "group" || (selection.kind === "group" && selection.id === candidate.id));
  const beginDialog = (next: NonNullable<typeof dialog>) => {
    setSaveError(""); setDialog(next);
    const target = next.groupId ? groups.find((group) => group.id === next.groupId) : undefined;
    setName(next.mode === "rename" ? target?.name ?? "" : "");
    setMoveParent(next.mode === "move" ? target?.parentId ?? "" : "");
    setMenuGroup(undefined);
  };
  const saveGroups = async (next: MaterialGroup[]) => {
    const errors = validateMaterialGroups(next);
    if (errors.length) { setSaveError(errors[0] === "GROUP_DUPLICATE_SIBLING" ? tr("同一上级分组下不能有同名分组。") : tr("分组结构无效，请检查名称和上级分组。 ")); return false; }
    try { await onGroupsChange(next); return true; }
    catch (error) { setSaveError(error instanceof Error ? error.message : tr("分组保存失败，请重试。")); return false; }
  };
  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || groupsSaving) return;
    let next: MaterialGroup[];
    if (dialog.mode === "create") {
      const siblings = groups.filter((group) => (group.parentId ?? "") === (dialog.parentId ?? ""));
      const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      next = [...groups, { id: `group_${uuid.replaceAll("-", "")}`, name: name.trim(), ...(dialog.parentId ? { parentId: dialog.parentId } : {}), order: siblings.reduce((maximum, group) => Math.max(maximum, group.order), -1) + 1 }];
    } else if (dialog.mode === "rename") {
      next = groups.map((group) => group.id === dialog.groupId ? { ...group, name: name.trim() } : group);
    } else {
      const target = groups.find((group) => group.id === dialog.groupId);
      if (!target || (moveParent && groupIncludes(groups, target.id, moveParent))) { setSaveError(tr("不能把分组移动到自身或后代分组下面。")); return; }
      const siblings = groups.filter((group) => (group.parentId ?? "") === moveParent && group.id !== target.id);
      next = groups.map((group) => {
        if (group.id !== target.id) return group;
        const moved = { ...group, order: siblings.reduce((maximum, sibling) => Math.max(maximum, sibling.order), -1) + 1 };
        if (moveParent) moved.parentId = moveParent;
        else delete moved.parentId;
        return moved;
      });
    }
    if (await saveGroups(next)) setDialog(undefined);
  };
  const deleteGroup = async (group: MaterialGroup) => {
    if (groupsSaving || groupCount(group.id) > 0 || groupChildCount(group.id) > 0) return;
    if (await saveGroups(groups.filter((item) => item.id !== group.id))) {
      setMenuGroup(undefined);
      if (selection.kind === "group" && selection.id === group.id) onSelect({ kind: "all" });
    }
  };
  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const renderMaterials = (items: MaterialSummary[], level: number) => items.length ? <ul role="group" className="material-group-materials">{items.map((item) => <li role="none" key={item.path}>
    <button type="button" role="treeitem" aria-level={level} aria-selected={selectedPath === item.path} aria-pressed={selectedPath === item.path} className="material-group-material-choice" title={item.path} onClick={() => onSelectMaterial?.(item.path)}>
      <FileText size={13} aria-hidden="true" /><span>{item.title}</span>
    </button>
  </li>)}</ul> : null;
  const renderGroups = (items: MaterialGroup[], level: number) => items.map((group) => {
    const nested = children.get(group.id) ?? [];
    const ownMaterials = materialsOf.get(group.id) ?? [];
    const branch = nested.length > 0 || ownMaterials.length > 0;
    const isExpanded = expanded.has(group.id);
    return <li role="none" key={group.id} className="material-group-node">
      <div className="material-group-row">
        {branch ? <button type="button" className="material-group-disclosure" aria-label={`${isExpanded ? tr("收起") : tr("展开")} ${group.name}`} aria-expanded={isExpanded} onClick={() => toggleExpanded(group.id)}>{isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="material-group-disclosure-placeholder" />}
        <button type="button" role="treeitem" data-group-id={group.id} aria-level={level} aria-selected={selected({ kind: "group", id: group.id })} aria-pressed={selected({ kind: "group", id: group.id })} className="material-group-choice" onClick={() => onSelect({ kind: "group", id: group.id })} title={group.name}>
          {branch && isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{group.name}</span><small>{groupCount(group.id)}</small>
        </button>
        <button type="button" className="material-group-more" aria-label={tr("管理 {name}", { name: group.name })} aria-expanded={menuGroup === group.id} disabled={groupsSaving} onClick={() => setMenuGroup((current) => current === group.id ? undefined : group.id)}><MoreHorizontal size={15} /></button>
      </div>
      {menuGroup === group.id && <div className="material-group-actions" role="group" aria-label={tr("{name}分组操作", { name: group.name })}>
        <button type="button" onClick={() => beginDialog({ mode: "create", parentId: group.id })}><Plus size={13} />{tr("新建子分组")}</button>
        <button type="button" onClick={() => beginDialog({ mode: "rename", groupId: group.id })}>{tr("重命名")}</button>
        <button type="button" onClick={() => beginDialog({ mode: "move", groupId: group.id })}>{tr("移动")}</button>
        <button type="button" disabled={groupsSaving || groupCount(group.id) > 0 || groupChildCount(group.id) > 0} onClick={() => void deleteGroup(group)}>{tr("删除")}</button>
        {(groupCount(group.id) > 0 || groupChildCount(group.id) > 0) && <small className="material-group-delete-hint">{tr("需先移动资料并删除子分组，才能删除此组。")}</small>}
      </div>}
      {branch && isExpanded && <ul role="group">
        {nested.length > 0 && renderGroups(nested, level + 1)}
        {ownMaterials.length > 0 && renderMaterials(ownMaterials, level + 1)}
      </ul>}
    </li>;
  });
  return <aside className="material-group-sidebar" aria-label={tr("资料分组")}>
    <div className="material-group-heading"><h3>{tr("分组")}</h3><button type="button" className="material-group-add" disabled={groupsSaving} onClick={() => beginDialog({ mode: "create" })}><Plus size={13} />{tr("新建分组")}</button></div>
    <ul role="tree" aria-label={tr("分组列表")} className="material-group-tree">
      <li role="none"><button type="button" role="treeitem" aria-level={1} aria-selected={selected({ kind: "all" })} aria-pressed={selected({ kind: "all" })} className="material-group-choice" onClick={() => onSelect({ kind: "all" })}><Folder size={14} /><span>{tr("全部资料")}</span><small>{itemCount}</small></button></li>
      <li role="none">
        <div className="material-group-row">
          {ungroupedCount > 0 ? <button type="button" className="material-group-disclosure" aria-label={`${expanded.has(ungroupedKey) ? tr("收起") : tr("展开")} ${tr("未分组")}`} aria-expanded={expanded.has(ungroupedKey)} onClick={() => toggleExpanded(ungroupedKey)}>{expanded.has(ungroupedKey) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="material-group-disclosure-placeholder" />}
          <button type="button" role="treeitem" aria-level={1} aria-selected={selected({ kind: "ungrouped" })} aria-pressed={selected({ kind: "ungrouped" })} className="material-group-choice" onClick={() => onSelect({ kind: "ungrouped" })}>{ungroupedCount > 0 && expanded.has(ungroupedKey) ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{tr("未分组")}</span><small>{ungroupedCount}</small></button>
        </div>
        {ungroupedCount > 0 && expanded.has(ungroupedKey) && renderMaterials(materialsOf.get("") ?? [], 2)}
      </li>
      {renderGroups(children.get("") ?? [], 1)}
    </ul>
    {dialog && <div className="modal-backdrop material-group-dialog-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="material-group-dialog-title" aria-label={dialog.mode === "create" ? dialog.parentId ? tr("新建子分组") : tr("新建分组") : dialog.mode === "rename" ? tr("重命名分组") : tr("移动分组")} className="material-group-dialog" onSubmit={(event) => void submitDialog(event)}>
      <h3 id="material-group-dialog-title">{dialog.mode === "create" ? dialog.parentId ? tr("新建子分组") : tr("新建分组") : dialog.mode === "rename" ? tr("重命名分组") : tr("移动分组")}</h3>
      {dialog.mode === "move" ? <label>{tr("移动到上级分组")}<select aria-label={tr("移动到上级分组")} value={moveParent} onChange={(event) => setMoveParent(event.target.value)}><option value="">{tr("最外层")}</option>{groups.filter((item) => item.id !== dialog.groupId && !groupIncludes(groups, dialog.groupId!, item.id)).map((item) => <option key={item.id} value={item.id}>{materialGroupPath(groups, item.id)}</option>)}</select></label>
        : <label>{tr("分组名称")}<input autoFocus required maxLength={100} aria-label={tr("分组名称")} value={name} onChange={(event) => setName(event.target.value)} /></label>}
      {saveError && <p role="alert" className="field-hint">{saveError}</p>}
      <div className="toolbar"><button type="button" disabled={groupsSaving} onClick={() => { setDialog(undefined); setSaveError(""); }}>{tr("取消")}</button><button type="submit" className="primary" disabled={groupsSaving || (dialog.mode !== "move" && !name.trim())}>{groupsSaving ? tr("保存中…") : dialog.mode === "create" ? tr("创建分组") : dialog.mode === "rename" ? tr("保存分组") : tr("移动分组")}</button></div>
    </form></div>}
  </aside>;
}
