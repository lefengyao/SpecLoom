import { describe, expect, test } from "vitest";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import { validateWorkflowDefinition } from "../../src/shared/workflow";
import { addReadAgent, canRemoveNode, connectSuccess, deleteEdges, removeReadAgent } from "../../src/renderer/workflow/workflow-editing";

describe("B-aware workflow editing", () => {
  test("adds a read-only agent in front of the write agent and keeps the definition valid", async () => {
    const definition = await loadOfficialWorkflow();
    const added = addReadAgent(definition, "read_extra");
    expect(added).toBeDefined();
    if (!added) return;
    expect(added.definition.nodes).toHaveLength(7);
    const addedNode = added.definition.nodes.find((node) => node.id === "read_extra");
    expect(addedNode?.type).toBe("agent");
    if (addedNode?.type === "agent") expect(addedNode.config.access).toBe("read");
    expect(added.definition.edges.some((edge) => edge.from === "plan" && edge.to === "read_extra")).toBe(true);
    expect(added.definition.edges.some((edge) => edge.from === "read_extra" && edge.to === "implement")).toBe(true);
    expect(validateWorkflowDefinition(added.definition).id).toBe(definition.id);
    expect(canRemoveNode(added.definition, "read_extra")).toBe(true);

    const removed = removeReadAgent(added.definition, "read_extra");
    expect(removed?.nodes).toHaveLength(6);
    expect(validateWorkflowDefinition(removed!).id).toBe(definition.id);
    expect(canRemoveNode(definition, "plan")).toBe(false);
    expect(canRemoveNode(definition, "implement")).toBe(false);
  });

  test("rewires one success edge and can delete an edge", async () => {
    const definition = await loadOfficialWorkflow();
    const rewired = connectSuccess(definition, "context", "implement", "e_custom");
    expect(rewired?.edges.find((edge) => edge.id === "e_custom")?.to).toBe("implement");
    expect(rewired?.edges.some((edge) => edge.from === "context" && edge.to === "plan")).toBe(false);
    expect(() => validateWorkflowDefinition(rewired!)).toThrow(/unreachable/);

    const deleted = deleteEdges(definition, ["e2"]);
    expect(deleted.edges).toHaveLength(5);
  });
});
