// forge.ts — the HTTP server: reads each request's body, works out which
// surface it belongs to (git smart HTTP, REST v3, GraphQL, MCP, health),
// checks the bearer token where one is required, and writes the answer.
// Every JSON reply carries an X-GitHub-Request-Id header, including the
// error replies, and every error body is JSON with a `message` — never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { bodyParses, errReply, nextRequestId, type Ctx, type Reply } from './kit.ts';
import { handleRest } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './smart.ts';
import { Vault } from './vault.ts';

const MAX_BODY = 128 * 1024 * 1024;

export function buildForge(expectedToken: string): { vault: Vault; server: Server } {
  const vault = new Vault();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (chunks.reduce((sum, part) => sum + part.length, 0) + chunk.length > MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        writeReply(res, errReply(413, 'request body is too large'));
        return;
      }
      const body = Buffer.concat(chunks);
      let answer: Reply;
      try {
        answer = route(vault, expectedToken, req, body);
      } catch (err) {
        // Log the stack server-side; the client only ever sees the message.
        console.error((err as Error).stack ?? (err as Error).message);
        answer = errReply(500, (err as Error).message);
      }
      writeReply(res, answer);
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  // Keep connections alive a little longer than a load balancer's idle
  // timeout so the read workload's single keep-alive connection never drops.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return { vault, server };
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function route(vault: Vault, expectedToken: string, req: IncomingMessage, body: Buffer): Reply {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const parts = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  const ctx: Ctx = {
    method,
    parts,
    path,
    query: url.searchParams,
    headers: req.headers,
    body,
    host: headerOf(req, 'host') ?? 'localhost',
    authed: false,
  };

  if (method === 'GET' && path === '/healthz') {
    return { status: 200, body: { ok: true } };
  }

  // Git smart HTTP lives under /{owner}/{repo}.git/... and needs no token.
  if (parts.length >= 2 && (parts[1] as string).endsWith('.git')) {
    const tail = parts.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      return handleInfoRefs(vault, ctx);
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      return handleUploadPack(vault, ctx);
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      return handleReceivePack(vault, ctx);
    }
    return errReply(404, 'not found');
  }

  // Everything else below is an API surface and needs the trial token.
  const auth = headerOf(req, 'authorization') ?? '';
  const authed = expectedToken !== '' && auth === `Bearer ${expectedToken}`;
  if (!authed) return errReply(401, 'authentication required');
  ctx.authed = true;

  if (method === 'POST' && path === '/api/graphql') {
    return handleGraphql(vault, ctx);
  }
  if (method === 'POST' && path === '/mcp') {
    return handleMcp(vault, ctx);
  }
  if (method === 'DELETE' && path === '/mcp') {
    return handleMcp(vault, ctx);
  }
  if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'v3') {
    if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && !bodyParses(ctx)) {
      return errReply(400, 'request body must be valid JSON');
    }
    return handleRest(vault, { ...ctx, parts: parts.slice(2) });
  }
  return errReply(404, 'not found');
}

function writeReply(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': nextRequestId() };
  if (reply.headers !== undefined) Object.assign(headers, reply.headers);
  if (reply.raw !== undefined) {
    headers['Content-Type'] = reply.contentType ?? 'application/octet-stream';
    headers['Content-Length'] = String(reply.raw.length);
    res.writeHead(reply.status, headers);
    res.end(reply.raw);
    return;
  }
  if (reply.rawJson !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(reply.rawJson));
    res.writeHead(reply.status, headers);
    res.end(reply.rawJson);
    return;
  }
  const text = reply.status === 204 ? '' : JSON.stringify(reply.body ?? {});
  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = String(Buffer.byteLength(text));
  res.writeHead(reply.status, headers);
  res.end(text);
}
