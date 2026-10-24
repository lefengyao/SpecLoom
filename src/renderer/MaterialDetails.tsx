import { Plus, Puzzle, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { type ComponentBinding, type ComponentField, type MaterialDocument } from "../shared/project-materials";
import { type StateMachine } from "../shared/state-machine";
import { materialGroupPath, resolveLegacyGroup, type MaterialGroup } from "../shared/material-groups";
import { categoryForPath, componentScope, componentScopeLabels, referenceId, resolveMaterial, wouldCycle, type MaterialSummary } from "./materials-model";
import { StateMachineEditor } from "./StateMachineEditor";
import { useI18n } from "./i18n";

type FieldValue = ComponentField["default"];
const fieldTypeLabels: Record<ComponentField["type"], string> = { number: "数值", string: "文本", boolean: "布尔" };
function stateMachineValue(value: unknown): StateMachine | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const states = Array.isArray(record.states) ? record.states.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item, index) => ({
    id: typeof item.id === "string" && item.id ? item.id : `state_${index + 1}`,
    title: typeof item.title === "string" && item.title ? item.title : `状态 ${index + 1}`,
    ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
  })) : [];
  const transitions = Array.isArray(record.transitions) ? record.transitions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item, index) => ({
    from: typeof item.from === "string" ? item.from : states[0]?.id ?? "idle",
    event: typeof item.event === "string" ? item.event : `event_${index + 1}`,
    to: typeof item.to === "string" ? item.to : states[0]?.id ?? "idle",
  })) : [];
  if (!states.length) return undefined;
  const initialState = typeof record.initialState === "string" && record.initialState ? record.initialState : states[0]!.id;
  return { initialState, states, transitions };
}

function initialStateMachine(): StateMachine {
  return { initialState: "idle", states: [{ id: "idle", title: "待机" }], transitions: [] };
}
function ValueInput({ label, type, value, onChange, disabled = false }: {
  label: string; type: ComponentField["type"]; value: FieldValue;
  onChange: (value: FieldValue) => void; disabled?: boolean;
}) {
  const tr = useI18n();
  if (type === "boolean") return <select aria-label={label} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value === "true")}><option value="true">{tr("是")}</option><option value="false">{tr("否")}</option></select>;
  return <input aria-label={label} type={type === "number" ? "number" : "text"} step={type === "number" ? "any" : undefined} required={type === "number"} value={String(value)} disabled={disabled} onChange={(event) => onChange(type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />;
}

export function MaterialDetails({ material, catalog, groups = [], onChange, disabled, originalFields = [] }: {
  material: MaterialDocument; catalog: MaterialSummary[];
  groups?: MaterialGroup[];
  onChange: (data: Record<string, unknown>, body?: string) => void; disabled: boolean;
  originalFields?: string[];
}) {
  const tr = useI18n();
  const { data, body } = material;
  const relationshipId = useId();
  const [componentId, setComponentId] = useState("");
  const owner = catalog.find((item) => item.id === data.id);
  const type = String(data.type);
  const entity = type === "entity" || (owner && categoryForPath(owner.path) === "entity");
  const isComponent = type === "component";
  const category = owner ? categoryForPath(owner.path) : undefined;
  const isSystem = category === "system";
  const isFeature = category === "feature";
  const isDecision = category === "decision";
  const rawBindings: unknown[] = Array.isArray(data.components) ? data.components : [];
  // Keep partially edited keys/defaults in place until the form is submitted.
  // The catalog reader filters invalid definitions, which would remove an input
  // as soon as the user cleared it while editing.
  const fields = Array.isArray(data.fields) ? data.fields.filter((value): value is ComponentField => Boolean(value && typeof value === "object" && typeof value.key === "string" && ["number", "string", "boolean"].includes(value.type))) : [];
  const sameCategory = catalog.filter((item) => owner && categoryForPath(item.path) === categoryForPath(owner.path) && !item.invalid);
  const parentChoices = sameCategory.filter((item) => owner && !wouldCycle(catalog, owner, item, "parent"));
  const baseChoices = catalog.filter((item) => categoryForPath(item.path) === "entity" && !item.invalid && owner && !wouldCycle(catalog, owner, item, "extends"));
  const components = catalog.filter((item) => categoryForPath(item.path) === "component" && item.type === "component" && !item.invalid);
  const componentBaseChoices = components.filter((item) => owner && item.path !== owner.path && !wouldCycle(catalog, owner, item, "extends"));
  const componentBase = isComponent ? resolveMaterial(components, referenceId(data.extends)) : undefined;
  const stateMachine = stateMachineValue(data.stateMachine);
  const stateMachineComponent = components.find((item) => item.id === "state_machine" || item.path.endsWith("/state_machine.md"));
  const bindings = rawBindings.map((entry, index) => {
    const target = referenceId(entry);
    const id = resolveMaterial(components, target)?.id ?? target ?? `invalid_${index}`;
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const values = record.values && typeof record.values === "object" && !Array.isArray(record.values) ? record.values as ComponentBinding["values"] : {};
    return { id, values, index };
  });
  const availableComponents = components.filter((item) => !bindings.some((binding) => binding.id === item.id));
  const componentOptions = (["system", "user"] as const).map((scope) => ({
    scope, title: tr(componentScopeLabels[scope]), items: availableComponents.filter((item) => componentScope(item) === scope),
  })).filter((section) => section.items.length > 0);
  const consumers = isComponent ? catalog.filter((item) => ["entity", "map"].includes(categoryForPath(item.path) ?? "") && item.components.some((binding) => resolveMaterial(components, binding.id)?.id === data.id)) : [];
  const componentConsumers = isComponent ? catalog.filter((item) => categoryForPath(item.path) === "component" && item.type === "component" && resolveMaterial(components, item.extends)?.id === data.id) : [];
  /** Reverse references: who points at this material from the other categories. */
  const reverseReferences = (() => {
    const id = String(data.id ?? "");
    if (!id) return [] as { label: string; items: MaterialSummary[] }[];
    const usable = catalog.filter((item) => !item.invalid && item.id !== id);
    const bindsTree = (bindings: ComponentBinding[] | undefined) => (bindings ?? []).some((binding) => binding.id === "decision_tree" && String((binding.values as Record<string, unknown>).tree ?? "") === id);
    if (category === "component") {
      return [
        { label: tr("被这些实体使用"), items: consumers },
        { label: tr("被这些系统引用"), items: usable.filter((item) => categoryForPath(item.path) === "system" && (item.uses ?? []).includes(id)) },
        { label: tr("被这些决策树使用"), items: usable.filter((item) => categoryForPath(item.path) === "decision_tree" && (item.treeComponents ?? []).includes(id)) },
      ].filter((section) => section.items.length > 0);
    }
    if (category === "system") {
      return [
        { label: tr("被这些功能引用"), items: usable.filter((item) => categoryForPath(item.path) === "feature" && (item.systems ?? []).includes(id)) },
        { label: tr("被这些架构决策影响"), items: usable.filter((item) => categoryForPath(item.path) === "decision" && (item.affectedSystems ?? []).includes(id)) },
        { label: tr("被这些决策树监听"), items: usable.filter((item) => categoryForPath(item.path) === "decision_tree" && (item.treeSignals ?? []).includes(id)) },
      ].filter((section) => section.items.length > 0);
    }
    if (category === "entity") {
      return [
        { label: tr("被这些决策树监听"), items: usable.filter((item) => categoryForPath(item.path) === "decision_tree" && (item.treeSignals ?? []).includes(id)) },
      ].filter((section) => section.items.length > 0);
    }
    if (category === "decision_tree") {
      return [
        { label: tr("挂载在实体上"), items: usable.filter((item) => ["entity", "map"].includes(categoryForPath(item.path) ?? "") && bindsTree(item.components)) },
        { label: tr("挂载在系统上"), items: usable.filter((item) => categoryForPath(item.path) === "system" && bindsTree(item.mounts)) },
      ].filter((section) => section.items.length > 0);
    }
    return [] as { label: string; items: MaterialSummary[] }[];
  })();
  const ownFieldKeys = new Set(fields.map((field) => field.key));
  const inheritedFields = isComponent && componentBase ? componentBase.fields.filter((field) => !ownFieldKeys.has(field.key)) : [];
  const emit = (value: Record<string, unknown>, nextBody?: string) => {
    const updated = { ...value };
    if (updated.groupId === undefined && typeof updated.group === "string") {
      const legacy = resolveLegacyGroup(groups, updated.group);
      if (legacy) { updated.groupId = legacy.id; delete updated.group; }
    }
    onChange(updated, nextBody);
  };
  const patch = (value: Record<string, unknown>) => emit({ ...data, ...value });
  const componentNotes = Array.isArray(data.notes) ? data.notes.filter((note): note is string => typeof note === "string").slice(0, 32) : [];
  const updateComponentNotes = (notes: string[]) => {
    const updated = { ...data };
    const next = notes.slice(0, 32);
    if (next.length) updated.notes = next;
    else delete updated.notes;
    emit(updated);
  };
  const currentGroupId = typeof data.groupId === "string" && groups.some((group) => group.id === data.groupId)
    ? data.groupId
    : typeof data.group === "string" ? resolveLegacyGroup(groups, data.group)?.id ?? "" : "";
  const groupOptions = groups.map((group) => ({ group, label: materialGroupPath(groups, group.id) })).sort((left, right) => left.group.order - right.group.order || left.label.localeCompare(right.label));
  const enableStateMachine = () => {
    const nextComponents = [...rawBindings];
    const alreadyBound = bindings.some((binding) => binding.id === stateMachineComponent?.id || binding.id === "state_machine");
    if (!alreadyBound) {
      const values = Object.fromEntries((stateMachineComponent?.fields ?? []).map((field) => [field.key, field.default]));
      nextComponents.push({ id: stateMachineComponent?.id ?? "state_machine", values });
    }
    patch({ stateMachine: initialStateMachine(), components: nextComponents });
  };
  const updateStateMachine = (value: StateMachine | undefined) => {
    if (value) patch({ stateMachine: value });
    else {
      const updated = { ...data };
      delete updated.stateMachine;
      emit(updated);
    }
  };
  const relationship = (key: "parent" | "extends", value: string) => {
    const updated = { ...data };
    if (value) updated[key] = value; else delete updated[key];
    emit(updated);
  };
  const selectedReference = (key: "parent" | "extends") => {
    const value = data[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return String((value as Record<string, unknown>).id ?? (value as Record<string, unknown>).path ?? "");
    return "";
  };
  const selectRelationship = (key: "parent" | "extends", label: string, choices: MaterialSummary[]) => {
    const current = selectedReference(key);
    const resolved = resolveMaterial(choices, current);
    return <label>{label}<select aria-label={label} aria-describedby={`${relationshipId}-${key}`} value={resolved?.id ?? current} onChange={(event) => relationship(key, event.target.value)}>
      <option value="">{tr("无")}</option>
      {current && !resolved && <option value={current}>{tr("关系待修正：{reference}", { reference: current })}</option>}
      {choices.map((item) => <option key={item.path} value={item.id}>{item.title}</option>)}
    </select></label>;
  };
  const inherited = new Map<string, { binding: ComponentBinding; source: string }>();
  if (entity) {
    const seen = new Set<string>();
    const chain: MaterialSummary[] = [];
    let base = resolveMaterial(catalog, selectedReference("extends"));
    while (base && !seen.has(base.path) && base.id !== data.id) {
      seen.add(base.path); chain.unshift(base); base = resolveMaterial(catalog, base.extends);
    }
    for (const base of chain) for (const binding of base.components) {
      const id = resolveMaterial(components, binding.id)?.id ?? binding.id;
      inherited.set(id, { binding: { id, values: { ...inherited.get(id)?.binding.values, ...binding.values } }, source: base.title });
    }
  }
  const updateBinding = (index: number, id: string, key: string, value: FieldValue) => patch({ components: rawBindings.map((entry, position) => {
    if (index !== position) return entry;
    const original = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : { id };
    const values = original.values && typeof original.values === "object" && !Array.isArray(original.values) ? original.values as Record<string, unknown> : {};
    return { ...original, values: { ...values, [key]: value } };
  }) });
  const bindingCard = (binding: ComponentBinding, source?: string, index?: number) => {
    const definition = components.find((item) => item.id === binding.id);
    const title = definition?.title ?? binding.id;
    return <section key={`${binding.id}:${index ?? "inherited"}`} className="material-card" aria-label={tr("组件 {title}", { title })}>
      <header><strong><Puzzle size={16} />{title}</strong>{source ? <button type="button" onClick={() => patch({ components: [...rawBindings, { id: binding.id, values: { ...binding.values }, ...(binding.mount ? { mount: binding.mount } : {}) }] })}>{tr("覆盖继承组件 {title}", { title })}</button> : <button type="button" aria-label={tr("移除组件 {title}", { title })} onClick={() => patch({ components: rawBindings.filter((_, position) => position !== index) })}><Trash2 size={15} />{tr("移除")}</button>}</header>
      {source && <p className="subtle">{tr("继承自 {source}", { source })}</p>}
      {!source && index !== undefined && entity && <label className="material-binding-key">{tr("实例 key")}<input aria-label={tr("{title} 的实例 key", { title })} maxLength={64} value={bindingKeyOf(rawBindings[index])} disabled={disabled} onChange={(event) => updateBindingKey(index, binding.id, event.target.value)} /></label>}
      {!definition && <p role="alert">{tr("组件定义不存在，请移除或重新添加。")}</p>}
      {definition && !definition.fields.length && <p className="subtle">{tr("这个组件还没有字段，可在组件页完善定义。")}</p>}
      <div className="material-values">{definition?.fields.map((field) => <label key={field.key}>{field.label || field.key}<ValueInput label={`${title} · ${field.label || field.key}`} type={field.type} value={binding.values[field.key] ?? inherited.get(binding.id)?.binding.values[field.key] ?? field.default} disabled={Boolean(source)} onChange={(value) => { if (index !== undefined) updateBinding(index, binding.id, field.key, value); }} /></label>)}</div>
    </section>;
  };
  const updateField = (index: number, value: Partial<ComponentField>) => patch({ fields: fields.map((field, position) => position === index ? { ...field, ...value } : field) });
  const fieldLocked = (index: number) => (consumers.length > 0 || componentConsumers.length > 0) && index < originalFields.length;
  const fieldKeyError = (index: number): string => {
    const key = fields[index]!.key;
    if (["__proto__", "prototype", "constructor"].includes(key)) return tr("字段名称不能使用保留键：{key}", { key });
    if (key && fields.some((field, position) => position !== index && field.key === key)) return tr("字段名称重复：{key}", { key });
    return "";
  };
  const referenceItems = (target: "component" | "entity" | "system" | "decision") =>
    catalog.filter((item) => !item.invalid && categoryForPath(item.path) === target);
  const decisionTrees = catalog.filter((item) => !item.invalid && categoryForPath(item.path) === "decision_tree");
  const mountList = Array.isArray(data.mounts)
    ? data.mounts.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const updateMount = (index: number, change: Record<string, unknown>) =>
    patch({ mounts: mountList.map((mount, position) => position === index ? { ...mount, ...change } : mount) });
  const signalNames = Array.isArray(data.signals) ? data.signals.filter((item): item is string => typeof item === "string") : [];
  const updateSignals = (next: string[]) => {
    const updated = { ...data };
    if (next.length) updated.signals = next; else delete updated.signals;
    emit(updated);
  };
  const bindingKeyOf = (entry: unknown): string => entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).key === "string" ? String((entry as Record<string, unknown>).key) : "";
  const updateBindingKey = (index: number, id: string, value: string) => patch({ components: rawBindings.map((entry, position) => {
    if (position !== index) return entry;
    const original: Record<string, unknown> = entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>) } : { id };
    if (value.trim()) original.key = value.trim(); else delete original.key;
    return original;
  }) });
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
  return <fieldset className="material-details form-stack" disabled={disabled}>
    <div className="form-row">
      <label>{tr("名称")}<input required maxLength={200} value={String(data.title ?? "")} onChange={(event) => {
        const title = event.target.value;
        emit({ ...data, title }, /^#\s+.+$/m.test(body) ? body.replace(/^#\s+.+$/m, `# ${title}`) : body);
      }} /></label>
      {entity && <label>{tr("实体类型")}<select aria-label={tr("实体类型")} value={type} onChange={(event) => patch({ type: event.target.value })}>
        <option value="entity">{tr("通用实体")}</option><option value="character">{tr("角色")}</option><option value="enemy">{tr("敌人")}</option><option value="item">{tr("物品")}</option><option value="system">{tr("系统")}</option><option value="event">{tr("事件")}</option>
      </select></label>}
    </div>
    <label>{tr("说明")}<textarea rows={2} value={String(data.description ?? "")} onChange={(event) => patch({ description: event.target.value })} /></label>
    {entity && <label>{tr("场景文件")}<input aria-label={tr("场景文件")} placeholder="entities/combat_entity/combat_entity.tscn" value={String(data.scene ?? "")} onChange={(event) => {
      const scene = event.target.value.trim();
      const next = { ...data };
      if (scene) next.scene = scene; else delete next.scene;
      emit(next);
    }} /></label>}
    {isComponent && <section className="material-section component-notes-section" aria-label={tr("说明条目")}>
      <header><div><h3>{tr("说明条目")}</h3><span className="subtle">{tr("用于补充字段无法表达的内容，可添加多条。")}</span></div><button type="button" disabled={componentNotes.length >= 32} onClick={() => updateComponentNotes([...componentNotes, ""])}><Plus size={16} />{tr("添加说明")}</button></header>
      {componentNotes.length ? <ul className="component-note-list">
        {componentNotes.map((note, index) => <li key={index}>
          <textarea aria-label={tr("说明 {index}", { index: index + 1 })} rows={2} maxLength={2000} value={note} onChange={(event) => {
            const next = [...componentNotes];
            next[index] = event.target.value;
            updateComponentNotes(next);
          }} onBlur={() => { if (!note.trim()) updateComponentNotes(componentNotes.filter((_, position) => position !== index)); }} />
          <button type="button" aria-label={tr("移除说明 {index}", { index: index + 1 })} onClick={() => updateComponentNotes(componentNotes.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
        </li>)}
      </ul> : <p className="subtle">{tr("还没有说明条目。")}</p>}
    </section>}
    <div className="material-relationships">
      <section className="material-relationship" aria-label={tr("资料层级")}>
        <h3>{tr("资料层级")}</h3>
        {selectRelationship("parent", tr("父级资料"), parentChoices)}
        <p id={`${relationshipId}-parent`} className="material-relationship-hint">{tr("父级资料决定列表和关系图中的层级。")}</p>
      </section>
      {entity && <section className="material-relationship" aria-label={tr("实体继承")}>
        <h3>{tr("实体继承")}</h3>
        {selectRelationship("extends", tr("继承自"), baseChoices)}
        <p id={`${relationshipId}-extends`} className="material-relationship-hint">{tr("继承实体模板的数据和组件，与父级资料层级独立。")}</p>
      </section>}
      {isComponent && <section className="material-relationship" aria-label={tr("组件继承")}>
        <h3>{tr("组件继承")}</h3>
        {selectRelationship("extends", tr("继承自"), componentBaseChoices)}
        <p id={`${relationshipId}-extends`} className="material-relationship-hint">{tr("继承另一组件的字段与默认值；同名自身字段会覆盖基类字段。实体之间的继承仍只指向实体。")}</p>
      </section>}
      <section className="material-relationship" aria-label={tr("资料分组")}>
        <h3>{tr("资料分组")}</h3>
        <label>{tr("分组")}<select aria-label={tr("分组")} aria-describedby={`${relationshipId}-group`} value={currentGroupId} onChange={(event) => {
          const updated = { ...data };
          if (event.target.value) { updated.groupId = event.target.value; delete updated.group; }
          else { delete updated.groupId; delete updated.group; }
          emit(updated);
        }}><option value="">{tr("未分组")}</option>{groupOptions.map(({ group, label }) => <option key={group.id} value={group.id}>{label}</option>)}</select></label>
        <p id={`${relationshipId}-group`} className="material-relationship-hint">{tr("分组用于归档和筛选，与资料层级独立。")}</p>
      </section>
    </div>
    {(isSystem || isFeature || isDecision) && <div className="material-relationships">
      {isSystem && <>
        {referenceSection(tr("引用的组件"), "components", "component")}
        {referenceSection(tr("引用的实体"), "entities", "entity")}
        {referenceSection(tr("依赖的系统"), "dependsOn", "system")}
      </>}
      {isFeature && <>
        {statusSection(tr("功能状态"), ["planned", "active", "done"])}
        {referenceSection(tr("关联系统"), "systems", "system")}
      </>}
      {isDecision && <>
        {statusSection(tr("决策状态"), ["proposed", "accepted", "superseded"])}
        {referenceSection(tr("影响的系统"), "affectedSystems", "system")}
        <section className="material-relationship" aria-label={tr("取代设置")}>
          <h3>{tr("取代的决策")}</h3>
          <label>{tr("取代")}<select aria-label={tr("取代的决策")} value={String(data.supersedes ?? "")} onChange={(event) => {
            const next = { ...data };
            if (event.target.value) next.supersedes = event.target.value; else delete next.supersedes;
            emit(next);
          }}>
            <option value="">{tr("不取代")}</option>
            {referenceItems("decision").filter((item) => item.id !== data.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
        </section>
      </>}
    </div>}
    {isSystem && <section className="material-section" aria-label={tr("系统挂载")}>
      <header><h3>{tr("挂载实例")}</h3><span className="subtle">{tr("把决策树等组件实例挂到系统上；同一组件可挂多个，用 key 区分。")}</span>
        <button type="button" disabled={disabled || !decisionTrees.length} onClick={() => {
          const used = new Set(mountList.map((mount) => String(mount.key ?? "")));
          let index = mountList.length + 1;
          let key = `tree_${index}`;
          while (used.has(key)) { index++; key = `tree_${index}`; }
          patch({ mounts: [...mountList, { id: "decision_tree", key, values: { tree: decisionTrees[0]?.id ?? "" } }] });
        }}><Plus size={16} />{tr("挂载决策树")}</button>
      </header>
      {mountList.length ? <ul className="material-mount-list">{mountList.map((mount, index) => <li key={index}>
        <label>{tr("实例 key")}<input aria-label={tr("挂载 key {index}", { index: index + 1 })} maxLength={64} value={String(mount.key ?? "")} disabled={disabled} onChange={(event) => updateMount(index, { key: event.target.value })} /></label>
        <label>{tr("决策树")}<select aria-label={tr("挂载决策树 {index}", { index: index + 1 })} value={String((mount.values as Record<string, unknown> | undefined)?.tree ?? "")} disabled={disabled} onChange={(event) => updateMount(index, { values: { ...((mount.values as Record<string, unknown> | undefined) ?? {}), tree: event.target.value } })}>
          <option value="">{tr("选择决策树")}</option>
          {decisionTrees.map((tree) => <option key={tree.id} value={tree.id}>{tree.title}</option>)}
        </select></label>
        <button type="button" aria-label={tr("移除挂载 {index}", { index: index + 1 })} disabled={disabled} onClick={() => patch({ mounts: mountList.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
      </li>)}</ul> : <p className="subtle">{tr("还没有挂载实例。")}</p>}
      {!decisionTrees.length && <p className="subtle">{tr("先在「决策树」页创建一棵树。")}</p>}
    </section>}
    {reverseReferences.length > 0 && <section className="material-section" aria-label={tr("被引用")}>
      <header><h3>{tr("被引用")}</h3><span className="subtle">{tr("反查其他资料对这里的引用，改名前可先确认影响范围。")}</span></header>
      {reverseReferences.map((group) => <div key={group.label} className="material-consumers">
        <strong>{group.label}</strong>
        <ul>{group.items.map((item) => <li key={item.path}><span>{item.title}</span><code>{item.id}</code></li>)}</ul>
      </div>)}
    </section>}
    {(entity || isSystem) && <section className="material-section" aria-label={tr("信号")}>
      <header><div><h3>{tr("信号")}</h3><span className="subtle">{tr("声明这里会发出的信号；决策树可以等待这些信号。")}</span></div>
        <button type="button" disabled={disabled || signalNames.length >= 64} onClick={() => updateSignals([...signalNames, "signal_raised"])}><Plus size={16} />{tr("添加信号")}</button></header>
      {signalNames.length ? <ul className="material-signal-list">{signalNames.map((name, index) => <li key={index}>
        <input aria-label={tr("信号 {index}", { index: index + 1 })} maxLength={80} value={name} disabled={disabled} onChange={(event) => {
          const next = [...signalNames];
          next[index] = event.target.value;
          updateSignals(next);
        }} />
        <button type="button" aria-label={tr("移除信号 {index}", { index: index + 1 })} disabled={disabled} onClick={() => updateSignals(signalNames.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
      </li>)}</ul> : <p className="subtle">{tr("还没有声明信号。")}</p>}
    </section>}
    {entity && !stateMachine && <section className="material-section state-machine-section" aria-label={tr("实体状态机")}>
      <header><div><h3>{tr("状态机")}</h3><span className="subtle">{tr("为实体添加状态和转换配置")}</span></div><button type="button" onClick={enableStateMachine}><Plus size={16} />{tr("添加状态机")}</button></header>
    </section>}
    {entity && stateMachine && <StateMachineEditor value={stateMachine} disabled={disabled} onChange={updateStateMachine} />}
    {entity && stateMachine && <button className="state-machine-remove" type="button" disabled={disabled} onClick={() => updateStateMachine(undefined)}><Trash2 size={15} />{tr("移除状态机")}</button>}
    {entity && <section className="material-section" aria-label={tr("实体组件")}>
      <header><h3>{tr("组件")}</h3><span className="subtle">{tr("组件绑定用于组合数据和能力，不决定父级资料层级。")}</span></header>
      <div className="component-picker"><label>{tr("选择组件")}<select aria-label={tr("选择组件")} value={componentId} onChange={(event) => setComponentId(event.target.value)}><option value="">{tr("请选择")}</option>{componentOptions.map((section) => <optgroup key={section.scope} label={section.title}>{section.items.map((item) => <option key={item.path} value={item.id}>{item.title}</option>)}</optgroup>)}</select></label>
        <button type="button" disabled={!componentId} onClick={() => {
          const definition = components.find((item) => item.id === componentId);
          if (!definition || bindings.some((item) => item.id === componentId)) return;
          const values = Object.fromEntries(definition.fields.map((field) => [field.key, field.default]));
          patch({ components: [...rawBindings, { id: componentId, values: { ...values, ...inherited.get(componentId)?.binding.values } }] });
          setComponentId("");
        }}><Plus size={16} />{tr("添加组件")}</button>
      </div>
      {!components.length && <p className="subtle">{tr("先在左侧“组件”页创建生命值、坐标、速度等组件。")}</p>}
      {!bindings.length && !inherited.size && <p className="subtle">{tr("尚未添加组件")}</p>}
      {bindings.map((binding) => bindingCard(binding, undefined, binding.index))}
      {[...inherited.values()].filter(({ binding }) => !bindings.some((item) => item.id === binding.id)).map(({ binding, source }) => bindingCard(binding, source))}
    </section>}
    {isComponent && <section className="material-section" aria-label={tr("组件字段")}>
      <header><h3>{tr("字段与默认值")}</h3><button type="button" onClick={() => {
        let index = fields.length + 1;
        while (fields.some((field) => field.key === `field_${index}`)) index++;
        patch({ fields: [...fields, { key: `field_${index}`, type: "number", default: 0 }] });
      }}><Plus size={16} />{tr("添加字段")}</button></header>
      {!fields.length && <p className="subtle">{tr("添加组件所需的数据字段，实体挂载时可以覆盖默认值。")}</p>}
      {consumers.length > 0 && <p className="field-hint">{tr("已被 {count} 个实体使用。先从这些实体移除组件，再修改字段名称、类型或删除字段：{entities}。", { count: consumers.length, entities: consumers.map((item) => item.title).join("、") })}</p>}
      {componentConsumers.length > 0 && <p className="field-hint">{tr("已被 {count} 个组件继承。先解除这些组件的继承，再修改字段名称、类型或删除字段：{components}。", { count: componentConsumers.length, components: componentConsumers.map((item) => item.title).join("、") })}</p>}
      {fields.map((field, index) => <div key={index} className="component-field">
        <label>{tr("字段名称")}<input aria-label={tr("字段名称 {index}", { index: index + 1 })} required disabled={fieldLocked(index)} pattern="[a-zA-Z_][a-zA-Z0-9_]*" aria-invalid={Boolean(fieldKeyError(index))} aria-describedby={fieldKeyError(index) ? `component-field-error-${index}` : undefined} ref={(input) => { input?.setCustomValidity(fieldKeyError(index)); }} value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} />
          {fieldKeyError(index) && <span role="alert" id={`component-field-error-${index}`} className="field-hint">{fieldKeyError(index)}</span>}
        </label>
        <label>{tr("显示名称")}<input aria-label={tr("显示名称 {index}", { index: index + 1 })} value={field.label ?? ""} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
        <label>{tr("字段类型")}<select aria-label={tr("字段类型 {index}", { index: index + 1 })} disabled={fieldLocked(index)} value={field.type} onChange={(event) => {
          const type = event.target.value as ComponentField["type"];
          updateField(index, { type, default: type === "number" ? 0 : type === "boolean" ? false : "" });
        }}><option value="number">{tr("数值")}</option><option value="string">{tr("文本")}</option><option value="boolean">{tr("布尔")}</option></select></label>
        <label>{tr("默认值")}<ValueInput label={tr("默认值 {index}", { index: index + 1 })} type={field.type} value={field.default} onChange={(value) => updateField(index, { default: value })} /></label>
        <button type="button" disabled={fieldLocked(index)} aria-label={tr("移除字段 {index}", { index: index + 1 })} onClick={() => patch({ fields: fields.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
      </div>)}
      {inheritedFields.length > 0 && <div className="component-inherited-fields">
        <h4>{tr("继承字段")}</h4>
        <p className="subtle">{tr("来自 {source}；添加同名字段即可覆盖。", { source: componentBase?.title ?? "" })}</p>
        <ul>
          {inheritedFields.map((field) => <li key={field.key}>
            <span><strong>{field.label || field.key}</strong><span className="subtle">{field.key} · {tr(fieldTypeLabels[field.type])}</span></span>
            <button type="button" onClick={() => patch({ fields: [...fields, { ...field }] })}>{tr("覆盖")}</button>
          </li>)}
        </ul>
      </div>}
    </section>}
    <label>{tr("Markdown 正文")}<textarea className="material-body" rows={16} value={body} spellCheck={false} onChange={(event) => emit(data, event.target.value)} /></label>
  </fieldset>;
}
