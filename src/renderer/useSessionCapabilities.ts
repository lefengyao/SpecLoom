import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSession, ChatSessionsApi } from "../shared/chat";
import { errorMessage } from "../shared/error-message";

type Snapshot = Pick<ChatSession, "id" | "title" | "revision" | "updatedAt" | "archived" | "capabilities" | "capabilityError">;
const snapshot = ({ id, title, revision, updatedAt, archived, capabilities, capabilityError }: ChatSession): Snapshot => ({ id, title, revision, updatedAt, archived, ...(capabilities ? { capabilities } : {}), ...(capabilityError ? { capabilityError } : {}) });

/** Metadata only: browsing capabilities never starts a model or executes a Skill. */
export function useSessionCapabilities(api: ChatSessionsApi | undefined, projectPath: string | undefined, onError: (error: unknown) => void) {
  const [records, setRecords] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const updates = useRef(0);
  const refresh = useCallback(async () => {
    if (!api || projectPath === undefined) return;
    const current = ++generation.current; const startedAt = updates.current; setLoading(true); setError("");
    try {
      const list = await api.list(projectPath);
      if (current === generation.current) setRecords((previous) => {
        const next = updates.current !== startedAt ? [...previous] : previous.filter((record) => list.some((item) => item.id === record.id));
        for (const record of list) {
          const index = next.findIndex((item) => item.id === record.id);
          if (index < 0) next.push(snapshot(record));
          else if (next[index]!.revision < record.revision) next[index] = snapshot(record);
        }
        return next;
      });
    } catch (failure) {
      if (current === generation.current) { setError(errorMessage(failure)); onError(failure); }
    } finally { if (current === generation.current) setLoading(false); }
  }, [api, projectPath, onError]);
  useEffect(() => {
    setRecords([]); setError(""); setLoading(false);
    const unsubscribe = api?.subscribe((event) => {
      if (event.projectPath !== projectPath || event.sessionId !== event.session.id || event.runId !== event.session.runId || event.seq !== event.session.seq) return;
      updates.current++;
      const next = snapshot(event.session);
      setRecords((previous) => { const existing = previous.find((record) => record.id === next.id); if (existing && existing.revision >= next.revision) return previous; return [...previous.filter((record) => record.id !== next.id), next]; });
    });
    void refresh();
    return () => { generation.current++; unsubscribe?.(); };
  }, [api, projectPath, refresh]);
  const selected = [...records].filter((record) => !record.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return { capabilities: selected?.capabilities, sessionTitle: selected?.title, loading: loading || !!(selected && !selected.capabilities && !selected.capabilityError), error: error || selected?.capabilityError || "", discoveryError: !!selected?.capabilityError, refresh };
}
