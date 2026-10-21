import { CheckCheck, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ChangeReview } from "../shared/desktop-api";
import type { ValidationResult } from "../shared/contracts";
import { useI18n } from "./i18n";
import { IconButton, isTerminal, Status } from "./ui";

function DiffText({
  content,
  other,
  kind,
}: {
  content: string;
  other: string;
  kind: "before" | "after";
}) {
  const lines = content.split("\n"),
    otherLines = other.split("\n");
  return (
    <pre className="diff-code">
      {lines.map((line, index) => (
        <span
          key={index}
          className={line !== otherLines[index] ? `diff-${kind}` : ""}
        >
          <i>{index + 1}</i>
          <code>{line || " "}</code>
        </span>
      ))}
    </pre>
  );
}
export function ValidationReport({
  result,
}: {
  result: ValidationResult | undefined;
}) {
  const tr = useI18n();
  const labels = { pass: "验证通过", fail: "验证失败", skipped: "验证跳过" };
  return (
    <section className="validation-report" aria-label={tr("验证结果")}>
      <strong className={`validation-${result?.status ?? "unknown"}`}>
        {result ? tr(labels[result.status]) : tr("尚未验证")}
      </strong>
      {result && (
        <>
          <ul className="check-list">
            {result.checks.map((check) => (
              <li key={check.id}>
                <span className={`validation-${check.status}`}>
                  {check.status === "pass"
                    ? tr("通过")
                    : check.status === "fail"
                      ? tr("失败")
                      : tr("跳过")}
                </span>
                {check.name}
                {check.exitCode !== undefined && (
                  <code>exit {check.exitCode}</code>
                )}
                {(check.stderr || check.stdout) && (
                  <details>
                    <summary>{tr("输出")}</summary>
                    <pre>{check.stderr || check.stdout}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {result.diagnostics.map((diagnostic, index) => (
            <p
              className={`diagnostic diagnostic-${diagnostic.severity}`}
              key={index}
            >
              <b>{diagnostic.code ?? diagnostic.severity}</b>{" "}
              {diagnostic.message}
              {diagnostic.path && (
                <code>
                  {diagnostic.path}
                  {diagnostic.line ? `:${diagnostic.line}` : ""}
                </code>
              )}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
export function ReviewPane({
  review,
  running,
  busy,
  onRefresh,
  onValidate,
  onApprove,
  onReject,
}: {
  review: ChangeReview | undefined;
  running: boolean;
  busy: boolean;
  onRefresh: () => void;
  onValidate: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const tr = useI18n();
  const entries = review?.changeSet.entries ?? [];
  const final = review && isTerminal(review.changeSet.status);
  return (
    <section className="review-pane">
      <header className="section-heading">
        <div>
          <h2>{tr("变更审查")}</h2>
          <span className="subtle">{tr("{count} 个文件", { count: entries.length })}</span>
        </div>
        <div className="toolbar">
          {review && <Status status={review.changeSet.status} />}
          <IconButton
            label={tr("刷新变更")}
            disabled={busy || running}
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </IconButton>
        </div>
      </header>
      <ValidationReport result={review?.validation} />
      <div className="change-list">
        {entries.length === 0 ? (
          <p className="empty-state">{tr("暂无暂存变更")}</p>
        ) : (
          entries.map((entry) => {
            const before = review?.before[entry.path] ?? "",
              after = entry.nextContent ?? "";
            return (
              <article className="file-diff" key={entry.path}>
                <header>
                  <code>{entry.path}</code>
                  <span>
                    {entry.operation === "create"
                      ? tr("新增")
                      : entry.operation === "delete"
                        ? tr("删除")
                        : tr("修改")}
                  </span>
                </header>
                <div className="diff-columns">
                  <section>
                    <h3>{tr("提交前")}</h3>
                    <DiffText content={before} other={after} kind="before" />
                  </section>
                  <section>
                    <h3>{tr("提交后")}</h3>
                    <DiffText content={after} other={before} kind="after" />
                  </section>
                </div>
              </article>
            );
          })
        )}
      </div>
      {review && entries.length > 0 && (
        <footer className="review-footer">
          <code className="digest" title={review.changeSet.digest}>
            {tr("摘要 {digest}", { digest: review.changeSet.digest })}
          </code>
          <div className="toolbar">
            <button
              disabled={
                busy ||
                running ||
                (!!final && review.changeSet.status !== "applied")
              }
              onClick={onValidate}
            >
              <ShieldCheck size={16} />
              {tr("验证")}
            </button>
            <button disabled={busy || running || !!final} onClick={onReject}>
              <X size={16} />
              {tr("拒绝变更")}
            </button>
            <button
              className="primary"
              disabled={busy || running || !!final}
              onClick={onApprove}
            >
              <CheckCheck size={16} />
              {tr("批准并提交")}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}
