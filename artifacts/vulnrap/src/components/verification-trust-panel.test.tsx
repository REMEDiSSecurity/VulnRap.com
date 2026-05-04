import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { VerificationCheck } from "@workspace/api-client-react";
import { VerificationTrustPanel } from "./verification-trust-panel";

function check(
  type: string,
  result: VerificationCheck["result"],
  overrides: Partial<VerificationCheck> = {},
): VerificationCheck {
  return {
    type,
    target: overrides.target ?? `${type}:target`,
    result,
    detail: overrides.detail ?? "",
    weight: overrides.weight ?? 0,
    ...overrides,
  };
}

describe("VerificationTrustPanel", () => {
  it("renders nothing when no checks are verifiable (only error/skipped/warning/info)", () => {
    const { container } = render(
      <VerificationTrustPanel
        checks={[
          check("github_file", "error"),
          check("nvd_cve", "skipped"),
          check("npm_package", "warning"),
          check("pypi_package", "info"),
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByTestId("verification-trust-panel"),
    ).not.toBeInTheDocument();
  });

  it("renders the panel as soon as one verifiable check is present", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file", "verified"),
          check("nvd_cve", "error"),
        ]}
      />,
    );
    expect(screen.getByTestId("verification-trust-panel")).toBeInTheDocument();
  });

  it("computes verified/total ratio from verifiable checks only and excludes error/skipped/warning/info", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file_a", "verified"),
          check("github_file_b", "verified"),
          check("github_file_c", "verified"),
          check("github_file_d", "not_found"),
          // These should be excluded from the ratio entirely:
          check("github_file_e", "error"),
          check("github_file_f", "skipped"),
          check("github_file_g", "warning"),
          check("github_file_h", "info"),
        ]}
      />,
    );

    // Ratio "verified/total" — verifiable count is 4 (3 verified + 1 not_found).
    // "3/4" renders both in the header and in the github source breakdown.
    expect(screen.getAllByText("3/4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(
      screen.getByText(
        /3 of 4 referenced resources verified, 1 not found/i,
      ),
    ).toBeInTheDocument();
  });

  it("omits the 'not found' suffix when every verifiable check is verified", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file_a", "verified"),
          check("github_file_b", "verified"),
        ]}
      />,
    );
    // Both the header and the per-source breakdown render "2/2" here.
    expect(screen.getAllByText("2/2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(
      screen.getByText(/2 of 2 referenced resources verified$/i),
    ).toBeInTheDocument();
  });

  it("prefers the summary.verified count over recomputing from checks when provided", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file_a", "verified"),
          check("github_file_b", "not_found"),
          check("github_file_c", "not_found"),
        ]}
        summary={{ verified: 2, notFound: 1, warnings: 0, errors: 0 }}
      />,
    );
    // Summary says 2 verified out of 3 verifiable checks
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
  });

  it("renders a per-source breakdown, classifying github_/nvd_/npm_/pypi_ prefixes correctly", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file_verified", "verified"),
          check("github_symbol_present", "not_found"),
          check("nvd_cve_lookup", "verified"),
          check("verified_cve", "verified"),
          check("npm_package_exists", "verified"),
          check("pypi_package_exists", "not_found"),
        ]}
      />,
    );

    const breakdown = screen.getByTestId("verification-trust-source-breakdown");
    expect(breakdown).toBeInTheDocument();

    const github = within(breakdown).getByTestId(
      "verification-trust-source-github",
    );
    expect(github).toHaveTextContent(/GitHub/i);
    expect(github).toHaveTextContent("1/2");

    const nvd = within(breakdown).getByTestId("verification-trust-source-nvd");
    expect(nvd).toHaveTextContent(/NVD/i);
    expect(nvd).toHaveTextContent("2/2");

    const npm = within(breakdown).getByTestId("verification-trust-source-npm");
    expect(npm).toHaveTextContent(/npm/i);
    expect(npm).toHaveTextContent("1/1");

    const pypi = within(breakdown).getByTestId(
      "verification-trust-source-pypi",
    );
    expect(pypi).toHaveTextContent(/PyPI/i);
    expect(pypi).toHaveTextContent("0/1");
  });

  it("classifies invalid_cve_year and unknown prefixes correctly", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("invalid_cve_year", "verified"),
          check("poc_placeholder_textbook", "verified"),
        ]}
      />,
    );

    const breakdown = screen.getByTestId("verification-trust-source-breakdown");
    expect(
      within(breakdown).getByTestId("verification-trust-source-nvd"),
    ).toHaveTextContent("1/1");
    expect(
      within(breakdown).getByTestId("verification-trust-source-other"),
    ).toHaveTextContent(/Other/i);
  });

  it("excludes error/skipped/warning checks from the per-source breakdown", () => {
    render(
      <VerificationTrustPanel
        checks={[
          check("github_file_a", "verified"),
          check("github_file_b", "error"),
          check("github_file_c", "skipped"),
          check("github_file_d", "warning"),
        ]}
      />,
    );

    const github = screen.getByTestId("verification-trust-source-github");
    // Only the single verified check counts; the rest are excluded.
    expect(github).toHaveTextContent("1/1");
  });

  it("color-codes the overall ratio: green ≥80%, yellow ≥50%, orange below", () => {
    const { rerender } = render(
      <VerificationTrustPanel
        checks={[
          check("github_a", "verified"),
          check("github_b", "verified"),
          check("github_c", "verified"),
          check("github_d", "verified"),
          check("github_e", "not_found"),
        ]}
      />,
    );
    // 4/5 = 80% — green. The percent badge is unique to the header; the
    // ratio "4/5" appears both in the header and the per-source breakdown,
    // so we assert tone on the percent which carries the same ratioTone class.
    expect(screen.getByText("80%")).toHaveClass("text-green-400");

    // 2/3 ≈ 67% — yellow
    rerender(
      <VerificationTrustPanel
        checks={[
          check("github_a", "verified"),
          check("github_b", "verified"),
          check("github_c", "not_found"),
        ]}
      />,
    );
    expect(screen.getByText("67%")).toHaveClass("text-yellow-400");

    // 1/4 = 25% — orange
    rerender(
      <VerificationTrustPanel
        checks={[
          check("github_a", "verified"),
          check("github_b", "not_found"),
          check("github_c", "not_found"),
          check("github_d", "not_found"),
        ]}
      />,
    );
    expect(screen.getByText("25%")).toHaveClass("text-orange-400");
  });

  it("color-codes per-source counts: all-verified green, none-verified orange, mixed yellow", () => {
    render(
      <VerificationTrustPanel
        checks={[
          // GitHub: all verified → green
          check("github_a", "verified"),
          check("github_b", "verified"),
          // NVD: none verified → orange
          check("nvd_a", "not_found"),
          // npm: mixed → yellow
          check("npm_a", "verified"),
          check("npm_b", "not_found"),
        ]}
      />,
    );

    const github = within(
      screen.getByTestId("verification-trust-source-github"),
    ).getByText("2/2");
    expect(github).toHaveClass("text-green-400");

    const nvd = within(
      screen.getByTestId("verification-trust-source-nvd"),
    ).getByText("0/1");
    expect(nvd).toHaveClass("text-orange-400");

    const npm = within(
      screen.getByTestId("verification-trust-source-npm"),
    ).getByText("1/2");
    expect(npm).toHaveClass("text-yellow-400");
  });
});
