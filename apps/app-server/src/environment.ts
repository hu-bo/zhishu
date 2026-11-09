import { config } from "dotenv";
import { resolve } from "node:path";
import { serverRoot } from "./paths.js";
config({ path: resolve(serverRoot, ".env") });
