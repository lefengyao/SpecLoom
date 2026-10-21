import { Plus, Trash2 } from "lucide-react";
import { type StateMachine, STATE_MACHINE_LIMITS } from "../shared/state-machine";
import { useI18n } from "./i18n";

type StateMachineEditorProps = {
  value: StateMachine;
  disabled?: boolean;
  onChange: (value: StateMachine) => void;
};

function stateId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stateTitle(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

export function StateMachineEditor({ value, disabled = false, onChange }: StateMachineEditorProps) {
  const tr = useI18n();
  const states = value.states;
  const patch = (next: Partial<StateMachine>) => onChange({ ...value, ...next });
  const updateState = (index: number, change: Partial<StateMachine["states"][number]>) => {
    const current = states[index];
    if (!current) return;
    const nextStates = states.map((state, position) => position === index ? { ...state, ...change } : state);
    if (change.id !== undefined && change.id !== current.id) {
      const nextId = stateId(change.id, current.id);
      patch({
        states: nextStates,
        initialState: value.initialState === current.id ? nextId : value.initialState,
        transitions: value.transitions.map((transition) => ({
          ...transition,
          from: transition.from === current.id ? nextId : transition.from,
          to: transition.to === current.id ? nextId : transition.to,
        })),
      });
      return;
    }
    patch({ states: nextStates });
  };
  const removeState = (index: number) => {
    if (states.length <= 1) return;
    const removed = states[index];
    if (!removed) return;
    const nextStates = states.filter((_, position) => position !== index);
    const initialState = value.initialState === removed.id ? nextStates[0]!.id : value.initialState;
    patch({
      states: nextStates,
      initialState,
      transitions: value.transitions.filter((transition) => transition.from !== removed.id && transition.to !== removed.id),
    });
  };
  const addState = () => {
    if (states.length >= STATE_MACHINE_LIMITS.states) return;
    let index = states.length + 1;
    let id = `state_${index}`;
    while (states.some((state) => state.id === id)) { index++; id = `state_${index}`; }
    patch({ states: [...states, { id, title: `状态 ${index}` }] });
  };
  const addTransition = () => {
    if (value.transitions.length >= STATE_MACHINE_LIMITS.transitions || !states.length) return;
    const index = value.transitions.length + 1;
    patch({ transitions: [...value.transitions, { from: states[0]!.id, event: `event_${index}`, to: states[states.length - 1]!.id }] });
  };
  const updateTransition = (index: number, change: Partial<StateMachine["transitions"][number]>) => {
    patch({ transitions: value.transitions.map((transition, position) => position === index ? { ...transition, ...change } : transition) });
  };
  const removeTransition = (index: number) => patch({ transitions: value.transitions.filter((_, position) => position !== index) });

  return <section className="material-section state-machine-editor" aria-label={tr("实体状态机")}>
    <header>
      <div><h3>{tr("状态机")}</h3><span className="subtle">{tr("定义实体的状态和转换")}</span></div>
      <label>{tr("初始状态")}<select aria-label={tr("初始状态")} value={value.initialState} disabled={disabled} onChange={(event) => patch({ initialState: event.target.value })}>
        {states.map((state) => <option key={state.id} value={state.id}>{state.title || state.id}</option>)}
      </select></label>
    </header>
    <div className="state-machine-toolbar">
      <strong>{tr("状态")}</strong>
      <button type="button" disabled={disabled || states.length >= STATE_MACHINE_LIMITS.states} onClick={addState}><Plus size={16} />{tr("添加状态")}</button>
    </div>
    <div className="state-machine-states">
      {states.map((state, index) => <div className="state-machine-row" key={`${index}:${state.id}`}>
        <label>{tr("状态 ID")}<input aria-label={tr("状态 ID {index}", { index: index + 1 })} required maxLength={STATE_MACHINE_LIMITS.id} value={stateId(state.id, `state_${index + 1}`)} disabled={disabled} onChange={(event) => updateState(index, { id: event.target.value })} /></label>
        <label>{tr("状态名称")}<input aria-label={tr("状态名称 {index}", { index: index + 1 })} required maxLength={STATE_MACHINE_LIMITS.title} value={stateTitle(state.title, `状态 ${index + 1}`)} disabled={disabled} onChange={(event) => updateState(index, { title: event.target.value })} /></label>
        <label>{tr("状态说明")}<textarea aria-label={tr("状态说明 {index}", { index: index + 1 })} maxLength={STATE_MACHINE_LIMITS.description} rows={1} value={state.description ?? ""} disabled={disabled} onChange={(event) => updateState(index, { description: event.target.value || undefined })} /></label>
        <button type="button" aria-label={tr("移除状态 {index}", { index: index + 1 })} disabled={disabled || states.length <= 1} onClick={() => removeState(index)}><Trash2 size={15} /></button>
      </div>)}
    </div>
    <div className="state-machine-toolbar">
      <strong>{tr("转换")}</strong>
      <button type="button" disabled={disabled || !states.length || value.transitions.length >= STATE_MACHINE_LIMITS.transitions} onClick={addTransition}><Plus size={16} />{tr("添加转换")}</button>
    </div>
    {value.transitions.map((transition, index) => <div className="state-machine-row state-machine-transition" key={index}>
      <label>{tr("来源")}<select aria-label={tr("转换来源 {index}", { index: index + 1 })} value={transition.from} disabled={disabled} onChange={(event) => updateTransition(index, { from: event.target.value })}>{states.map((state) => <option key={state.id} value={state.id}>{state.title || state.id}</option>)}</select></label>
      <label>{tr("事件")}<input aria-label={tr("转换事件 {index}", { index: index + 1 })} required maxLength={STATE_MACHINE_LIMITS.event} value={transition.event} disabled={disabled} onChange={(event) => updateTransition(index, { event: event.target.value })} /></label>
      <label>{tr("目标")}<select aria-label={tr("转换目标 {index}", { index: index + 1 })} value={transition.to} disabled={disabled} onChange={(event) => updateTransition(index, { to: event.target.value })}>{states.map((state) => <option key={state.id} value={state.id}>{state.title || state.id}</option>)}</select></label>
      <button type="button" aria-label={tr("移除转换 {index}", { index: index + 1 })} disabled={disabled} onClick={() => removeTransition(index)}><Trash2 size={15} /></button>
    </div>)}
    {!value.transitions.length && <p className="subtle">{tr("尚未添加转换")}</p>}
  </section>;
}
