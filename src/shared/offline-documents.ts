import { z } from "zod";

export const OfflineDocumentBundleIdSchema = z.string().uuid();
export const OfflineDocumentVersionIdSchema = z.string().uuid();
const relativeDocumentPath = z.string().min(1).max(2048).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.split("/").some((segment) => segment === ".." || segment === "");
}, "Document paths must be relative and cannot escape the bundle");

export const OfflineDocumentFileSchema = z.object({
  path: relativeDocumentPath,
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  size: z.number().int().nonnegative(),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type OfflineDocumentFile = z.infer<typeof OfflineDocumentFileSchema>;

export const OfflineDocumentVersionSchema = z.object({
  id: OfflineDocumentVersionIdSchema,
  label: z.string().trim().min(1).max(128),
  fileCount: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  importedAt: z.string().datetime(),
  files: z.array(OfflineDocumentFileSchema).max(10000),
}).strict();
export type OfflineDocumentVersion = z.infer<typeof OfflineDocumentVersionSchema>;

export const OfflineDocumentBundleSchema = z.object({
  id: OfflineDocumentBundleIdSchema,
  name: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
  activeVersionId: OfflineDocumentVersionIdSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  versions: z.array(OfflineDocumentVersionSchema).max(128),
}).strict();
export type OfflineDocumentBundle = z.infer<typeof OfflineDocumentBundleSchema>;

export const OfflineDocumentReadOptionsSchema = z.object({
  /** UTF-16 offset; use the returned nextOffset rather than counting characters. */
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(8000).default(6000),
}).strict();
export type OfflineDocumentReadOptions = z.input<typeof OfflineDocumentReadOptionsSchema>;

export const OfflineDocumentReadSchema = z.object({
  bundleId: OfflineDocumentBundleIdSchema,
  versionId: OfflineDocumentVersionIdSchema,
  path: relativeDocumentPath,
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  size: z.number().int().nonnegative(),
  kind: z.enum(["text", "binary"]),
  content: z.string().optional(),
  page: z.object({
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    totalChars: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).strict().optional(),
}).strict();
export type OfflineDocumentRead = z.infer<typeof OfflineDocumentReadSchema>;

export interface OfflineDocumentImportOptions {
  /** The first imported version is active automatically; later imports opt in explicitly. */
  setCurrent?: boolean;
}

export const OFFLINE_DOCUMENT_LIMITS = {
  maxBundles: 128,
  maxVersionsPerBundle: 128,
  maxFilesPerVersion: 10_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxVersionBytes: 512 * 1024 * 1024,
  maxReadTextBytes: 1 * 1024 * 1024,
} as const;
