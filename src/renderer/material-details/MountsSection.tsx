import { Plus, Trash2 } from "lucide-react";
import { categoryForPath, type MaterialSummary } from "../materials-model";
import { useI18n } from "../i18n";

/** Mounts of a system: instances of components such as decision trees, keyed per instance. */
export function MountsSection({ data, catalog, patch, disabled }: {
  data: Record<string, unknown>;
  catalog: MaterialSummary[];
  patch: (value: Record<string, unknown>) => void;
  disabled: boolean;
}) {
  const tr = useI18n();
  const decisionTrees = catalog.filter((item) => !item.invalid && categoryForPath(item.path) === "decision_tree");
  const mounts = Array.isArray(data.mounts)
    ? data.mounts.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const updateMount = (index: number, change: Record<string, unknown>) =>
    patch({ mounts: mounts.map((mount, position) => position === index ? { ...mount, ...change } : mount) });

  return <section className="material-section" aria-label={tr("系统挂载")}>
    <header><h3>{tr("挂载实例")}</h3><span className="subtle">{tr("把决策树等组件实例挂到系统上；同一组件可挂多个，用 key 区分。")}</span>
      <button type="button" disabled={disabled || !decisionTrees.length} onClick={() => {
        const used = new Set(mounts.map((mount) => String(mount.key ?? "")));
        let index = mounts.length + 1;
        let key = `tree_${index}`;
        while (used.has(key)) { index++; key = `tree_${index}`; }
        patch({ mounts: [...mounts, { id: "decision_tree", key, values: { tree: decisionTrees[0]?.id ?? "" } }] });
      }}><Plus size={16} />{tr("挂载决策树")}</button>
    </header>
    {mounts.length ? <ul className="material-mount-list">{mounts.map((mount, index) => <li key={index}>
      <label>{tr("实例 key")}<input aria-label={tr("挂载 key {index}", { index: index + 1 })} maxLength={64} value={String(mount.key ?? "")} disabled={disabled} onChange={(event) => updateMount(index, { key: event.target.value })} /></label>
      <label>{tr("决策树")}<select aria-label={tr("挂载决策树 {index}", { index: index + 1 })} value={String((mount.values as Record<string, unknown> | undefined)?.tree ?? "")} disabled={disabled} onChange={(event) => updateMount(index, { values: { ...((mount.values as Record<string, unknown> | undefined) ?? {}), tree: event.target.value } })}>
        <option value="">{tr("选择决策树")}</option>
        {decisionTrees.map((tree) => <option key={tree.id} value={tree.id}>{tree.title}</option>)}
      </select></label>
      <button type="button" aria-label={tr("移除挂载 {index}", { index: index + 1 })} disabled={disabled} onClick={() => patch({ mounts: mounts.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
    </li>)}</ul> : <p className="subtle">{tr("还没有挂载实例。")}</p>}
    {!decisionTrees.length && <p className="subtle">{tr("先在「决策树」页创建一棵树。")}</p>}
  </section>;
}
