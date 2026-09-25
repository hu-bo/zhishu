import { config } from "dotenv";
import { resolve } from "node:path";
import { workspaceRoot } from "./paths.js";
config({ path: resolve(workspaceRoot, ".env") });
