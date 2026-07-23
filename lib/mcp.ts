// MCP client for the Ship server (Streamable HTTP).
// Lazy singleton connection + small semaphore. The concurrency cap, call
// spacing, retry count and per-call timeout all come from config.ts — see
// MCP_CONCURRENCY / MCP_CALL_SPACING_MS / MCP_RETRIES / MCP_TIMEOUT_MS.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  MCP_CALL_SPACING_MS,
  MCP_CONCURRENCY,
  MCP_RETRIES,
  MCP_TIMEOUT_MS,
} from "./config";

export class McpAuthError extends Error {}

/** The server answered normally but the tool itself reported failure. The
 *  transport is healthy, so this must NOT tear the shared client down. */
class McpToolError extends Error {}

function serverUrl(): string {
  const url = process.env.SHIP_MCP_URL;
  if (!url) throw new Error("SHIP_MCP_URL is not set (see .env.example)");
  return url;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "shipwatch", version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (process.env.SHIP_MCP_TOKEN) {
    headers.Authorization = `Bearer ${process.env.SHIP_MCP_TOKEN}`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl()), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

let cached: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (cached) return cached;
  // Dedup concurrent connects. Callers arrive in waves (MCP_CONCURRENCY at a
  // time), so after a reset they would each build their own Client and only the
  // last would win the `cached` slot — leaking the rest's transports/sockets in
  // a process that runs for days.
  connecting ??= connect()
    .then((c) => {
      cached = c;
      return c;
    })
    .finally(() => {
      connecting = null;
    });
  try {
    return await connecting;
  } catch (err) {
    throw classify(err);
  }
}

function classify(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(msg)) {
    return new McpAuthError(
      "Ship MCP rejected the token (401/403). Check SHIP_MCP_URL / SHIP_MCP_TOKEN in .env.local."
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function resetClient() {
  try {
    cached?.close();
  } catch {
    /* ignore */
  }
  cached = null;
}

// ---- semaphore with spacing ----
let active = 0;
let lastStart = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  // `while`, not `if`: waking a waiter is a microtask, so a caller arriving
  // synchronously in the gap can take the slot first. A woken waiter must
  // re-check rather than assume the slot is still free, or `active` drifts
  // above MCP_CONCURRENCY and the portal throttle silently stops holding.
  while (active >= MCP_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  const wait = lastStart + MCP_CALL_SPACING_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + MCP_CALL_SPACING_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function release() {
  active--;
  // Only hand the slot on if there's genuinely room; waking unconditionally
  // lets a backlog push `active` past the cap.
  if (active < MCP_CONCURRENCY) waiters.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Call an MCP tool and return its parsed JSON result. Read-only server.
 *  `opts.timeoutMs` / `opts.retries` override the global defaults for a single
 *  call (used to bound best-effort calls like the KPI phase). */
export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  opts?: { timeoutMs?: number; retries?: number }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? MCP_TIMEOUT_MS;
  const retries = opts?.retries ?? MCP_RETRIES;
  await acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const client = await getClient();
        const res = (await client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs,
        })) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
        if (res.isError) {
          const text = extractText(res);
          throw new McpToolError(`Tool ${name} returned error: ${text.slice(0, 500)}`);
        }
        return parseResult<T>(res);
      } catch (err) {
        lastErr = classify(err);
        if (lastErr instanceof McpAuthError) throw lastErr;
        // Only a transport-level failure justifies tearing down the shared
        // client. `cached` is used concurrently by up to MCP_CONCURRENCY calls,
        // so closing it on a mere tool-level error (e.g. one slow query the
        // portal rejected) aborts the healthy siblings mid-flight — and each of
        // them then resets and retries, cascading one bad page into a wave.
        if (!(lastErr instanceof McpToolError)) resetClient();
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    release();
  }
}

export async function listTools(): Promise<string[]> {
  const client = await getClient();
  const res = await client.listTools();
  return res.tools.map((t) => t.name);
}

function extractText(res: { content?: unknown }): string {
  const content = res.content as Array<{ type: string; text?: string }> | undefined;
  return (content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function parseResult<T>(res: { structuredContent?: unknown; content?: unknown }): T {
  if (res.structuredContent !== undefined && res.structuredContent !== null) {
    return res.structuredContent as T;
  }
  const text = extractText(res);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ---- typed envelopes ----
export type ListOrdersResponse = {
  range: { from: string; to: string };
  date_field: string;
  total_matched: number;
  returned: number;
  limit: number;
  offset: number;
  has_more: boolean;
  orders: Record<string, unknown>[];
};
