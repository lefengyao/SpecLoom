import type { z } from "zod";
import type { OfflineDocumentRead, OfflineDocumentReadOptionsSchema } from "../../shared/offline-documents";
import { toolOutput } from "./agent-output";
import { ProjectError } from "./errors";

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
}

/** Keep the content and continuation metadata intact through the real tool serializer. */
export function offlineDocumentPage(document: OfflineDocumentRead, text: string, options: z.output<typeof OfflineDocumentReadOptionsSchema>): OfflineDocumentRead {
  const { offset, limit } = options;
  if (offset > text.length || splitsSurrogate(text, offset)) {
    throw new ProjectError("VALIDATION_FAILED", "Invalid document offset; use page.nextOffset to continue reading", { offset, totalChars: text.length });
  }
  const candidate = (length: number): OfflineDocumentRead => {
    let end = Math.min(offset + length, text.length);
    if (splitsSurrogate(text, end)) end--;
    const hasMore = end < text.length;
    return { ...document, content: text.slice(offset, end), page: { offset, nextOffset: hasMore ? end : null, totalChars: text.length, hasMore } };
  };
  const fits = (page: OfflineDocumentRead): boolean => {
    const output = JSON.parse(toolOutput(true, page)) as { truncated: boolean; result?: OfflineDocumentRead };
    // A partial redaction marker must not be rewritten by final output redaction.
    return !output.truncated && output.result?.content === page.content;
  };
  let low = 0;
  let high = Math.min(limit, text.length - offset);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  const page = candidate(low);
  if (!fits(page) || (offset < text.length && !page.content?.length)) {
    throw new ProjectError("VALIDATION_FAILED", "Document page cannot fit; increase limit to include a complete character", { offset, limit });
  }
  return page;
}
