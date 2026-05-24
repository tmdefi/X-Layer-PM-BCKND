import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { createSettlementWorker } from "../settlement/index.js";
import { createDefaultSourceRegistry } from "../sources/index.js";
import { createProviderSyncWorker } from "../sync/index.js";
import { createOperatorTransactionRecoveryWorker } from "../operator-recovery/index.js";
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
  const operatorRecoveryWorker = createOperatorTransactionRecoveryWorker({
    store,
    logger: app.log
  });

  await app.register(cors, {
    origin: true
  });

  await app.register(rateLimit, {
    global: false
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues
      });
    }

    if (isClientStatusError(error)) {
      return reply.code(error.statusCode).send({
        error: error.message
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: "Internal server error"
    });
  });

  await registerRoutes(app, store, sourceRegistry, settlementWorker, syncWorker, undefined, operatorRecoveryWorker);

  if (env.SETTLEMENT_WORKER_ENABLED) {
    settlementWorker.start();
  }

  if (env.SYNC_WORKER_ENABLED) {
    syncWorker.start();
  }

  if (env.OPERATOR_TX_RECOVERY_WORKER_ENABLED) {
    operatorRecoveryWorker.start();
  }

  app.addHook("onClose", async () => {
    settlementWorker.stop();
    syncWorker.stop();
    operatorRecoveryWorker.stop();
    if (store instanceof PrismaBackedStore) {
      await store.disconnect();
    }
  });

  return app;
}

function isClientStatusError(error: unknown): error is Error & { statusCode: number } {
  if (!(error instanceof Error)) return false;
  const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500;
}
