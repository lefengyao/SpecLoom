import { AlertCircle, Check, Copy, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
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
/** Human-readable age of an ISO timestamp, for the recently opened project list. */
export function formatRelativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 45) return "刚刚";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
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

type EditableTarget = HTMLInputElement | HTMLTextAreaElement;
export type EditablePasteHandler = (selection: { start: number; end: number }) => void | Promise<void>;
const editablePasteHandlers = new WeakMap<EditableTarget, () => EditablePasteHandler>();
export function registerEditablePaste(target: EditableTarget, capture: () => EditablePasteHandler): () => void {
  editablePasteHandlers.set(target, capture);
  return () => { if (editablePasteHandlers.get(target) === capture) editablePasteHandlers.delete(target); };
}
type ContextAction = "copy" | "cut" | "paste";
interface ContextMenuState {
  paste?: EditablePasteHandler;
  target: EditableTarget;
  start: number;
  end: number;
  x: number;
  y: number;
  canCopy: boolean;
  canCut: boolean;
  canPaste: boolean;
}

function isEditableTarget(value: EventTarget | null): value is EditableTarget {
  if (value instanceof HTMLTextAreaElement) return true;
  if (!(value instanceof HTMLInputElement)) return false;
  return value.selectionStart !== null;
}

function selectionFor(target: EditableTarget): { start: number; end: number } {
  return {
    start: target.selectionStart ?? 0,
    end: target.selectionEnd ?? target.selectionStart ?? 0,
  };
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document.execCommand === "function" && document.execCommand("copy")) return;
  throw new Error("Clipboard access is unavailable");
}

function dispatchInput(target: EditableTarget): void {
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

/** App-wide text editing context menu for the native input and textarea controls. */
export function ContextMenu({
  children,
  onError,
}: {
  children: ReactNode;
  onError?: (error: unknown) => void;
}) {
  const [menu, setMenu] = useState<ContextMenuState>();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(event: Event) {
      if (event.type === "pointerdown" && menuRef.current?.contains(event.target as Node)) return;
      setMenu(undefined);
    }
    function handleContextMenu(event: MouseEvent) {
      const target = event.target;
      if (!isEditableTarget(target) || target.disabled) return;
      const { start, end } = selectionFor(target);
      event.preventDefault();
      setMenu({
        target,
        ...(editablePasteHandlers.has(target) ? { paste: editablePasteHandlers.get(target)!() } : {}),
        start,
        end,
        x: event.clientX,
        y: event.clientY,
        canCopy: end > start,
        canCut: end > start && !target.readOnly,
        canPaste: !target.readOnly,
      });
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(undefined);
    }
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  async function run(action: ContextAction): Promise<void> {
    if (!menu) return;
    const { target, start, end } = menu;
    if (!target.isConnected) {
      setMenu(undefined);
      return;
    }
    target.focus();
    target.setSelectionRange(start, end);
    try {
      if (action === "copy") {
        await writeClipboard(target.value.slice(start, end));
      } else if (action === "cut") {
        await writeClipboard(target.value.slice(start, end));
        target.setRangeText("", start, end, "start");
        dispatchInput(target);
      } else {
        if (menu.paste) await menu.paste({ start, end });
        else {
          if (!navigator.clipboard?.readText) throw new Error("Clipboard access is unavailable");
          const pasted = await navigator.clipboard.readText();
          target.setRangeText(pasted, start, end, "end");
          dispatchInput(target);
        }
      }
    } catch (error) {
      onError?.(error);
    } finally {
      setMenu(undefined);
    }
  }

  const position: CSSProperties | undefined = menu
    ? {
        left: Math.min(Math.max(4, menu.x), Math.max(4, window.innerWidth - 188)),
        top: Math.min(Math.max(4, menu.y), Math.max(4, window.innerHeight - 130)),
      }
    : undefined;
  return (
    <>
      {children}
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          style={position}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" disabled={!menu.canCopy} onClick={() => void run("copy")}>
            <span>复制</span><kbd>Ctrl+C</kbd>
          </button>
          <button type="button" role="menuitem" disabled={!menu.canCut} onClick={() => void run("cut")}>
            <span>剪切</span><kbd>Ctrl+X</kbd>
          </button>
          <button type="button" role="menuitem" disabled={!menu.canPaste} onClick={() => void run("paste")}>
            <span>粘贴</span><kbd>Ctrl+V</kbd>
          </button>
        </div>
      )}
    </>
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
