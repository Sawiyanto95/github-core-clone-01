// gitcore.ts — the git object model and the wire framing, as pure functions
// over Buffers. Nothing here touches the network or the store: it hashes
// objects, reads and writes trees, commits and tags, builds and reads
// packfiles (plain objects, no deltas on write), and encodes and decodes
// pkt-lines and sideband packets. The store and the smart-HTTP handlers
// build on these.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface Obj {
  kind: ObjKind;
  bytes: Buffer;
}

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The object id: SHA-1 over `<kind> <size>\0` plus the object's bytes. */
export function oidOf(kind: ObjKind, bytes: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${kind} ${bytes.length}\0`, 'utf8'));
  hash.update(bytes);
  return hash.digest('hex');
}

// -------------------------------------------------------------------------------- trees

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function readTree(bytes: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = bytes.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > bytes.length) throw new Error('tree entry is truncated');
    const mode = bytes.subarray(at, space).toString('ascii');
    const name = bytes.subarray(space + 1, nul).toString('utf8');
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    items.push({ mode, name, oid });
    at = nul + 21;
  }
  return items;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function treeOrder(a: TreeItem, b: TreeItem): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Serialise tree entries, sorted the way git sorts them. */
export function writeTree(items: readonly TreeItem[]): Buffer {
  const sorted = [...items].sort(treeOrder);
  const parts: Buffer[] = [];
  for (const item of sorted) {
    parts.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
    parts.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The entry with a given name in a parsed tree, or undefined when absent. */
export function treeEntry(items: readonly TreeItem[], name: string): TreeItem | undefined {
  return items.find((item) => item.name === name);
}

/** A tree flattened to path -> blob oid, walking subdirectories. */
export function flattenTree(
  lookup: (oid: string) => Obj | undefined,
  treeOid: string,
  prefix: string,
  out: Map<string, string>,
): void {
  const tree = lookup(treeOid);
  if (tree === undefined || tree.kind !== 'tree') return;
  for (const item of readTree(tree.bytes)) {
    const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.mode === '40000') flattenTree(lookup, item.oid, path, out);
    else if (item.mode !== '160000') out.set(path, item.oid);
  }
}

// -------------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Throws on a malformed header layout. */
export function readCommit(bytes: Buffer): CommitInfo {
  const blank = bytes.indexOf('\n\n');
  const head = blank < 0 ? bytes.length : blank;
  const message = blank < 0 ? '' : bytes.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of bytes.subarray(0, head).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. `who` is a full `Name <email> <epoch> +0000` line. */
export function writeCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjKind;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function readTag(bytes: Buffer): TagInfo {
  const blank = bytes.indexOf('\n\n');
  const head = blank < 0 ? bytes.length : blank;
  const headers = new Map<string, string>();
  for (const line of bytes.subarray(0, head).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjKind,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : bytes.subarray(blank + 2).toString('utf8'),
  };
}

/** Follow tag objects to the commit they point at. */
export function peelToCommit(lookup: (oid: string) => Obj | undefined, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = lookup(current);
    if (obj === undefined) return null;
    if (obj.kind === 'commit') return current;
    if (obj.kind !== 'tag') return null;
    current = readTag(obj.bytes).object;
  }
  return null;
}

// -------------------------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`: commit -> tree + parents, tag -> its
 * target, tree -> entries (gitlinks skipped). `barrier` names commits whose
 * parents are not traversed (a shallow boundary is held, its history is not).
 * Missing objects are skipped quietly; the caller decides whether that matters.
 */
export function reachable(
  lookup: (oid: string) => Obj | undefined,
  roots: Iterable<string>,
  barrier?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.kind === 'commit') {
      let info: CommitInfo;
      try {
        info = readCommit(obj.bytes);
      } catch {
        continue;
      }
      queue.push(info.tree);
      if (barrier === undefined || !barrier.has(oid)) {
        for (const parent of info.parents) queue.push(parent);
      }
    } else if (obj.kind === 'tag') {
      try {
        queue.push(readTag(obj.bytes).object);
      } catch {
        continue;
      }
    } else if (obj.kind === 'tree') {
      let items: TreeItem[];
      try {
        items = readTree(obj.bytes);
      } catch {
        continue;
      }
      for (const item of items) if (item.mode !== '160000') queue.push(item.oid);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or is the tip itself). */
export function isAncestor(lookup: (oid: string) => Obj | undefined, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.kind !== 'commit') continue;
    try {
      for (const parent of readCommit(obj.bytes).parents) queue.push(parent);
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The newest common ancestor of two commits, for a merge base. Walks the
 * second tip's ancestry in breadth-first order and returns the first commit
 * the first tip also reaches; null when the histories never meet.
 */
export function mergeBase(lookup: (oid: string) => Obj | undefined, first: string, second: string): string | null {
  const firstSide = reachable(lookup, [first]);
  if (firstSide.has(second)) return second;
  const seen = new Set<string>();
  const queue: string[] = [second];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (firstSide.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.kind !== 'commit') continue;
    try {
      for (const parent of readCommit(obj.bytes).parents) queue.push(parent);
    } catch {
      continue;
    }
  }
  return null;
}

/** Commits reachable from a tip, newest first (breadth-first from the tip). */
export function commitList(lookup: (oid: string) => Obj | undefined, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.kind !== 'commit') continue;
    order.push(oid);
    try {
      for (const parent of readCommit(obj.bytes).parents) queue.push(parent);
    } catch {
      continue;
    }
  }
  return order;
}

// -------------------------------------------------------------------------------- packfiles

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let at = start + 1;
  while (byte & 0x80) {
    if (at >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[at] as number;
    at += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: at, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let at = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (at >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[at] as number;
    at += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: at };
}

function inflateAt(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta's copy/insert stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[at] as number;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[at] as number) * 2 ** shift;
          at += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[at] as number) * 2 ** shift;
          at += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (at + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, at, at + literal);
      at += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA entries. `outside` supplies a base a thin pack
 * leaves out. Every object's id is recomputed; a mismatch is an error.
 */
export function readPack(pack: Buffer, outside?: (oid: string) => Obj | undefined): Map<string, Obj> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const trailer = pack.subarray(trailerAt).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerAt)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface Raw {
    offset: number;
    code: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: Obj;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let at = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = at;
    const header = readVarint(pack, at);
    at = header.next;
    const code = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, code, size: header.size, data: Buffer.alloc(0) };
    if (code === 6) {
      const base = readOfsBase(pack, at);
      at = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (code === 7) {
      if (at + 20 > trailerAt) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (CODE_KIND[code] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${code}`);
    }
    const inflated = inflateAt(pack, at, trailerAt);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    at = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (at !== trailerAt) throw new Error(`pack has ${trailerAt - at} stray bytes before its trailer`);

  const objects = new Map<string, Obj>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): Obj => {
    if (entry.resolved !== undefined && entry.oid !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let kind: ObjKind;
    let data: Buffer;
    if (entry.code === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      kind = base.kind;
      data = applyDelta(base.bytes, entry.data);
    } else if (entry.code === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = byOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        kind = base.kind;
        data = applyDelta(base.bytes, entry.data);
      } else {
        const external = outside?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        kind = external.kind;
        data = applyDelta(external.bytes, entry.data);
      }
    } else {
      kind = CODE_KIND[entry.code] as ObjKind;
      data = entry.data;
    }
    const oid = oidOf(kind, data);
    const obj: Obj = { kind, bytes: data };
    entry.resolved = obj;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    if (entry.oid !== undefined && !objects.has(entry.oid)) objects.set(entry.oid, obj);
  }
  return objects;
}

function packObjectHeader(kind: ObjKind, size: number): Buffer {
  const code = KIND_CODE[kind];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: Iterable<Obj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.kind, obj.bytes.length));
    parts.push(deflateSync(obj.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------- pkt-lines

export const PKT_MAX = 65520;

/** One data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_MAX - 4}-byte maximum`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload?: Buffer;
}

/** Decode a whole buffer into packets. Throws on a malformed header. */
export function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error(`truncated pkt-line: ${buf.length - at} trailing byte(s)`);
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length === 3 || length > PKT_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > buf.length) throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - at} available`);
    out.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return out;
}

/** The text of every data packet, control packets dropped. A packet's text
 * is one protocol line, so one trailing newline is stripped from each. */
export function pktLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) {
      lines.push(packet.payload.toString('utf8').replace(/\r?\n$/, ''));
    }
  }
  return lines;
}

/** Split pack bytes into sideband band-1 packets, each well under the pkt-line limit. */
export function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const step = 32768;
  for (let at = 0; at < pack.length; at += step) {
    const slice = pack.subarray(at, Math.min(pack.length, at + step));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
  return chunks;
}
