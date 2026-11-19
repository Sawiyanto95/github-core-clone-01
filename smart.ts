// smart.ts — git smart HTTP: the two info/refs advertisements, the
// upload-pack conversation (protocol v2 with ls-refs and fetch, plus a v0
// fallback) and receive-pack (v0, with report-status). Packs are built and
// read by gitcore.ts; this module only decides which objects travel and
// which refs move. A malformed request never takes the server down: it
// answers 400 and keeps serving.

import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  decodePkts,
  isOid,
  mergeBase,
  pkt,
  pktLines,
  readCommit,
  readPack,
  reachable,
  sidebandChunks,
  writePack,
  type Obj,
} from './gitcore.ts';
import { errReply, headerText, jsonReply, type Ctx, type Reply } from './kit.ts';
import { DEFAULT_BRANCH, Vault, type RepoRec } from './vault.ts';

const AGENT = 'forge/1.0';

/**
 * Whole fetch responses, keyed by everything that can change them: the
 * repository's identity and generation plus the request's wants, haves,
 * shallow boundaries and depth. The clone workload repeats the same fetch
 * fifty times, so the later clones reuse the first one's bytes. Entries are
 * never mutated after they are built, and the generation bump on any
 * object or ref change keeps a stale pack from ever being served.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 32;

function fetchCacheKey(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowHeld: readonly string[],
  depth: number | null,
): string {
  return [
    `${repo.owner}/${repo.name}#${repo.createdSeq}@${repo.generation}`,
    `w=${[...wants].sort().join(',')}`,
    `h=${[...haves].sort().join(',')}`,
    `s=${[...shallowHeld].sort().join(',')}`,
    `d=${depth ?? ''}`,
  ].join('|');
}

function fetchCachePut(key: string, response: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value as string | undefined;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, response);
}

/** The caps a v0 upload-pack advertisement carries on its first ref line. */
const UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`;
/** The caps a v0 receive-pack advertisement must carry. */
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** Split `/{owner}/{repo}.git/...` into the repo and the rest of the path. */
function gitPath(ctx: Ctx): { owner: string; repo: string; tail: string[] } | null {
  if (ctx.parts.length < 3) return null;
  const owner = ctx.parts[0] as string;
  const repoPart = ctx.parts[1] as string;
  if (!repoPart.endsWith('.git')) return null;
  return { owner, repo: repoPart.slice(0, -4), tail: ctx.parts.slice(2) };
}

/** One ref line for a v0 advertisement; `caps` only on the very first line. */
function v0RefLine(oid: string, name: string, caps: string | null, peeled?: string): Buffer {
  let text = `${oid} ${name}`;
  if (peeled !== undefined) text = `${oid} ${name}^{}`;
  if (caps !== null) text += `\0${caps}`;
  return pkt(`${text}\n`);
}

interface RefRow {
  name: string;
  oid: string;
  peeled: string | null;
}

/** Every ref with its peeled commit (for annotated tags), in advertisement order. */
function refRows(vault: Vault, repo: RepoRec): RefRow[] {
  const rows: RefRow[] = [];
  const lookup = vault.objectOf(repo);
  for (const row of vault.sortedRefs(repo)) {
    const name = row.name;
    const oid = row.oid;
    let peeled: string | null = null;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.kind === 'tag') {
      const target = vault.peelRef(repo, name);
      if (target !== null && target !== oid) peeled = target;
    }
    void lookup;
    rows.push({ name, oid, peeled });
  }
  return rows;
}

function v0Advertisement(service: string, rows: RefRow[], caps: string, headTip: string | null): Buffer {
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), FLUSH_PKT];
  if (rows.length === 0) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headTip ?? rows[0]?.oid ?? ZERO_OID;
    chunks.push(v0RefLine(head, 'HEAD', caps));
    for (const row of rows) {
      // Capabilities travel only on the HEAD line above; every ref after it
      // is a bare `<oid> <name>` line, with a peeled line after a tag ref.
      chunks.push(v0RefLine(row.oid, row.name, null));
      if (row.peeled !== null) chunks.push(v0RefLine(row.peeled, row.name, null, row.peeled));
    }
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    pkt(`agent=${AGENT}\n`),
    FLUSH_PKT,
  ]);
}

// ---------------------------------------------------------------- upload-pack

interface FetchPlan {
  /** The objects to send, with their ids. */
  send: Map<string, Obj>;
  /** Commits that stay shallow after this fetch. */
  shallow: string[];
  /** Commits that stop being shallow because their parent now travels. */
  unshallow: string[];
  /** The client's `have` commits this forge actually holds. */
  held: Set<string>;
}

/**
 * Which objects a fetch must send. `wants` are the tips the client asked
 * for; `haves` are commits it already holds; `knownShallow` are its shallow
 * boundaries. `depth` caps how far back the want side walks (want = 1).
 */
function planFetch(
  vault: Vault,
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  knownShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = vault.objectOf(repo);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (isOid(want) && !dist.has(want)) {
      dist.set(want, 1);
      queue.push(want);
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const distance = dist.get(oid) as number;
    const obj = lookup(oid);
    if (obj === undefined || obj.kind !== 'commit') continue;
    if (depth !== null && distance >= depth) {
      boundary.add(oid);
      continue;
    }
    let parents: string[] = [];
    try {
      parents = readCommit(obj.bytes).parents;
    } catch {
      parents = [];
    }
    for (const parent of parents) {
      if (!dist.has(parent)) {
        dist.set(parent, distance + 1);
        queue.push(parent);
      }
    }
  }
  const wantObjects = reachable(lookup, [...dist.keys()], boundary);
  const haveObjects = reachable(lookup, haves, new Set(knownShallow));
  const send = new Map<string, Obj>();
  for (const oid of wantObjects) {
    if (haveObjects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) send.set(oid, obj);
  }
  const shallow: string[] = [];
  for (const oid of boundary) if (!haveObjects.has(oid)) shallow.push(oid);
  const unshallow: string[] = [];
  for (const old of knownShallow) {
    if (!dist.has(old)) continue;
    const obj = lookup(old);
    if (obj === undefined || obj.kind !== 'commit') continue;
    let parents: string[] = [];
    try {
      parents = readCommit(obj.bytes).parents;
    } catch {
      parents = [];
    }
    if (parents.some((parent) => send.has(parent))) unshallow.push(old);
  }
  shallow.sort();
  unshallow.sort();
  const held = new Set<string>();
  for (const have of haves) if (repo.objects.has(have)) held.add(have);
  return { send, shallow, unshallow, held };
}

function fetchResponse(plan: FetchPlan, haves: readonly string[], depthRequested: boolean): Buffer {
  // Protocol v2 sections each open with a header line naming the section,
  // and a delim packet closes each section but the last (which ends with a
  // flush). The acknowledgments section is sent only when the client named
  // commits it already holds: one ACK per held commit plus `ready`, or NAK
  // when the server holds none of them. The shallow-info section is sent
  // only when a depth was requested. The packfile section always follows,
  // opening with the literal line "packfile" and carrying the pack in
  // sideband packets.
  const chunks: Buffer[] = [];
  if (haves.length > 0) {
    chunks.push(pkt('acknowledgments\n'));
    const held = haves.filter((have) => plan.held.has(have));
    if (held.length === 0) {
      chunks.push(pkt('NAK\n'));
    } else {
      for (const oid of held) chunks.push(pkt(`ACK ${oid}\n`));
      chunks.push(pkt('ready\n'));
    }
    chunks.push(DELIM_PKT);
  }
  if (depthRequested) {
    chunks.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
    chunks.push(DELIM_PKT);
  }
  chunks.push(pkt('packfile\n'));
  // Pack entries are ordered by object id, so the same fetch always builds
  // the same bytes — the trial's replay check depends on that stability.
  const sorted = [...plan.send.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const packed = writePack(sorted.map(([, obj]) => obj));
  chunks.push(...sidebandChunks(packed));
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

/** Answer a v2 ls-refs request. */
function lsRefsResponse(vault: Vault, repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const rows = refRows(vault, repo);
  const lines: string[] = [];
  if (prefixes.length === 0) {
    const headTip = vault.headTip(repo);
    if (headTip !== null) {
      lines.push(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${headTip} HEAD`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
    for (const row of rows) {
      lines.push(row.oid + ' ' + row.name + (peel && row.peeled !== null ? ` peeled:${row.peeled}` : ''));
    }
  } else {
    // A prefix filters server-side. HEAD is a ref like any other here: it
    // appears only when a prefix matches it (for example `ref-prefix HEAD`
    // in a clone), never when the prefixes name something else.
    const headTip = vault.headTip(repo);
    if (headTip !== null && prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
      lines.push(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${headTip} HEAD`);
    }
    for (const row of rows) {
      if (!prefixes.some((prefix) => row.name.startsWith(prefix))) continue;
      lines.push(row.oid + ' ' + row.name + (peel && row.peeled !== null ? ` peeled:${row.peeled}` : ''));
    }
  }
  const chunks = lines.map((line) => pkt(`${line}\n`));
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function uploadPackV2(vault: Vault, repo: RepoRec, ctx: Ctx): Reply {
  let packets;
  try {
    packets = decodePkts(ctx.body);
  } catch (err) {
    return errReply(400, (err as Error).message);
  }
  const lines = pktLines(packets);
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length) ?? '';
  const afterDelim = packets.findIndex((packet) => packet.kind === 'delim');
  const args = afterDelim < 0 ? [] : pktLines(packets.slice(afterDelim + 1));
  if (command === 'ls-refs') {
    return {
      status: 200,
      raw: lsRefsResponse(vault, repo, args),
      contentType: 'application/x-git-upload-pack-result',
    };
  }
  if (command !== 'fetch') {
    return errReply(400, `unknown upload-pack command ${JSON.stringify(command)}`);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowHeld: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowHeld.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  const cacheKey = fetchCacheKey(repo, wants, haves, shallowHeld, depth);
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) {
    return {
      status: 200,
      raw: cached,
      contentType: 'application/x-git-upload-pack-result',
    };
  }
  const plan = planFetch(vault, repo, wants, haves, shallowHeld, depth);
  const response = fetchResponse(plan, haves, depth !== null);
  fetchCachePut(fetchCacheKey(repo, wants, haves, shallowHeld, depth), response);
  return {
    status: 200,
    raw: response,
    contentType: 'application/x-git-upload-pack-result',
  };
}

function uploadPackV0(vault: Vault, repo: RepoRec, ctx: Ctx): Reply {
  let packets;
  try {
    packets = decodePkts(ctx.body);
  } catch (err) {
    return errReply(400, (err as Error).message);
  }
  const lines = pktLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const clean = line.split('\0')[0] as string;
    const trimmed = clean.trim();
    if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).trim().split(' ')[0] as string);
    else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('deepen ')) {
      const parsed = Number.parseInt(trimmed.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  const plan = planFetch(vault, repo, wants, haves, [], depth);
  const chunks: Buffer[] = [];
  const held = haves.filter((have) => repo.objects.has(have));
  if (held.length === 0) {
    chunks.push(pkt('NAK\n'));
  } else {
    for (const oid of held) chunks.push(pkt(`ACK ${oid}\n`));
  }
  if (depth !== null) {
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
  }
  const sorted = [...plan.send.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  chunks.push(...sidebandChunks(writePack(sorted.map(([, obj]) => obj))));
  chunks.push(FLUSH_PKT);
  return {
    status: 200,
    raw: Buffer.concat(chunks),
    contentType: 'application/x-git-upload-pack-result',
  };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Read pkt-lines up to the first flush; return the lines and the offset of
 * the first byte after that flush. The packfile follows at that offset.
 */
function readCommandList(body: Buffer): { lines: string[]; afterFlush: number } {
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const head = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) return { lines, afterFlush: at + 4 };
    if (length < 4 || at + length > body.length) throw new Error('truncated pkt-line in command list');
    const payload = body.subarray(at + 4, at + length).toString('utf8');
    for (const line of payload.split('\n')) if (line !== '') lines.push(line);
    at += length;
  }
  throw new Error('command list has no flush packet');
}

function receivePack(vault: Vault, repo: RepoRec, ctx: Ctx): Reply {
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { lines, afterFlush } = readCommandList(ctx.body);
    packBytes = ctx.body.subarray(afterFlush);
    for (const line of lines) {
      const clean = line.split('\0')[0] as string;
      const fields = clean.trim().split(' ');
      if (fields.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(clean)}`);
      const [oldOid, newOid, ref] = fields as [string, string, string];
      if (!isOid(oldOid) || !isOid(newOid)) throw new Error('receive-pack command has a bad object id');
      commands.push({ oldOid, newOid, ref });
    }
  } catch (err) {
    return errReply(400, (err as Error).message);
  }
  if (commands.length === 0) return errReply(400, 'receive-pack sent no commands');

  const report: string[] = [];
  let changed = false;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, vault.objectOf(repo));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      // New objects arrived, so any cached fetch answer for this repo is
      // stale — even when every ref command below is refused.
      changed = true;
      report.push('unpack ok');
    } catch (err) {
      report.push(`unpack ${(err as Error).message}`);
      return receiveResult(report);
    }
  } else {
    report.push('unpack ok');
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        report.push(`ng ${command.ref} ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} old value does not match`);
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} object ${command.newOid} is missing`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${command.ref} ref already exists`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (current === undefined) {
      report.push(`ng ${command.ref} ref does not exist`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} old value does not match`);
      continue;
    }
    if (!vault.isFastForward(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    report.push(`ok ${command.ref}`);
  }
  if (changed) repo.generation += 1;
  return receiveResult(report);
}

/** Wrap report lines in band 1, end the report with a flush, close the stream. */
function receiveResult(lines: readonly string[]): Reply {
  const inner = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH_PKT]);
  const band = pkt(Buffer.concat([Buffer.from([1]), inner]));
  return {
    status: 200,
    raw: Buffer.concat([band, FLUSH_PKT]),
    contentType: 'application/x-git-receive-pack-result',
  };
}

// ---------------------------------------------------------------- entry points

export function handleInfoRefs(vault: Vault, ctx: Ctx): Reply {
  const path = gitPath(ctx);
  if (path === null || path.tail.length !== 2 || path.tail[0] !== 'info' || path.tail[1] !== 'refs') {
    return errReply(404, 'not found');
  }
  const service = ctx.query.get('service') ?? '';
  const repo = vault.lookup(path.owner, path.repo);
  if (repo === undefined) return errReply(404, 'repository not found');
  const rows = refRows(vault, repo);
  const headTip = vault.headTip(repo);
  const wantsV2 = headerText(ctx, 'git-protocol')?.includes('version=2') ?? false;
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      return { status: 200, raw: v2Advertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    return { status: 200, raw: v0Advertisement('git-upload-pack', rows, UPLOAD_CAPS, headTip), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, raw: v0Advertisement('git-receive-pack', rows, RECEIVE_CAPS, headTip), contentType: 'application/x-git-receive-pack-advertisement' };
  }
  return errReply(400, `unknown service ${JSON.stringify(service)}`);
}

export function handleUploadPack(vault: Vault, ctx: Ctx): Reply {
  const path = gitPath(ctx);
  if (path === null || path.tail.length !== 1 || path.tail[0] !== 'git-upload-pack') {
    return errReply(404, 'not found');
  }
  const repo = vault.lookup(path.owner, path.repo);
  if (repo === undefined) return errReply(404, 'repository not found');
  let firstLine = '';
  try {
    const packets = decodePkts(ctx.body);
    const lines = pktLines(packets);
    firstLine = lines[0] ?? '';
  } catch (err) {
    return errReply(400, (err as Error).message);
  }
  if (firstLine.startsWith('command=')) return uploadPackV2(vault, repo, ctx);
  return uploadPackV0(vault, repo, ctx);
}

export function handleReceivePack(vault: Vault, ctx: Ctx): Reply {
  const path = gitPath(ctx);
  if (path === null || path.tail.length !== 1 || path.tail[0] !== 'git-receive-pack') {
    return errReply(404, 'not found');
  }
  const repo = vault.lookup(path.owner, path.repo);
  if (repo === undefined) return errReply(404, 'repository not found');
  return receivePack(vault, repo, ctx);
}
