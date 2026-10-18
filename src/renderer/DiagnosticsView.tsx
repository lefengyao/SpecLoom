import { useCallback, useEffect, useState } from "react";
import type { DiagnosticEvent, DiagnosticQuery } from "../shared/diagnostics";
import type { DiagnosticsApi } from "../shared/desktop-api";

const eventLabels: Record<DiagnosticEvent["type"], string> = {
  request_started: "请求开始",
  connection_error: "连接失败",
  response_headers: "收到响应头",
  first_stream_data: "收到首段数据",
  stream_read_error: "流读取失败",
  protocol_parse_error: "协议解析失败",
  retry_scheduled: "计划重试",
  request_completed: "请求完成",
  request_failed: "请求失败",
};
const fieldLabels: Record<string, string> = {
  diagnosticId: "诊断编号", sessionId: "会话", runId: "运行", providerId: "供应商", modelId: "模型",
  protocol: "协议", attempt: "尝试", round: "轮次", status: "HTTP 状态", mediaType: "媒体类型",
  elapsedMs: "耗时（毫秒）", receivedBytes: "接收字节", receivedFrames: "接收帧数",
  completionReceived: "收到完成信号", errorCategory: "错误类别", causeCode: "安全错误码",
  retryLimitReached: "达到重试上限", at: "时间", severity: "级别", eventId: "事件编号",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function EventCard({ event }: { event: DiagnosticEvent }) {
  const visibleFields = Object.entries(event).filter(([key]) => key !== "schemaVersion");
  return <article className={"diagnostic-event diagnostic-" + (event.severity ?? "info")}>
    <header>
      <div><strong>{eventLabels[event.type]}</strong><span>{new Date(event.at).toLocaleString()}</span></div>
      <span className="diagnostic-event-meta">{(event.protocol ?? "未知协议") + " · " + (event.modelId ?? "未知模型") + (event.attempt ? " · 第 " + event.attempt + " 次尝试" : "")}</span>
    </header>
    <details>
      <summary>查看安全诊断字段</summary>
      <dl>{visibleFields.map(([key, value]) => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd>{typeof value === "boolean" ? value ? "是" : "否" : String(value)}</dd></div>)}</dl>
    </details>
  </article>;
}

export function DiagnosticsView({ api }: { api: DiagnosticsApi }) {
  const [summary, setSummary] = useState<Awaited<ReturnType<DiagnosticsApi["summary"]>>>();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [text, setText] = useState("");
  const [diagnosticId, setDiagnosticId] = useState("");
  const [query, setQuery] = useState<DiagnosticQuery>({ limit: 200 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (nextQuery: DiagnosticQuery) => {
    setLoading(true); setError("");
    try {
      const [nextSummary, result] = await Promise.all([api.summary(), api.list(nextQuery)]);
      setSummary(nextSummary); setEvents(result.events);
      if (result.readIssues) setNotice("有 " + result.readIssues + " 条日志记录损坏，已跳过。");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "无法读取诊断日志。");
    } finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh({ limit: 200 }); }, [api, refresh]);

  async function applyFilter() {
    const id = diagnosticId.trim();
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setError("诊断编号格式无效。"); return;
    }
    const next: DiagnosticQuery = { limit: 200, ...(id ? { diagnosticId: id } : {}), ...(text.trim() ? { text: text.trim() } : {}) };
    setQuery(next); await refresh(next);
  }
  async function clearExpired() {
    try { const count = await api.clearExpired(); setNotice("已清理 " + count + " 个过期日志文件。"); await refresh(query); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "清理过期日志失败。"); }
  }
  async function clearAll() {
    if (!window.confirm("清空全部诊断日志？此操作无法撤销。")) return;
    try { const count = await api.clearAll(); setNotice("已清空 " + count + " 个日志文件。"); await refresh(query); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "清空诊断日志失败。"); }
  }
  async function exportLogs() {
    try {
      const saved = await api.export();
      setNotice(saved ? "已导出诊断日志。" : "已取消导出。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导出诊断日志失败。"); }
  }

  return <section className="settings-group settings-group-wide diagnostics-view" aria-label="诊断日志">
    <h2>诊断日志</h2>
    <p className="field-hint">用于定位模型请求阶段与传输错误。日志不包含提示词、回复、工具参数或凭据。</p>
    {summary && <div className="diagnostics-summary" aria-label="日志保留情况">
      <span>{summary.files} 个文件 · {formatBytes(summary.bytes)} · {summary.events} 条事件</span>
      <span>保留 {summary.retentionDays} 天 · 上限 {formatBytes(summary.maxBytes)} · 单文件 {formatBytes(summary.maxFileBytes)}</span>
      {summary.cleanupError && <span role="status">{summary.cleanupError}</span>}
      {summary.readIssues > 0 && <span>{summary.readIssues} 条记录无法读取</span>}
    </div>}
    <div className="diagnostics-controls">
      <label>诊断编号筛选<input aria-label="诊断编号筛选" value={diagnosticId} onChange={event => setDiagnosticId(event.target.value)} placeholder="粘贴会话中的诊断编号" /></label>
      <label>文本筛选<input aria-label="文本筛选" value={text} onChange={event => setText(event.target.value)} placeholder="模型、协议、错误类别" maxLength={200} /></label>
      <button type="button" onClick={() => void applyFilter()} disabled={loading}>筛选</button>
      <button type="button" onClick={() => void refresh({ limit: 200 })} disabled={loading}>刷新</button>
    </div>
    <div className="diagnostics-actions">
      <button type="button" onClick={() => void exportLogs()}>导出日志</button>
      <button type="button" onClick={() => void clearExpired()}>清理过期日志</button>
      <button type="button" onClick={() => void clearAll()}>清空全部日志</button>
    </div>
    {error && <p className="run-error" role="alert">{error}</p>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
    {loading && <p className="field-hint">正在读取日志…</p>}
    {!loading && !events.length && <p className="empty-state">没有符合条件的诊断事件。</p>}
    <div className="diagnostics-events">{events.map(event => <EventCard key={event.eventId} event={event} />)}</div>
  </section>;
}
