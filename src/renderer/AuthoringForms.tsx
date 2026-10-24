import { Save } from "lucide-react";
import { useState } from "react";
import { stringify } from "yaml";
import { createMaterialId, writeMaterial, type ComponentField } from "../shared/project-materials";
import { Modal } from "./ui";
import { useI18n } from "./i18n";

export interface EntityOption { id: string; title?: string; type: string }

interface MaterialFormProps {
  busy: boolean;
  onClose: () => void;
  onSave: (path: string, content: string, version?: string) => Promise<boolean>;
}

export function NewEntity({ kind = "entity", initialParent, ...props }: MaterialFormProps & { kind?: "entity" | "map"; initialParent?: string }) {
  return kind === "map" ? <NewMap {...props} /> : <EntityCreation {...props} {...(initialParent ? { initialParent } : {})} />;
}

function EntityCreation({ busy, onClose, onSave, initialParent }: MaterialFormProps & { initialParent?: string }) {
  const tr = useI18n();
  const [name, setName] = useState("");
  return <Modal title={tr("新建实体")} onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      const title = name.trim();
      if (!title) return;
      const id = createMaterialId("entity", title);
      const content = writeMaterial({
        schemaVersion: 1,
        id,
        type: "entity",
        title,
        description: "",
        status: "draft",
        version: 1,
        relations: [],
        source: "developer",
        components: [],
        ...(initialParent?.trim() ? { parent: initialParent.trim() } : {}),
      }, `\n# ${title}\n`);
      void onSave(`specs/entities/${id}.md`, content, "absent").then((ok) => { if (ok) onClose(); });
    }}>
      <label>{tr("名称")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="subtle">{tr("创建后可以填写详细内容、设置父级和继承关系，并添加组件。")}</p>
      <footer className="form-actions">
        <button type="button" onClick={onClose}>{tr("取消")}</button>
        <button className="primary" disabled={busy || !name.trim()}><Save size={16} />{tr("创建实体")}</button>
      </footer>
    </form>
  </Modal>;
}

const componentTemplates: Record<string, { name: string; fields: ComponentField[] }> = {
  blank: { name: "", fields: [] },
  health: { name: "生命值", fields: [
    { key: "current", label: "当前值", type: "number", default: 100 },
    { key: "max", label: "上限", type: "number", default: 100 },
  ] },
  position: { name: "坐标", fields: [
    { key: "x", label: "X", type: "number", default: 0 },
    { key: "y", label: "Y", type: "number", default: 0 },
  ] },
  speed: { name: "速度", fields: [{ key: "value", label: "速度", type: "number", default: 180 }] },
};

export function NewComponent({ busy, onClose, onSave }: MaterialFormProps) {
  const tr = useI18n();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  return <Modal title={tr("新建组件")} onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      const title = name.trim();
      if (!title) return;
      const id = createMaterialId("component", title);
      const content = writeMaterial({ schemaVersion: 1, id, type: "component", scope: "user", title, description: "", fields: componentTemplates[template]!.fields }, `\n# ${title}\n`);
      void onSave(`specs/components/${id}.md`, content, "absent").then((ok) => { if (ok) onClose(); });
    }}>
      <label>{tr("组件模板")}<select aria-label={tr("组件模板")} value={template} onChange={(event) => {
        const value = event.target.value;
        setTemplate(value);
        setName(componentTemplates[value]!.name);
      }}>
        <option value="blank">{tr("空白组件")}</option>
        <option value="health">{tr("生命值")}</option>
        <option value="position">{tr("坐标")}</option>
        <option value="speed">{tr("速度")}</option>
      </select></label>
      <label>{tr("名称")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="subtle">{tr("创建后可以定义组件字段、类型和默认值，再将组件添加到实体。")}</p>
      <footer className="form-actions">
        <button type="button" onClick={onClose}>{tr("取消")}</button>
        <button className="primary" disabled={busy || !name.trim()}><Save size={16} />{tr("创建组件")}</button>
      </footer>
    </form>
  </Modal>;
}

function NewMap({ busy, onClose, onSave }: MaterialFormProps) {
  const tr = useI18n();
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("## 职责\n\n\n## 行为\n\n\n## 生成边界\n\n");
  const [status, setStatus] = useState("draft");
  const [relations, setRelations] = useState("");
  const [source, setSource] = useState("developer");
  return (
    <Modal title={tr("新建地图")} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const content = `---\n${stringify({
            schemaVersion: 1,
            id,
            type: "map",
            title: title.trim() || id,
            description: "",
            status,
            version: 1,
            relations: relations
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            source,
          })}---\n\n# ${title || id}\n\n${body}`;
          void onSave(
            `specs/maps/${id}.md`,
            content,
            "absent",
          ).then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <div className="form-row">
          <label>
            {tr("地图 ID")}
            <input
              required
              pattern="[a-z][a-z0-9_-]*"
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
        </div>
        <label>
          {tr("名称")}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            {tr("状态")}
            <select
              aria-label={tr("状态")}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option>draft</option>
              <option>active</option>
              <option>archived</option>
            </select>
          </label>
          <label>
            {tr("来源")}
            <input
              required
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
        </div>
        <label>
          {tr("关联实体")}
          <input
            value={relations}
            onChange={(event) => setRelations(event.target.value)}
          />
        </label>
        <label>
          {tr("Markdown 内容")}
          <textarea
            rows={7}
            value={body}
            required
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            {tr("取消")}
          </button>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            {tr("创建地图")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function NewSpec({
  kind = "spec",
  busy,
  onClose,
  onSave,
}: {
  kind?: "spec" | "setting" | "ui" | "system" | "feature" | "decision" | "decision_tree";
  busy: boolean;
  onClose: () => void;
  onSave: (
    path: string,
    content: string,
    version?: string,
  ) => Promise<boolean>;
}) {
  const tr = useI18n();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [parent, setParent] = useState("");
  const formTitle = kind === "setting" ? tr("新建设定") : kind === "ui" ? tr("新建 UI") : kind === "system" ? tr("新建系统") : kind === "feature" ? tr("新建功能") : kind === "decision" ? tr("新建架构决策") : kind === "decision_tree" ? tr("新建决策树") : tr("新建规范");
  const submitLabel = kind === "setting" ? tr("创建设定") : kind === "ui" ? tr("创建 UI") : kind === "system" ? tr("创建系统") : kind === "feature" ? tr("创建功能") : kind === "decision" ? tr("创建架构决策") : kind === "decision_tree" ? tr("创建决策树") : tr("创建规范");
  const directory = kind === "spec" || kind === undefined ? "specs" : kind === "setting" ? "specs/settings" : kind === "ui" ? "specs/ui" : `specs/${kind}s`;
  return (
    <Modal title={formTitle} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const status = kind === "feature" ? { status: "planned" } : kind === "decision" ? { status: "proposed" } : {};
          const text = `---\n${stringify({ schemaVersion: 1, id: name, title, description: "", ...(kind === "spec" || kind === undefined ? {} : { type: kind }), ...status, ...(parent.trim() ? { parent: parent.trim() } : {}) })}---\n\n# ${title}\n\n${content}`;
          void onSave(`${directory}/${name}.md`, text, "absent").then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <label>
          {tr("文件名称")}
          <input
            required
            pattern={kind === "decision" ? "[0-9]{4}-[a-z0-9-]+" : "[a-z][a-z0-9_-]*"}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {tr("标题")}
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {kind !== "spec" && kind !== "decision" && <label>
          {tr("父级资料 ID（可选）")}
          <input aria-label={tr("父级资料 ID")} value={parent} onChange={(event) => setParent(event.target.value)} placeholder={tr("例如 world 或 combat")} />
        </label>}
        {kind === "decision" && <p className="subtle">{tr("文件名使用四位编号，例如 0002-shared-armor-slots。")}</p>}
        {kind === "system" && <p className="subtle">{tr("创建后可在前端 matter 里填写 components、entities 与 dependsOn。")}</p>}
        {kind === "feature" && <p className="subtle">{tr("创建后会带上 status: planned；用 systems 关联系统，状态可改为 active 或 done。")}</p>}
        <label>
          {tr("Markdown 正文")}
          <textarea
            required
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            {tr("取消")}
          </button>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            {submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
