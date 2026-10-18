import { ChevronDown, ChevronRight, Folder, FolderOpen, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { groupIncludes, materialGroupPath, validateMaterialGroups, type MaterialGroup } from "../shared/material-groups";
import type { MaterialSummary } from "./materials-model";

export type MaterialGroupSelection = { kind: "all" } | { kind: "ungrouped" } | { kind: "group"; id: string };

export function MaterialGroupTree({ groups, materials, selection, onSelect, groupsSaving, onGroupsChange }: {
  groups: MaterialGroup[];
  materials: MaterialSummary[];
  selection: MaterialGroupSelection;
  onSelect: (selection: MaterialGroupSelection) => void;
  groupsSaving: boolean;
  onGroupsChange: (groups: MaterialGroup[]) => Promise<void>;
}) {
  const children = useMemo(() => {
    const result = new Map<string, MaterialGroup[]>();
    for (const group of groups) {
      const parent = group.parentId ?? "";
      result.set(parent, [...(result.get(parent) ?? []), group]);
    }
    for (const siblings of result.values()) siblings.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    return result;
  }, [groups]);
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
    if (errors.length) { setSaveError(errors[0] === "GROUP_DUPLICATE_SIBLING" ? "同一上级分组下不能有同名分组。" : "分组结构无效，请检查名称和上级分组。 "); return false; }
    try { await onGroupsChange(next); return true; }
    catch (error) { setSaveError(error instanceof Error ? error.message : "分组保存失败，请重试。"); return false; }
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
      if (!target || (moveParent && groupIncludes(groups, target.id, moveParent))) { setSaveError("不能把分组移动到自身或后代分组下面。"); return; }
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
  const renderGroups = (items: MaterialGroup[], level: number) => items.map((group) => {
    const nested = children.get(group.id) ?? [];
    const isExpanded = expanded.has(group.id);
    return <li role="none" key={group.id} className="material-group-node">
      <div className="material-group-row">
        {nested.length ? <button type="button" className="material-group-disclosure" aria-label={`${isExpanded ? "收起" : "展开"} ${group.name}`} onClick={() => setExpanded((current) => {
          const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next;
        })}>{isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="material-group-disclosure-placeholder" />}
        <button type="button" role="treeitem" data-group-id={group.id} aria-level={level} aria-selected={selected({ kind: "group", id: group.id })} aria-pressed={selected({ kind: "group", id: group.id })} className="material-group-choice" onClick={() => onSelect({ kind: "group", id: group.id })} title={group.name}>
          {nested.length && isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{group.name}</span><small>{groupCount(group.id)}</small>
        </button>
        <button type="button" className="material-group-more" aria-label={`管理 ${group.name}`} aria-expanded={menuGroup === group.id} disabled={groupsSaving} onClick={() => setMenuGroup((current) => current === group.id ? undefined : group.id)}><MoreHorizontal size={15} /></button>
      </div>
      {menuGroup === group.id && <div className="material-group-actions" role="group" aria-label={`${group.name}分组操作`}>
        <button type="button" onClick={() => beginDialog({ mode: "create", parentId: group.id })}><Plus size={13} />新建子分组</button>
        <button type="button" onClick={() => beginDialog({ mode: "rename", groupId: group.id })}>重命名</button>
        <button type="button" onClick={() => beginDialog({ mode: "move", groupId: group.id })}>移动</button>
        <button type="button" disabled={groupsSaving || groupCount(group.id) > 0 || groupChildCount(group.id) > 0} onClick={() => void deleteGroup(group)}>删除</button>
        {(groupCount(group.id) > 0 || groupChildCount(group.id) > 0) && <small className="material-group-delete-hint">需先移动资料并删除子分组，才能删除此组。</small>}
      </div>}
      {nested.length > 0 && isExpanded && <ul role="group">{renderGroups(nested, level + 1)}</ul>}
    </li>;
  });
  return <aside className="material-group-sidebar" aria-label="资料分组">
    <div className="material-group-heading"><h3>分组</h3><button type="button" className="material-group-add" disabled={groupsSaving} onClick={() => beginDialog({ mode: "create" })}><Plus size={13} />新建分组</button></div>
    <ul role="tree" aria-label="分组列表" className="material-group-tree">
      <li role="none"><button type="button" role="treeitem" aria-level={1} aria-selected={selected({ kind: "all" })} aria-pressed={selected({ kind: "all" })} className="material-group-choice" onClick={() => onSelect({ kind: "all" })}><Folder size={14} /><span>全部资料</span><small>{itemCount}</small></button></li>
      <li role="none"><button type="button" role="treeitem" aria-level={1} aria-selected={selected({ kind: "ungrouped" })} aria-pressed={selected({ kind: "ungrouped" })} className="material-group-choice" onClick={() => onSelect({ kind: "ungrouped" })}><Folder size={14} /><span>未分组</span><small>{ungroupedCount}</small></button></li>
      {renderGroups(children.get("") ?? [], 1)}
    </ul>
    {dialog && <div className="modal-backdrop material-group-dialog-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="material-group-dialog-title" aria-label={dialog.mode === "create" ? dialog.parentId ? "新建子分组" : "新建分组" : dialog.mode === "rename" ? "重命名分组" : "移动分组"} className="material-group-dialog" onSubmit={(event) => void submitDialog(event)}>
      <h3 id="material-group-dialog-title">{dialog.mode === "create" ? dialog.parentId ? "新建子分组" : "新建分组" : dialog.mode === "rename" ? "重命名分组" : "移动分组"}</h3>
      {dialog.mode === "move" ? <label>移动到上级分组<select aria-label="移动到上级分组" value={moveParent} onChange={(event) => setMoveParent(event.target.value)}><option value="">最外层</option>{groups.filter((item) => item.id !== dialog.groupId && !groupIncludes(groups, dialog.groupId!, item.id)).map((item) => <option key={item.id} value={item.id}>{materialGroupPath(groups, item.id)}</option>)}</select></label>
        : <label>分组名称<input autoFocus required maxLength={100} aria-label="分组名称" value={name} onChange={(event) => setName(event.target.value)} /></label>}
      {saveError && <p role="alert" className="field-hint">{saveError}</p>}
      <div className="toolbar"><button type="button" disabled={groupsSaving} onClick={() => { setDialog(undefined); setSaveError(""); }}>取消</button><button type="submit" className="primary" disabled={groupsSaving || (dialog.mode !== "move" && !name.trim())}>{groupsSaving ? "保存中…" : dialog.mode === "create" ? "创建分组" : dialog.mode === "rename" ? "保存分组" : "移动分组"}</button></div>
    </form></div>}
  </aside>;
}
