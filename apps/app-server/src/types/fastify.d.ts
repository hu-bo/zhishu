import type { Database } from "../../database/index.js";
import type { Pool } from "pg";
import type { Principal } from "../modules/identity/identity.types.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    dbPool: Pool;
  }

  interface FastifyRequest {
    principal: Principal | null;
  }

  interface FastifyContextConfig {
    auth?: false;
  }
}
