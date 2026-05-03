// Task #724 — Cover both branches of the request-id middleware.
import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { resolveRequestId, requestIdMiddleware } from "./request-id";

function makeReq(header?: string): Request {
  const headers: Record<string, string> = {};
  if (header !== undefined) headers["x-request-id"] = header;
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function makeRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response;
  return { res, headers };
}

describe("request-id middleware", () => {
  it("honours a well-formed inbound X-Request-Id", () => {
    const id = "abc.123-def_456";
    expect(resolveRequestId(makeReq(id))).toBe(id);
  });

  it("ignores a malformed inbound X-Request-Id and generates a fresh ULID", () => {
    const id = resolveRequestId(makeReq("has spaces & weird ; chars"));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("ignores a too-long inbound X-Request-Id", () => {
    const id = resolveRequestId(makeReq("a".repeat(200)));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates a ULID when no header is present", () => {
    const id = resolveRequestId(makeReq());
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("middleware echoes the id in the response header and sets req.id", () => {
    const req = makeReq("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    const { res, headers } = makeRes();
    let nextCalled = false;
    requestIdMiddleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect((req as Request & { id?: string }).id).toBe(
      "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    );
    expect(headers["x-request-id"]).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
  });
});
