import { Check, Clipboard, ClipboardPaste, Download, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { errorMessage } from "../shared/error-message";
import { type ModelReference, type ProviderInput, type ProviderPublic, type ReasoningLevel } from "../shared/contracts";
import { formatModelConfigJson, parseModelSettingsJson } from "../main/core/model-json";
import { resolveModelSettings } from "../main/core/model-settings";
import { useI18n, type Translate } from "./i18n";

type ProviderApi = NonNullable<DesktopApi["providers"]>;

const PROTOCOLS = [
  ["openai", "OpenAI 兼容"],
  ["anthropic", "Anthropic"],
  ["gemini", "Gemini 原生"],
] as const;

/** Common context-window values surfaced by the aligned model settings UI. */
const CONTEXT_TOKEN_PRESETS = [32_768, 65_536, 131_072, 200_000, 262_144, 300_000, 400_000, 524_288, 1_048_576] as const;
/** Keep output presets within the request client's current supported ceiling. */
const OUTPUT_TOKEN_PRESETS = [4_096, 8_192, 16_384, 32_768, 65_536] as const;
const TOKEN_PRESET_LABELS: Record<number, string> = {
  4_096: "4K",
  8_192: "8K",
  16_384: "16K",
  32_768: "32K",
  65_536: "64K",
  131_072: "128K",
  200_000: "200K",
  262_144: "256K",
  300_000: "300K",
  400_000: "400K",
  524_288: "512K",
  1_048_576: "1M",
};

function formatTokenPreset(value: number): string {
  if (TOKEN_PRESET_LABELS[value]) return TOKEN_PRESET_LABELS[value];
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return value.toLocaleString("en-US");
}

function tokenPresetOptions(defaultValue: number, currentValue: number | undefined, presets: readonly number[], tr: Translate): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [{ value: "", label: tr("模型默认（{value}）", { value: formatTokenPreset(defaultValue) }) }];
  if (currentValue !== undefined) {
    options.push({ value: String(currentValue), label: tr("当前值（{value}）", { value: formatTokenPreset(currentValue) }) });
  }
  for (const preset of presets) {
    if (preset === defaultValue || preset === currentValue) continue;
    options.push({ value: String(preset), label: formatTokenPreset(preset) });
  }
  return options;
}

function idForNewProvider(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `provider-${Date.now()}`;
}

function dedupeModels(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const model = value.trim();
    if (model && !seen.has(model)) {
      seen.add(model);
      output.push(model);
    }
  }
  return output;
}

function keyStorageLabel(provider: ProviderPublic): string {
  if (provider.credentialStatus === "needs-reconfiguration") return "系统加密存储（无法解密）";
  if (!provider.hasKey) return "未设置密钥";
  if (provider.keyStorage === "encrypted" || provider.keyStorage === "safeStorage") return "系统加密存储";
  if (provider.keyStorage === "plain" || provider.keyStorage === "plaintext") return "明文存储";
  return "未设置密钥";
}

function credentialStatusLabel(provider: ProviderPublic): string {
  if (provider.credentialStatus === "needs-reconfiguration") return "密钥需重新配置";
  return provider.hasKey ? "已配置密钥" : "未配置密钥";
}

export function ProvidersView({
  providers: initialProviders,
  api,
  defaultModel,
  busy,
  onRefresh,
  onError,
}: {
  providers: ProviderPublic[];
  api: DesktopApi;
  defaultModel?: ModelReference;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const tr = useI18n();
  const providerApi = api.providers;
  const [providers, setProviders] = useState<ProviderPublic[]>(initialProviders);
  const [editing, setEditing] = useState<ProviderPublic | "new">();
  const [managerId, setManagerId] = useState<string>();

  useEffect(() => {
    setProviders(initialProviders);
  }, [initialProviders]);

  if (!providerApi) {
    return <section className="standard-view"><header className="section-heading"><div><h1>{tr("供应商与模型")}</h1><span className="subtle">{tr("当前桌面主进程尚未启用供应商注册表")}</span></div></header><p className="empty-state">{tr("请重启软件以加载新版供应商功能。")}</p></section>;
  }
  const providerRegistry: ProviderApi = providerApi;

  async function saveProvider(input: ProviderInput): Promise<void> {
    try {
      const next = await providerRegistry.save(input);
      setProviders(next);
      await onRefresh();
      setEditing(undefined);
      setManagerId(input.id);
    } catch (error) {
      onError(error);
    }
  }

  async function removeProvider(provider: ProviderPublic): Promise<void> {
    try {
      setProviders(await providerRegistry.remove(provider.id));
      if (managerId === provider.id) setManagerId(undefined);
      await onRefresh();
    } catch (error) {
      onError(error);
    }
  }

  const manager = providers.find((provider) => provider.id === managerId);
  if (manager) {
    return (
      <ProviderModelManager
        key={manager.id}
        provider={manager}
        providerApi={providerRegistry}
        api={api}
        {...(defaultModel ? { defaultModel } : {})}
        busy={busy}
        onBack={() => setManagerId(undefined)}
        onSaved={(next) => { setProviders(next); void onRefresh(); }}
        onError={onError}
      />
    );
  }

  return (
    <section className="standard-view providers-view">
      <header className="section-heading">
        <div><h1>{tr("供应商与模型")}</h1><span className="subtle">{tr("先配置连接，再管理供应商下的模型能力")}</span></div>
        <button className="primary" type="button" onClick={() => setEditing("new")}><Plus size={16} />{tr("添加供应商")}</button>
      </header>
      <div className="provider-list">
        {providers.map((provider) => (
          <article className="provider-card" key={provider.id}>
            <div className="provider-card-main">
              <div className="provider-card-title"><strong>{provider.name}</strong><code>{provider.id}</code></div>
              <div className="provider-card-meta"><span>{tr(PROTOCOLS.find(([id]) => id === provider.protocol)?.[1] ?? provider.protocol)}</span><code>{provider.baseUrl}</code></div>
              <div className="provider-card-status"><span className={`status ${provider.credentialStatus === "needs-reconfiguration" ? "status-staged" : provider.hasKey ? "status-applied" : "status-staged"}`}>{tr(credentialStatusLabel(provider))}</span><span>{provider.models.length} {tr("个模型")}</span><span>{tr(keyStorageLabel(provider))}</span>{provider.keyPreview && <code>{provider.keyPreview}</code>}</div>
            </div>
            <div className="toolbar provider-card-actions">
              <button type="button" onClick={() => setManagerId(provider.id)} aria-label={tr("管理 {name} 的模型", { name: provider.name })}><Pencil size={15} />{tr("模型管理")}</button>
              <button type="button" onClick={() => setEditing(provider)} aria-label={tr("编辑 {name}", { name: provider.name })}><Pencil size={15} />{tr("编辑供应商")}</button>
              <button type="button" disabled={busy} onClick={() => void removeProvider(provider)} aria-label={tr("删除供应商 {name}", { name: provider.name })}><Trash2 size={15} /></button>
            </div>
          </article>
        ))}
      </div>
      {!providers.length && <p className="empty-state">{tr("尚未配置供应商")}</p>}
      {editing && <ProviderForm {...(editing === "new" ? {} : { provider: editing })} busy={busy} onCancel={() => setEditing(undefined)} onSave={(input) => void saveProvider(input)} />}
    </section>
  );
}

function ProviderForm({ provider, busy, onCancel, onSave }: { provider?: ProviderPublic; busy: boolean; onCancel: () => void; onSave: (input: ProviderInput) => void }) {
  const tr = useI18n();
  const [name, setName] = useState(provider?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderInput["protocol"]>(provider?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://api.openai.com/v1");
  const [secret, setSecret] = useState("");
  const needsCredentialReconfiguration = provider?.credentialStatus === "needs-reconfiguration";
  return (
    <div className="provider-editor" role="dialog" aria-label={tr(provider ? "编辑供应商" : "添加供应商")}>
      <div className="provider-editor-heading"><div><h2>{tr(provider ? "编辑供应商" : "添加供应商")}</h2><span className="subtle">{tr("API 密钥只在主进程保存，公开状态不会包含密钥内容")}</span>{needsCredentialReconfiguration && <p className="provider-inline-error" role="alert">{tr("当前密钥无法解密，请输入新的 API 密钥后保存，以恢复发送。")}</p>}</div><button type="button" onClick={onCancel} aria-label={tr("关闭")}><X size={16} /></button></div>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); onSave({ ...(provider ? { id: provider.id } : { id: idForNewProvider() }), name: name.trim(), protocol, baseUrl: baseUrl.trim(), models: provider?.models ?? [], modelSettings: provider?.modelSettings ?? {}, ...(secret.trim() ? { apiKey: secret } : {}) }); }}>
        <label>{tr("供应商名称")}<input required aria-label={tr("供应商名称")} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{tr("协议")}<select aria-label={tr("协议")} value={protocol} onChange={(event) => setProtocol(event.target.value as ProviderInput["protocol"])}>{PROTOCOLS.map(([id, label]) => <option key={id} value={id}>{tr(label)}</option>)}</select></label>
        <label>{tr("服务地址")}<input required type="url" aria-label={tr("服务地址")} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label>{tr("API 密钥")}<input type="password" aria-label={tr("API 密钥")} autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} required={needsCredentialReconfiguration} placeholder={needsCredentialReconfiguration ? tr("请输入新的 API 密钥（必填）") : provider ? tr("留空以沿用现有密钥") : tr("可选")} /></label>
        <div className="form-actions"><button type="button" onClick={onCancel}>{tr("取消")}</button><button className="primary" disabled={busy}><Save size={16} />{tr("保存供应商")}</button></div>
      </form>
    </div>
  );
}

function ProviderModelManager({ provider, providerApi, api, defaultModel, busy, onBack, onSaved, onError }: { provider: ProviderPublic; providerApi: ProviderApi; api: DesktopApi; defaultModel?: ModelReference; busy: boolean; onBack: () => void; onSaved: (providers: ProviderPublic[]) => void; onError: (error: unknown) => void }) {
  const tr = useI18n();
  const [models, setModels] = useState(() => dedupeModels(provider.models));
  const [settings, setSettings] = useState(() => structuredClone(provider.modelSettings));
  const [selectedModel, setSelectedModel] = useState(() => defaultModel?.providerId === provider.id && models.includes(defaultModel.model) ? defaultModel.model : models[0]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [configuredQuery, setConfiguredQuery] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [json, setJson] = useState(() => models[0] ? formatModelConfigJson(models[0], settings[models[0]] ?? {}) : "");
  const [error, setError] = useState<string>();
  const [savedNotice, setSavedNotice] = useState<string>();

  const effective = selectedModel ? resolveModelSettings(selectedModel, settings[selectedModel]) : undefined;
  const modelDefaults = selectedModel ? resolveModelSettings(selectedModel) : undefined;
  const contextOverride = selectedModel ? settings[selectedModel]?.contextTokens : undefined;
  const outputOverride = selectedModel ? settings[selectedModel]?.maxOutputTokens : undefined;
  const contextPresetOptions = modelDefaults ? tokenPresetOptions(modelDefaults.contextTokens, contextOverride, CONTEXT_TOKEN_PRESETS, tr) : [];
  const outputPresetOptions = modelDefaults ? tokenPresetOptions(modelDefaults.maxOutputTokens, outputOverride, OUTPUT_TOKEN_PRESETS, tr) : [];
  const candidates = useMemo(() => discovered.filter((model) => !models.includes(model) && model.toLowerCase().includes(query.trim().toLowerCase())), [discovered, models, query]);
  const filteredModels = useMemo(() => models.filter((model) => model.toLowerCase().includes(configuredQuery.trim().toLowerCase())), [models, configuredQuery]);

  function selectModel(model: string): void {
    setSelectedModel(model);
    setJson(formatModelConfigJson(model, settings[model] ?? {}));
    setError(undefined);
  }
  function patchSetting<K extends keyof typeof settings[string]>(field: K, value: (typeof settings[string])[K]): void {
    if (!selectedModel) return;
    setSettings((current) => ({ ...current, [selectedModel]: { ...(current[selectedModel] ?? {}), [field]: value } }));
  }
  function selectTokenPreset(field: "contextTokens" | "maxOutputTokens", value: string): void {
    if (!selectedModel) return;
    if (!value) {
      setSettings((current) => {
        const next = { ...current };
        const modelSettings = { ...(next[selectedModel] ?? {}) };
        delete modelSettings[field];
        if (Object.keys(modelSettings).length) next[selectedModel] = modelSettings;
        else delete next[selectedModel];
        return next;
      });
      return;
    }
    patchSetting(field, Number(value));
  }
  async function discover(): Promise<void> {
    try {
      const result = await providerApi.listModels(provider.id);
      setDiscovered(dedupeModels(result.ids));
      setError(undefined);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      onError(cause);
    }
  }
  function addSelected(): void {
    const additions = dedupeModels(checked).filter((model) => !models.includes(model));
    if (!additions.length) return;
    setModels((current) => dedupeModels([...current, ...additions]));
    setChecked([]);
    void providerApi.addModels(provider.id, additions).catch((cause) => {
      setError(errorMessage(cause));
      onError(cause);
    });
  }
  function addManual(): void {
    const model = manualModel.trim();
    if (!model) return;
    setModels((current) => dedupeModels([...current, model]));
    setSelectedModel(model);
    setManualModel("");
    if (!settings[model]) setSettings((current) => ({ ...current, [model]: {} }));
    setJson(formatModelConfigJson(model, settings[model] ?? {}));
  }
  function removeModel(model: string): void {
    setModels((current) => current.filter((item) => item !== model));
    setSettings((current) => { const next = { ...current }; delete next[model]; return next; });
    if (selectedModel === model) {
      const next = models.find((item) => item !== model);
      setSelectedModel(next);
      if (next) setJson(formatModelConfigJson(next, settings[next] ?? {}));
      else setJson("");
    }
  }
  function applyJson(): void {
    try {
      if (!selectedModel) return;
      const parsed = parseModelSettingsJson(json);
      setSettings((current) => ({ ...current, [selectedModel]: parsed }));
      setJson(formatModelConfigJson(selectedModel, parsed));
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function updateMappingPath(path: string): void {
    if (!selectedModel) return;
    const map = settings[selectedModel]?.reasoningMap;
    patchSetting("reasoningMap", { path, values: { ...(map?.values ?? {}) } });
  }

  function updateMappingValue(level: ReasoningLevel, value: string): void {
    if (!selectedModel) return;
    const map = settings[selectedModel]?.reasoningMap;
    const values = { ...(map?.values ?? {}) };
    if (value.trim()) values[level] = value;
    else delete values[level];
    patchSetting("reasoningMap", { path: map?.path ?? "", values });
  }
  function restoreJson(): void {
    if (selectedModel) setJson(formatModelConfigJson(selectedModel, settings[selectedModel] ?? {}));
    setError(undefined);
  }
  async function saveModels(): Promise<void> {
    try {
      const next = await providerApi.save({ id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, models, modelSettings: settings });
      onSaved(next);
      setSavedNotice(tr("模型配置已保存"));
      setTimeout(() => setSavedNotice(undefined), 1800);
    } catch (cause) {
      setError(errorMessage(cause));
      onError(cause);
    }
  }
  async function makeDefault(): Promise<void> {
    if (!selectedModel) return;
    const setDefaultModel = (api as DesktopApi & { setDefaultModel?: (reference: ModelReference) => Promise<unknown> }).setDefaultModel;
    if (!setDefaultModel) return;
    try {
      await setDefaultModel({ providerId: provider.id, model: selectedModel });
      setSavedNotice(tr("已设为默认模型"));
      setTimeout(() => setSavedNotice(undefined), 1800);
    } catch (cause) {
      onError(cause);
    }
  }
  async function clipboardWrite(): Promise<void> { try { await navigator.clipboard?.writeText(json); } catch (cause) { onError(cause); } }
  async function clipboardRead(): Promise<void> { try { setJson(await navigator.clipboard.readText()); } catch (cause) { onError(cause); } }

  return (
    <section className="standard-view providers-view model-manager-view">
      <header className="section-heading"><div><button type="button" className="link-button" onClick={onBack}>{tr("供应商列表")}</button><h1>{provider.name} · {tr("模型管理")}</h1><span className="subtle">{provider.baseUrl} · {provider.protocol}</span></div><button className="primary" type="button" disabled={busy} onClick={() => void saveModels()}><Save size={16} />{tr("保存模型配置")}</button></header>
      <div className="model-manager-layout">
        <aside className="model-manager-sidebar">
          <div className="model-manager-toolbar"><strong>{tr("已配置模型")}</strong><span>{models.length}</span></div>
          <label className="search-field"><Search size={15} /><input aria-label={tr("搜索已配置模型")} value={configuredQuery} onChange={(event) => setConfiguredQuery(event.target.value)} placeholder={tr("搜索已配置模型")} /></label>
          {filteredModels.map((model) => <div className={`managed-model ${selectedModel === model ? "selected" : ""}`} key={model}><button type="button" aria-label={tr("选择模型 {model}", { model })} onClick={() => selectModel(model)}><span>{model}</span>{defaultModel?.providerId === provider.id && defaultModel.model === model && <Check size={14} />}</button><button type="button" aria-label={tr("删除模型 {model}", { model })} onClick={() => removeModel(model)}><Trash2 size={14} /></button></div>)}
          {!models.length && <p className="empty-state">{tr("尚未添加模型")}</p>}
          {models.length > 0 && filteredModels.length === 0 && <p className="empty-state">{tr("没有匹配的模型")}</p>}
          <label className="manual-model-field">{tr("手动模型 ID")}<input aria-label={tr("手动模型 ID")} value={manualModel} onChange={(event) => setManualModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }} /></label>
          <button type="button" onClick={addManual} disabled={!manualModel.trim()}><Plus size={15} />{tr("手动添加")}</button>
        </aside>
        <div className="model-manager-content">
          <section className="model-discovery-panel">
            <div className="model-manager-toolbar"><h2>{tr("发现模型")}</h2><button type="button" onClick={() => void discover()}><RefreshCw size={15} />{tr("拉取模型列表")}</button></div>
            <label className="search-field"><Search size={15} /><input aria-label={tr("搜索待添加模型")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("搜索待添加模型")} /></label>
            {error && <p className="provider-inline-error">{error}</p>}
            <div className="discovered-models">{candidates.map((model) => <label key={model}><input type="checkbox" aria-label={tr("添加 {model}", { model })} checked={checked.includes(model)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, model] : current.filter((item) => item !== model))} />{model}</label>)}{!candidates.length && <span className="subtle">{tr("拉取列表后显示可添加模型")}</span>}</div>
            <button type="button" disabled={!checked.length} onClick={addSelected}><Plus size={15} />{tr("添加所选模型")}</button>
          </section>
          {selectedModel && effective ? <section className="model-settings-panel">
            <div className="model-manager-toolbar"><div><h2>{selectedModel}</h2><span className="subtle">{effective.source}</span></div><div className="capability-badges"><span className={effective.reasoningSupport ? "capability-on" : ""}>{tr("思考")}</span><span className={effective.vision ? "capability-on" : ""}>{tr("图片")}</span><button type="button" disabled={!((api as DesktopApi & { setDefaultModel?: unknown }).setDefaultModel)} onClick={() => void makeDefault()}>{defaultModel?.providerId === provider.id && defaultModel.model === selectedModel ? tr("当前默认") : tr("设为默认")}</button></div></div>
            <div className="model-capability-grid"><label className="checkbox-label"><input type="checkbox" aria-label={tr("支持思考")} checked={effective.reasoningSupport} onChange={(event) => patchSetting("reasoningSupport", event.target.checked)} />{tr("支持思考")}</label><label className="checkbox-label"><input type="checkbox" aria-label={tr("支持图片输入")} checked={effective.vision} onChange={(event) => patchSetting("vision", event.target.checked)} />{tr("支持图片输入")}</label><label>{tr("默认思考")}<select aria-label={tr("默认思考")} value={effective.reasoning} onChange={(event) => patchSetting("reasoning", event.target.value as ReasoningLevel)}>{["off", "low", "medium", "high"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label><label>{tr("上下文 tokens")}<input type="number" min="1" aria-label={tr("上下文 tokens")} value={effective.contextTokens} onChange={(event) => patchSetting("contextTokens", Number(event.target.value))} /><select aria-label={tr("上下文 tokens 预设")} value={contextOverride === undefined ? "" : String(contextOverride)} onChange={(event) => selectTokenPreset("contextTokens", event.target.value)}>{contextPresetOptions.map((option) => <option key={option.value || option.label} value={option.value}>{option.label}</option>)}</select></label><label>{tr("输出 tokens")}<input type="number" min="1" aria-label={tr("输出 tokens")} value={effective.maxOutputTokens} onChange={(event) => patchSetting("maxOutputTokens", Number(event.target.value))} /><select aria-label={tr("输出 tokens 预设")} value={outputOverride === undefined ? "" : String(outputOverride)} onChange={(event) => selectTokenPreset("maxOutputTokens", event.target.value)}>{outputPresetOptions.map((option) => <option key={option.value || option.label} value={option.value} disabled={option.value !== "" && Number(option.value) > effective.contextTokens && Number(option.value) !== effective.maxOutputTokens}>{option.label}</option>)}</select></label></div>
            <div className="model-reasoning-mapping">
              <label className="checkbox-label"><input type="checkbox" aria-label={tr("自定义思考参数映射")} checked={effective.reasoningMap !== null} onChange={(event) => patchSetting("reasoningMap", event.target.checked ? { path: "", values: {} } : null)} />{tr("自定义思考参数映射")}</label>
              {effective.reasoningMap !== null && <><label>{tr("官方参数路径")}<input aria-label={tr("官方参数路径")} value={effective.reasoningMap.path} onChange={(event) => updateMappingPath(event.target.value)} placeholder={provider.protocol === "anthropic" ? "thinking" : provider.protocol === "gemini" ? "generationConfig.thinkingConfig.thinkingBudget" : "reasoning_effort"} /></label><div className="model-mapping-values">{(["off", "low", "medium", "high"] as const).map((level) => <label key={level}>{level}<input aria-label={tr("{level} 思考映射值", { level })} value={effective.reasoningMap?.values[level] ?? ""} onChange={(event) => updateMappingValue(level, event.target.value)} /></label>)}</div><span className="field-hint">{tr("字符串原样保存；请求时将数字、布尔值、JSON 对象解析为对应类型")}</span></>}
            </div>
            <div className="json-editor-heading"><h2>{tr("完整 JSON 配置")}</h2><div className="toolbar"><button type="button" onClick={() => void clipboardWrite()} aria-label={tr("复制 JSON")}><Clipboard size={15} />{tr("复制")}</button><button type="button" onClick={() => void clipboardRead()} aria-label={tr("粘贴 JSON")}><ClipboardPaste size={15} />{tr("粘贴")}</button><button type="button" onClick={restoreJson} aria-label={tr("恢复当前配置")}><Download size={15} />{tr("恢复")}</button></div></div>
            <textarea aria-label={tr("完整 JSON 配置")} value={json} onChange={(event) => setJson(event.target.value)} rows={14} spellCheck={false} />
            <div className="form-actions"><span className="field-hint">schemaVersion: 1 · {tr("最多 64000 字符")}</span><button type="button" onClick={applyJson}>{tr("应用 JSON")}</button>{savedNotice && <span className="status status-applied">{savedNotice}</span>}</div>
          </section> : <p className="empty-state">{tr("选择或添加模型后编辑能力配置")}</p>}
        </div>
      </div>
    </section>
  );
}
