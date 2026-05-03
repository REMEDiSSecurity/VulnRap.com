// Resolve a user-supplied report reference to the underlying numeric id.
//
// Accepts:
//   - decimal report id from the URL ("1234", "#1234")
//   - the human-readable hex code with prefix ("VR-000B", "vr_000b")
//   - a bare report code: either contains a non-decimal hex digit ("000B")
//     or is at least four characters with a leading zero ("0010", canonical
//     zero-padded format produced by anonymizeId)
//
// Report codes are just the report's numeric id rendered as uppercase hex,
// zero-padded to width 4, with a `VR-` prefix (see anonymizeId in
// api-server: `id.toString(16).padStart(4, "0").toUpperCase()`). Codes are
// therefore resolvable client-side by parsing hex back to an integer — no
// extra API call required.
//
// For bare inputs we have to disambiguate decimal-vs-hex. The rules above
// cover every canonical code and every numeric URL id, with one residual
// ambiguity: a bare 4+ digit input with no leading zero and no hex letter
// (e.g. "1234") is treated as a decimal id. Reviewers who want the report
// code form in that range should paste it with the `VR-` prefix; the
// README documents this.
export function parseReportId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const prefixed = /^VR[-_]?([0-9A-Fa-f]{1,8})$/i.exec(value);
  if (prefixed) {
    const n = parseInt(prefixed[1], 16);
    return Number.isFinite(n) && n > 0 ? String(n) : null;
  }

  const stripped = value.replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{1,8}$/.test(stripped)) return null;

  const looksLikeCode =
    /[A-Fa-f]/.test(stripped) ||
    (stripped.length >= 4 && stripped.startsWith("0"));

  const n = looksLikeCode
    ? parseInt(stripped, 16)
    : /^\d+$/.test(stripped)
      ? parseInt(stripped, 10)
      : NaN;
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}
