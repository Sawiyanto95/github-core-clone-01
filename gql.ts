// gql.ts — a small GraphQL executor for the documents the conformance suite
// sends, and nothing more: a tokenizer, a parser for operations, fragments
// and arguments, and a resolver that walks the store. It answers batched
// operations, introspection of the Issue / PullRequest / Repository types,
// cursor pagination, and the five mutations. An unknown field is a 200 with
// an `errors` entry naming it, never an HTTP error.

import { errReply, type Ctx, type Reply } from './kit.ts';
import {
  VIEWER_LOGIN,
  decodeGlobalId,
  Vault,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './vault.ts';

// ------------------------------------------------------------------- tokens

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'punct'; value: string }
  | { type: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ type: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:!@$=|&'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ type: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let out = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const escaped = source[at + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[escaped] ?? escaped;
          at += 2;
        } else {
          out += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new Error('unterminated string');
      at += 1;
      tokens.push({ type: 'string', value: out });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let end = at;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9.]/.test(source[end] as string)) end += 1;
      if (end < source.length && /[eE]/.test(source[end] as string)) {
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end] as string)) end += 1;
      }
      const value = Number(source.slice(at, end));
      if (!Number.isFinite(value)) throw new Error(`bad number ${JSON.stringify(source.slice(at, end))}`);
      tokens.push({ type: 'number', value });
      at = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = at + 1;
      while (end < source.length && isNameChar(source[end] as string)) end += 1;
      tokens.push({ type: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeName: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of query');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in query`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error('expected a name in query');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.at < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as Operation['kind'];
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.type === 'name') {
          name = this.next().value as string;
        }
        const variables = this.parseVariableDefinitions();
        operations.push({ kind, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment must say "on Type"');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} at the top of a query`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.acceptPunct('(')) return out;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      out.push({ name, defaultValue });
    }
    return out;
  }

  private parseType(): void {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek() as Token;
      if (token.type === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.type === 'name' && nextToken.value === 'on') {
          this.next();
          const typeName = this.expectName();
          out.push({ kind: 'inline', typeName, selection: this.parseSelectionSet() });
        } else if (nextToken !== undefined && nextToken.type === 'name') {
          out.push({ kind: 'spread', name: this.next().value as string });
        } else {
          out.push({ kind: 'inline', typeName: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      out.push({ kind: 'field', field: this.parseField() });
    }
    return out;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selection: SelectionNode[] | null = null;
    const nextToken = this.peek();
    if (nextToken !== undefined && nextToken.type === 'punct' && nextToken.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return out;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.type === 'string' || token.type === 'number') return { kind: 'lit', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'enum', name: token.value };
    }
    throw new Error('expected a value in query');
  }
}

// ------------------------------------------------------------------- values

type GqlObject = Record<string, unknown> & { __kind: string };

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'lit':
      return node.value;
    case 'enum':
      return node.name;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- schema knowledge

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'description', 'isPrivate'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

const KIND_TYPE: Record<string, string> = {
  Query: 'Query',
  Mutation: 'Mutation',
  User: 'User',
  Repository: 'Repository',
  Issue: 'Issue',
  PullRequest: 'PullRequest',
  IssueConnection: 'IssueConnection',
  PullRequestConnection: 'PullRequestConnection',
  FileConnection: 'FileConnection',
  PageInfo: 'PageInfo',
  BranchRef: 'BranchRef',
  CommentEdge: 'CommentEdge',
  Comment: 'Comment',
  Type: '__Type',
  TypeField: '__Field',
  EnumValue: '__EnumValue',
  CreateIssuePayload: 'CreateIssuePayload',
  CloseIssuePayload: 'CloseIssuePayload',
  CreatePullRequestPayload: 'CreatePullRequestPayload',
  MergePullRequestPayload: 'MergePullRequestPayload',
  AddCommentPayload: 'AddCommentPayload',
};

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

// ------------------------------------------------------------------- executor

interface ExecState {
  vault: Vault;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

function wrapIssue(repo: RepoRec, issue: IssueRec): GqlObject {
  return { __kind: 'Issue', __repo: repo, __issue: issue };
}

function wrapPull(repo: RepoRec, pull: PullRec): GqlObject {
  return { __kind: 'PullRequest', __repo: repo, __pull: pull };
}

function wrapRepo(repo: RepoRec): GqlObject {
  return { __kind: 'Repository', __repo: repo };
}

/** The issues connection: filtering, ordering and cursor slicing in one place. */
function issueConnection(repo: RepoRec, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  let issues = [...repo.issues];
  if (states !== null) {
    const wantOpen = states.includes('OPEN');
    const wantClosed = states.includes('CLOSED');
    issues = issues.filter((issue) => (wantOpen && issue.state === 'open') || (wantClosed && issue.state === 'closed'));
  }
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = asString(args.after, '');
  let start = 0;
  if (after !== '') {
    const decoded = unb64(after);
    const last = decoded === null ? Number.NaN : Number.parseInt(decoded, 10);
    if (Number.isFinite(last)) {
      const index = issues.findIndex((issue) => issue.number === last);
      if (index >= 0) start = index + 1;
    }
  }
  const first = asInt(args.first, issues.length - start);
  const page = issues.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? b64(String(page[page.length - 1]?.number ?? '')) : null;
  return {
    __kind: 'IssueConnection',
    __nodes: page.map((issue) => wrapIssue(repo, issue)),
    __pageInfo: { __kind: 'PageInfo', __hasNextPage: hasNextPage, __endCursor: endCursor },
  };
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  let pulls = [...repo.pulls];
  if (states !== null) {
    const wantOpen = states.includes('OPEN');
    const wantClosed = states.includes('CLOSED') || states.includes('MERGED');
    pulls = pulls.filter((pull) => (wantOpen && pull.state === 'open') || (wantClosed && pull.state === 'closed'));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => a.number - b.number);
  const first = asInt(args.first, pulls.length);
  const page = pulls.slice(0, Math.max(0, first));
  return {
    __kind: 'PullRequestConnection',
    __nodes: page.map((pull) => wrapPull(repo, pull)),
    __pageInfo: { __kind: 'PageInfo', __hasNextPage: page.length < pulls.length, __endCursor: page.length > 0 ? b64(String(page[page.length - 1]?.number ?? '')) : null },
  };
}

/** Resolve one field on one object. `undefined` means "no such field". */
function resolveField(state: ExecState, obj: GqlObject, field: FieldNode): unknown {
  const kind = obj.__kind;
  const name = field.name;
  const args = argsOf(field, state.variables);
  if (name === '__typename') return KIND_TYPE[kind] ?? kind;
  switch (kind) {
    case 'Query': {
      if (name === 'viewer') return { __kind: 'User', __login: VIEWER_LOGIN };
      if (name === 'repository') {
        const repo = state.vault.lookup(asString(args.owner), asString(args.name));
        return repo === undefined ? null : wrapRepo(repo);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(asString(args.id));
        if (decoded === null) return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        if (decoded.kind === 'repo') return wrapRepo(repo);
        if (decoded.kind === 'issue') {
          const issue = state.vault.findIssue(repo, decoded.number);
          return issue === undefined ? null : wrapIssue(repo, issue);
        }
        if (decoded.kind === 'pull') {
          const pull = state.vault.findPull(repo, decoded.number);
          return pull === undefined ? null : wrapPull(repo, pull);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = asString(args.name);
        return { __kind: 'Type', __typeName: typeName };
      }
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(asString(input.repositoryId));
        if (decoded === null) return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        const created = state.vault.createIssue(repo, asString(input.title), asString(input.body), []);
        if ('badLabel' in created) return null;
        return { __kind: 'CreateIssuePayload', __issue: wrapIssue(repo, created) };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(asString(input.issueId));
        if (decoded === null || decoded.kind !== 'issue') return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        const issue = state.vault.findIssue(repo, decoded.number);
        if (issue === undefined) return null;
        issue.state = 'closed';
        issue.cachedJson = null;
        return { __kind: 'CloseIssuePayload', __issue: wrapIssue(repo, issue) };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(asString(input.repositoryId));
        if (decoded === null) return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        const created = state.vault.createPull(
          repo,
          asString(input.title),
          asString(input.body),
          asString(input.headRefName),
          asString(input.baseRefName),
        );
        if ('error' in created) return null;
        return { __kind: 'CreatePullRequestPayload', __pull: wrapPull(repo, created) };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(asString(input.pullRequestId));
        if (decoded === null || decoded.kind !== 'pull') return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        const merged = state.vault.mergePull(repo, decoded.number);
        if ('error' in merged) return null;
        const pull = state.vault.findPull(repo, decoded.number);
        if (pull === undefined) return null;
        return { __kind: 'MergePullRequestPayload', __pull: wrapPull(repo, pull) };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(asString(input.subjectId));
        if (decoded === null || decoded.kind !== 'issue') return null;
        const repo = state.vault.lookup(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        const comment = state.vault.addComment(repo, decoded.number, asString(input.body));
        if (comment === null) return null;
        return {
          __kind: 'AddCommentPayload',
          __edge: { __kind: 'CommentEdge', __node: { __kind: 'Comment', __id: comment.gid, __body: comment.body } },
        };
      }
      return undefined;
    }
    case 'User': {
      if (name === 'login') return obj.__login ?? VIEWER_LOGIN;
      if (name === 'id') return `U_${b64(String(obj.__login ?? VIEWER_LOGIN))}`;
      return undefined;
    }
    case 'Repository': {
      const repo = obj.__repo as RepoRec;
      if (name === 'id') return repo.id;
      if (name === 'databaseId') return repo.databaseId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __kind: 'User', __login: repo.owner };
      if (name === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`)
          ? { __kind: 'BranchRef', __name: repo.defaultBranch }
          : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.isPrivate;
      if (name === 'issue') {
        const issue = state.vault.findIssue(repo, asInt(args.number, -1));
        return issue === undefined ? null : wrapIssue(repo, issue);
      }
      if (name === 'issues') return issueConnection(repo, args);
      if (name === 'pullRequest') {
        const pull = state.vault.findPull(repo, asInt(args.number, -1));
        return pull === undefined ? null : wrapPull(repo, pull);
      }
      if (name === 'pullRequests') return pullConnection(repo, args);
      return undefined;
    }
    case 'Issue': {
      const issue = obj.__issue as IssueRec;
      if (name === 'id') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return gqlState(issue.state);
      if (name === 'body') return issue.body;
      // The forge has one actor, so every issue's author is the viewer.
      if (name === 'author') return { __kind: 'User', __login: VIEWER_LOGIN };
      return undefined;
    }
    case 'PullRequest': {
      const repo = obj.__repo as RepoRec;
      const pull = obj.__pull as PullRec;
      if (name === 'id') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return gqlState(pull.state);
      if (name === 'merged') return pull.merged;
      // The forge has one actor, so every pull request's author is the viewer.
      if (name === 'author') return { __kind: 'User', __login: VIEWER_LOGIN };
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return state.vault.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (name === 'files') {
        const listed = state.vault.pullFiles(repo, pull);
        const first = asInt(args.first, listed.length);
        const page = listed.slice(0, Math.max(0, first));
        return {
          __kind: 'FileConnection',
          __nodes: page.map((file) => ({ __kind: 'File', __path: file.filename })),
          __pageInfo: { __kind: 'PageInfo', __hasNextPage: page.length < listed.length, __endCursor: null },
        };
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection': {
      if (name === 'nodes') return (obj.__nodes as GqlObject[]).map((node) => node);
      if (name === 'edges') {
        return (obj.__nodes as GqlObject[]).map((node) => ({ __kind: 'Edge', __node: node }));
      }
      if (name === 'pageInfo') return obj.__pageInfo as GqlObject;
      if (name === 'totalCount') return (obj.__nodes as GqlObject[]).length;
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.__hasNextPage as boolean;
      if (name === 'endCursor') return obj.__endCursor as string | null;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      return undefined;
    }
    case 'BranchRef': {
      if (name === 'name') return obj.__name as string;
      return undefined;
    }
    case 'CommentEdge': {
      if (name === 'node') return obj.__node as GqlObject;
      return undefined;
    }
    case 'Comment': {
      if (name === 'id') return obj.__id as string;
      if (name === 'body') return obj.__body as string;
      return undefined;
    }
    case 'File': {
      if (name === 'path') return obj.__path as string;
      return undefined;
    }
    case 'Edge': {
      if (name === 'node') return obj.__node as GqlObject;
      return undefined;
    }
    case 'Type': {
      const typeName = obj.__typeName as string;
      if (name === 'name') return typeName;
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeName] ?? [];
        return fields.map((fieldName) => ({ __kind: 'TypeField', __name: fieldName }));
      }
      if (name === 'enumValues') {
        if (typeName === 'SearchType') {
          return ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((value) => ({ __kind: 'EnumValue', __name: value }));
        }
        return [];
      }
      return undefined;
    }
    case 'TypeField': {
      if (name === 'name') return obj.__name as string;
      return undefined;
    }
    case 'EnumValue': {
      if (name === 'name') return obj.__name as string;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return obj.__issue as GqlObject;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return obj.__pull as GqlObject;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return obj.__edge as GqlObject;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeSelection(state: ExecState, obj: GqlObject, selection: SelectionNode[], typeName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'spread') {
      const fragment = state.fragments.get(node.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(state, obj, fragment, typeName));
      continue;
    }
    if (node.kind === 'inline') {
      const applies = node.typeName === null || node.typeName === typeName || node.typeName === KIND_TYPE[obj.__kind];
      if (!applies) continue;
      Object.assign(out, executeSelection(state, obj, node.selection, node.typeName ?? typeName));
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    const value = resolveField(state, obj, field);
    if (value === undefined) {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    if (field.selection === null || value === null || typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__kind' in item) {
          return executeSelection(state, item as GqlObject, field.selection as SelectionNode[], KIND_TYPE[(item as GqlObject).__kind] ?? (item as GqlObject).__kind);
        }
        return item;
      });
      continue;
    }
    const child = value as GqlObject;
    out[key] = executeSelection(state, child, field.selection, KIND_TYPE[child.__kind] ?? child.__kind);
  }
  return out;
}

function runOperation(vault: Vault, doc: Document, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const state: ExecState = { vault, variables: { ...variables }, errors: [], fragments: doc.fragments };
  for (const variable of operation.variables) {
    if (!(variable.name in state.variables) && variable.defaultValue !== null) {
      state.variables[variable.name] = evalValue(variable.defaultValue, state.variables);
    }
  }
  const root: GqlObject = { __kind: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(state, root, operation.selection, operation.kind === 'mutation' ? 'Mutation' : 'Query');
  const result: Record<string, unknown> = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

export function handleGraphql(vault: Vault, ctx: Ctx): Reply {
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return errReply(400, 'request body must be JSON');
  }
  const docs = Array.isArray(payload) ? payload : [payload];
  const results: Array<Record<string, unknown>> = [];
  for (const doc of docs) {
    if (doc === null || typeof doc !== 'object') {
      results.push({ data: null, errors: [{ message: 'request body must be a GraphQL operation object' }] });
      continue;
    }
    const query = (doc as Record<string, unknown>).query;
    if (typeof query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query must be a string' }] });
      continue;
    }
    const variables = (doc as Record<string, unknown>).variables;
    const vars = variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
    let parsed: Document;
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: (err as Error).message }] });
      continue;
    }
    if (parsed.operations.length === 0) {
      results.push({ data: null, errors: [{ message: 'query has no operation' }] });
      continue;
    }
    const operationName = (doc as Record<string, unknown>).operationName;
    let operation = parsed.operations[0] as Operation;
    if (typeof operationName === 'string' && parsed.operations.length > 1) {
      operation = parsed.operations.find((candidate) => candidate.name === operationName) ?? operation;
    }
    results.push(runOperation(vault, parsed, operation, vars));
  }
  const body = Array.isArray(payload) ? results : results[0];
  return { status: 200, body };
}
