import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    AUTH_MODE: z.enum(["mock", "external"]),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    METRICS_BEARER_TOKEN: z.string().min(32).optional(),
    MOCK_AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(28800),
    DATABASE_URL: z.string().url(),
    AI_MODEL: z.string().trim().min(1).optional(),
    AI_API_KEY: z.string().min(1).optional(),
    AI_IMAGE_MODEL: z.string().trim().min(1).optional(),
    AI_IMAGE_API_KEY: z.string().min(1).optional(),
    AI_IMAGE_BASE_URL: z.string().url().optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_API_FORMAT: z.enum(["openai", "anthropic"]).optional(),
    AI_THINKING: z.enum(["adaptive", "disabled"]).optional(),
    AI_REASONING_EFFORT: z.enum(["low", "medium", "high", "max"]).optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
    AI_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(4),
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    TENANT_MAX_DOCUMENTS: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    TENANT_MAX_ASSET_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(1_099_511_627_776)
      .default(10_737_418_240),
    ASSET_STORAGE_ENDPOINT: z
      .string()
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"))
      .optional(),
    ASSET_STORAGE_PUBLIC_ENDPOINT: z
      .string()
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"))
      .optional(),
    ASSET_STORAGE_REGION: z.string().min(1).default("us-east-1"),
    ASSET_STORAGE_BUCKET: z.string().min(3).max(63).default("zhishu-private-assets"),
    ASSET_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    ASSET_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    ASSET_STORAGE_AUTO_CREATE_BUCKET: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ASSET_STORAGE_CHECK_ON_STARTUP: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    ASSET_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(10_485_760),
    ASSET_UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
    ASSET_ACCESS_URL_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
    ASSET_ORPHAN_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(2_592_000)
      .default(86_400),
    COLLABORATION_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    COLLABORATION_HOST: z.string().min(1).default("0.0.0.0"),
    COLLABORATION_PUBLIC_URL: z.string().url().default("ws://localhost:3001"),
    COLLABORATION_TOKEN_SECRET: z
      .string()
      .min(32)
      .default("local-development-collaboration-secret-change-me"),
    COLLABORATION_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    COLLABORATION_MAX_UPDATE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(10_485_760)
      .default(1_048_576),
    COLLABORATION_TEST_CRASH_AFTER_COMMIT: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    COLLABORATION_MAX_CONNECTIONS: z.coerce.number().int().min(2).max(10_000).default(100),
    COLLABORATION_MAX_ACTIVE_ROOMS: z.coerce.number().int().min(1).max(2_000).default(50),
    COLLABORATION_MAX_ROOM_CONNECTIONS: z.coerce.number().int().min(1).max(1_000).default(20),
    COLLABORATION_MAX_DOCUMENTS_PER_CONNECTION: z.coerce.number().int().min(1).max(100).default(1),
    COLLABORATION_ALLOWED_ORIGINS: z
      .string()
      .default(
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5180,http://127.0.0.1:5180",
      )
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    SWAGGER_UI_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .superRefine((config, context) => {
    if (Boolean(config.AI_IMAGE_MODEL) !== Boolean(config.AI_IMAGE_API_KEY))
      context.addIssue({
        code: "custom",
        path: ["AI_IMAGE_MODEL"],
        message: "AI_IMAGE_MODEL and AI_IMAGE_API_KEY must be configured together.",
      });
    if (Boolean(config.AI_MODEL) !== Boolean(config.AI_API_KEY))
      context.addIssue({
        code: "custom",
        path: ["AI_MODEL"],
        message: "AI_MODEL and AI_API_KEY must be configured together.",
      });
    if (config.COLLABORATION_TEST_CRASH_AFTER_COMMIT && config.NODE_ENV !== "test") {
      context.addIssue({
        code: "custom",
        path: ["COLLABORATION_TEST_CRASH_AFTER_COMMIT"],
        message: "Post-commit crash injection is available only in test mode.",
      });
    }
    if (config.NODE_ENV === "production" && config.AUTH_MODE === "mock") {
      context.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "Mock authentication is disabled in production; configure SSO before launch.",
      });
    }
    if (
      config.NODE_ENV === "production" &&
      (!config.ASSET_STORAGE_ENDPOINT ||
        !config.ASSET_STORAGE_ACCESS_KEY_ID ||
        !config.ASSET_STORAGE_SECRET_ACCESS_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ASSET_STORAGE_ENDPOINT"],
        message: "Private object storage endpoint and credentials are required in production.",
      });
    }
    if (
      Boolean(config.ASSET_STORAGE_ACCESS_KEY_ID) !==
        Boolean(config.ASSET_STORAGE_SECRET_ACCESS_KEY) ||
      (Boolean(config.ASSET_STORAGE_ACCESS_KEY_ID) && !config.ASSET_STORAGE_ENDPOINT)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ASSET_STORAGE_ACCESS_KEY_ID"],
        message: "Object storage credentials must be provided as a pair with an endpoint.",
      });
    }
    if (config.COLLABORATION_PORT === config.PORT) {
      context.addIssue({
        code: "custom",
        path: ["COLLABORATION_PORT"],
        message: "The standalone collaboration listener must use a different port from the API.",
      });
    }
    if (config.NODE_ENV === "production") {
      if (
        config.COLLABORATION_TOKEN_SECRET === "local-development-collaboration-secret-change-me"
      ) {
        context.addIssue({
          code: "custom",
          path: ["COLLABORATION_TOKEN_SECRET"],
          message: "A private collaboration session signing secret is required in production.",
        });
      }
      if (!config.COLLABORATION_PUBLIC_URL.startsWith("wss://")) {
        context.addIssue({
          code: "custom",
          path: ["COLLABORATION_PUBLIC_URL"],
          message: "The public collaboration URL must use WSS in production.",
        });
      }
      if (
        config.COLLABORATION_ALLOWED_ORIGINS.length === 0 ||
        config.COLLABORATION_ALLOWED_ORIGINS.some((origin) => /localhost|127\.0\.0\.1/.test(origin))
      ) {
        context.addIssue({
          code: "custom",
          path: ["COLLABORATION_ALLOWED_ORIGINS"],
          message: "Production collaboration origins must be explicitly configured.",
        });
      }
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
