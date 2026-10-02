import { Save } from "lucide-react";
import { useState } from "react";
import { stringify } from "yaml";
import { Modal } from "./ui";

const folders = {
  character: "characters",
  map: "maps",
  system: "systems",
  item: "items",
  event: "events",
};

export function NewEntity({
  busy,
  onClose,
  onStage,
}: {
  busy: boolean;
  onClose: () => void;
  onStage: (
    path: string,
    content: string,
    version?: string,
  ) => Promise<boolean>;
}) {
  const [id, setId] = useState("");
  const [type, setType] = useState<keyof typeof folders>("character");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("## 职责\n\n\n## 行为\n\n\n## 生成边界\n\n");
  const [status, setStatus] = useState("draft");
  const [relations, setRelations] = useState("");
  const [source, setSource] = useState("developer");
  return (
    <Modal title="新建实体" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const content = `---\n${stringify({
            id,
            type,
            status,
            version: 1,
            relations: relations
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            source,
          })}---\n\n# ${title || id}\n\n${body}`;
          void onStage(
            `specs/entities/${folders[type]}/${id}.md`,
            content,
            "absent",
          ).then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <div className="form-row">
          <label>
            实体 ID
            <input
              required
              pattern="[a-z][a-z0-9_-]*"
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label>
            类型
            <select
              aria-label="类型"
              value={type}
              onChange={(event) =>
                setType(event.target.value as keyof typeof folders)
              }
            >
              {Object.keys(folders).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          名称
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            状态
            <select
              aria-label="状态"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option>draft</option>
              <option>active</option>
              <option>archived</option>
            </select>
          </label>
          <label>
            来源
            <input
              required
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
        </div>
        <label>
          关联实体
          <input
            value={relations}
            onChange={(event) => setRelations(event.target.value)}
          />
        </label>
        <label>
          Markdown 内容
          <textarea
            rows={7}
            value={body}
            required
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            暂存实体
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function NewSpec({
  busy,
  onClose,
  onStage,
}: {
  busy: boolean;
  onClose: () => void;
  onStage: (
    path: string,
    content: string,
    version?: string,
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  return (
    <Modal title="新建规范" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const text = `---\n${stringify({ schemaVersion: 1, id: name, title, description: "" })}---\n\n# ${title}\n\n${content}`;
          void onStage(`specs/${name}.md`, text, "absent").then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <label>
          文件名称
          <input
            required
            pattern="[a-z][a-z0-9_-]*"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          标题
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Markdown 正文
          <textarea
            required
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            暂存规范
          </button>
        </footer>
      </form>
    </Modal>
  );
}
