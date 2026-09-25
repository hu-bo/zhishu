import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { projectsModule } from "./modules/projects/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";

export async function buildApp(config: AppConfig, options: { exportMode?: boolean } = {}) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.token",
      ],
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  try {
    await registerOpenApi(app, config.SWAGGER_UI_ENABLED && !options.exportMode);
    await app.register(databasePlugin, { ...config, exportMode: options.exportMode });
    await app.register(healthRoutes);
    await app.register(projectsModule, { prefix: "/api" });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
