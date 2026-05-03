import { describe, expect, it } from "vitest";
import { renderBadgeSvg, BADGE_STYLES } from "./badge-svg";

describe("renderBadgeSvg", () => {
  it.each(BADGE_STYLES)("renders a valid SVG document for style=%s", (style) => {
    const svg = renderBadgeSvg({ label: "vulnrap", value: "Slop (90)", color: "#f85149", style });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toMatch(/<\/svg>$/);
    expect(svg).toContain("vulnrap");
    expect(svg).toContain("Slop (90)");
  });

  it("escapes XML metacharacters in label and value", () => {
    const svg = renderBadgeSvg({ label: "<x>", value: "a&b\"c", color: "#000", style: "flat" });
    expect(svg).not.toMatch(/<x>/);
    expect(svg).toContain("&lt;x&gt;");
    expect(svg).toContain("a&amp;b&quot;c");
  });

  it("includes the value-side fill color", () => {
    const svg = renderBadgeSvg({ label: "vulnrap", value: "Clean (5)", color: "#3fb950", style: "flat" });
    expect(svg.toLowerCase()).toContain("#3fb950");
  });
});
