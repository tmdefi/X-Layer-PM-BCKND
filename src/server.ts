import "dotenv/config";
import { buildApp } from "./api/app.js";
import { env } from "./config/env.js";

const app = await buildApp();

await app.listen({ port: env.PORT, host: env.HOST });
