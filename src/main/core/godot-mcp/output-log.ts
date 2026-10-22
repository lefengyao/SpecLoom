// Adapted from Godot MCP Server's bounded Output-log history helper.
// Copyright (c) KeeVeeG; MIT, see resources/godot-mcp/LICENSE and NOTICE.md.
import { randomBytes, randomUUID } from 'node:crypto';

export const LOG_LEVELS = ['ERROR', 'WARNING', 'INFO', 'DEBUG', 'UNKNOWN'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogOrigin = 'editor' | 'game' | 'unknown';

export interface LogRecord {
  readonly text: string;
  readonly stream: 'editor_output';
  readonly origin: LogOrigin;
  readonly level: LogLevel;
  readonly timestamp?: string;
}

export interface LogSnapshot {
  readonly id: string;
  readonly records: readonly LogRecord[];
  readonly text: string;
  readonly history_truncated: boolean;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface LogPage {
  readonly success: true;
  readonly source: 'editor_output';
  readonly snapshot_id: string;
  readonly records: readonly LogRecord[];
  readonly older_cursor: string | null;
  readonly newer_cursor: string | null;
  readonly history_truncated: boolean;
}

export type LogHistoryErrorCode = 'parameter_error' | 'stale_cursor';

export class LogHistoryError extends Error {
  constructor(
    readonly code: LogHistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LogHistoryError';
  }
}

const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS_PER_SNAPSHOT = 32_768;
const MAX_CURSORS = 8_192;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

interface CursorState {
  readonly snapshot_id: string;
  /** null represents no filter; [] is a filter that selects no records. */
  readonly levels: readonly LogLevel[] | null;
  /** A boundary in the filtered record sequence. */
  readonly position: number;
}

interface PageOptions {
  readonly limit: number;
  readonly levels?: readonly LogLevel[];
}

/**
 * Parse visible Output lines without discarding entries that cannot be
 * classified. Only explicit severity, source, and timestamp markers are used.
 */
export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function parseEditorOutput(content: string): readonly LogRecord[] {
  return parseBoundedEditorOutput(content).records;
}

interface ParsedOutput {
  readonly records: readonly LogRecord[];
  readonly historyTruncated: boolean;
  readonly text: string;
}

function parseBoundedEditorOutput(content: string): ParsedOutput {
  const retained: Array<LogRecord | undefined> = [];
  let firstRetained = 0;
  let retainedCount = 0;
  let retainedBytes = 0;
  let historyTruncated = false;

  const appendRecord = (record: LogRecord): void => {
    const recordBytes = Buffer.byteLength(record.text, 'utf8');
    retained.push(record);
    retainedBytes += recordBytes + (retainedCount > 0 ? 1 : 0);
    retainedCount += 1;

    while (retainedCount > MAX_RECORDS_PER_SNAPSHOT || retainedBytes > MAX_SNAPSHOT_BYTES) {
      const oldest = retained[firstRetained];
      if (oldest === undefined) break;
      retained[firstRetained] = undefined;
      firstRetained += 1;
      retainedCount -= 1;
      retainedBytes -= Buffer.byteLength(oldest.text, 'utf8') + (retainedCount > 0 ? 1 : 0);
      historyTruncated = true;
    }

    // Keep the queue's backing array bounded while avoiding an O(n) shift for
    // each old line discarded from a very verbose Output panel.
    if (firstRetained >= 4_096 && firstRetained >= retained.length / 2) {
      retained.splice(0, firstRetained);
      firstRetained = 0;
    }
  };

  // Walk the string incrementally instead of split(), which would allocate a
  // second array containing every line before the retention limits are applied.
  let lineStart = 0;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf('\n', lineStart);
    if (lineEnd < 0) {
      appendRecord(parseRecord(content.slice(lineStart)));
      break;
    }

    appendRecord(parseRecord(content.slice(lineStart, lineEnd)));
    lineStart = lineEnd + 1;
    // A terminal newline ends the previous record; it does not add an extra one.
  }

  const records = Object.freeze(retained.slice(firstRetained) as LogRecord[]);
  const text = records.map((record) => record.text).join('\n');
  return Object.freeze({ records, historyTruncated, text });
}

function parseRecord(rawLine: string): LogRecord {
  const withoutAnsi = stripAnsi(rawLine);
  const line = withoutAnsi.endsWith('\r') ? withoutAnsi.slice(0, -1) : withoutAnsi;
  let remainder = line;
  let timestamp: string | undefined;

  const timestampMatch = remainder.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*/)
    ?? remainder.match(/^\[?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?\s+/);
  if (timestampMatch) {
    timestamp = timestampMatch[1];
    remainder = remainder.slice(timestampMatch[0].length);
  }

  let origin: LogOrigin = 'unknown';
  const originMatch = remainder.match(/^\[(?:MCP\s+)?(EDITOR|GAME|RUNTIME)\]\s*/i);
  if (originMatch) {
    const marker = originMatch[1]!.toUpperCase();
    origin = marker === 'EDITOR' ? 'editor' : 'game';
    remainder = remainder.slice(originMatch[0].length);
  }

  let level: LogLevel = 'UNKNOWN';
  const bracketedLevel = remainder.match(/^\[(ERROR|WARNING|INFO|DEBUG)\](?:\s+|$)/i);
  const prefixedLevel = remainder.match(/^(?:(?:SCRIPT|SHADER|GDSCRIPT|CORE|RESOURCE|SCENE)\s+)?(ERROR|WARNING|INFO|DEBUG):(?:\s|$)/i);
  const levelMatch = bracketedLevel ?? prefixedLevel;
  if (levelMatch) level = levelMatch[1]!.toUpperCase() as LogLevel;

  const record: LogRecord = {
    text: line,
    stream: 'editor_output',
    origin,
    level,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
  return Object.freeze(record);
}

/**
 * Bounded, immutable in-memory snapshots of the connected editor Output
 * panel. Cursors are random, process-local tokens; restarting the server
 * naturally invalidates every outstanding cursor.
 */
export class LogSnapshotStore {
  private readonly snapshots = new Map<string, LogSnapshot>();
  private readonly cursors = new Map<string, CursorState>();

  createSnapshot(content: string, sourceTruncated = false, now = Date.now()): LogSnapshot {
    this.removeExpired(now);

    const parsed = parseBoundedEditorOutput(content);
    const records = parsed.records;
    const text = parsed.text;
    const historyTruncated = sourceTruncated || parsed.historyTruncated;

    const snapshot: LogSnapshot = Object.freeze({
      id: randomUUID(),
      records: Object.freeze(records),
      text,
      history_truncated: historyTruncated,
      created_at: now,
      expires_at: now + SNAPSHOT_TTL_MS,
    });
    this.snapshots.set(snapshot.id, snapshot);

    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldestId = this.snapshots.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      this.removeSnapshot(oldestId);
    }

    return snapshot;
  }

  latestPage(snapshotId: string, options: PageOptions): LogPage {
    this.removeExpired(Date.now());
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new LogHistoryError('stale_cursor', 'The log snapshot is stale or expired. Request a new output log snapshot.');
    }

    const levels = normalizeLevels(options.levels);
    const records = filterRecords(snapshot.records, levels);
    const start = Math.max(0, records.length - options.limit);
    return this.makePage(snapshot, records, start, records.length, levels);
  }

  pageFromCursor(
    cursor: string,
    direction: 'older' | 'newer' | undefined,
    options: PageOptions,
  ): LogPage {
    this.removeExpired(Date.now());
    const cursorState = this.cursors.get(cursor);
    if (!cursorState) {
      throw new LogHistoryError('stale_cursor', 'The cursor is stale, expired, evicted, or from a previous server session. Request a new output log snapshot.');
    }

    const snapshot = this.snapshots.get(cursorState.snapshot_id);
    if (!snapshot) {
      this.cursors.delete(cursor);
      throw new LogHistoryError('stale_cursor', 'The cursor refers to a stale or expired log snapshot. Request a new output log snapshot.');
    }

    const levels = options.levels === undefined ? cursorState.levels : normalizeLevels(options.levels);
    if (!sameLevels(levels, cursorState.levels)) {
      throw new LogHistoryError('parameter_error', 'The levels filter cannot change while following a cursor. Omit levels to reuse the cursor filter, or request a new snapshot.');
    }

    const records = filterRecords(snapshot.records, levels);
    const actualDirection = direction ?? 'older';
    let start: number;
    let end: number;
    if (actualDirection === 'older') {
      end = Math.min(cursorState.position, records.length);
      start = Math.max(0, end - options.limit);
    } else {
      start = Math.min(cursorState.position, records.length);
      end = Math.min(records.length, start + options.limit);
    }
    return this.makePage(snapshot, records, start, end, levels);
  }

  private makePage(
    snapshot: LogSnapshot,
    records: readonly LogRecord[],
    start: number,
    end: number,
    levels: readonly LogLevel[] | null,
  ): LogPage {
    const needsOlderCursor = start > 0;
    const needsNewerCursor = end < records.length;
    this.reserveCursorCapacity(Number(needsOlderCursor) + Number(needsNewerCursor));

    return Object.freeze({
      success: true,
      source: 'editor_output',
      snapshot_id: snapshot.id,
      records: Object.freeze(records.slice(start, end)),
      older_cursor: needsOlderCursor ? this.createCursor(snapshot, levels, start) : null,
      newer_cursor: needsNewerCursor ? this.createCursor(snapshot, levels, end) : null,
      history_truncated: snapshot.history_truncated,
    });
  }

  private reserveCursorCapacity(required: number): void {
    while (this.cursors.size + required > MAX_CURSORS) {
      const oldestCursor = this.cursors.keys().next().value as string | undefined;
      if (oldestCursor === undefined) break;
      this.cursors.delete(oldestCursor);
    }
  }

  private createCursor(snapshot: LogSnapshot, levels: readonly LogLevel[] | null, position: number): string {
    let token: string;
    do {
      token = randomBytes(24).toString('base64url');
    } while (this.cursors.has(token));

    this.cursors.set(
      token,
      Object.freeze({
        snapshot_id: snapshot.id,
        levels: levels === null ? null : Object.freeze([...levels]),
        position,
      }),
    );
    return token;
  }

  private removeExpired(now: number): void {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expires_at <= now) this.removeSnapshot(id);
    }
  }

  private removeSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    for (const [token, state] of this.cursors) {
      if (state.snapshot_id === snapshotId) this.cursors.delete(token);
    }
  }
}

function normalizeLevels(levels: readonly LogLevel[] | undefined): readonly LogLevel[] | null {
  if (levels === undefined) return null;
  return Object.freeze([...new Set(levels)].sort());
}

function sameLevels(left: readonly LogLevel[] | null, right: readonly LogLevel[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((level, index) => level === right[index]);
}

function filterRecords(records: readonly LogRecord[], levels: readonly LogLevel[] | null): readonly LogRecord[] {
  if (levels === null) return records;
  const selected = new Set(levels);
  return records.filter((record) => selected.has(record.level));
}
