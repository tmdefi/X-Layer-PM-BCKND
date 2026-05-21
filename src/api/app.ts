import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { createSettlementWorker } from "../settlement/index.js";
import { createDefaultSourceRegistry } from "../sources/index.js";
import { createProviderSyncWorker } from "../sync/index.js";
import { registerRoutes } from "./routes.js";
import { PrismaBackedStore, createStore } from "./store.js";

export async function buildApp() {
  const app = Fastify({
    logger: true
  });

  const store = await createStore();
  const sourceRegistry = createDefaultSourceRegistry();
  const settlementWorker = createSettlementWorker({
    store,
    sourceRegistry,
    logger: app.log
  });
  const syncWorker = createProviderSyncWorker({
    store,
    sourceRegistry,
    logger: app.log
  });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  });

  await registerRoutes(app, store, sourceRegistry, settlementWorker, syncWorker);

  if (env.SETTLEMENT_WORKER_ENABLED) {
    settlementWorker.start();
  }

  if (env.SYNC_WORKER_ENABLED) {
    syncWorker.start();
  }

  app.addHook("onClose", async () => {
    settlementWorker.stop();
    syncWorker.stop();
    if (store instanceof PrismaBackedStore) {
      await store.disconnect();
    }
  });

  return app;
}
