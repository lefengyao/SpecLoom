import type { AttachmentEntry } from "./attachment-ingest";
import { useI18n } from "../i18n";

export function AttachmentTray({ entries, onRemove }: { entries: AttachmentEntry[]; onRemove(id: string): void }) {
  const tr = useI18n();
  if (!entries.length) return null;
  return <div className="attachment-tray" aria-label={tr("待发送附件")}>
    {entries.map(entry => <section key={entry.id} className="attachment-card" aria-label={tr("附件 {name}", { name: entry.name })}>
      {entry.value?.kind === "image" && <img alt={entry.name} src={`data:${entry.value.image.mimeType};base64,${entry.value.image.base64}`} />}
      <div><strong title={entry.name}>{entry.name}</strong><small>{(entry.size / 1024).toFixed(1)} KiB{entry.status === "pending" ? ` · ${tr("读取中…")}` : entry.status === "error" ? ` · ${tr("失败")}` : ` · ${tr("已就绪")}`}</small>
        {entry.error && <span role="alert">{entry.error}</span>}
        {entry.value?.kind === "document" && <details><summary>{tr("查看提取正文")}</summary>{entry.value.notices.map((notice, index) => <p key={index}>{notice}</p>)}<pre>{entry.value.text}</pre></details>}
      </div><button type="button" aria-label={tr("移除附件 {name}", { name: entry.name })} onClick={() => onRemove(entry.id)}>×</button>
    </section>)}
  </div>;
}
