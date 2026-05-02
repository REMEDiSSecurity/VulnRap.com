import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// The calibration reviewer token must NOT be shipped in the public frontend
// bundle. VITE_* env vars are compile-time client-side values that are
// embedded verbatim in the public JavaScript, so any secret placed there
// is recoverable by every visitor. Calibration mutations now require the
// token to be supplied server-side only; the browser-facing setCalibrationToken
// call has been removed to prevent the shared secret from leaking through
// the public bundle or observed network requests.

createRoot(document.getElementById("root")!).render(<App />);
