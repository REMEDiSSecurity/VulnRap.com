import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ImpossibleHttpMarkers,
  __testables,
} from "./impossible-http-markers";

// Coverage for the per-marker badge component used by the triage UI to
// render each impossible_http_response marker as its own chip with a
// plain-language RFC tooltip. Pins the static lookup table, the dynamic
// pattern → label builders, the unknown-marker fallback, and the
// rendered output (badges, aria summary, custom test-id prefix).

describe("lookupMarkerInfo", () => {
  const { lookupMarkerInfo } = __testables;

  it("returns the static label for every Content-Length impossibility", () => {
    for (const id of [
      "content_length_zero_but_body_present",
      "content_length_declared_but_body_empty",
      "content_length_disagrees_with_body",
    ]) {
      const info = lookupMarkerInfo(id);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.label).not.toEqual(id);
      expect(info.explanation).toMatch(/Content-Length|body|payload|framing|RFC/i);
    }
  });

  it("builds a status-code-aware label for status_<code>_must_have_no_body", () => {
    const info204 = lookupMarkerInfo("status_204_must_have_no_body");
    expect(info204.label).toContain("204");
    expect(info204.explanation).toMatch(/RFC 7230/);

    const info304 = lookupMarkerInfo("status_304_must_have_no_body");
    expect(info304.label).toContain("304");

    const info103 = lookupMarkerInfo("status_103_must_have_no_body");
    expect(info103.label).toContain("103");
    expect(info103.label).not.toEqual("status 103 must have no body");
  });

  it("builds a status-code-aware label for status_<code>_with_wrong_reason_phrase", () => {
    const info = lookupMarkerInfo("status_404_with_wrong_reason_phrase");
    expect(info.label).toContain("404");
    expect(info.explanation).toMatch(/reason phrase|canonical|status line/i);
  });

  it("turns response-only / request-only header markers into Title-Cased header names", () => {
    // Marker IDs use hyphenated lowercase header names (e.g. `set-cookie`),
    // matching how the detector keys its header map.
    const reqOnly = lookupMarkerInfo("response_carries_request_only_cookie");
    expect(reqOnly.label).toContain("Cookie");
    expect(reqOnly.explanation).toMatch(/request header|RFC 6265|RFC 7231/i);

    const respOnly = lookupMarkerInfo("request_carries_response_only_set-cookie");
    expect(respOnly.label).toContain("Set-Cookie");
    expect(respOnly.explanation).toMatch(/response header/i);

    const ifNoneMatch = lookupMarkerInfo("response_carries_request_only_if-none-match");
    expect(ifNoneMatch.label).toContain("If-None-Match");
  });

  it("builds a method-aware label for response_to_<METHOD>_must_have_no_body", () => {
    const head = lookupMarkerInfo("response_to_HEAD_must_have_no_body");
    expect(head.label).toContain("HEAD");
    expect(head.explanation).toMatch(/RFC 7230/);

    const connect = lookupMarkerInfo("response_to_CONNECT_must_have_no_body");
    expect(connect.label).toContain("CONNECT");
  });

  it("falls back to a humanised label and a generic explanation for unknown marker IDs", () => {
    const info = lookupMarkerInfo("brand_new_marker_xyz");
    expect(info.label).toBe("brand new marker xyz");
    expect(info.explanation).toMatch(/hallucination-detector\.ts/);
  });
});

describe("<ImpossibleHttpMarkers />", () => {
  it("renders nothing when the markers list is empty", () => {
    const { container } = render(<ImpossibleHttpMarkers markers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one badge per marker with the friendly label and the raw ID caption", () => {
    render(
      <ImpossibleHttpMarkers
        markers={[
          "status_204_must_have_no_body",
          "response_carries_request_only_cookie",
          "content_length_zero_but_body_present",
        ]}
      />,
    );

    expect(screen.getByText(/204 response carries a body/i)).toBeInTheDocument();
    expect(screen.getByText(/Response carries request-only header: Cookie/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Content-Length: 0 but body present/i))
      .toBeInTheDocument();
    expect(screen.getByText(/\(status_204_must_have_no_body\)/)).toBeInTheDocument();
  });

  it("attaches an aria-label summarising the marker count for screen readers", () => {
    render(
      <ImpossibleHttpMarkers
        markers={["status_204_must_have_no_body", "content_length_zero_but_body_present"]}
      />,
    );
    expect(
      screen.getByLabelText(/2 impossibility markers/i),
    ).toBeInTheDocument();
  });

  it("surfaces the per-marker explanation as the trigger button's accessible name", () => {
    // Tooltip content lives in a Radix Portal that doesn't open without
    // a real hover/tap, so the trigger's aria-label encodes the same
    // explanation for screen-reader users.
    render(
      <ImpossibleHttpMarkers markers={["status_204_must_have_no_body"]} />,
    );
    const trigger = screen.getByTestId(
      "impossible-http-marker-status_204_must_have_no_body",
    );
    expect(trigger.getAttribute("aria-label")).toMatch(
      /204 response carries a body/i,
    );
    expect(trigger.getAttribute("aria-label")).toMatch(/RFC 7230/);
  });

  it("honours a custom testIdPrefix so multiple instances on the same page don't collide", () => {
    render(
      <ImpossibleHttpMarkers
        markers={["status_204_must_have_no_body"]}
        testIdPrefix="evidence-3-marker"
      />,
    );
    expect(
      screen.getByTestId("evidence-3-marker-list"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("evidence-3-marker-status_204_must_have_no_body"),
    ).toBeInTheDocument();
  });
});
