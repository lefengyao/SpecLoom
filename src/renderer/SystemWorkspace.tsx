import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { DocumentsView, type DocumentCategory, type MaterialDraft } from "./DocumentsView";
import { SystemWorkbench } from "./SystemWorkbench";
import { useI18n } from "./i18n";
import "./entity-workspace.css";
import "./system-workbench.css";

type SystemMode = "workbench" | "detail" | "source";

export interface SystemWorkspaceProps {
  api: DesktopApi;
  projectPath: string;
  onError: (value: unknown) => void;
  busy: boolean;
  revision: number;
  drafts: MaterialDraft[];
  onDraftsChange: Dispatch<SetStateAction<MaterialDraft[]>>;
  onSavingChange?: (saving: boolean) => void;
  onReloadHandled?: (sequence: number) => void;
  onOpenFileHandled?: (sequence: number) => void;
  reloadRequest?: { path: string; sequence: number };
  openFileRequest?: { path: string; sequence: number };
}

const modes: { id: SystemMode; label: string }[] = [
  { id: "workbench", label: "工作台" },
  { id: "detail", label: "详情" },
  { id: "source", label: "源码" },
];

/** System page shell: workbench, detail editor and source editor share one draft. */
export const SystemWorkspace = memo(function SystemWorkspace(props: SystemWorkspaceProps) {
  const tr = useI18n();
  const [mode, setMode] = useState<SystemMode>("workbench");
  const [detailVisited, setDetailVisited] = useState(false);
  const [detailRequest, setDetailRequest] = useState<{ path: string; sequence: number }>();
  const detailSequence = useRef(0);
  useEffect(() => {
    if (mode !== "workbench") setDetailVisited(true);
  }, [mode]);
  const openDetail = useCallback((path: string) => {
    setDetailVisited(true);
    setMode("detail");
    setDetailRequest({ path, sequence: ++detailSequence.current });
  }, []);
  const fileRequest = detailRequest ?? props.openFileRequest;

  return (
    <section className="entity-workspace" aria-label={tr("系统")}>
      <header className="entity-workspace-header">
        <div>
          <h1>{tr("系统")}</h1>
          <p className="subtle">{tr("在画布上挂载组件与决策树，或在详情 / 源码中编辑同一份资料。")}</p>
        </div>
        <div className="entity-workspace-modes" role="tablist" aria-label={tr("系统视图")}>
          {modes.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>
              {tr(item.label)}
            </button>
          ))}
        </div>
      </header>

      <div className="entity-workspace-pane" hidden={mode !== "workbench"}>
        <SystemWorkbench
          key={props.projectPath}
          api={props.api}
          projectPath={props.projectPath}
          onError={props.onError}
          onOpenDetail={openDetail}
        />
      </div>

      {detailVisited && (
        <div className="entity-workspace-pane" hidden={mode === "workbench"}>
          <DocumentsView
            key={props.projectPath}
            api={props.api}
            projectPath={props.projectPath}
            onError={props.onError}
            busy={props.busy}
            revision={props.revision}
            category={"system" as DocumentCategory}
            mode={mode === "source" ? "source" : "detail"}
            active={mode !== "workbench"}
            drafts={props.drafts}
            onDraftsChange={props.onDraftsChange}
            {...(props.onSavingChange ? { onSavingChange: props.onSavingChange } : {})}
            {...(props.reloadRequest ? { reloadRequest: props.reloadRequest } : {})}
            {...(props.onReloadHandled ? { onReloadHandled: props.onReloadHandled } : {})}
            {...(fileRequest ? { openFileRequest: fileRequest } : {})}
            onOpenFileHandled={(sequence) => {
              if (detailRequest?.sequence === sequence) setDetailRequest(undefined);
              props.onOpenFileHandled?.(sequence);
            }}
          />
        </div>
      )}
    </section>
  );
});
