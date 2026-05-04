// Crash-safe atomic JSON file writer.
//
// A plain `writeFileSync` call leaves a window where a crash (deploy,
// OOM, power loss) mid-write produces a half-written JSON blob. The
// next start silently discards it and throws away whatever state was
// being tracked. This helper closes that window by writing to a
// unique sibling temp file, fsyncing the bytes to disk, then using
// POSIX rename(2) — which is atomic on the same filesystem — to
// replace the destination. After a successful rename the caller sees
// either the old file or the fully-written new file, never a corrupt
// intermediate.
//
// The random suffix on the temp path prevents two concurrent writers
// (e.g. overlapping flush calls) from clobbering each other's temp
// file before the rename completes.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Serialize `data` as formatted JSON and write it atomically to
 * `filePath`. The parent directory is created (recursively) if it
 * does not already exist.
 *
 * On failure the destination file is left unchanged and the error is
 * re-thrown after best-effort cleanup of the temp sibling.
 */
export function atomicWriteJsonFileSync(
  filePath: string,
  data: unknown,
): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const serialized = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o644);
    writeSync(fd, serialized, 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
