import { z } from "zod";

/** Bounds shared by the renderer, project validator, and agent material tools. */
export const STATE_MACHINE_LIMITS = {
  states: 128,
  transitions: 512,
  id: 128,
  title: 200,
  description: 4000,
  event: 128,
} as const;

const stateId = z.string().trim().min(1).max(STATE_MACHINE_LIMITS.id);
const stateTitle = z.string().trim().min(1).max(STATE_MACHINE_LIMITS.title);

export const StateMachineStateSchema = z.object({
  id: stateId,
  title: stateTitle,
  description: z.string().max(STATE_MACHINE_LIMITS.description).optional(),
}).strict();
export type StateMachineState = z.infer<typeof StateMachineStateSchema>;

export const StateMachineTransitionSchema = z.object({
  from: stateId,
  event: z.string().trim().min(1).max(STATE_MACHINE_LIMITS.event),
  to: stateId,
}).strict();
export type StateMachineTransition = z.infer<typeof StateMachineTransitionSchema>;

export const StateMachineSchema = z.object({
  initialState: stateId,
  states: z.array(StateMachineStateSchema).min(1).max(STATE_MACHINE_LIMITS.states),
  transitions: z.array(StateMachineTransitionSchema).max(STATE_MACHINE_LIMITS.transitions),
}).strict().superRefine((machine, context) => {
  const ids = new Set<string>();
  for (const [index, state] of machine.states.entries()) {
    if (ids.has(state.id)) context.addIssue({ code: "custom", message: `State '${state.id}' is already defined`, path: ["states", index, "id"] });
    ids.add(state.id);
  }
  if (!ids.has(machine.initialState)) context.addIssue({ code: "custom", message: `Initial state '${machine.initialState}' does not exist`, path: ["initialState"] });
  const transitions = new Set<string>();
  for (const [index, transition] of machine.transitions.entries()) {
    if (!ids.has(transition.from)) context.addIssue({ code: "custom", message: `Transition source '${transition.from}' does not exist`, path: ["transitions", index, "from"] });
    if (!ids.has(transition.to)) context.addIssue({ code: "custom", message: `Transition target '${transition.to}' does not exist`, path: ["transitions", index, "to"] });
    const key = `${transition.from}\u0000${transition.event}`;
    if (transitions.has(key)) context.addIssue({ code: "custom", message: `Transition '${transition.from}' + '${transition.event}' is already defined`, path: ["transitions", index] });
    transitions.add(key);
  }
});
export type StateMachine = z.infer<typeof StateMachineSchema>;

export function isStateMachine(value: unknown): value is StateMachine {
  return StateMachineSchema.safeParse(value).success;
}
