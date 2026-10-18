import { z } from "zod";

export const ApprovalModeSchema = z.enum(["ask", "auto", "full"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";
export const ToolApprovalInputSchema = z.object({
  toolName: z.string().min(1).max(128),
  arguments: z.string().max(16384),
  reason: z.string().min(1).max(2000),
  risk: z.enum(["standard", "high"]),
}).strict();
export type ToolApprovalInput = z.infer<typeof ToolApprovalInputSchema>;
const approvalId = z.string().min(1).max(256);
export const ApprovalRequestSchema = ToolApprovalInputSchema.extend({ id: approvalId, runId: approvalId, sessionId: approvalId });
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
