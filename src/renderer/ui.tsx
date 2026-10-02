import { AlertCircle, Check, Copy, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export interface UiError {
  code: string;
  message: string;
  path?: string;
}
export function describeError(error: unknown): UiError {
  const value = error as {
    code?: string;
    message?: string;
    details?: { path?: string };
  };
  return {
    code: value?.code ?? "INTERNAL_ERROR",
    message: value?.message ?? "操作失败",
    ...(value?.details?.path ? { path: value.details.path } : {}),
  };
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function CopyButton({
  value,
  label = "复制",
  onError,
}: {
  value: string;
  label?: string;
  onError: (error: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "已复制" : label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, onError);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </IconButton>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLElement>("input, textarea, select, button")
      ?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key !== "Tab") return;
          const controls = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)",
            ) ?? []),
          ];
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="section-heading">
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
export function ErrorNotice({
  error,
  onDismiss,
  onReload,
  onRestart,
}: {
  error: UiError | undefined;
  onDismiss: () => void;
  onReload: () => void;
  onRestart: (() => void) | undefined;
}) {
  if (!error) return null;
  return (
    <div role="alert" className="error-notice">
      <AlertCircle size={18} />
      <div>
        <strong>{error.code}</strong>
        <span>{error.message}</span>
        {error.path && <code>{error.path}</code>}
      </div>
      <div className="error-actions">
        {error.code === "VERSION_CONFLICT" && (
          <>
            <button onClick={onReload}>重新读取</button>
            {onRestart && <button onClick={onRestart}>重新创建任务</button>}
          </>
        )}
        <IconButton label="关闭错误" onClick={onDismiss}>
          <X size={16} />
        </IconButton>
      </div>
    </div>
  );
}
export const statusLabels: Record<string, string> = {
  staged: "待审查",
  validated: "已验证",
  applied: "已提交",
  rejected: "已拒绝",
  conflicted: "版本冲突",
  failed: "失败",
  committing: "提交中",
  "recovery-conflict": "恢复冲突",
};
export const isTerminal = (status: string) =>
  ["applied", "rejected", "conflicted", "failed", "recovery-conflict"].includes(
    status,
  );
export function Status({
  status,
  running = false,
}: {
  status: string;
  running?: boolean;
}) {
  return (
    <span className={`status status-${running ? "running" : status}`}>
      {running ? "运行中" : (statusLabels[status] ?? status)}
    </span>
  );
}
