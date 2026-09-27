import "../environment.js";
import { startServer } from "../server.js";
import { loadConfig } from "../config.js";
import { mockUser } from "../modules/identity/mock-user.js";

const token = process.env.POST_COMMIT_CRASH_SMOKE_TOKEN;
if (!token) throw new Error("POST_COMMIT_CRASH_SMOKE_TOKEN is required.");

await startServer({
  config: loadConfig(),
  identityAuthenticator: {
    authenticate(authorization) {
      return authorization === `Bearer ${token}` ? mockUser : null;
    },
  },
});
