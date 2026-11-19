// rest.ts — the REST v3 surface: repositories, refs, branches, commits,
// contents, labels, issues, comments and pull requests, plus the two
// discovery endpoints the harness leans on (`/` and `/meta`). Every reply
// is JSON with a request id; every error is a JSON object with a `message`.
// The shapes mirror what github.com returns closely enough that the
// conformance checks — and the MCP setup, which drives REST itself — read
// back exactly what they wrote.

import { errReply, jsonReply, pageOf, strField, boolField, bodyJson, intQuery, type Ctx, type Reply } from './kit.ts';
import {
  DEFAULT_BRANCH,
  FORGE_STAMP,
  VIEWER_ID,
  VIEWER_LOGIN,
  Vault,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './vault.ts';
import { isOid } from './gitcore.ts';

/** The repository object every REST route returns for a repo. */
export function repoShape(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.databaseId,
    databaseId: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: FORGE_STAMP,
    updated_at: FORGE_STAMP,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueShape(issue: IssueRec, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.databaseId * 100000 + issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FORGE_STAMP,
    updated_at: FORGE_STAMP,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The single-issue GET answer, serialised once and reused until the issue changes. */
function issueReply(issue: IssueRec, repo: RepoRec): Reply {
  if (issue.cachedJson === null) issue.cachedJson = JSON.stringify(issueShape(issue, repo));
  return { status: 200, rawJson: issue.cachedJson };
}

function pullShape(pull: PullRec, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.databaseId * 100000 + pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FORGE_STAMP,
    updated_at: FORGE_STAMP,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** A page of results with a `Link` header when another page follows. */
function paged<T>(items: readonly T[], ctx: Ctx, render: (item: T) => unknown): Reply {
  const { page, hasMore, pageNo, perPage } = pageOf(items, ctx.query);
  const headers: Record<string, string> = {};
  if (hasMore) {
    const next = new URL(`http://${ctx.host}${ctx.path}`);
    next.searchParams.set('page', String(pageNo + 1));
    next.searchParams.set('per_page', String(perPage));
    for (const [key, value] of ctx.query) {
      if (key !== 'page' && key !== 'per_page') next.searchParams.set(key, value);
    }
    headers.Link = `<${next.toString()}>; rel="next"`;
  }
  return jsonReply(200, page.map(render), headers);
}

/** Decode a contents path from its URL segments, joining them with '/'. */
function contentPath(parts: readonly string[]): string {
  return parts.map((part) => decodeURIComponent(part)).join('/');
}

/** The `{owner, repo}` at the head of a route, or null when it is not one. */
function ownerRepo(ctx: Ctx, at: number): { owner: string; repo: string } | null {
  if (ctx.parts.length <= at + 1) return null;
  return { owner: ctx.parts[at] as string, repo: ctx.parts[at + 1] as string };
}

export function handleRest(vault: Vault, ctx: Ctx): Reply {
  const parts = ctx.parts;
  // ------------------------------------------------------------------ root
  if (parts.length === 0) {
    return jsonReply(200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (parts.length === 1 && parts[0] === 'meta') {
    return jsonReply(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (parts.length === 1 && parts[0] === 'user') {
    if (ctx.method === 'GET') {
      return jsonReply(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
    }
    return errReply(404, 'not found');
  }
  // ------------------------------------------------------------ user repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (ctx.method === 'GET') {
      return paged(vault.viewerRepos(), ctx, repoShape);
    }
    if (ctx.method === 'POST') {
      const body = bodyJson(ctx);
      if (body === null) return errReply(400, 'request body must be a JSON object');
      const name = strField(body, 'name');
      if (name === '') return errReply(422, 'name is required');
      const repo = vault.createRepo(VIEWER_LOGIN, name, strField(body, 'description'), boolField(body, 'private', false));
      if (repo === null) return errReply(422, `repository ${name} already exists`);
      return jsonReply(201, repoShape(repo));
    }
    return errReply(404, 'not found');
  }
  // ------------------------------------------------------------ repo routes
  if (parts.length >= 3 && parts[0] === 'repos') {
    const target = ownerRepo(ctx, 1);
    if (target === null) return errReply(404, 'not found');
    const repo = vault.lookup(target.owner, target.repo);
    const rest = parts.slice(3);
    if (rest.length === 0) {
      if (repo === undefined) return errReply(404, 'repository not found');
      if (ctx.method === 'GET') return jsonReply(200, repoShape(repo));
      if (ctx.method === 'PATCH') {
        const body = bodyJson(ctx);
        if (body === null) return errReply(400, 'request body must be a JSON object');
        const description = body.description;
        if (typeof description === 'string') repo.description = description;
        return jsonReply(200, repoShape(repo));
      }
      if (ctx.method === 'DELETE') {
        vault.deleteRepo(target.owner, target.repo);
        return { status: 204, body: undefined };
      }
      return errReply(404, 'not found');
    }
    if (repo === undefined) return errReply(404, 'repository not found');
    return handleRepoSub(vault, repo, rest, ctx);
  }
  return errReply(404, 'not found');
}

function handleRepoSub(vault: Vault, repo: RepoRec, rest: string[], ctx: Ctx): Reply {
  const head = rest[0] as string;
  // ------------------------------------------------------------- git refs
  if (head === 'git' && rest[1] === 'refs') {
    if (ctx.method === 'POST' && rest.length === 2) {
      const body = bodyJson(ctx);
      if (body === null) return errReply(400, 'request body must be a JSON object');
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (!ref.startsWith('refs/') || !isOid(sha)) return errReply(422, 'ref and sha are required');
      if (!repo.objects.has(sha)) return errReply(422, `object ${sha} does not exist`);
      if (repo.refs.has(ref)) return errReply(422, `reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      repo.generation += 1;
      return jsonReply(201, { ref, object: { sha } });
    }
    if (ctx.method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const tip = vault.branchTip(repo, branch);
      if (tip === null) return errReply(404, `branch ${branch} not found`);
      return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
    }
    return errReply(404, 'not found');
  }
  // ------------------------------------------------------------- branches
  if (head === 'branches') {
    if (ctx.method === 'GET' && rest.length === 1) {
      const rows = vault.sortedRefs(repo)
        .filter((row) => row.name.startsWith('refs/heads/'))
        .map((row) => ({ name: row.name.slice('refs/heads/'.length), commit: { sha: row.oid } }));
      return jsonReply(200, rows);
    }
    if (ctx.method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = vault.branchTip(repo, branch);
      if (tip === null) return errReply(404, `branch ${branch} not found`);
      return jsonReply(200, { name: branch, commit: { sha: tip } });
    }
    return errReply(404, 'not found');
  }
  // -------------------------------------------------------------- commits
  if (head === 'commits' && ctx.method === 'GET' && rest.length === 1) {
    const ref = ctx.query.get('sha') ?? null;
    const commits = vault.commitsFrom(repo, ref);
    return jsonReply(200, commits.map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message, author: { name: 'ada iversen', email: 'adaiversen@example.invalid' } },
    })));
  }
  // ------------------------------------------------------------- contents
  if (head === 'contents') {
    const path = contentPath(rest.slice(1));
    if (ctx.method === 'GET') {
      const ref = ctx.query.get('ref') ?? null;
      const found = vault.readPath(repo, ref, path);
      if (found === null) return errReply(404, 'path not found');
      if (found.kind === 'dir') {
        return jsonReply(200, found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
        })));
      }
      return jsonReply(200, {
        type: 'file',
        encoding: 'base64',
        content: found.bytes.toString('base64'),
        sha: found.blobOid,
        size: found.bytes.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    if (ctx.method === 'PUT') {
      const body = bodyJson(ctx);
      if (body === null) return errReply(400, 'request body must be a JSON object');
      const message = strField(body, 'message') || 'update';
      const encoded = strField(body, 'content');
      const branch = strField(body, 'branch') || repo.defaultBranch;
      const expected = strField(body, 'sha');
      let content: Buffer;
      try {
        content = Buffer.from(encoded, 'base64');
      } catch {
        return errReply(422, 'content must be base64');
      }
      if (expected !== '') {
        const tip = vault.branchTip(repo, branch);
        const current = tip === null ? null : vault.filesAt(repo, tip).get(path);
        if (current === undefined || current === null) return errReply(404, 'path not found');
        if (current !== expected) return errReply(409, 'sha does not match the current blob');
      }
      const result = vault.commitFile(repo, branch, path, content, message);
      return jsonReply(result.created ? 201 : 200, {
        content: { sha: result.blobSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    }
    if (ctx.method === 'DELETE') {
      const body = bodyJson(ctx);
      if (body === null) return errReply(400, 'request body must be a JSON object');
      const message = strField(body, 'message') || 'delete';
      const removed = vault.removeFile(repo, path, message);
      if (removed === null) return errReply(404, 'path not found');
      return jsonReply(200, { commit: { sha: removed.commitSha } });
    }
    return errReply(404, 'not found');
  }
  // --------------------------------------------------------------- labels
  if (head === 'labels' && ctx.method === 'GET' && rest.length === 1) {
    return jsonReply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }
  if (head === 'labels' && ctx.method === 'POST' && rest.length === 1) {
    const body = bodyJson(ctx);
    if (body === null) return errReply(400, 'request body must be a JSON object');
    const name = strField(body, 'name');
    if (name === '') return errReply(422, 'name is required');
    const color = strField(body, 'color') || 'ededed';
    const label = { name, color };
    repo.labels.set(name, label);
    return jsonReply(201, label);
  }
  // --------------------------------------------------------------- issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const body = bodyJson(ctx);
        if (body === null) return errReply(400, 'request body must be a JSON object');
        const title = strField(body, 'title');
        if (title === '') return errReply(422, 'title is required');
        const rawLabels = body.labels;
        const labelNames: string[] = Array.isArray(rawLabels)
          ? rawLabels.map((label) => (typeof label === 'string' ? label : typeof label === 'object' && label !== null ? strField(label as Record<string, unknown>, 'name') : '')).filter((name) => name !== '')
          : [];
        const created = vault.createIssue(repo, title, strField(body, 'body'), labelNames);
        if ('badLabel' in created) return errReply(422, `label ${created.badLabel} does not exist`);
        return jsonReply(201, issueShape(created, repo));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        const listed = vault.listIssues(repo, state, sort, direction);
        return paged(listed, ctx, (issue) => issueShape(issue, repo));
      }
      return errReply(404, 'not found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number) || number < 1) return errReply(404, 'not found');
    if (rest.length === 2) {
      const issue = vault.findIssue(repo, number);
      if (issue === undefined) return errReply(404, 'issue not found');
      if (ctx.method === 'GET') return issueReply(issue, repo);
      if (ctx.method === 'PATCH') {
        const body = bodyJson(ctx);
        if (body === null) return errReply(400, 'request body must be a JSON object');
        const state = strField(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = strField(body, 'title');
        if (title !== '') issue.title = title;
        // The shape changed, so the cached serialisation is stale.
        issue.cachedJson = null;
        return jsonReply(200, issueShape(issue, repo));
      }
      return errReply(404, 'not found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (ctx.method === 'POST') {
        const body = bodyJson(ctx);
        if (body === null) return errReply(400, 'request body must be a JSON object');
        const comment = vault.addComment(repo, number, strField(body, 'body'));
        if (comment === null) return errReply(404, 'issue not found');
        return jsonReply(201, { id: comment.id, body: comment.body });
      }
      if (ctx.method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        return jsonReply(200, comments.map((comment) => ({ id: comment.id, body: comment.body })));
      }
      return errReply(404, 'not found');
    }
    return errReply(404, 'not found');
  }
  // ---------------------------------------------------------------- pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const body = bodyJson(ctx);
        if (body === null) return errReply(400, 'request body must be a JSON object');
        const title = strField(body, 'title');
        const headRef = strField(body, 'head');
        const baseRef = strField(body, 'base');
        if (title === '' || headRef === '' || baseRef === '') return errReply(422, 'title, head and base are required');
        const created = vault.createPull(repo, title, strField(body, 'body'), headRef, baseRef);
        if ('error' in created) return errReply(422, created.error);
        return jsonReply(201, pullShape(created, repo));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const listed = vault.listPulls(repo, state === 'all' ? 'all' : 'open');
        return paged(listed, ctx, (pull) => pullShape(pull, repo));
      }
      return errReply(404, 'not found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number) || number < 1) return errReply(404, 'not found');
    if (rest.length === 2) {
      const pull = vault.findPull(repo, number);
      if (pull === undefined) return errReply(404, 'pull request not found');
      if (ctx.method === 'GET') return jsonReply(200, pullShape(pull, repo));
      return errReply(404, 'not found');
    }
    if (rest.length === 3 && rest[2] === 'files' && ctx.method === 'GET') {
      const pull = vault.findPull(repo, number);
      if (pull === undefined) return errReply(404, 'pull request not found');
      return jsonReply(200, vault.pullFiles(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && ctx.method === 'PUT') {
      const merged = vault.mergePull(repo, number);
      if ('error' in merged) return errReply(merged.status, merged.error);
      const pull = vault.findPull(repo, number) as PullRec;
      return jsonReply(200, { sha: merged.sha, merged: true, message: `${pull.title} (#${pull.number})` });
    }
    return errReply(404, 'not found');
  }
  return errReply(404, 'not found');
}
