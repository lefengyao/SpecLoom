import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import type { DesktopApi } from "../shared/desktop-api";
import type { UsageRecord } from "../shared/contracts";
import "./usage.css";

const DAYS = 14;
const number = new Intl.NumberFormat("zh-CN");

function dateKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function projectName(path: string | undefined): string {
  if (!path) return "未归属";
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}
function formatNumber(value: number): string { return number.format(Math.round(value)); }
function formatTime(at: number): string { return new Date(at).toLocaleString(); }

export function UsageView({ api, onError }: { api: DesktopApi; onError: (error: unknown) => void }) {
  const [records, setRecords] = useState<UsageRecord[]>();
  const [project, setProject] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!api.usage) { setError("用量接口不可用。"); return; }
    setBusy(true); setError("");
    try { setRecords(await api.usage.list()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); onError(failure); }
    finally { setBusy(false); }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  const projects = useMemo(() => [...new Set((records ?? []).map((record) => record.workspaceId).filter((value): value is string => !!value))].sort(), [records]);
  const scoped = useMemo(() => (records ?? []).filter((record) => project === "all" || record.workspaceId === project), [records, project]);
  const totals = useMemo(() => scoped.reduce((result, record) => ({
    calls: result.calls + 1,
    prompt: result.prompt + record.promptTokens,
    completion: result.completion + record.completionTokens,
    cached: result.cached + record.cachedTokens,
  }), { calls: 0, prompt: 0, completion: 0, cached: 0 }), [scoped]);
  const days = useMemo(() => {
    const today = new Date(); const keys: string[] = [];
    for (let offset = DAYS - 1; offset >= 0; offset--) { const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset); keys.push(dateKey(date.getTime())); }
    const byDay = new Map(keys.map((key) => [key, { key, calls: 0, tokens: 0 }]));
    for (const record of scoped) { const day = byDay.get(dateKey(record.at)); if (day) { day.calls++; day.tokens += record.promptTokens + record.completionTokens; } }
    return [...byDay.values()];
  }, [scoped]);
  const maxDay = Math.max(1, ...days.map((day) => day.tokens));
  const models = useMemo(() => {
    const byModel = new Map<string, { provider: string; model: string; calls: number; prompt: number; completion: number; cached: number }>();
    for (const record of scoped) {
      const key = `${record.providerId}\0${record.model}`;
      const item = byModel.get(key) ?? { provider: record.providerName, model: record.model, calls: 0, prompt: 0, completion: 0, cached: 0 };
      item.calls++; item.prompt += record.promptTokens; item.completion += record.completionTokens; item.cached += record.cachedTokens;
      byModel.set(key, item);
    }
    return [...byModel.values()].sort((left, right) => right.calls - left.calls);
  }, [scoped]);
  const recent = useMemo(() => [...scoped].sort((left, right) => right.at - left.at).slice(0, 20), [scoped]);
  const cacheRate = totals.prompt > 0 ? totals.cached / totals.prompt : 0;

  return <section className="usage-view">
    <header className="usage-heading"><div><span className="usage-eyebrow">SPECLOOM</span><h1>用量</h1><p>模型调用按请求记录；缓存命中率 = 命中缓存的输入 token ÷ 输入 token。</p></div><div className="usage-actions"><label>项目<select value={project} onChange={(event) => setProject(event.target.value)}><option value="all">全部项目</option>{projects.map((path) => <option key={path} value={path}>{projectName(path)}</option>)}</select></label><button disabled={busy} onClick={() => void load()}><RefreshCw size={14} />刷新</button></div></header>
    {error && <p role="alert" className="usage-error">{error}</p>}
    {!records ? <p className="usage-empty">正在读取用量…</p> : records.length === 0 ? <div className="usage-empty-card"><BarChart3 size={28} /><h2>还没有用量记录</h2><p>完成一次模型请求后，这里会显示调用量、token 和缓存命中情况。</p><button disabled={busy} onClick={() => void load()}>刷新</button></div> : <>
      <div className="usage-cards">
        <article><span>调用次数</span><strong>{formatNumber(totals.calls)}</strong></article>
        <article><span>输入 token</span><strong>{formatNumber(totals.prompt)}</strong></article>
        <article><span>输出 token</span><strong>{formatNumber(totals.completion)}</strong></article>
        <article><span>缓存命中率</span><strong>{(cacheRate * 100).toFixed(1)}%</strong></article>
      </div>
      <section className="usage-panel"><div className="usage-panel-heading"><h2>最近 14 天</h2><span>{formatNumber(days.reduce((sum, day) => sum + day.calls, 0))} 次调用</span></div><div className="usage-chart" role="img" aria-label="最近 14 天 token 趋势">{days.map((day) => <div key={day.key} className="usage-bar-slot" title={`${day.key} · ${formatNumber(day.calls)} 次 · ${formatNumber(day.tokens)} token`}><div className="usage-bar" style={{ height: `${Math.max(day.tokens ? 4 : 0, (day.tokens / maxDay) * 100)}%` }} /><span>{day.key.slice(5)}</span></div>)}</div></section>
      <div className="usage-grid">
        <section className="usage-panel"><div className="usage-panel-heading"><h2>模型</h2><span>{models.length} 个</span></div><div className="usage-table"><div className="usage-table-row header"><span>模型</span><span>调用</span><span>输入</span><span>输出</span><span>缓存</span></div>{models.map((model) => <div key={`${model.provider}\0${model.model}`} className="usage-table-row"><span title={model.provider}>{model.model}</span><span>{formatNumber(model.calls)}</span><span>{formatNumber(model.prompt)}</span><span>{formatNumber(model.completion)}</span><span>{formatNumber(model.cached)}</span></div>)}</div></section>
        <section className="usage-panel"><div className="usage-panel-heading"><h2>最近调用</h2><span>最多 20 条</span></div><div className="usage-recent">{recent.map((record, index) => <div key={`${record.at}-${index}`} className="usage-recent-row"><div><b>{record.model}</b><small>{formatTime(record.at)} · {projectName(record.workspaceId)}</small></div><span>{formatNumber(record.promptTokens)} / {formatNumber(record.completionTokens)}</span></div>)}</div></section>
      </div>
    </>}
  </section>;
}
