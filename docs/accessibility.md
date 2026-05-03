# Accessibility

VulnRap targets **[WCAG 2.1 Level AA](https://www.w3.org/TR/WCAG21/)** conformance for the public web frontend (`artifacts/vulnrap`). This matches the baseline used by GOV.UK, the EU Web Accessibility Directive, and EN 301 549, so a project that consumes our pages from one of those compliance regimes can do so without an extra exception.

The accessibility statement that ships to end-users lives at [/accessibility](https://vulnrap.com/accessibility). This page is for contributors: what is covered, how to run the checks locally, and what is currently known to fail.

## Coverage

| Layer | Tooling | What it catches |
| --- | --- | --- |
| Lint | `eslint-plugin-jsx-a11y` (recommended ruleset) | Static markup mistakes — missing `alt`, click handlers without keyboard handlers, invalid ARIA, misuse of `tabindex`, etc. |
| Unit | `vitest` + `@testing-library/react` + `axe-core` | Render-time violations on the heaviest reused components: report submission flow, diagnostics panel, comparison view, dashboard cards. |
| End-to-end | `@playwright/test` + `@axe-core/playwright` | Whole-page scans on each major route (landing, results, check, verify, stats, developers, privacy) plus scans of the obvious empty/loaded states. |
| Manual | Keyboard-only walkthrough | Things tools cannot catch: focus order, focus-visible on every interactive element, screen-reader announcements on async results, colour contrast on score badges and tier labels, `prefers-reduced-motion` honoured by Framer Motion. |

The unit suite runs as part of `pnpm --filter @workspace/vulnrap run test:unit`. The Playwright suite runs as part of `pnpm --filter @workspace/vulnrap run test:e2e`. Both are wired into the diff-aware CI selector at `scripts/vulnrap-e2e-select-specs.mjs`, so a touch on a shared component reruns the full a11y scan and a touch on an a11y spec only reruns that spec.

## Running the checks locally

```bash
# 1. Static (jsx-a11y)
pnpm --filter @workspace/vulnrap exec eslint .

# 2. Unit-level axe assertions
pnpm --filter @workspace/vulnrap run test:unit

# 3. End-to-end axe scans across every major route
pnpm --filter @workspace/vulnrap exec playwright test accessibility.spec.ts
```

Severity contract: the e2e and unit axe scans **fail the build on any violation classed as `serious` or `critical`**. `moderate` and `minor` violations are surfaced in the test output for visibility but do not block CI; we triage them as follow-up issues.

## Known gaps

These are tracked but not yet fixed. PRs welcome — file or claim a follow-up task before starting work.

- **Full assistive-tech sweep** with NVDA, JAWS, and VoiceOver. The current pass is a keyboard-only walkthrough plus axe; it does not certify behaviour under every screen reader.
- **Localisation / RTL.** All UI strings are English-only and the layout has not been audited for right-to-left mirroring.
- **Animated marketing decoration** (laser effects, cursor bugs, crawling bugs on the landing page) respects `prefers-reduced-motion` via Framer Motion's global `MotionConfig`, but reduced-motion users still see a static gradient where peers see motion. Acceptable per WCAG 2.3.3 (AAA, not AA), but worth noting.

## Reporting a new accessibility issue

Open a GitHub issue with the `accessibility` label and include:

1. The page URL or component name.
2. The assistive technology, browser, and OS you were using.
3. What you expected versus what happened.
4. A screenshot, screen-reader transcript, or short screen recording if available.

For a security-relevant accessibility regression (for example, a focus trap that exposes a private surface), use the contact in [`/.well-known/security.txt`](https://vulnrap.com/.well-known/security.txt) instead of a public issue.

## How this is enforced for new code

- `eslint-plugin-jsx-a11y` is wired into `artifacts/vulnrap/eslint.config.js`. New JSX is checked on every `pnpm exec eslint .` run; once the workspace pre-commit hook lands (separate task), it will be invoked automatically on staged files.
- The Playwright a11y spec (`artifacts/vulnrap/e2e/accessibility.spec.ts`) is part of the diff-aware e2e selector and runs in CI on any PR that touches shared frontend code.
- The unit-level axe assertions live next to their components (`*.a11y.test.tsx`) and run as part of the regular vitest pass.

If you add a major new route or a new heavy reused component, add it to the corresponding scan list rather than relying on a future audit to find regressions.
