import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatImageAttachment, ChatSession, ChatSessionsApi, SessionDeltaEvent, SessionEvent } from "../../shared/chat";
import { playCompletionChime } from "../sound";
import { composePrompt, type PreparedDraftSnapshot } from "./attachment-ingest";

/** Session snapshots contain plain JSON data; compare bodies without allocating serialized copies. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function mergeDeltaSession(current: ChatSession[], event: SessionDeltaEvent): ChatSession[] {
  const session = current.find((candidate) => candidate.id === event.sessionId);
  if (!session || !["running", "waiting"].includes(session.status) || event.seq < session.seq || (event.runId !== undefined && session.runId !== undefined && event.runId !== session.runId)) return current;
  const runId = event.runId ?? session.runId;
  if (!runId) return current;
  const itemId = `${runId}:${event.stream.messageId}`;
  const item = event.stream.type === "thinking"
    ? { id: itemId, kind: "thinking" as const, content: event.stream.content, partial: true as const }
    : { id: itemId, kind: "message" as const, role: "assistant" as const, content: event.stream.content, partial: true as const };
  const existing = session.items.find((candidate) => candidate.id === itemId);
  const items = existing
    ? session.items.map((candidate) => candidate.id === itemId ? item : candidate)
    : [...session.items, item];
  const next: ChatSession = { ...session, runId, status: "running", seq: event.seq, items };
  return current.map((candidate) => candidate.id === session.id ? next : candidate);
}
export function mergeSession(current: ChatSession[], next: ChatSession): ChatSession[] {
  const previous = current.find((s) => s.id === next.id);
  if (previous && previous.revision >= next.revision) return current;
  if (previous) {
    const existing = new Map(previous.items.map((item) => [item.id, item]));
    next = { ...next, items: next.items.map((item) => { const old = existing.get(item.id); return old && sameValue(old, item) ? old : item; }) };
  }
  return previous ? current.map((s) => s.id === next.id ? next : s) : [...current, next];
}
interface Draft { text: string; revision: number }
export interface PendingGuidance { id: string; sessionId: string; runId: string; text: string; images?: ChatImageAttachment[]; sending?: boolean }
export function windowStorageKey(key: string, windowId?: string): string {
  return windowId ? `${key}:window:${encodeURIComponent(windowId)}` : key;
}
export function readWindowStorage(key: string, windowId?: string): string | null {
  try {
    const scoped = windowStorageKey(key, windowId);
    const current = localStorage.getItem(scoped);
    if (current !== null || windowId !== "hub-window-1") return current;
    const legacy = localStorage.getItem(key);
    if (legacy !== null) {
      // Only the first Hub slot inherits recovery data from releases before multi-window support.
      try { localStorage.setItem(scoped, legacy); localStorage.removeItem(key); } catch { /* Keep recovery usable when storage is full. */ }
    }
    return legacy;
  } catch { return null; }
}
export function useChatSessions(api: ChatSessionsApi, projectPath: string, onError: (error: unknown) => void, onFinished: () => void, onRestoreImages?: (id: string, images: ChatImageAttachment[]) => void, windowId?: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const activeKey = `specloom:active-session:${encodeURIComponent(projectPath)}`;
  const [activeId, setActiveId] = useState(() => readWindowStorage(activeKey, windowId) ?? "");
  const [creating, setCreating] = useState(false);
  const createPending = useRef(false);
  const selectionSeq = useRef(0);
  const refreshSeq = useRef(0);
  const select = useCallback((id: string) => { selectionSeq.current++; setActiveId(id); }, []);
  const [draftTick, setDraftTick] = useState(0);
  const [sending, setSending] = useState<string[]>([]);
  const drafts = useRef(new Map<string, Draft>());
  const chains = useRef(new Map<string, Promise<ChatSession>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const deleted = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const records = useRef(sessions); records.current = sessions;
  const alive = useRef(true);
  const legacyGuidanceKey = `specloom:guidance:${encodeURIComponent(projectPath)}`;
  const guidanceKey = windowStorageKey(legacyGuidanceKey, windowId);
  const [pendingGuidance, setPendingGuidance] = useState<PendingGuidance[]>(() => {
    try {
      const saved: unknown = JSON.parse(readWindowStorage(legacyGuidanceKey, windowId) ?? "[]");
      return Array.isArray(saved) ? saved.filter((entry): entry is PendingGuidance => !!entry && typeof entry === "object" && typeof entry.id === "string" && typeof entry.sessionId === "string" && typeof entry.runId === "string" && typeof entry.text === "string" && entry.text.length <= 131072).map(entry => ({ ...entry, sending: false })) : [];
    } catch { return []; }
  });
  const guidance = useRef(pendingGuidance);
  const restoringImages = useRef(onRestoreImages); restoringImages.current = onRestoreImages;
  function updateGuidance(next: PendingGuidance[]) {
    // A remounted workspace owns its own queue; old IPC callbacks must not overwrite that storage.
    if (!alive.current) return;
    guidance.current = next;
    try { if (next.length) localStorage.setItem(guidanceKey, JSON.stringify(next.map(entry => ({ ...entry, sending: false })))); else localStorage.removeItem(guidanceKey); } catch { /* The retained page still holds the pending messages. */ }
    if (alive.current) setPendingGuidance(next);
  }
  function restoreGuidance(entries: PendingGuidance[]) {
    for (const id of new Set(entries.map(entry => entry.sessionId))) {
      const messages = entries.filter(entry => entry.sessionId === id);
      const text = [...messages.map(entry => entry.text), draft(id).text].filter(Boolean).join("\n\n");
      // A staged message already fits the input limit; keep any overflow staged rather than truncate user text.
      if (text.length > 131072) continue;
      setDraft(id, text);
      const images = messages.flatMap(entry => entry.images ?? []);
      if (images.length) restoringImages.current?.(id, images);
      updateGuidance(guidance.current.filter(entry => !messages.some(message => message.id === entry.id)));
    }
  }
  useEffect(() => {
    const accepted = guidance.current.filter(entry => records.current.find(session => session.id === entry.sessionId)?.items.some(item => item.id === `${entry.runId}:guidance:${entry.id}`));
    if (accepted.length) updateGuidance(guidance.current.filter(entry => !accepted.some(message => message.id === entry.id)));
    const candidates = guidance.current.filter(entry => {
      const session = records.current.find(session => session.id === entry.sessionId);
      return !entry.sending && !!session && (session.runId !== entry.runId || !["running", "waiting"].includes(session.status));
    });
    restoreGuidance(candidates);
  }, [sessions, pendingGuidance, draftTick]);
  useEffect(() => { if (activeId) { try { localStorage.setItem(windowStorageKey(activeKey, windowId), activeId); } catch { /* ignored */ } } }, [activeId, activeKey, windowId]);
  const legacyKey = useCallback((id: string) => `specloom:draft:${encodeURIComponent(projectPath)}:${id}`, [projectPath]);
  const key = useCallback((id: string) => windowStorageKey(legacyKey(id), windowId), [legacyKey, windowId]);
  const remember = (id: string, text: string) => { try { localStorage.setItem(key(id), text); } catch { /* Main-process storage remains available. */ } };
  const draft = (id: string): Draft => {
    let found = drafts.current.get(id);
    if (!found) {
      const local = readWindowStorage(legacyKey(id), windowId);
      const stored = records.current.find((s) => s.id === id);
      found = { text: local ?? stored?.draft ?? "", revision: 0 };
      // A restored selection can render before its history arrives; do not cache that placeholder.
      if (local !== null || stored) drafts.current.set(id, found);
    }
    return found;
  };
  const apply = useCallback((session: ChatSession) => {
    if (!alive.current || deleted.current.has(session.id)) return;
    const previous = records.current; const next = mergeSession(previous, session);
    if (next === previous) return;
    records.current = next;
    setSessions(current => current === previous ? next : mergeSession(current, session));
  }, []);
  const applyDelta = useCallback((event: SessionDeltaEvent) => {
    if (!alive.current || deleted.current.has(event.sessionId)) return;
    const previous = records.current;
    const next = mergeDeltaSession(previous, event);
    if (next === previous) return;
    records.current = next;
    setSessions(current => mergeDeltaSession(current, event));
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++refreshSeq.current; const selection = selectionSeq.current;
    const baseline = new Map(records.current.map(session => [session.id, session.revision]));
    const next = (await api.list(projectPath)).filter(session => !deleted.current.has(session.id));
    if (!alive.current || generation !== refreshSeq.current) return;
    const present = new Set(next.map(session => session.id));
    // A stream/create received after the list request can be newer than its snapshot.
    // Preserve only those newer records so unrelated peer deletions still take effect.
    const merged = next.reduce(mergeSession, records.current.filter(session => present.has(session.id) || !baseline.has(session.id) || session.revision > baseline.get(session.id)!));
    records.current = merged; setSessions(merged);
    if (selection === selectionSeq.current) setActiveId((current) => merged.some((s) => s.id === current) ? current : merged.find((s) => !s.archived)?.id ?? "");
  }, [api, projectPath]);
  useEffect(() => {
    alive.current = true;
    const receive = (event: SessionEvent) => {
      if (event.projectPath !== projectPath || event.sessionId !== event.session.id || event.runId !== event.session.runId || event.seq !== event.session.seq) return;
      apply(event.session);
    };
    const receiveDelta = (event: SessionDeltaEvent) => {
      if (event.projectPath !== projectPath) return;
      applyDelta(event);
    };
    const unsubscribe = api.subscribe(receive);
    const unsubscribeDelta = api.subscribeDelta?.(receiveDelta);
    let queued = false;
    const unsubscribeChanges = api.subscribeChanges?.((changedProject) => {
      if (changedProject !== projectPath || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (alive.current) void refresh().catch(onError);
      });
    });
    void refresh().catch(onError);
    const taskTimers = timers.current;
    return () => { alive.current = false; refreshSeq.current++; unsubscribe(); unsubscribeDelta?.(); unsubscribeChanges?.(); for (const timer of taskTimers.values()) clearTimeout(timer); };
  }, [api, projectPath, refresh, apply, applyDelta, onError]);
  function persist(id: string, text: string): Promise<ChatSession> {
    const previous = chains.current.get(id);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => {
      if (deleted.current.has(id)) throw new Error("会话已删除");
      return api.patch(projectPath, id, { draft: text });
    });
    chains.current.set(id, next); void next.then(apply, (error) => { if (alive.current && !deleted.current.has(id)) onError(error); }); return next;
  }
  function setDraft(id: string, text: string) {
    if (deleted.current.has(id)) return;
    const value = draft(id); value.text = text; value.revision++; drafts.current.set(id, value); remember(id, text); setDraftTick((n) => n + 1);
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); void persist(id, text); }, 200));
  }
  async function create(taskId?: string, onCreated?: (session: ChatSession) => void) {
    if (createPending.current) return undefined;
    createPending.current = true; setCreating(true); const generation = ++selectionSeq.current;
    try {
      const next = await api.create(projectPath, undefined, taskId);
      // Hand off the temporary composer before publishing the new selection.
      onCreated?.(next);
      apply(next);
      const selected = alive.current && generation === selectionSeq.current;
      if (selected) setActiveId(next.id);
      return { session: next, selected };
    } finally { createPending.current = false; if (alive.current) setCreating(false); }
  }
  async function remove(id: string) {
    const pendingTimer = timers.current.get(id);
    clearTimeout(pendingTimer); timers.current.delete(id);
    try { await api.remove(projectPath, id); }
    catch (error) {
      if (alive.current && pendingTimer !== undefined) setDraft(id, draft(id).text);
      throw error;
    }
    deleted.current.add(id);
    updateGuidance(guidance.current.filter(entry => entry.sessionId !== id));
    clearTimeout(timers.current.get(id)); timers.current.delete(id); chains.current.delete(id);
    if (!alive.current) return;
    drafts.current.delete(id);
    try { localStorage.removeItem(key(id)); } catch { /* ignored */ }
    records.current = records.current.filter((session) => session.id !== id);
    setSessions((current) => current.filter((session) => session.id !== id));
    if (activeId === id) {
      selectionSeq.current++;
      setActiveId("");
    }
    await refresh();
  }
  async function send(id: string, images?: ChatImageAttachment[], model?: ChatSession["model"], snapshot?: PreparedDraftSnapshot) {
    if (inFlight.current.has(id)) return false;
    const value = draft(id);
    if (snapshot && (snapshot.draftRevision !== value.revision || snapshot.draftText !== value.text)) return false;
    const prompt = snapshot ? composePrompt(snapshot) : value.text.trim() || (images?.length ? "请查看附件并说明你观察到的内容。" : ""); if (!prompt) return false;
    const sourceText = value.text;
    const sourceRevision = value.revision;
    const previousRunId = records.current.find((s) => s.id === id)?.runId;
    const accepted = () => {
      const session = records.current.find((s) => s.id === id);
      return !!session?.runId && session.runId !== previousRunId && session.items.some((item) => item.id === `${session.runId}:user` && item.kind === "message" && item.role === "user" && item.content === prompt);
    };
    inFlight.current.add(id); setSending((current) => [...current, id]);
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    try {
      const saved = await persist(id, sourceText);
      if (!alive.current) return;
      let clearedRevision: number | undefined;
      if (draft(id).revision === sourceRevision) { value.text = ""; value.revision++; clearedRevision = value.revision; remember(id, ""); setDraftTick((n) => n + 1); }
      let requested = false;
      try {
        if (model) await patch(id, { model });
        requested = true;
        const next = images?.length ? await api.send(projectPath, id, prompt, saved.draftRevision, images) : await api.send(projectPath, id, prompt, saved.draftRevision);
        apply(next); playCompletionChime(); onFinished(); return true;
      }
      catch (error) {
        // send resolves after the model run, so a run error can follow successful message acceptance.
        if (requested && !accepted()) {
          try { const latest = (await api.list(projectPath)).find((s) => s.id === id); if (latest) apply(latest); }
          catch { /* Preserve the send error if the acceptance snapshot is unavailable. */ }
        }
        if (alive.current && !accepted() && clearedRevision !== undefined && sourceText && (draft(id).revision === clearedRevision || draft(id).text)) {
          const current = draft(id);
          const restored = current.revision === clearedRevision && !current.text ? sourceText : [sourceText, current.text].filter(Boolean).join("\n\n");
          if (restored.length <= 131072) setDraft(id, restored);
          else {
            updateGuidance([...guidance.current, { id: crypto.randomUUID(), sessionId: id, runId: `unsent:${crypto.randomUUID()}`, text: sourceText }]);
            onError(new Error("原消息和新草稿合计超过输入上限，原消息已保留在待引导消息中，整理草稿后可点击修改恢复。"));
          }
        }
        throw error;
      }
    } catch (error) { const sent = accepted(); if (alive.current && !(sent && records.current.find((s) => s.id === id)?.status === "cancelled")) onError(error); return sent; }
    finally { inFlight.current.delete(id); if (alive.current) setSending((current) => current.filter((item) => item !== id)); }
  }
  async function patch(id: string, patch: Parameters<ChatSessionsApi["patch"]>[2]) { const next = await api.patch(projectPath, id, patch); apply(next); }
  function stageDraft(id: string, images?: ChatImageAttachment[], snapshot?: PreparedDraftSnapshot) {
    const session = records.current.find(session => session.id === id);
    const current = draft(id);
    if (snapshot && (snapshot.draftRevision !== current.revision || snapshot.draftText !== current.text)) return false;
    const text = snapshot ? composePrompt(snapshot) : current.text;
    if (!session?.runId || !["running", "waiting"].includes(session.status) || (!text.trim() && !images?.length) || session.archived) return false;
    updateGuidance([...guidance.current, { id: crypto.randomUUID(), sessionId: id, runId: session.runId, text: text || "请查看附件并说明你观察到的内容。", ...(images?.length ? { images } : {}) }]);
    setDraft(id, "");
    return true;
  }
  async function guide(id: string) {
    const entry = guidance.current.find(entry => entry.id === id);
    if (!entry || entry.sending) return;
    updateGuidance(guidance.current.map(message => message.id === id ? { ...message, sending: true } : message));
    const accepted = () => records.current.find(session => session.id === entry.sessionId)?.items.some(item => item.id === `${entry.runId}:guidance:${entry.id}`);
    try {
      const next = entry.images?.length ? await api.guide(projectPath, entry.sessionId, entry.runId, entry.id, entry.text, entry.images) : await api.guide(projectPath, entry.sessionId, entry.runId, entry.id, entry.text);
      apply(next);
      updateGuidance(guidance.current.filter(message => message.id !== id));
    } catch (error) {
      if (!accepted()) {
        try { const latest = (await api.list(projectPath)).find(session => session.id === entry.sessionId); if (latest) apply(latest); } catch { /* Keep the original failure and staged text. */ }
      }
      if (accepted()) updateGuidance(guidance.current.filter(message => message.id !== id));
      else {
        updateGuidance(guidance.current.map(message => message.id === id ? { ...message, sending: false } : message));
        if (alive.current) onError(error);
      }
    }
  }
  function editGuidance(id: string) { const entry = guidance.current.find(entry => entry.id === id); if (entry && !entry.sending) restoreGuidance([entry]); }
  function removeGuidance(id: string) { updateGuidance(guidance.current.filter(entry => entry.id !== id || entry.sending)); }
  return { sessions, activeId, setActiveId: select, active: sessions.find((s) => s.id === activeId), creating, refresh, create, remove, apply, patch, send, sending, pendingGuidance: pendingGuidance.filter(entry => entry.sessionId === activeId), stageDraft, guide, editGuidance, removeGuidance, snapshotDraft: (id: string) => ({ ...draft(id) }), draft: activeId ? draft(activeId).text : "", setDraft: (text: string) => { if (activeId) setDraft(activeId, text); }, setDraftFor: (id: string, text: string) => setDraft(id, text), appendDraft: (id: string, addition: string) => { if (!alive.current) return; const text = draft(id).text + addition; if (text.length > 131072) throw new Error("消息已超过长度上限"); setDraft(id, text); }, draftTick };
}
