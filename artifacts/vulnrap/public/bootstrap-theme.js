// Task #1310 — Bootstrap theme class before render to prevent FOUC.
//
// Extracted from index.html so the production CSP can drop
// 'unsafe-inline' from script-src without breaking the no-flash
// behaviour. Loaded as a same-origin classic script so the browser
// blocks parsing on it, which is exactly what we want before #root
// is hydrated.
(function () {
  try {
    var t = localStorage.getItem("vulnrap:theme") || "system";
    var resolved =
      t === "light" || t === "dark"
        ? t
        : window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.classList.add(resolved);
    document.documentElement.style.colorScheme = resolved;
  } catch (e) {
    document.documentElement.classList.add("dark");
  }
})();
