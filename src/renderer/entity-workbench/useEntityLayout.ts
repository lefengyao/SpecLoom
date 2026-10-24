import { type Dispatch, type SetStateAction } from "react";
import {
  COMPONENT_CARD_SIZE,
  ENTITY_CARD_SIZE,
  ENTITY_NODE_ID,
  
  defaultEntityPositions,
  layoutSize,
  mountParentId,
  packMountPositions,
  pruneEntityLayout,
  saveEntityLayout,
  type EntityAnchorSide,
  type EntityComponentLayout,
  type EntityLayout,
  type EntityPoint,
  type EntitySize,
} from "../entity-layout";
import { clamp, newAnchorId, type EntityEntry, type ResolvedBinding } from "./model";

export interface EntityLayoutControls {
  entity: EntityEntry | undefined;
  bindings: ResolvedBinding[];
  projectPath: string;
  setLayout: Dispatch<SetStateAction<EntityLayout>>;
  saveLayout?: ((layout: EntityLayout) => void) | undefined;
}

/**
 * Canvas layout for one entity: card positions and sizes, custom anchors, and the
 * sidecar save that keeps the entity workbench layout across restarts.
 */
export function useEntityLayout({ entity, bindings, projectPath, setLayout, saveLayout }: EntityLayoutControls) {
  function persistLayout(next: EntityLayout): void {
    saveEntityLayout(projectPath, next);
    saveLayout?.(next);
  }

  function moveBinding(bindingId: string, position: EntityPoint) {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const next: EntityLayout = {
        ...current,
        [entity.id]: {
          ...entityLayout,
          [bindingId]: { ...(entityLayout[bindingId] ?? {}), x: Math.round(position.x), y: Math.round(position.y) },
        },
      };
      persistLayout(next);
      return next;
    });
  }

  /** Persist a measured card size so overlap always reasons about real rectangles. */
  function measureNode(nodeId: string, size: EntitySize) {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entry = entityLayout[nodeId] ?? { x: 0, y: 0 };
      const unchanged = entry.size && Math.abs(entry.size.width - size.width) < 1 && Math.abs(entry.size.height - size.height) < 1;
      if (unchanged) return current;
      const next: EntityLayout = {
        ...current,
        [entity.id]: { ...entityLayout, [nodeId]: { ...entry, size: { width: Math.round(size.width), height: Math.round(size.height) } } },
      };
      persistLayout(next);
      return next;
    });
  }

  /** Re-pack every component around the entity using the measured sizes. */
  function arrangeComponents() {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entitySize = layoutSize(entityLayout[ENTITY_NODE_ID], ENTITY_CARD_SIZE);
      const boundIds = new Set(bindings.map((binding) => binding.id));
      const cards = bindings.map((binding) => {
        const parent = mountParentId(binding.id, binding.mount?.parent, boundIds);
        return { id: binding.id, size: layoutSize(entityLayout[binding.id], COMPONENT_CARD_SIZE), ...(parent ? { parent } : {}) };
      });
      const positions = packMountPositions(cards, entitySize);
      const nextEntity: Record<string, EntityComponentLayout> = {
        ...entityLayout,
        [ENTITY_NODE_ID]: { ...(entityLayout[ENTITY_NODE_ID] ?? { x: 0, y: 0 }), x: 0, y: 0, size: entitySize },
      };
      for (const [id, position] of Object.entries(positions)) nextEntity[id] = { ...(entityLayout[id] ?? {}), x: position.x, y: position.y };
      const next: EntityLayout = { ...current, [entity.id]: nextEntity };
      persistLayout(next);
      return next;
    });
  }

  function updateBindingLayout(bindingId: string, update: (entry: EntityComponentLayout) => EntityComponentLayout): void {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entitySize = layoutSize(entityLayout[ENTITY_NODE_ID], ENTITY_CARD_SIZE);
      const sizes: Record<string, EntitySize> = {};
      for (const binding of bindings) sizes[binding.id] = layoutSize(entityLayout[binding.id], COMPONENT_CARD_SIZE);
      const defaults = defaultEntityPositions(bindings.map((binding) => binding.id), sizes, entitySize);
      const entry = entityLayout[bindingId] ?? { ...(defaults[bindingId] ?? { x: entitySize.width + 24, y: 0 }) };
      const next: EntityLayout = { ...current, [entity.id]: { ...entityLayout, [bindingId]: update(entry) } };
      persistLayout(next);
      return next;
    });
  }

  function setConnection(bindingId: string, patch: { sourceAnchor?: EntityAnchorSide | null; targetAnchor?: string | null }): void {
    updateBindingLayout(bindingId, (entry) => {
      const next = { ...entry };
      if ("sourceAnchor" in patch) {
        if (patch.sourceAnchor) next.sourceAnchor = patch.sourceAnchor;
        else delete next.sourceAnchor;
      }
      if ("targetAnchor" in patch) {
        if (patch.targetAnchor) next.targetAnchor = patch.targetAnchor;
        else delete next.targetAnchor;
      }
      return next;
    });
  }

  function addAnchor(bindingId: string, side: EntityAnchorSide, offset: number): void {
    updateBindingLayout(bindingId, (entry) => ({
      ...entry,
      anchors: [...(entry.anchors ?? []), { id: newAnchorId(), side, offset: Number.isFinite(offset) ? clamp(Math.round(offset), 5, 95) : 50 }],
    }));
  }

  function removeAnchor(bindingId: string, id: string): void {
    updateBindingLayout(bindingId, (entry) => {
      const anchors = (entry.anchors ?? []).filter((anchor) => anchor.id !== id);
      const next = { ...entry };
      if (anchors.length) next.anchors = anchors;
      else delete next.anchors;
      if (next.targetAnchor === id) delete next.targetAnchor;
      return next;
    });
  }

  function connectAnchor(bindingId: string, sourceAnchor: EntityAnchorSide, targetAnchor: string): void {
    updateBindingLayout(bindingId, (entry) => ({ ...entry, sourceAnchor, targetAnchor }));
  }

  /** Drop layout entries for components that are no longer bound. */
  function pruneBindings(activeIds: string[]): void {
    if (!entity) return;
    setLayout((current) => {
      const pruned = pruneEntityLayout(current, entity.id, activeIds);
      persistLayout(pruned);
      return pruned;
    });
  }

  return { persistLayout, moveBinding, measureNode, arrangeComponents, setConnection, addAnchor, removeAnchor, connectAnchor, pruneBindings };
}
