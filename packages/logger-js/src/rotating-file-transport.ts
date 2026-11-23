import build from "pino-abstract-transport";
import fs from "node:fs";
import path from "node:path";
import { createStream, type RotatingFileStream } from "rotating-file-stream";

export type RotatingFileTransportOptions = {
  dir: string;
  filename?: string;
  size?: string;
  interval?: string;
  retentionDays?: number;
  /** Mirror every line to stdout as well, for container log collection. */
  stdout?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Rotated names keep the creation-time UTC timestamp, matching the previous transport's `iso` format
// (app-YYYYMMDDHHMMSS.log). rfs starts the per-period index at 1, so only suffix it on collisions.
function rotatedFileName(base: string, time?: number | Date | null, index?: number | null): string {
  if (!time) return `${base}.log`;
  const stamp = new Date(time).toISOString().replace(/[-:T]/g, "").split(".")[0];
  const suffix = index == null || index <= 1 ? "" : `-${index}`;
  return `${base}-${stamp}${suffix}.log`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupExpiredLogs(dir: string, prefix: string, retentionDays: number): void {
  if (retentionDays <= 0) return;
  const deadline = Date.now() - retentionDays * DAY_MS;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${prefix}-`) || !(name.endsWith(".log") || name.endsWith(".log.gz")))
      continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < deadline) fs.rmSync(file);
    } catch {
      // The file may have just been rotated or removed; the next cleanup pass covers it.
    }
  }
}

/**
 * Writes pino's JSON lines to a size/time rotating file, one record per line.
 *
 * Replaces `pino-transport-rotating-file`, whose raw mode concatenated records without line
 * separators (invalid NDJSON) and whose only JSON-free alternative was hardcoded pino-pretty.
 * With `stdout: true` each line is also mirrored to stdout, which lets the production logger
 * stay a single transport target (multi-target pipelines reject custom level formatters).
 */
export default function rotatingFileTransport(options: RotatingFileTransportOptions) {
  const {
    dir,
    filename = "app",
    size = "20M",
    interval = "1d",
    retentionDays = 30,
    stdout = false,
  } = options;

  // Log files are not worth taking the service down for: this transport runs in a worker thread,
  // so anything thrown here reaches the main thread as an unhandled ThreadStream "error" and exits
  // the process. A directory that cannot be created (dangling symlink, path component that is a
  // file, stale or read-only mount) therefore degrades to stdout-only logging.
  let dirReady = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    dirReady = true;
  } catch (error) {
    console.error(
      `[logger-js] cannot use log directory ${dir}: ${describeError(error)}. ` +
        "Logs go to stdout only; fix LOG_DIR to get the rotating file.",
    );
  }

  // immutable: every file keeps its creation timestamp name, so the active file never changes name.
  const fileStream: RotatingFileStream | null = dirReady
    ? createStream((time, index) => rotatedFileName(filename, time, index), {
        path: dir,
        interval,
        size,
        immutable: true,
      })
    : null;
  let failed = !dirReady;
  fileStream?.on("error", (error: Error) => {
    // Logging must not crash the worker when the volume fails; pino forwards worker stderr to the main process.
    failed = true;
    console.error(`[logger-js] rotating file stream for ${dir} failed:`, error?.message ?? error);
  });

  if (dirReady) {
    const cleanup = () => {
      try {
        cleanupExpiredLogs(dir, filename, retentionDays);
      } catch (error) {
        console.error(
          `[logger-js] log retention cleanup for ${dir} failed:`,
          describeError(error),
        );
      }
    };
    cleanup();
    setInterval(cleanup, DAY_MS).unref();
  }

  // Transport workers redirect process.stdout, so mirror straight to fd 1 like pino/file does.
  // One line per write stays inside pipe buffer sizes; stdout is best-effort next to the file.
  const writeStdoutLine = (line: string): void => {
    try {
      fs.writeSync(1, `${line}\n`);
    } catch {
      // Ignored: the rotating file remains the authoritative copy.
    }
  };

  return build(
    async (source) => {
      for await (const line of source) {
        // Without the file there is nothing else holding the line, so stdout covers both cases.
        if (stdout || !fileStream || failed) writeStdoutLine(line);
        if (fileStream && !failed) fileStream.write(`${line}\n`);
      }
      if (fileStream && !failed) {
        await new Promise<void>((resolve, reject) => {
          fileStream.once("close", resolve);
          fileStream.once("error", reject);
          fileStream.end();
        });
      }
    },
    { parse: "lines" },
  );
}
