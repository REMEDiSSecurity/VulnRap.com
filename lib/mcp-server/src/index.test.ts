// Integration test for the MCP server's request handlers. Boots the
// `Server` instance via `buildServer()`, invokes the registered request
// handlers directly, and asserts the wire-shape of `tools/list` and
// `tools/call` responses. fetch() is stubbed so the test stays
// offline-deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./index.js";
import { TOOLS } from "./tools.js";

interface AnyServer {
  // The Server instance keeps its handlers on `_requestHandlers` keyed by the
  // request method string. We type the access loosely so this stays robust
  // to minor SDK internal refactors.
  _requestHandlers: Map<
    string,
    (req: unknown, extra: unknown) => Promise<unknown>
  >;
}

beforeEach(() => {
  process.env["VULNRAP_API_BASE_URL"] = "https://example.test";
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ totalReports: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["VULNRAP_API_BASE_URL"];
});

function getHandler(server: unknown, method: string) {
  const handlers = (server as AnyServer)._requestHandlers;
  const h = handlers.get(method);
  if (!h) throw new Error(`No handler registered for ${method}`);
  return h;
}

describe("MCP request handlers", () => {
  it("ListTools returns every registered tool with a json-schema-shaped input", async () => {
    const server = buildServer();
    const handler = getHandler(server, "tools/list");
    const req = ListToolsRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const res = (await handler(req, {})) as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { type: string; properties?: unknown };
      }>;
    };
    expect(res.tools).toHaveLength(TOOLS.length);
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of res.tools) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("CallTool dispatches to the right handler and wraps the response in MCP content", async () => {
    const server = buildServer();
    const handler = getHandler(server, "tools/call");
    const req = CallToolRequestSchema.parse({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "query_stats", arguments: {} },
    });
    const res = (await handler(req, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text)).toEqual({ totalReports: 7 });
  });

  it("CallTool returns an isError content entry for unknown tool names", async () => {
    const server = buildServer();
    const handler = getHandler(server, "tools/call");
    const req = CallToolRequestSchema.parse({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "does-not-exist", arguments: {} },
    });
    const res = (await handler(req, {})) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("CallTool surfaces zod validation failures as isError without throwing", async () => {
    const server = buildServer();
    const handler = getHandler(server, "tools/call");
    const req = CallToolRequestSchema.parse({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "score_report", arguments: {} },
    });
    const res = (await handler(req, {})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/score_report/);
  });
});
