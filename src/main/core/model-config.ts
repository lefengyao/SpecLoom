import { ModelProfileSchema, type ModelProfile } from "../../shared/contracts";
import { ProjectError } from "./errors";

export function parseModelProfile(value: unknown): ModelProfile {
  const parsed = ModelProfileSchema.safeParse(value);
  if (!parsed.success || parsed.data.timeoutMs > 300_000 || parsed.data.maxToolRounds > 32
    || (parsed.data.maxOutputTokens ?? 0) > 65_536 || parsed.data.id.length > 256
    || parsed.data.name.length > 256 || parsed.data.model.length > 256 || parsed.data.baseUrl.length > 2_048) {
    throw new ProjectError("MODEL_ERROR", "Invalid or unbounded model configuration.");
  }
  return parsed.data;
}

export function chatCompletionsUrl(baseUrl: string): string {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new ProjectError("MODEL_ERROR", "Invalid model endpoint."); }
  const validated = ModelProfileSchema.shape.baseUrl.safeParse(baseUrl);
  if (!validated.success) throw new ProjectError("MODEL_ERROR", "Invalid model endpoint.");
  const root = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
  endpoint.hash = "";
  endpoint.searchParams.sort();
  return endpoint.toString();
}

export const normalizeEndpoint = chatCompletionsUrl;
