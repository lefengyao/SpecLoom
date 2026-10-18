import { TextDecoder } from "node:util";

const MAX_RECORD_BYTES = 8192;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function legacyLabel(codePage: number): string | undefined {
  if (codePage === 936) return "gbk";
  if (codePage === 932) return "shift_jis";
  if (codePage === 949) return "euc-kr";
  if (codePage === 950) return "big5";
  if (codePage === 866) return "ibm866";
  if (codePage === 874 || (codePage >= 1250 && codePage <= 1258)) return `windows-${codePage}`;
  return undefined;
}

/**
 * Prefer strict UTF-8 per bounded line; only invalid UTF-8 may use the supervisor's
 * system code page. Keeping raw bytes until a line/boundary avoids committing a
 * valid-looking GBK prefix as UTF-8. Separate lines may use different encodings.
 * Encoding-ambiguous bytes and mixed encodings within one line cannot be inferred
 * perfectly; neither a process-wide guess nor a chunk boundary decides encoding.
 */
export class ProcessOutputDecoder {
  private pending = Buffer.alloc(0);
  private header = Buffer.alloc(0);
  private awaitingHeader: boolean;
  private legacy?: TextDecoder;
  private warned = false;
  constructor(private readonly outputMarker?: string) { this.awaitingHeader = outputMarker !== undefined; }

  write(bytes: Buffer): string {
    if (!this.awaitingHeader) return this.consume(bytes);
    const limit = this.outputMarker!.length + 12;
    const take = Math.min(bytes.length, limit - this.header.length);
    this.header = Buffer.concat([this.header, bytes.subarray(0, take)]);
    const newline = this.header.indexOf(10);
    const prefix = Buffer.from(this.outputMarker!);
    const matches = this.header.subarray(0, Math.min(this.header.length, prefix.length)).equals(prefix.subarray(0, Math.min(this.header.length, prefix.length)));
    if (matches && newline < 0 && this.header.length < limit) return "";
    this.awaitingHeader = false;
    const line = this.header.subarray(0, newline).toString("ascii");
    const codePage = matches && newline >= 0 ? line.slice(this.outputMarker!.length) : "";
    const label = /^\d{1,5}$/.test(codePage) ? legacyLabel(Number(codePage)) : undefined;
    if (label) this.legacy = new TextDecoder(label, { fatal: true });
    const remainder = matches && /^\d{1,5}$/.test(codePage) ? this.header.subarray(newline + 1) : this.header;
    const output = this.consume(remainder) + this.consume(bytes.subarray(take));
    this.header = Buffer.alloc(0);
    return output;
  }

  end(): string {
    let output = "";
    if (this.awaitingHeader) { this.awaitingHeader = false; output += this.consume(this.header); this.header = Buffer.alloc(0); }
    if (this.pending.length) output += this.decode(this.pending);
    this.pending = Buffer.alloc(0);
    return output;
  }

  /** A revisable snapshot: retain raw bytes so a later chunk can correct an ambiguous prefix. */
  preview(): string {
    if (this.awaitingHeader || !this.pending.length) return "";
    const end = this.completeBoundary(this.pending);
    return end ? this.decode(this.pending.subarray(0, end), false) : "";
  }

  private consume(bytes: Buffer): string {
    let output = "", offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(bytes.length - offset, MAX_RECORD_BYTES - this.pending.length);
      this.pending = Buffer.concat([this.pending, bytes.subarray(offset, offset + take)]); offset += take;
      let newline: number;
      while ((newline = this.pending.indexOf(10)) >= 0) {
        output += this.decode(this.pending.subarray(0, newline + 1)); this.pending = this.pending.subarray(newline + 1);
      }
      if (this.pending.length === MAX_RECORD_BYTES) {
        // A bounded record may end inside a character; retain at most three bytes.
        const end = this.completeBoundary(this.pending);
        output += this.decode(this.pending.subarray(0, end)); this.pending = this.pending.subarray(end);
      }
    }
    return output;
  }

  private completeBoundary(bytes: Buffer): number {
    for (const decoder of [utf8, this.legacy]) {
      if (!decoder) continue;
      for (let retained = 0; retained <= Math.min(3, bytes.length); retained++) {
        try { decoder.decode(bytes.subarray(0, bytes.length - retained)); return bytes.length - retained; } catch { /* Try a complete multibyte boundary. */ }
      }
    }
    return bytes.length;
  }

  private decode(bytes: Buffer, commit = true): string {
    try { return utf8.decode(bytes); } catch { /* Legacy native programs may ignore the shell's UTF-8 code page. */ }
    if (this.legacy) {
      try {
        const decoded = this.legacy.decode(bytes);
        const binary = [...decoded].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13, 27].includes(code); });
        if (!binary) return decoded;
      } catch { /* Invalid legacy bytes must remain visibly damaged. */ }
    }
    const warning = this.warned ? "" : "[输出包含无法可靠解码的字节，已显示替换字符]\n";
    if (commit) this.warned = true;
    return warning + bytes.toString("utf8");
  }
}
