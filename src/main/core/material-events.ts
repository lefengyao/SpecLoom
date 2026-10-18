import type { MaterialChange } from "../../shared/desktop-api";

const listeners = new Set<(event: MaterialChange) => void>();
export function subscribeMaterialChanges(listener: (event: MaterialChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishMaterialChange(event: MaterialChange): void {
  for (const listener of listeners) {
    // A closed observer must not turn a successful durable save into a reported failure.
    try { listener(event); } catch { /* Observers own their delivery lifecycle. */ }
  }
}
