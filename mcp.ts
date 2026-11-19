// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over plain
// HTTP POSTs. The client first probes `server/discover`; a server that
// answers the modern era never hears `initialize`, but the legacy handshake
// is answered too. Six tools share the store with REST and GraphQL, so a
// repository made here reads back over `/api/v3` byte for byte. The tool
// list is built once as a constant, so two `tools/list` calls answer the
// same bytes.

import { errReply, type Ctx, type Reply } from './kit.ts';
import { VIEWER_LOGIN, Vault } from './vault.ts';
import { repoShape } from './rest.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list, built once and never mutated, so list answers are stable. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A tool's answer: its JSON, carried as one text content block. */
function toolText(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return -1;
}

function callTool(vault: Vault, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = strArg(args, 'owner') || VIEWER_LOGIN;
  const repoName = strArg(args, 'repo');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = strArg(args, 'name');
      if (repoNameArg === '') return toolFailure('name is required');
      const repo = vault.createRepo(
        VIEWER_LOGIN,
        repoNameArg,
        strArg(args, 'description'),
        typeof args.private === 'boolean' ? (args.private as boolean) : false,
      );
      if (repo === null) return toolFailure(`repository ${repoNameArg} already exists`);
      return toolText({ ...repoShape(repo), full_name: `${repo.owner}/${repo.name}` });
    }
    case 'get_repo': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      return toolText({ ...repoShape(repo), full_name: `${repo.owner}/${repo.name}` });
    }
    case 'create_issue': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      const title = strArg(args, 'title');
      if (title === '') return toolFailure('title is required');
      const created = vault.createIssue(repo, title, strArg(args, 'body'), []);
      if ('badLabel' in created) return toolFailure(`label ${created.badLabel} does not exist`);
      return toolText({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    case 'list_issues': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      const state = strArg(args, 'state') || 'open';
      const listed = vault.listIssues(repo, state, 'created', 'asc');
      return toolText(listed.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      })));
    }
    case 'get_issue': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      const number = intArg(args, 'issue_number', 'issueNumber', 'number');
      if (number < 1) return toolFailure('issue_number is required');
      const issue = vault.findIssue(repo, number);
      if (issue === undefined) return toolFailure('issue not found');
      return toolText({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    case 'create_pull_request': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      const created = vault.createPull(
        repo,
        strArg(args, 'title'),
        strArg(args, 'body'),
        strArg(args, 'head'),
        strArg(args, 'base'),
      );
      if ('error' in created) return toolFailure(created.error);
      return toolText({
        id: created.id,
        number: created.number,
        pull_number: created.number,
        title: created.title,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    case 'merge_pull_request': {
      const repo = vault.lookup(owner, repoName);
      if (repo === undefined) return toolFailure('repository not found');
      const number = intArg(args, 'pull_number', 'pullNumber', 'number');
      if (number < 1) return toolFailure('pull_number is required');
      const merged = vault.mergePull(repo, number);
      if ('error' in merged) return toolFailure(merged.error);
      return toolText({ number, pull_number: number, merged: true, sha: merged.sha, state: 'closed' });
    }
    default:
      return toolFailure(`unknown tool ${name}`);
  }
}

export function handleMcp(vault: Vault, ctx: Ctx): Reply {
  if (ctx.method === 'DELETE') {
    // The close handshake for a session id: nothing to tear down.
    return { status: 204, body: undefined };
  }
  if (ctx.method !== 'POST') return errReply(405, 'method not allowed');
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON-RPC object');
    }
    request = parsed as Record<string, unknown>;
  } catch {
    // A body that is not JSON: HTTP 400 with -32700; echo the id when the
    // raw bytes still carry one.
    let id: unknown = null;
    const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(ctx.body.toString('utf8'));
    if (match !== null) {
      try {
        id = JSON.parse(match[1] as string) as unknown;
      } catch {
        id = null;
      }
    }
    return rpcError(id, -32700, 'Parse error', 400);
  }
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  // Notifications carry no id and expect no answer.
  if (id === undefined) {
    return { status: 202, body: undefined };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [MODERN_VERSION],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MODERN_VERSION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(id, -32602, `unknown tool ${JSON.stringify(name)}`);
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const required = (tool.inputSchema.required ?? []) as string[];
    for (const key of required) {
      if (args[key] === undefined || args[key] === null || args[key] === '') {
        return rpcError(id, -32602, `missing required argument ${JSON.stringify(key)}`);
      }
    }
    return rpcResult(id, callTool(vault, name, args));
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
