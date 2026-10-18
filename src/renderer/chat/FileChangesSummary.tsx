import { useState } from "react";
import { Files } from "lucide-react";
import type { RunFileChanges } from "../../shared/chat";

const labels = { create: "新增", modify: "修改", delete: "删除" };

export function FileChangesSummary({ report }: { report: RunFileChanges }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? report.files : report.files.slice(0, 8);
  return <section className="file-changes-summary" role="region" aria-label="本次文件变更" data-run-id={report.runId}>
    <header><Files size={15} aria-hidden="true" /><strong>本次文件变更</strong><span>{report.files.length} 个文件</span></header>
    {!report.files.length ? <p>{report.complete ? "本次未检测到文件修改" : "暂未确认文件修改，检查范围受限"}</p> : <ul>{visible.map(file => <li key={file.path}>
      <span className={`file-change-operation is-${file.operation}`}>{labels[file.operation]}</span><code title={file.path}>{file.path}</code><small>{file.source === "tool" ? "编辑工具确认" : "运行期间检测"}</small>
    </li>)}</ul>}
    {report.files.length > 8 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起文件清单" : `展开其余 ${report.files.length - 8} 个文件`}</button>}
    {!report.complete && <p className="file-changes-notice">清单可能不完整</p>}
    {report.complete && report.notes.length ? <details className="file-changes-scope"><summary>检测说明</summary>{report.notes.map((note, index) => <p key={index}>{note}</p>)}</details> : report.notes.map((note, index) => <p className="file-changes-note" key={index}>{note}</p>)}
  </section>;
}
