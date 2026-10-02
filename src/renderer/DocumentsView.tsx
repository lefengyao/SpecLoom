import { FilePlus2, FileText, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import type { FileReadResult } from "../shared/contracts";
import { IconButton } from "./ui";
import { NewEntity, NewSpec } from "./AuthoringForms";

interface DocumentVersion {
  path: string;
  version: string;
  size: number;
}
export function DocumentsView({
  api,
  onError,
  onStage,
  busy,
  revision,
}: {
  api: DesktopApi;
  onError: (value: unknown) => void;
  onStage: (
    path: string,
    content: string,
    version?: string,
  ) => Promise<boolean>;
  busy: boolean;
  revision: number;
}) {
  const [documents, setDocuments] = useState<DocumentVersion[]>([]);
  const [file, setFile] = useState<FileReadResult>();
  const requestedPath = useRef<string>(undefined);
  const readRequest = useRef(0);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [entityForm, setEntityForm] = useState(false);
  const [specForm, setSpecForm] = useState(false);
  const refresh = useCallback(async () => {
    setDocuments(await api.documents());
  }, [api]);
  useEffect(() => {
    void refresh().catch(onError);
  }, [refresh, onError]);
  useEffect(() => {
    if (!revision) return;
    const path = requestedPath.current;
    const request = ++readRequest.current;
    setLoading(true);
    void api
      .documents()
      .then(async (next) => {
        if (request !== readRequest.current) return;
        setDocuments(next);
        if (!path) return;
        const updated = next.find((document) => document.path === path);
        if (!updated) {
          setFile(undefined);
          setText("");
          return;
        }
        const result = await api.readDocument(updated.path, updated.version);
        if (request === readRequest.current) {
          setFile(result);
          setText(result.content);
        }
      })
      .catch((error) => {
        if (request === readRequest.current) onError(error);
      })
      .finally(() => {
        if (request === readRequest.current) setLoading(false);
      });
  }, [api, onError, revision]);
  useEffect(
    () => () => {
      readRequest.current++;
    },
    [],
  );
  async function read(document: DocumentVersion) {
    const request = ++readRequest.current;
    requestedPath.current = document.path;
    setLoading(true);
    try {
      const result = await api.readDocument(document.path, document.version);
      if (request !== readRequest.current) return;
      setFile(result);
      setText(result.content);
    } catch (value) {
      if (request === readRequest.current) onError(value);
    } finally {
      if (request === readRequest.current) setLoading(false);
    }
  }
  return (
    <div className="documents-layout">
      <aside className="document-sidebar">
        <header className="section-heading">
          <h2>规范与实体</h2>
          <div className="toolbar">
            <IconButton label="新建规范" onClick={() => setSpecForm(true)}>
              <FilePlus2 size={17} />
            </IconButton>
            <IconButton
              label="刷新文档"
              onClick={() => {
                void refresh().catch(onError);
              }}
            >
              <RefreshCw size={16} />
            </IconButton>
          </div>
        </header>
        <button className="entity-create" onClick={() => setEntityForm(true)}>
          <FilePlus2 size={16} />
          新建实体
        </button>
        <div className="document-list">
          {documents.map((document) => (
            <button
              className={file?.path === document.path ? "selected" : ""}
              key={document.path}
              onClick={() => {
                void read(document);
              }}
            >
              <FileText size={15} />
              <span>{document.path.replace(/^specs\//, "")}</span>
            </button>
          ))}
        </div>
      </aside>
      <section className="document-editor">
        {file ? (
          <>
            <header className="section-heading">
              <div>
                <h2>{file.path}</h2>
                <code className="version-text" title={file.version}>
                  {file.version}
                </code>
              </div>
              <button
                className="primary"
                disabled={busy || loading || file.content === text}
                onClick={() => {
                  void onStage(file.path, text, file.version);
                }}
              >
                <Save size={16} />
                暂存编辑
              </button>
            </header>
            <textarea
              aria-label="文档内容"
              className="markdown-editor"
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={loading}
            />
          </>
        ) : (
          <div className="empty-state">
            {loading ? "读取中…" : "选择规范或实体"}
          </div>
        )}
      </section>
      {entityForm && (
        <NewEntity
          busy={busy}
          onClose={() => setEntityForm(false)}
          onStage={onStage}
        />
      )}
      {specForm && (
        <NewSpec
          busy={busy}
          onClose={() => setSpecForm(false)}
          onStage={onStage}
        />
      )}
    </div>
  );
}
