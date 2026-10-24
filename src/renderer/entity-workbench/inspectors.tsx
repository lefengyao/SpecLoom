import { useState } from "react";
import "@xyflow/react/dist/style.css";
import type { DesktopApi } from "../../shared/desktop-api";
import { type ComponentField, type ComponentMount, type ComponentValue } from "../../shared/project-materials";
import { useI18n } from "../i18n";
import { ENTITY_ANCHOR_SIDES, type EntityAnchor, type EntityAnchorSide } from "../entity-layout";
import { Plus, Trash2, X } from "lucide-react";
import { FieldEditor } from "./canvas";
import { anchorSideLabels, readFieldValue, type EntityEntry, type ResolvedBinding } from "./model";

export interface EntityWorkbenchProps {
  api: DesktopApi;
  projectPath: string;
  onError?: (error: unknown) => void;
  /** Explicit "open full detail" action from the inspector. */
  onOpenDetail?: (path: string) => void;
}

/**
 * Entity workbench: mounts component bindings on one entity at a time. Own and
 * inherited bindings are merged for display, drafts stay in component state,
 * and saving writes the entity file through the versioned document API.
 */
export interface ComponentFillPanelProps {
  binding: ResolvedBinding | undefined;
  component: ResolvedBinding["component"];
  fields: ComponentField[];
  anchors?: EntityAnchor[];
  mount?: ComponentMount | undefined;
  mountParents?: { id: string; label: string; anchors: { name: string; label?: string }[] }[] | undefined;
  onMountChange?: ((mount: ComponentMount | undefined) => void) | undefined;
  sourceAnchor?: EntityAnchorSide | undefined;
  targetAnchor?: string | undefined;
  onConnectionChange?: (patch: { sourceAnchor?: EntityAnchorSide | null; targetAnchor?: string | null }) => void;
  onAddAnchor?: (side: EntityAnchorSide, offset: number) => void;
  onRemoveAnchor?: (id: string) => void;
  rangeEnabled?: boolean;
  currentFieldKey?: string | undefined;
  range?: { current: number; max: number } | undefined;
  onChange: (binding: ResolvedBinding, field: ComponentField, value: ComponentValue) => void;
  onRemove: (binding: ResolvedBinding) => void;
  onOverride: (binding: ResolvedBinding) => void;
  onNotesChange?: (notes: string[]) => void;
  onClose?: () => void;
  onOpenDetail?: (path: string) => void;
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */
export function ComponentFillPanel({
  binding,
  component,
  fields,
  anchors = [],
  mount,
  mountParents,
  onMountChange,
  sourceAnchor,
  targetAnchor,
  onConnectionChange,
  onAddAnchor,
  onRemoveAnchor,
  rangeEnabled = false,
  currentFieldKey,
  range,
  onChange,
  onRemove,
  onOverride,
  onNotesChange,
  onClose,
  onOpenDetail,
}: ComponentFillPanelProps) {
  const tr = useI18n();
  const [anchorSide, setAnchorSide] = useState<EntityAnchorSide>("right");
  const [anchorOffset, setAnchorOffset] = useState(25);
  const declaredAnchors = mountParents?.find((item) => item.id === mount?.parent)?.anchors ?? [];
  return (
    <section className="ewb-panel ewb-inspector" role="complementary" aria-label={tr("组件检查器")}>
      <header className="ewb-panel-head">
        <h2>{tr("组件检查器")}</h2>
        <div className="ewb-inspector-head-actions">
          {onOpenDetail && binding?.component?.path && <button type="button" onClick={() => onOpenDetail(binding.component!.path)}>{tr("详情")}</button>}
          {onClose && <button type="button" className="ewb-drawer-close" aria-label={tr("收起组件详情")} title={tr("收起组件详情")} onClick={onClose}><X size={15} /></button>}
        </div>
      </header>
      {!binding ? (
        <p className="ewb-empty">{tr("选择画布中的组件查看字段")}</p>
      ) : (
        <>
          <div className="ewb-inspector-title">
            <strong>{component?.title ?? binding.id}</strong>
            <span className={binding.own ? "ewb-badge is-own" : "ewb-badge"}>
              {binding.own ? tr("本实体") : tr("继承自") + " " + (binding.inheritedFrom ?? tr("父实体"))}
            </span>
          </div>
          <code className="ewb-inspector-path">{component?.path ?? tr("找不到组件定义")}</code>
          {mountParents && mountParents.length > 0 && onMountChange && (
            <section className="ewb-mount-editor" aria-label={tr("挂载")}>
              <h3>{tr("挂载")}</h3>
              <label>{tr("父级")}
                <select
                  aria-label={tr("挂载父级")}
                  value={mount ? mount.parent : ""}
                  onChange={(event) => {
                    const parentId = event.target.value;
                    if (!parentId) { onMountChange(undefined); return; }
                    const anchor = mountParents.find((item) => item.id === parentId)?.anchors[0]?.name;
                    if (anchor) onMountChange({ parent: parentId, anchor });
                  }}
                >
                  <option value="">{tr("不挂载")}</option>
                  {mountParents.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {mount && <label>{tr("锚点")}
                <select
                  aria-label={tr("挂载锚点")}
                  value={mount.anchor}
                  onChange={(event) => onMountChange({ parent: mount.parent, anchor: event.target.value })}
                >
                  {declaredAnchors.map((anchor) => <option key={anchor.name} value={anchor.name}>{anchor.label ?? anchor.name}</option>)}
                  {!declaredAnchors.some((anchor) => anchor.name === mount.anchor) && <option value={mount.anchor}>{mount.anchor}（{tr("未声明")}）</option>}
                </select>
              </label>}
              {mount && declaredAnchors.length === 0 && <p className="ewb-inspector-hint">{tr("该父级没有声明锚点，请先在组件里添加。")}</p>}
            </section>
          )}
          {component && (component.description?.trim() || component.body?.trim()) && (
            <section className="ewb-component-notes" aria-label={tr("组件说明")}>
              <h3>{tr("组件说明")}</h3>
              {component.description?.trim() && <p>{component.description}</p>}
              {component.notes?.length ? <ul className="ewb-component-note-list">{component.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
              {component.body?.trim() && <pre>{component.body}</pre>}
            </section>
          )}
          {!binding.component ? (
            <p className="ewb-inspector-hint">{tr("组件定义不存在，无法编辑字段。请检查项目资料中的组件文件。")}</p>
          ) : fields.length === 0 ? (
            <p className="ewb-inspector-hint">{tr("该组件没有字段。")}</p>
          ) : (
            <div className="ewb-fields">
              {fields.map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={readFieldValue(binding, field)}
                  disabled={!binding.component}
                  {...(rangeEnabled && field.key === currentFieldKey
                    ? { range: { current: range?.current ?? 0, max: range?.max ?? 0 } }
                    : {})}
                  onChange={(value) => onChange(binding, field, value)}
                />
              ))}
            </div>
          )}
          {onNotesChange && (
            <section className="ewb-binding-notes" aria-label={tr("补充描述")}>
              <header className="ewb-binding-notes-head">
                <h3>{tr("补充描述")}</h3>
                <button type="button" disabled={binding.notes.length >= 32} onClick={() => onNotesChange([...binding.notes, ""])}><Plus size={13} />{tr("添加描述")}</button>
              </header>
              <p className="ewb-inspector-hint">{tr("用于记录字段表达不清的规则、约定或备注，仅作用于当前实体。")}</p>
              {binding.notes.length ? (
                <ul>
                  {binding.notes.map((note, index) => (
                    <li key={index}>
                      <textarea
                        aria-label={tr("描述 {index}", { index: index + 1 })}
                        rows={2}
                        maxLength={2000}
                        value={note}
                        onChange={(event) => {
                          const next = [...binding.notes];
                          next[index] = event.target.value;
                          onNotesChange(next);
                        }}
                      />
                      <button type="button" aria-label={tr("移除描述 {index}", { index: index + 1 })} onClick={() => onNotesChange(binding.notes.filter((_, position) => position !== index))}><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ul>
              ) : <p className="ewb-inspector-hint">{tr("还没有补充描述。")}</p>}
            </section>
          )}
          {onConnectionChange && (
            <section className="ewb-anchors" aria-label={tr("连接锚点")}>
              <h3>{tr("连接锚点")}</h3>
              <div className="ewb-anchor-grid">
                <label>
                  <span>{tr("实体侧")}</span>
                  <select value={sourceAnchor ?? ""} onChange={(event) => onConnectionChange({ sourceAnchor: event.target.value ? event.target.value as EntityAnchorSide : null })}>
                    <option value="">{tr("自动")}</option>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                  </select>
                </label>
                <label>
                  <span>{tr("组件侧")}</span>
                  <select value={targetAnchor ?? ""} onChange={(event) => onConnectionChange({ targetAnchor: event.target.value || null })}>
                    <option value="">{tr("自动")}</option>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                    {anchors.map((anchor) => <option key={anchor.id} value={anchor.id}>{tr("{side}侧 {offset}%", { side: tr(anchorSideLabels[anchor.side]), offset: anchor.offset })}</option>)}
                  </select>
                </label>
              </div>
              <p className="field-hint">{tr("也可直接从实体卡片的锚点拖到组件锚点")}</p>
              {onAddAnchor && (
                <div className="ewb-anchor-add">
                  <select aria-label={tr("新锚点位置")} value={anchorSide} onChange={(event) => setAnchorSide(event.target.value as EntityAnchorSide)}>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                  </select>
                  <input aria-label={tr("新锚点偏移")} type="number" min={5} max={95} step={5} value={anchorOffset} onChange={(event) => setAnchorOffset(Number(event.target.value))} />
                  <button type="button" onClick={() => onAddAnchor(anchorSide, Number.isFinite(anchorOffset) ? anchorOffset : 50)}>{tr("添加锚点")}</button>
                </div>
              )}
              {anchors.length > 0 && (
                <ul className="ewb-anchor-list" aria-label={tr("自定义锚点")}>
                  {anchors.map((anchor) => (
                    <li key={anchor.id}>
                      <span>{tr("{side}侧 {offset}%", { side: tr(anchorSideLabels[anchor.side]), offset: anchor.offset })}</span>
                      {onRemoveAnchor && <button type="button" aria-label={tr("移除锚点")} onClick={() => onRemoveAnchor(anchor.id)}><Trash2 size={12} /></button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="ewb-inspector-actions">
            {binding.own ? (
              <button type="button" className="danger-ghost" onClick={() => onRemove(binding)}>
                <Trash2 size={13} />
                {tr("移除组件")}
              </button>
            ) : (
              <button type="button" onClick={() => onOverride(binding)}>
                {tr("覆盖继承组件")}
              </button>
            )}
          </div>
          {!binding.own && (
            <p className="ewb-inspector-hint">
              {tr("继承组件的字段可直接编辑；首次修改会自动覆盖为当前实体的自有绑定。")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function EntityDetailsPanel({
  entity,
  inheritsFrom,
  imageUrl,
  imageMaxHeight,
  onClose,
  onOpenDetail,
}: {
  entity: EntityEntry;
  inheritsFrom?: string | undefined;
  imageUrl?: string | undefined;
  imageMaxHeight: number;
  onClose: () => void;
  onOpenDetail?: ((path: string) => void) | undefined;
}) {
  const tr = useI18n();
  const data = entity.data;
  const rows: [string, string][] = [];
  if (inheritsFrom) rows.push([tr("继承"), inheritsFrom]);
  if (typeof data.type === "string" && data.type) rows.push([tr("类型"), data.type]);
  if (typeof data.status === "string" && data.status) rows.push([tr("状态"), data.status]);
  const group = typeof data.group === "string" ? data.group : typeof data.groupId === "string" ? data.groupId : "";
  if (group) rows.push([tr("分组"), group]);
  if (typeof data.parent === "string" && data.parent) rows.push([tr("父级资料"), data.parent]);
  rows.push([tr("组件"), String(entity.bindings.length)]);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return (
    <section className="ewb-panel ewb-inspector ewb-entity-details" role="complementary" aria-label={tr("实体详情")}>
      <header className="ewb-panel-head">
        <h2>{tr("实体详情")}</h2>
        <div className="ewb-inspector-head-actions">
          {onOpenDetail && <button type="button" onClick={() => onOpenDetail(entity.path)}>{tr("详情")}</button>}
          <button type="button" className="ewb-drawer-close" aria-label={tr("收起详情")} title={tr("收起详情")} onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      {imageUrl && <img className="ewb-entity-detail-image" src={imageUrl} alt={tr("{title}配图", { title: entity.title })} style={{ maxHeight: imageMaxHeight }} />}
      <div className="ewb-entity-heading">
        <strong>{entity.title}</strong>
        <code>{entity.path}</code>
      </div>
      {description && <p className="ewb-entity-description">{description}</p>}
      <dl className="ewb-entity-facts">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="ewb-inspector-hint">{tr("在画布中点击组件查看组件字段；点“详情”打开完整编辑页。")}</p>
    </section>
  );
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */

