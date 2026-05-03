// Task #724 — Request ID middleware.
//
// Honours an inbound `X-Request-Id` header when present and well-formed,
// otherwise generates a fresh ULID. The id is:
//   * attached to `req.id` (so pino-http picks it up via genReqId below)
//   * echoed in the `X-Request-Id` response header
//   * stored in AsyncLocalStorage so outbound fetch helpers can forward it
import type { Request, Response, NextFunction } from "express";
import { ulid } from "ulid";
import { runWithRequestContext } from "../lib/request-context";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(req: Request): string {
  const incoming = req.header("x-request-id");
  if (incoming && SAFE_ID.test(incoming)) {
    return incoming;
  }
  return ulid();
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = resolveRequestId(req);
  // pino-http reads req.id when genReqId is configured to return it.
  (req as Request & { id: string }).id = id;
  res.setHeader("x-request-id", id);
  runWithRequestContext({ requestId: id }, () => next());
}
