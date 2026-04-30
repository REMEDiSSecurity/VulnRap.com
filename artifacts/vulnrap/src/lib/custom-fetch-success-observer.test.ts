// Task #421 — narrow integration tests for the shared client's new
// success-observer contract. The calibration-token-rejection store
// (see calibration-token-rejection.test.ts) tests its own filter logic
// by pushing notices in directly; these tests instead drive customFetch
// against a mocked global fetch and assert that the SuccessNotice fan-
// out fires exactly when expected (2xx only) with the right method, url
// and status, and that addSuccessObserver's unsubscribe handle works.
//
// Co-located in vulnrap rather than @workspace/api-client-react because
// the latter has no test infrastructure today; vulnrap already pulls
// the shared client and has happy-dom + vitest wired up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addSuccessObserver,
  customFetch,
  type SuccessNotice,
} from "@workspace/api-client-react";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const originalFetch = globalThis.fetch;
let fetchMock: FetchMock;

function jsonResponse(
  body: unknown,
  init: { status?: number; url?: string } = {},
): Response {
  const status = init.status ?? 200;
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  // Response.url is read-only; some test environments leave it empty,
  // which is fine — customFetch falls back to the request URL when
  // response.url is empty.
  if (init.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

beforeEach(() => {
  fetchMock = vi.fn() as FetchMock;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("customFetch success observer", () => {
  it("emits a SuccessNotice for a 2xx response with method, url and status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const notices: SuccessNotice[] = [];
    const unsubscribe = addSuccessObserver((notice) => {
      notices.push(notice);
    });

    try {
      await customFetch("/api/feedback/calibration/handwavy-phrases", {
        method: "POST",
        body: JSON.stringify({ phrase: "definitely vulnerable" }),
      });
    } finally {
      unsubscribe();
    }

    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice.method).toBe("POST");
    expect(notice.url).toBe("/api/feedback/calibration/handwavy-phrases");
    expect(notice.status).toBe(200);
    expect(notice.headers).toBeInstanceOf(Headers);
  });

  it("does not emit for 4xx or 5xx responses", async () => {
    const notices: SuccessNotice[] = [];
    const unsubscribe = addSuccessObserver((notice) => {
      notices.push(notice);
    });

    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "nope" }, { status: 401 }),
      );
      await expect(
        customFetch("/api/feedback/calibration/handwavy-phrases", {
          method: "POST",
        }),
      ).rejects.toThrow();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "boom" }, { status: 500 }),
      );
      await expect(
        customFetch("/api/feedback/calibration/handwavy-phrases", {
          method: "POST",
        }),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
    }

    expect(notices).toHaveLength(0);
  });

  it("stops emitting after the unsubscribe handle is called", async () => {
    const notices: SuccessNotice[] = [];
    const unsubscribe = addSuccessObserver((notice) => {
      notices.push(notice);
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await customFetch("/api/feedback/calibration/handwavy-phrases", {
      method: "POST",
    });
    expect(notices).toHaveLength(1);

    unsubscribe();

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await customFetch("/api/feedback/calibration/handwavy-phrases", {
      method: "POST",
    });
    expect(notices).toHaveLength(1);
  });

  it("uppercases the request method on the notice", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const notices: SuccessNotice[] = [];
    const unsubscribe = addSuccessObserver((notice) => {
      notices.push(notice);
    });

    try {
      await customFetch("/api/feedback/calibration/handwavy-phrases/abc", {
        method: "delete",
      });
    } finally {
      unsubscribe();
    }

    expect(notices).toHaveLength(1);
    expect(notices[0].method).toBe("DELETE");
  });
});
