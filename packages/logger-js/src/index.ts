import pino from "pino";
import path from "node:path";

export type LoggerOptions = pino.LoggerOptions & {
  environment?: string;
  directory?: string;
};

/** JSON consumers read "ERROR"/"INFO" instead of numeric codes; pino-pretty is excluded because it rejects custom level formatters. */
function withTextLevel(options: pino.LoggerOptions): pino.LoggerOptions {
  return {
    ...options,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
      ...options.formatters,
    },
  };
}

/** A real Pino instance, including native bindings, serializers and child loggers. */
export function createLogger(
  service: string,
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
) {
  if (!service.trim()) throw new Error("service name is required for logger initialization");
  const {
    environment = process.env.NODE_ENV || "development",
    directory = process.env.LOG_DIR || "logs",
    ...pinoOptions
  } = options;
  const settings: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    ...pinoOptions,
    base: { pid: process.pid, service, env: environment, ...pinoOptions.base },
  };
  if (destination) return pino(withTextLevel(settings), destination);
  if (environment === "test" || settings.level === "silent") return pino(withTextLevel(settings));
  if (environment !== "production") {
    return pino(
      settings,
      pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "yyyy-mm-dd HH:MM:ss", ignore: "pid,hostname" },
      }),
    );
  }
  // Single transport target: keep container stdout alongside the persistent rotating file;
  // both receive the same JSON lines with text levels from the main-thread serializer.
  return pino(
    withTextLevel(settings),
    pino.transport({
      target: new URL("./rotating-file-transport.js", import.meta.url).href,
      options: {
        dir: path.resolve(directory),
        filename: service,
        size: "20M",
        interval: "1d",
        retentionDays: 30,
        stdout: true,
      },
    }),
  );
}
