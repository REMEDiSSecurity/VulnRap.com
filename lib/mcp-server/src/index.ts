#!/usr/bin/env node
// VulnRap MCP server entrypoint. Speaks Model Context Protocol over
// stdio so it can be wired straight into Claude Desktop, Cursor, or any
// MCP-compatible agent runtime via a one-line config (see README).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS, getToolByName } from "./tools.js";
import { HttpError, getBaseUrl } from "./client.js";

// Convert each tool's Zod schema into the JSON-Schema shape MCP clients
// expect. We avoid pulling in zod-to-json-schema as a dep by emitting a
// minimal, lossy-but-correct projection: object with described properties
// and a required list. The handler still validates with the real zod
// schema, so any type drift between the projection and the runtime check
// surfaces as a clean validation error rather than silent misuse.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap common wrappers so describe()/refine() chains still expose the
  // underlying object.
  let inner: z.ZodTypeAny = schema;
  while (
    inner instanceof z.ZodEffects ||
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    if (inner instanceof z.ZodEffects) {
      inner = inner._def.schema as z.ZodTypeAny;
    } else if (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodNullable
    ) {
      inner = inner._def.innerType as z.ZodTypeAny;
    } else if (inner instanceof z.ZodDefault) {
      inner = inner._def.innerType as z.ZodTypeAny;
    }
  }

  if (!(inner instanceof z.ZodObject)) {
    return { type: "object", additionalProperties: true };
  }

  const shape = inner.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    properties[key] = describeZodField(fieldSchema);
    if (!isOptional(fieldSchema)) required.push(key);
  }

  const out: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) out.required = required;
  const desc = (schema as { description?: string }).description;
  if (desc) out.description = desc;
  return out;
}

function isOptional(s: z.ZodTypeAny): boolean {
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) return true;
  if (s instanceof z.ZodEffects) return isOptional(s._def.schema as z.ZodTypeAny);
  return false;
}

function describeZodField(s: z.ZodTypeAny): Record<string, unknown> {
  let cur: z.ZodTypeAny = s;
  let optional = false;
  while (
    cur instanceof z.ZodOptional ||
    cur instanceof z.ZodDefault ||
    cur instanceof z.ZodNullable ||
    cur instanceof z.ZodEffects
  ) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodDefault) {
      optional = true;
    }
    if (cur instanceof z.ZodEffects) {
      cur = cur._def.schema as z.ZodTypeAny;
    } else {
      cur = cur._def.innerType as z.ZodTypeAny;
    }
  }

  const description = (s as { description?: string }).description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  if (cur instanceof z.ZodString) base.type = "string";
  else if (cur instanceof z.ZodNumber) base.type = "number";
  else if (cur instanceof z.ZodBoolean) base.type = "boolean";
  else if (cur instanceof z.ZodEnum) {
    base.type = "string";
    base.enum = (cur._def.values as readonly string[]).slice();
  } else if (cur instanceof z.ZodArray) {
    base.type = "array";
    base.items = describeZodField(cur._def.type as z.ZodTypeAny);
  } else if (cur instanceof z.ZodObject) {
    Object.assign(base, zodToJsonSchema(cur));
  } else {
    // Fallback — accept anything; the runtime parse() will catch issues.
    base.type = "string";
  }

  if (optional) base.nullable = true;
  return base;
}

export function buildServer(): Server {
  const server = new Server(
    { name: "vulnrap-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const tool = getToolByName(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
    }

    const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Input validation failed for ${name}:\n${parsed.error.toString()}`,
          },
        ],
      };
    }

    try {
      const result = await tool.handler(parsed.data);
      return {
        content: [
          {
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${err.message}\n${err.bodyText.slice(0, 2000)}`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Tool ${name} failed: ${(err as Error).message ?? String(err)}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `[vulnrap-mcp] connected. base=${getBaseUrl()} tools=${TOOLS.length}`,
  );
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(`file://${entry}`).href;
    return import.meta.url === url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[vulnrap-mcp] fatal:", err);
    process.exit(1);
  });
}
