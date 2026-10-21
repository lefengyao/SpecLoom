import { Plus, Puzzle, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { type ComponentBinding, type ComponentField, type MaterialDocument } from "../shared/project-materials";
import { type StateMachine } from "../shared/state-machine";
import { materialGroupPath, resolveLegacyGroup, type MaterialGroup } from "../shared/material-groups";
import { categoryForPath, componentScope, componentScopeLabels, referenceId, resolveMaterial, wouldCycle, type MaterialSummary } from "./materials-model";
import { StateMachineEditor } from "./StateMachineEditor";

type FieldValue = ComponentField["default"];
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
  if (type === "boolean") return <select aria-label={label} value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value === "true")}><option value="true">是</option><option value="false">否</option></select>;
  return <input aria-label={label} type={type === "number" ? "number" : "text"} step={type === "number" ? "any" : undefined} required={type === "number"} value={String(value)} disabled={disabled} onChange={(event) => onChange(type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />;
}

export function MaterialDetails({ material, catalog, groups = [], onChange, disabled, originalFields = [] }: {
  material: MaterialDocument; catalog: MaterialSummary[];
  groups?: MaterialGroup[];
  onChange: (data: Record<string, unknown>, body?: string) => void; disabled: boolean;
  originalFields?: string[];
}) {
  const { data, body } = material;
  const relationshipId = useId();
  const [componentId, setComponentId] = useState("");
  const owner = catalog.find((item) => item.id === data.id);
  const type = String(data.type);
  const entity = type === "entity" || (owner && categoryForPath(owner.path) === "entity");
  const isComponent = type === "component";
  const rawBindings: unknown[] = Array.isArray(data.components) ? data.components : [];
  // Keep partially edited keys/defaults in place until the form is submitted.
  // The catalog reader filters invalid definitions, which would remove an input
  // as soon as the user cleared it while editing.
  const fields = Array.isArray(data.fields) ? data.fields.filter((value): value is ComponentField => Boolean(value && typeof value === "object" && typeof value.key === "string" && ["number", "string", "boolean"].includes(value.type))) : [];
  const sameCategory = catalog.filter((item) => owner && categoryForPath(item.path) === categoryForPath(owner.path) && !item.invalid);
  const parentChoices = sameCategory.filter((item) => owner && !wouldCycle(catalog, owner, item, "parent"));
  const baseChoices = catalog.filter((item) => categoryForPath(item.path) === "entity" && !item.invalid && owner && !wouldCycle(catalog, owner, item, "extends"));
  const components = catalog.filter((item) => categoryForPath(item.path) === "component" && item.type === "component" && !item.invalid);
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
    scope, title: componentScopeLabels[scope], items: availableComponents.filter((item) => componentScope(item) === scope),
  })).filter((section) => section.items.length > 0);
  const consumers = isComponent ? catalog.filter((item) => ["entity", "map"].includes(categoryForPath(item.path) ?? "") && item.components.some((binding) => resolveMaterial(components, binding.id)?.id === data.id)) : [];
  const emit = (value: Record<string, unknown>, nextBody?: string) => {
    const updated = { ...value };
    if (updated.groupId === undefined && typeof updated.group === "string") {
      const legacy = resolveLegacyGroup(groups, updated.group);
      if (legacy) { updated.groupId = legacy.id; delete updated.group; }
    }
    onChange(updated, nextBody);
  };
  const patch = (value: Record<string, unknown>) => emit({ ...data, ...value });
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
      <option value="">无</option>
      {current && !resolved && <option value={current}>关系待修正：{current}</option>}
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
    return <section key={`${binding.id}:${index ?? "inherited"}`} className="material-card" aria-label={`组件 ${title}`}>
      <header><strong><Puzzle size={16} />{title}</strong>{source ? <button type="button" onClick={() => patch({ components: [...rawBindings, { id: binding.id, values: { ...binding.values } }] })}>覆盖继承组件 {title}</button> : <button type="button" aria-label={`移除组件 ${title}`} onClick={() => patch({ components: rawBindings.filter((_, position) => position !== index) })}><Trash2 size={15} />移除</button>}</header>
      {source && <p className="subtle">继承自 {source}</p>}
      {!definition && <p role="alert">组件定义不存在，请移除或重新添加。</p>}
      {definition && !definition.fields.length && <p className="subtle">这个组件还没有字段，可在组件页完善定义。</p>}
      <div className="material-values">{definition?.fields.map((field) => <label key={field.key}>{field.label || field.key}<ValueInput label={`${title} · ${field.label || field.key}`} type={field.type} value={binding.values[field.key] ?? inherited.get(binding.id)?.binding.values[field.key] ?? field.default} disabled={Boolean(source)} onChange={(value) => { if (index !== undefined) updateBinding(index, binding.id, field.key, value); }} /></label>)}</div>
    </section>;
  };
  const updateField = (index: number, value: Partial<ComponentField>) => patch({ fields: fields.map((field, position) => position === index ? { ...field, ...value } : field) });
  const fieldLocked = (index: number) => consumers.length > 0 && index < originalFields.length;
  const fieldKeyError = (index: number): string => {
    const key = fields[index]!.key;
    if (["__proto__", "prototype", "constructor"].includes(key)) return `字段名称不能使用保留键：${key}`;
    if (key && fields.some((field, position) => position !== index && field.key === key)) return `字段名称重复：${key}`;
    return "";
  };
  return <fieldset className="material-details form-stack" disabled={disabled}>
    <div className="form-row">
      <label>名称<input required maxLength={200} value={String(data.title ?? "")} onChange={(event) => {
        const title = event.target.value;
        emit({ ...data, title }, /^#\s+.+$/m.test(body) ? body.replace(/^#\s+.+$/m, `# ${title}`) : body);
      }} /></label>
      {entity && <label>实体类型<select aria-label="实体类型" value={type} onChange={(event) => patch({ type: event.target.value })}>
        <option value="entity">通用实体</option><option value="character">角色</option><option value="enemy">敌人</option><option value="item">物品</option><option value="system">系统</option><option value="event">事件</option>
      </select></label>}
    </div>
    <label>说明<textarea rows={2} value={String(data.description ?? "")} onChange={(event) => patch({ description: event.target.value })} /></label>
    <div className="material-relationships">
      <section className="material-relationship" aria-label="资料层级">
        <h3>资料层级</h3>
        {selectRelationship("parent", "父级资料", parentChoices)}
        <p id={`${relationshipId}-parent`} className="material-relationship-hint">父级资料决定列表和关系图中的层级。</p>
      </section>
      {entity && <section className="material-relationship" aria-label="实体继承">
        <h3>实体继承</h3>
        {selectRelationship("extends", "继承自", baseChoices)}
        <p id={`${relationshipId}-extends`} className="material-relationship-hint">继承实体模板的数据和组件，与父级资料层级独立。</p>
      </section>}
      <section className="material-relationship" aria-label="资料分组">
        <h3>资料分组</h3>
        <label>分组<select aria-label="分组" aria-describedby={`${relationshipId}-group`} value={currentGroupId} onChange={(event) => {
          const updated = { ...data };
          if (event.target.value) { updated.groupId = event.target.value; delete updated.group; }
          else { delete updated.groupId; delete updated.group; }
          emit(updated);
        }}><option value="">未分组</option>{groupOptions.map(({ group, label }) => <option key={group.id} value={group.id}>{label}</option>)}</select></label>
        <p id={`${relationshipId}-group`} className="material-relationship-hint">分组用于归档和筛选，与资料层级独立。</p>
      </section>
    </div>
    {entity && !stateMachine && <section className="material-section state-machine-section" aria-label="实体状态机">
      <header><div><h3>状态机</h3><span className="subtle">为实体添加状态和转换配置</span></div><button type="button" onClick={enableStateMachine}><Plus size={16} />添加状态机</button></header>
    </section>}
    {entity && stateMachine && <StateMachineEditor value={stateMachine} disabled={disabled} onChange={updateStateMachine} />}
    {entity && stateMachine && <button className="state-machine-remove" type="button" disabled={disabled} onClick={() => updateStateMachine(undefined)}><Trash2 size={15} />移除状态机</button>}
    {entity && <section className="material-section" aria-label="实体组件">
      <header><h3>组件</h3><span className="subtle">组件绑定用于组合数据和能力，不决定父级资料层级。</span></header>
      <div className="component-picker"><label>选择组件<select aria-label="选择组件" value={componentId} onChange={(event) => setComponentId(event.target.value)}><option value="">请选择</option>{componentOptions.map((section) => <optgroup key={section.scope} label={section.title}>{section.items.map((item) => <option key={item.path} value={item.id}>{item.title}</option>)}</optgroup>)}</select></label>
        <button type="button" disabled={!componentId} onClick={() => {
          const definition = components.find((item) => item.id === componentId);
          if (!definition || bindings.some((item) => item.id === componentId)) return;
          const values = Object.fromEntries(definition.fields.map((field) => [field.key, field.default]));
          patch({ components: [...rawBindings, { id: componentId, values: { ...values, ...inherited.get(componentId)?.binding.values } }] });
          setComponentId("");
        }}><Plus size={16} />添加组件</button>
      </div>
      {!components.length && <p className="subtle">先在左侧“组件”页创建生命值、坐标、速度等组件。</p>}
      {!bindings.length && !inherited.size && <p className="subtle">尚未添加组件</p>}
      {bindings.map((binding) => bindingCard(binding, undefined, binding.index))}
      {[...inherited.values()].filter(({ binding }) => !bindings.some((item) => item.id === binding.id)).map(({ binding, source }) => bindingCard(binding, source))}
    </section>}
    {isComponent && <section className="material-section" aria-label="组件字段">
      <header><h3>字段与默认值</h3><button type="button" onClick={() => {
        let index = fields.length + 1;
        while (fields.some((field) => field.key === `field_${index}`)) index++;
        patch({ fields: [...fields, { key: `field_${index}`, type: "number", default: 0 }] });
      }}><Plus size={16} />添加字段</button></header>
      {!fields.length && <p className="subtle">添加组件所需的数据字段，实体挂载时可以覆盖默认值。</p>}
      {consumers.length > 0 && <p className="field-hint">已被 {consumers.length} 个实体使用。先从这些实体移除组件，再修改字段名称、类型或删除字段：{consumers.map((item) => item.title).join("、")}。</p>}
      {fields.map((field, index) => <div key={index} className="component-field">
        <label>字段名称<input aria-label={`字段名称 ${index + 1}`} required disabled={fieldLocked(index)} pattern="[a-zA-Z_][a-zA-Z0-9_]*" aria-invalid={Boolean(fieldKeyError(index))} aria-describedby={fieldKeyError(index) ? `component-field-error-${index}` : undefined} ref={(input) => { input?.setCustomValidity(fieldKeyError(index)); }} value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} />
          {fieldKeyError(index) && <span role="alert" id={`component-field-error-${index}`} className="field-hint">{fieldKeyError(index)}</span>}
        </label>
        <label>显示名称<input aria-label={`显示名称 ${index + 1}`} value={field.label ?? ""} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
        <label>字段类型<select aria-label={`字段类型 ${index + 1}`} disabled={fieldLocked(index)} value={field.type} onChange={(event) => {
          const type = event.target.value as ComponentField["type"];
          updateField(index, { type, default: type === "number" ? 0 : type === "boolean" ? false : "" });
        }}><option value="number">数值</option><option value="string">文本</option><option value="boolean">布尔</option></select></label>
        <label>默认值<ValueInput label={`默认值 ${index + 1}`} type={field.type} value={field.default} onChange={(value) => updateField(index, { default: value })} /></label>
        <button type="button" disabled={fieldLocked(index)} aria-label={`移除字段 ${index + 1}`} onClick={() => patch({ fields: fields.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
      </div>)}
    </section>}
    <label>Markdown 正文<textarea className="material-body" rows={16} value={body} spellCheck={false} onChange={(event) => emit(data, event.target.value)} /></label>
  </fieldset>;
}
