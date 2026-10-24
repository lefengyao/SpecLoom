import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { ComponentAnchor, ComponentMount } from "../../shared/project-materials";
import { useI18n } from "../i18n";
import type { EntityAnchor } from "../entity-layout";
import { anchorOffsetStyle, anchorPosition } from "./model";

export const COMPONENT_NODE_PREFIX = "component:";

export type WorkbenchNodeData = {
  kind: "entity" | "component";
  title: string;
  meta: string;
  summary?: string;
  path?: string;
  inherited?: boolean;
  inheritedFrom?: string;
  selected?: boolean;
  missing?: boolean;
  imageUrl?: string;
  imageMaxHeight?: number;
  anchors?: EntityAnchor[];
  /** Attach points declared by the spec; `anchors` above stays canvas-only. */
  specAnchors?: ComponentAnchor[];
  mount?: ComponentMount;
};

export type WorkbenchFlowNode = Node<WorkbenchNodeData>;

export function EntityCard({ data }: NodeProps) {
  const tr = useI18n();
  const card = data as unknown as WorkbenchNodeData;
  const inheritance = card.inheritedFrom ? tr("继承自 {source}", { source: card.inheritedFrom }) : undefined;
  return (
    <div className="ewb-card ewb-card-entity" title={[card.path, inheritance].filter(Boolean).join("\n") || undefined}>
      {card.imageUrl && <img className="ewb-card-image" src={card.imageUrl} alt={tr("{title}配图", { title: card.title })} style={{ maxHeight: card.imageMaxHeight ?? 160 }} />}
      <span className="ewb-card-kicker">{tr("实体")}</span>
      <strong className="ewb-card-title">{card.title}</strong>
      {inheritance && <span className="ewb-card-inheritance">{inheritance}</span>}
      <span className="ewb-card-meta">{card.meta}</span>
      {card.specAnchors?.length ? <span className="ewb-card-spec-anchors">{tr("锚点")}: {card.specAnchors.map((anchor) => anchor.name).join(" · ")}</span> : null}
      {card.path && <code className="ewb-card-path">{card.path}</code>}
      <Handle type="source" position={Position.Top} id="source-top" className="ewb-handle" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="ewb-handle" />
      <Handle type="source" position={Position.Left} id="source-left" className="ewb-handle" />
      <Handle type="source" position={Position.Right} id="source-right" className="ewb-handle" />
    </div>
  );
}

export function ComponentCard({ data }: NodeProps) {
  const tr = useI18n();
  const card = data as unknown as WorkbenchNodeData;
  const classes = ["ewb-card", "ewb-card-component", card.inherited ? "is-inherited" : "", card.selected ? "is-selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} title={card.inherited ? tr("继承自 {source}", { source: card.inheritedFrom ?? tr("父实体") }) : undefined}>
      <button type="button" className="ewb-card-select" aria-label={tr("选择组件 {title}", { title: card.title })}>
        <strong className="ewb-card-title">{card.title}</strong>
        <span className="ewb-card-meta">{card.meta}</span>
        {card.summary && <span className="ewb-card-summary">{card.summary}</span>}
        {card.mount && <span className="ewb-card-mount">{tr("挂载")}: {card.mount.parent === "__entity__" ? tr("实体") : card.mount.parent} · {card.mount.anchor}</span>}
        {card.specAnchors?.length ? <span className="ewb-card-spec-anchors">{tr("锚点")}: {card.specAnchors.map((anchor) => anchor.name).join(" · ")}</span> : null}
      </button>
      {card.inherited && (
        <span className="ewb-badge" title={card.inheritedFrom ? tr("继承自 {source}", { source: card.inheritedFrom }) : tr("继承组件")}>
          {tr("继承")}
        </span>
      )}
      <Handle type="target" position={Position.Top} id="target-top" className="ewb-handle" />
      <Handle type="target" position={Position.Bottom} id="target-bottom" className="ewb-handle" />
      <Handle type="target" position={Position.Left} id="target-left" className="ewb-handle" />
      <Handle type="target" position={Position.Right} id="target-right" className="ewb-handle" />
      {/* Components can host mounted children, so they expose source sides too. */}
      <Handle type="source" position={Position.Top} id="source-top" className="ewb-handle" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="ewb-handle" />
      <Handle type="source" position={Position.Left} id="source-left" className="ewb-handle" />
      <Handle type="source" position={Position.Right} id="source-right" className="ewb-handle" />
      {(card.anchors ?? []).map((anchor) => (
        <Handle
          key={anchor.id}
          type="target"
          position={anchorPosition(anchor.side)}
          id={`target-${anchor.id}`}
          className="ewb-handle ewb-handle-custom"
          style={anchorOffsetStyle(anchor)}
        />
      ))}
    </div>
  );
}

// Stable identity: React Flow warns when nodeTypes is recreated on every render.
export const nodeTypes: NodeTypes = { entity: EntityCard, component: ComponentCard };

export function componentNodeId(bindingId: string): string {
  return `${COMPONENT_NODE_PREFIX}${bindingId}`;
}

