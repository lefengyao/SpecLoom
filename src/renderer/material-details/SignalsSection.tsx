import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";

/** Signals an entity or system emits; decision trees may wait on them. */
export function SignalsSection({ data, onChange, disabled }: {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  disabled: boolean;
}) {
  const tr = useI18n();
  const names = Array.isArray(data.signals) ? data.signals.filter((item): item is string => typeof item === "string") : [];
  const update = (next: string[]) => {
    const updated = { ...data };
    if (next.length) updated.signals = next; else delete updated.signals;
    onChange(updated);
  };

  return <section className="material-section" aria-label={tr("信号")}>
    <header><div><h3>{tr("信号")}</h3><span className="subtle">{tr("声明这里会发出的信号；决策树可以等待这些信号。")}</span></div>
      <button type="button" disabled={disabled || names.length >= 64} onClick={() => update([...names, "signal_raised"])}><Plus size={16} />{tr("添加信号")}</button></header>
    {names.length ? <ul className="material-signal-list">{names.map((name, index) => <li key={index}>
      <input aria-label={tr("信号 {index}", { index: index + 1 })} maxLength={80} value={name} disabled={disabled} onChange={(event) => {
        const next = [...names];
        next[index] = event.target.value;
        update(next);
      }} />
      <button type="button" aria-label={tr("移除信号 {index}", { index: index + 1 })} disabled={disabled} onClick={() => update(names.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
    </li>)}</ul> : <p className="subtle">{tr("还没有声明信号。")}</p>}
  </section>;
}
