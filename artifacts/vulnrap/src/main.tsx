import { createRoot } from "react-dom/client";
import { setCalibrationToken } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Task #113 — pick up the reviewer token (if configured at build time) so
// every calibration mutation hook automatically sends the credential. When
// VITE_CALIBRATION_TOKEN is unset, the API server treats the namespace as
// open (single-reviewer / local-dev fallback), so this is a no-op.
setCalibrationToken(import.meta.env.VITE_CALIBRATION_TOKEN);

createRoot(document.getElementById("root")!).render(<App />);
