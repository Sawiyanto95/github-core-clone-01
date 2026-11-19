// vault.ts — the forge's whole memory: every repository, ref, object, issue
// and pull request lives here, in maps, for the trial's duration. The three
// surfaces (REST, GraphQL, MCP) all work through these operations, so an
// object created on one surface reads back identical on the others. Nothing
// here reads the wall clock: sequence numbers order creation, and a fixed
// epoch stamps the commits this forge writes itself, so two runs of the same
// requests reach the same bytes.

import {
  ZERO_OID,
  commitList,
  flattenTree,
  isAncestor,
  isOid,
  mergeBase,
  oidOf,
  peelToCommit,
  readCommit,
  readTree,
  reachable,
  treeEntry,
  writeCommit,
  writeTree,
  type Obj,
  type TreeItem,
} from './gitcore.ts';

/** The login the trial token names, from the contest's fixed scenario seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The stamp every commit this forge writes carries (never the wall clock). */
export const FORGE_EPOCH = 1700000000;
export const FORGE_STAMP = '2026-11-19T00:00:00Z';
export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FORGE_EPOCH} +0000`;

export interface LabelRec {
  name: string;
  color: string;
}

export interface IssueRec {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  seq: number;
  /** The serialized REST shape, cached until the issue is next mutated. */
  cachedJson: string | null;
}

export interface CommentRec {
  id: number;
  gid: string;
  body: string;
}

export interface PullRec {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}

export interface RepoRec {
  owner: string;
  name: string;
  id: string;
  databaseId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Bumped on every change to objects or refs; fetch-pack cache keys use it. */
  generation: number;
  objects: Map<string, Obj>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  issueSeq: number;
  pulls: PullRec[];
  pullSeq: number;
  comments: Map<number, CommentRec[]>;
  commentSeq: number;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64url(`${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return `I_${b64url(`${owner}/${name}#${number}`)}`;
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return `P_${b64url(`${owner}/${name}!${number}`)}`;
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, id: number): string {
  return `C_${b64url(`${owner}/${name}#${issueNumber}:${id}`)}`;
}

/** Decode a global id back to what it names, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; owner: string; name: string; number: number; commentId: number } | null {
  const match = /^([RIPC])_(.+)$/.exec(id);
  if (match === null) return null;
  const kind = match[1] as 'R' | 'I' | 'P' | 'C';
  let plain: string;
  try {
    plain = Buffer.from(match[2] as string, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const slash = plain.indexOf('/');
  if (slash < 0) return null;
  const owner = plain.slice(0, slash);
  const rest = plain.slice(slash + 1);
  if (kind === 'R') return { kind: 'repo', owner, name: rest, number: 0, commentId: 0 };
  if (kind === 'I') {
    const hash = rest.lastIndexOf('#');
    if (hash < 0) return null;
    return { kind: 'issue', owner, name: rest.slice(0, hash), number: Number(rest.slice(hash + 1)) || 0, commentId: 0 };
  }
  if (kind === 'P') {
    const bang = rest.lastIndexOf('!');
    if (bang < 0) return null;
    return { kind: 'pull', owner, name: rest.slice(0, bang), number: Number(rest.slice(bang + 1)) || 0, commentId: 0 };
  }
  const hash = rest.lastIndexOf('#');
  const colon = rest.lastIndexOf(':');
  if (hash < 0 || colon < 0) return null;
  return {
    kind: 'comment',
    owner,
    name: rest.slice(0, hash),
    number: Number(rest.slice(hash + 1, colon)) || 0,
    commentId: Number(rest.slice(colon + 1)) || 0,
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Vault {
  readonly repos = new Map<string, RepoRec>();
  private nextDbId = 5000;
  private seq = 0;

  lookup(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec | null {
    if (this.repos.has(repoKey(owner, name))) return null;
    this.seq += 1;
    const repo: RepoRec = {
      owner,
      name,
      id: repoGlobalId(owner, name),
      databaseId: this.nextDbId,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq,
      generation: 0,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      comments: new Map(),
      commentSeq: 0,
    };
    this.nextDbId += 1;
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** The object lookup a git helper needs for one repository. */
  objectOf(repo: RepoRec): (oid: string) => Obj | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store an object, returning its id. */
  putObject(repo: RepoRec, kind: Obj['kind'], bytes: Buffer): string {
    const oid = oidOf(kind, bytes);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, bytes });
    return oid;
  }

  /** The tip a ref name points at, or null when the ref does not exist. */
  refTip(repo: RepoRec, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip of a branch, or null. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Every ref, sorted by name: heads first, then tags. */
  sortedRefs(repo: RepoRec): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** HEAD's target branch tip, or null on an unborn repository. */
  headTip(repo: RepoRec): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  // ---------------------------------------------------------------- contents

  /** The tree a commit points at, as a path -> blob map. Empty when unborn. */
  filesAt(repo: RepoRec, commitOid: string | null): Map<string, string> {
    const out = new Map<string, string>();
    if (commitOid === null) return out;
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.kind !== 'commit') return out;
    let tree: string;
    try {
      tree = readCommit(obj.bytes).tree;
    } catch {
      return out;
    }
    flattenTree(this.objectOf(repo), tree, '', out);
    return out;
  }

  /** Set or remove one path in a tree, returning the new root tree's id. */
  setPath(repo: RepoRec, rootTree: string | null, segments: readonly string[], blobOid: string | null): string {
    const lookup = this.objectOf(repo);
    const walk = (treeOid: string | null, depth: number): string => {
      const items: TreeItem[] = treeOid === null ? [] : readTree(lookup(treeOid)?.bytes ?? Buffer.alloc(0));
      const head = segments[depth] as string;
      const kept = items.filter((item) => item.name !== head);
      if (depth === segments.length - 1) {
        if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const existing = items.find((item) => item.name === head && item.mode === '40000');
        const child = walk(existing?.oid ?? null, depth + 1);
        const childObj = lookup(child);
        if (childObj !== undefined) {
          let entries: TreeItem[] = [];
          try {
            entries = readTree(childObj.bytes);
          } catch {
            entries = [];
          }
          if (entries.length > 0) kept.push({ mode: '40000', name: head, oid: child });
        }
      }
      return this.putObject(repo, 'tree', writeTree(kept));
    };
    return walk(rootTree, 0);
  }

  /**
   * Write one file through the contents API: build the blob, the tree and
   * the commit, and move the branch. A missing branch is created from the
   * default branch's tip (or from nothing on an unborn repository).
   */
  commitFile(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const segments = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
    const blobSha = this.putObject(repo, 'blob', content);
    const tip = this.branchTip(repo, branch);
    let baseTree: string | null = null;
    let parents: string[] = [];
    let created = false;
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.kind === 'commit') {
        try {
          baseTree = readCommit(commit.bytes).tree;
        } catch {
          baseTree = null;
        }
        parents = [tip];
      }
    } else if (branch !== repo.defaultBranch) {
      const base = this.headTip(repo);
      if (base !== null) {
        const commit = repo.objects.get(base);
        if (commit !== undefined && commit.kind === 'commit') {
          try {
            baseTree = readCommit(commit.bytes).tree;
          } catch {
            baseTree = null;
          }
          parents = [base];
        }
      }
      created = true;
    } else {
      created = true;
    }
    const existed = this.filesAt(repo, tip).has(path);
    const tree = this.setPath(repo, baseTree, segments, blobSha);
    const commitBytes = writeCommit(tree, parents, FORGE_IDENTITY, FORGE_IDENTITY, message);
    const commitSha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.generation += 1;
    return { commitSha, blobSha, created: created || !existed };
  }

  /**
   * Remove one file through the contents API and commit the result.
   * Returns null when the file is not there.
   */
  removeFile(repo: RepoRec, path: string, message: string): { commitSha: string } | null {
    const branch = repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const files = this.filesAt(repo, tip);
    if (!files.has(path)) return null;
    const segments = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
    let tree: string;
    try {
      tree = readCommit((repo.objects.get(tip) as Obj).bytes).tree;
    } catch {
      return null;
    }
    const next = this.setPath(repo, tree, segments, null);
    const commitBytes = writeCommit(next, [tip], FORGE_IDENTITY, FORGE_IDENTITY, message);
    const commitSha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.generation += 1;
    return { commitSha };
  }

  /** Read a file or a directory out of a ref's tree. */
  readPath(
    repo: RepoRec,
    ref: string | null,
    path: string,
  ): { kind: 'file'; blobOid: string; bytes: Buffer } | { kind: 'dir'; entries: TreeItem[] } | null {
    const tip = ref === null ? this.headTip(repo) : this.branchTip(repo, ref) ?? this.refTip(repo, `refs/tags/${ref}`) ?? this.refTip(repo, ref);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.kind !== 'commit') return null;
    let treeOid: string;
    try {
      treeOid = readCommit(commit.bytes).tree;
    } catch {
      return null;
    }
    if (path === '' || path === '/') {
      return { kind: 'dir', entries: readTree((repo.objects.get(treeOid) as Obj).bytes) };
    }
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const tree = repo.objects.get(current);
      if (tree === undefined || tree.kind !== 'tree') return null;
      const entry = treeEntry(readTree(tree.bytes), segments[index] as string);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') {
          const dir = repo.objects.get(entry.oid);
          if (dir === undefined) return null;
          return { kind: 'dir', entries: readTree(dir.bytes) };
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined || blob.kind !== 'blob') return null;
        return { kind: 'file', blobOid: entry.oid, bytes: blob.bytes };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Commits reachable from a ref, newest first, with their messages. */
  commitsFrom(repo: RepoRec, ref: string | null): Array<{ sha: string; message: string }> {
    const tip = ref === null ? this.headTip(repo) : this.branchTip(repo, ref) ?? this.refTip(repo, ref);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    for (const sha of commitList(this.objectOf(repo), tip)) {
      const obj = repo.objects.get(sha);
      if (obj === undefined) continue;
      let message = '';
      try {
        message = readCommit(obj.bytes).message.replace(/\n$/, '');
      } catch {
        message = '';
      }
      out.push({ sha, message });
    }
    return out;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: RepoRec, title: string, body: string, labelNames: readonly string[]): IssueRec | { badLabel: string } {
    const labels: LabelRec[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { badLabel: name };
      labels.push({ name: label.name, color: label.color });
    }
    repo.issueSeq += 1;
    this.seq += 1;
    const issue: IssueRec = {
      number: repo.issueSeq,
      id: issueGlobalId(repo.owner, repo.name, repo.issueSeq),
      title,
      body,
      state: 'open',
      labels,
      seq: this.seq,
      cachedJson: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: RepoRec, number: number): IssueRec | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: RepoRec, state: string, sort: string, direction: string): IssueRec[] {
    let out = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    if (sort === 'created') {
      out = [...out].sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
    } else {
      out = [...out].sort((a, b) => a.seq - b.seq);
    }
    return out;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec | null {
    const issue = this.findIssue(repo, issueNumber);
    if (issue === undefined) return null;
    repo.commentSeq += 1;
    const comment: CommentRec = {
      id: repo.commentSeq,
      gid: commentGlobalId(repo.owner, repo.name, issueNumber, repo.commentSeq),
      body,
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: RepoRec, title: string, body: string, head: string, base: string): PullRec | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null) return { error: `head branch ${head} does not exist` };
    if (baseSha === null) return { error: `base branch ${base} does not exist` };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    repo.pullSeq += 1;
    this.seq += 1;
    const pull: PullRec = {
      number: repo.pullSeq,
      id: pullGlobalId(repo.owner, repo.name, repo.pullSeq),
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: this.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: RepoRec, number: number): PullRec | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: RepoRec, state: string): PullRec[] {
    if (state === 'all') return [...repo.pulls].sort((a, b) => a.seq - b.seq);
    return repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => a.seq - b.seq);
  }

  /** Paths changed between two commits, as path -> blob oid (null when removed). */
  changedPaths(repo: RepoRec, from: string, to: string): Map<string, string | null> {
    const before = this.filesAt(repo, from);
    const after = this.filesAt(repo, to);
    const out = new Map<string, string | null>();
    for (const [path, oid] of after) if (before.get(path) !== oid) out.set(path, oid);
    for (const path of before.keys()) if (!after.has(path)) out.set(path, null);
    return out;
  }

  /** The changed files of a pull request, against its base tip. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = mergeBase(this.objectOf(repo), pull.headSha, pull.baseSha) ?? pull.baseSha;
    const changes = this.changedPaths(repo, base, pull.headSha);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const [path, oid] of [...changes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const before = this.filesAt(repo, base).get(path);
      const after = oid;
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      if (before === undefined && after !== null) {
        status = 'added';
        const blob = repo.objects.get(after);
        additions = blob === undefined ? 0 : countLines(blob.bytes.toString('utf8'));
      } else if (before !== undefined && after === null) {
        status = 'removed';
        const blob = repo.objects.get(before);
        deletions = blob === undefined ? 0 : countLines(blob.bytes.toString('utf8'));
      } else if (before !== undefined && after !== null) {
        const oldText = (repo.objects.get(before)?.bytes ?? Buffer.alloc(0)).toString('utf8');
        const newText = (repo.objects.get(after)?.bytes ?? Buffer.alloc(0)).toString('utf8');
        [additions, deletions] = lineDiff(oldText, newText);
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch. Answers the merge
   * commit's id, or why the merge cannot happen.
   */
  mergePull(repo: RepoRec, number: number): { sha: string } | { error: string; status: number } {
    const pull = this.findPull(repo, number);
    if (pull === undefined) return { error: 'pull request not found', status: 404 };
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return { error: 'base branch does not exist', status: 405 };
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const base = mergeBase(this.objectOf(repo), headTip, baseTip);
    if (base === null) return { error: 'no merge base', status: 405 };
    const headChanges = this.changedPaths(repo, base, headTip);
    const baseChanges = this.changedPaths(repo, base, baseTip);
    for (const [path, headOid] of headChanges) {
      if (!baseChanges.has(path)) continue;
      if (baseChanges.get(path) !== headOid) return { error: 'merge conflict', status: 405 };
    }
    const merged = this.filesAt(repo, baseTip);
    for (const [path, oid] of headChanges) {
      if (oid === null) merged.delete(path);
      else merged.set(path, oid);
    }
    const tree = this.buildTreeFromFiles(repo, merged);
    const message = `${pull.title} (#${pull.number})`;
    const commitBytes = writeCommit(tree, [baseTip], FORGE_IDENTITY, FORGE_IDENTITY, message);
    const sha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    repo.generation += 1;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FORGE_STAMP;
    pull.mergeSha = sha;
    pull.baseSha = sha;
    return { sha };
  }

  /** Build a tree object from a flat path -> blob map. */
  buildTreeFromFiles(repo: RepoRec, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const items: TreeItem[] = [];
      for (const [name, oid] of node.files) items.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) items.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', writeTree(items));
    };
    return build(root);
  }

  /** Whether a pull request can merge cleanly (its head against the base tip). */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return false;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const base = mergeBase(this.objectOf(repo), headTip, baseTip);
    if (base === null) return false;
    const headChanges = this.changedPaths(repo, base, headTip);
    const baseChanges = this.changedPaths(repo, base, baseTip);
    for (const [path, headOid] of headChanges) {
      if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- git helpers

  /** Peel a tag ref to its commit, or null when it does not peel. */
  peelRef(repo: RepoRec, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit(this.objectOf(repo), oid);
  }

  /** True when `tip` descends from `ancestor` inside this repository. */
  isFastForward(repo: RepoRec, ancestor: string, tip: string): boolean {
    if (ancestor === ZERO_OID) return true;
    return isAncestor(this.objectOf(repo), ancestor, tip);
  }
}

/** Lines in a blob's text: newlines, plus one when the last line is unterminated. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Added and removed line counts between two texts, by multiset difference. */
export function lineDiff(oldText: string, newText: string): [number, number] {
  const split = (text: string): string[] => {
    if (text === '') return [];
    const parts = text.split('\n');
    if (text.endsWith('\n')) parts.pop();
    return parts;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return [additions, deletions];
}
