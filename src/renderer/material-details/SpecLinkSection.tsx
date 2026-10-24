import { categoryForPath, type MaterialSummary } from "../materials-model";
import { useI18n } from "../i18n";

type SpecKind = "system" | "feature" | "decision";

/**
 * Reference and status editors for system, feature and decision specs. They share
 * the checkbox list shape, so they live together instead of in the generic form.
 */
export function SpecLinkSection({ kind, data, catalog, patch, onChange }: {
  kind: SpecKind;
  data: Record<string, unknown>;
  catalog: MaterialSummary[];
  patch: (value: Record<string, unknown>) => void;
  onChange: (data: Record<string, unknown>) => void;
}) {
  const tr = useI18n();
  const referenceItems = (target: "component" | "entity" | "system" | "decision") =>
    catalog.filter((item) => !item.invalid && categoryForPath(item.path) === target);
  const referenceIds = (key: string): string[] => (Array.isArray(data[key]) ? (data[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  const referenceSection = (label: string, key: string, target: "component" | "entity" | "system" | "decision") => {
    const items = referenceItems(target).filter((item) => item.id !== data.id);
    return <section key={key} className="material-relationship" aria-label={label}>
      <h3>{label}</h3>
      {items.length ? <ul className="material-reference-list">{items.map((item) => <li key={item.id}>
        <label>
          <input type="checkbox" aria-label={`${label} ${item.title}`} checked={referenceIds(key).includes(item.id)} onChange={(event) => {
            const current = referenceIds(key);
            patch({ [key]: event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id) });
          }} />
          <span>{item.title}</span><code>{item.id}</code>
        </label>
      </li>)}</ul> : <p className="subtle">{tr("暂无可选项。")}</p>}
    </section>;
  };
  const statusSection = (label: string, options: string[]) => <section className="material-relationship" aria-label={`${label}设置`}>
    <h3>{tr("状态")}</h3>
    <label>{tr("状态")}<select aria-label={label} value={String(data.status ?? options[0])} onChange={(event) => patch({ status: event.target.value })}>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select></label>
  </section>;

  return <div className="material-relationships">
    {kind === "system" && <>
      {referenceSection(tr("引用的组件"), "components", "component")}
      {referenceSection(tr("引用的实体"), "entities", "entity")}
      {referenceSection(tr("依赖的系统"), "dependsOn", "system")}
    </>}
    {kind === "feature" && <>
      {statusSection(tr("功能状态"), ["planned", "active", "done"])}
      {referenceSection(tr("关联系统"), "systems", "system")}
    </>}
    {kind === "decision" && <>
      {statusSection(tr("决策状态"), ["proposed", "accepted", "superseded"])}
      {referenceSection(tr("影响的系统"), "affectedSystems", "system")}
      <section className="material-relationship" aria-label={tr("取代设置")}>
        <h3>{tr("取代的决策")}</h3>
        <label>{tr("取代")}<select aria-label={tr("取代的决策")} value={String(data.supersedes ?? "")} onChange={(event) => {
          const next = { ...data };
          if (event.target.value) next.supersedes = event.target.value; else delete next.supersedes;
          onChange(next);
        }}>
          <option value="">{tr("不取代")}</option>
          {referenceItems("decision").filter((item) => item.id !== data.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
      </section>
    </>}
  </div>;
}
