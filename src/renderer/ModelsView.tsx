import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ModelProfile } from "../shared/contracts";
import { IconButton, Modal } from "./ui";

export function ModelsView({
  models,
  busy,
  onSave,
  onRemove,
}: {
  models: ModelProfile[];
  busy: boolean;
  onSave: (profile: ModelProfile, secret?: string) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<ModelProfile | "new">();
  return (
    <section className="standard-view">
      <header className="section-heading">
        <div>
          <h1>模型</h1>
          <span className="subtle">OpenAI 兼容端点</span>
        </div>
        <button className="primary" onClick={() => setEditing("new")}>
          <Plus size={16} />
          添加模型
        </button>
      </header>
      <div className="model-table">
        <div className="table-heading">
          <span>配置</span>
          <span>模型与端点</span>
          <span>授权</span>
          <span>操作</span>
        </div>
        {models.map((profile) => (
          <div className="model-table-row" key={profile.id}>
            <div>
              <strong>{profile.name}</strong>
              <code>{profile.id}</code>
            </div>
            <div>
              <span>{profile.model}</span>
              <code>{profile.baseUrl}</code>
            </div>
            <span
              className={`status ${profile.approved ? "status-applied" : "status-staged"}`}
            >
              {profile.approved ? "已授权" : "未授权"}
            </span>
            <div className="toolbar">
              <IconButton
                label={`编辑 ${profile.name}`}
                onClick={() => setEditing(profile)}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label={`移除 ${profile.name}`}
                disabled={busy}
                onClick={() => onRemove(profile.id)}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
      {!models.length && <p className="empty-state">尚未配置模型</p>}
      {editing && (
        <ModelForm
          key={editing === "new" ? "new" : editing.id}
          profile={editing === "new" ? undefined : editing}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSave={onSave}
        />
      )}
    </section>
  );
}
function ModelForm({
  profile,
  busy,
  onClose,
  onSave,
}: {
  profile: ModelProfile | undefined;
  busy: boolean;
  onClose: () => void;
  onSave: (profile: ModelProfile, secret?: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState<ModelProfile>(
    profile ?? {
      id: crypto.randomUUID(),
      name: "",
      provider: "openai-compatible",
      model: "",
      baseUrl: "https://api.openai.com/v1",
      approved: false,
      timeoutMs: 120000,
      maxToolRounds: 12,
    },
  );
  const [replaceSecret, setReplaceSecret] = useState(!profile);
  const [secret, setSecret] = useState("");
  function update<K extends keyof ModelProfile>(key: K, next: ModelProfile[K]) {
    setValue((current) => ({ ...current, [key]: next }));
  }
  return (
    <Modal title={profile ? "编辑模型" : "添加模型"} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(value, replaceSecret ? secret : undefined).then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <label>
          配置名称
          <input
            required
            value={value.name}
            onChange={(event) => update("name", event.target.value)}
          />
        </label>
        <label>
          模型 ID
          <input
            required
            value={value.model}
            onChange={(event) => update("model", event.target.value)}
          />
        </label>
        <label>
          端点 URL
          <input
            type="url"
            required
            value={value.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
          />
        </label>
        {profile && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={replaceSecret}
              onChange={(event) => setReplaceSecret(event.target.checked)}
            />
            替换凭据
          </label>
        )}
        {replaceSecret && (
          <label>
            API 密钥
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <span className="field-hint">空值：无密钥端点</span>
          </label>
        )}
        <div className="form-row">
          <label>
            超时（秒）
            <input
              type="number"
              min={1}
              max={600}
              value={value.timeoutMs / 1000}
              onChange={(event) =>
                update("timeoutMs", Number(event.target.value) * 1000)
              }
            />
          </label>
          <label>
            工具轮次上限
            <input
              type="number"
              min={1}
              max={100}
              value={value.maxToolRounds}
              onChange={(event) =>
                update("maxToolRounds", Number(event.target.value))
              }
            />
          </label>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.approved}
            onChange={(event) => update("approved", event.target.checked)}
          />
          授权此端点接收任务上下文
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <Save size={16} />
            保存模型
          </button>
        </footer>
      </form>
    </Modal>
  );
}
