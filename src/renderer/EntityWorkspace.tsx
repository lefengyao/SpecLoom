import { useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { DocumentsView, type DocumentCategory, type MaterialDraft } from "./DocumentsView";
import { EntityWorkbench } from "./EntityWorkbench";
import "./entity-workspace.css";

type EntityMode = "workbench" | "detail" | "source";

export interface EntityWorkspaceProps {
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

const modes: { id: EntityMode; label: string }[] = [
  { id: "workbench", label: "工作台" },
  { id: "detail", label: "详情" },
  { id: "source", label: "源码" },
];

/**
 * Entity page shell. The workbench, the normal material detail editor, and the
 * source editor stay mounted so switching modes does not discard the workbench
 * draft. DocumentsView receives the source/detail mode from this shell.
 */
export function EntityWorkspace(props: EntityWorkspaceProps) {
  const [mode, setMode] = useState<EntityMode>("workbench");

  return (
    <section className="entity-workspace" aria-label="实体">
      <header className="entity-workspace-header">
        <div>
          <h1>实体</h1>
          <p className="subtle">在画布上拼接组件，或在详情 / 源码中编辑同一份资料。</p>
        </div>
        <div className="entity-workspace-modes" role="tablist" aria-label="实体视图">
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="entity-workspace-pane" hidden={mode !== "workbench"}>
        <EntityWorkbench
          key={props.projectPath}
          api={props.api}
          projectPath={props.projectPath}
          onError={props.onError}
        />
      </div>

      <div className="entity-workspace-pane" hidden={mode === "workbench"}>
        <DocumentsView
          key={props.projectPath}
          api={props.api}
          projectPath={props.projectPath}
          onError={props.onError}
          busy={props.busy}
          revision={props.revision}
          category={"entity" as DocumentCategory}
          mode={mode === "source" ? "source" : "detail"}
          active={mode !== "workbench"}
          drafts={props.drafts}
          onDraftsChange={props.onDraftsChange}
          {...(props.onSavingChange ? { onSavingChange: props.onSavingChange } : {})}
          {...(props.reloadRequest ? { reloadRequest: props.reloadRequest } : {})}
          {...(props.onReloadHandled ? { onReloadHandled: props.onReloadHandled } : {})}
          {...(props.openFileRequest ? { openFileRequest: props.openFileRequest } : {})}
          {...(props.onOpenFileHandled ? { onOpenFileHandled: props.onOpenFileHandled } : {})}
        />
      </div>
    </section>
  );
}
