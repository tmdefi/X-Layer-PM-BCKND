import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

export async function requireClobOperatorApiKey(request: FastifyRequest, reply: FastifyReply) {
  if (!env.CLOB_OPERATOR_API_KEY) {
    request.log.error({ route: request.routeOptions.url }, "CLOB operator API key is not configured");
    return reply.code(503).send({ error: "CLOB operator API key is not configured" });
  }

  const provided = headerValue(request.headers["x-operator-api-key"]);
  if (!provided || !constantTimeEqual(provided, env.CLOB_OPERATOR_API_KEY)) {
    request.log.warn(
      { route: request.routeOptions.url, ip: request.ip },
      "Rejected CLOB operator request"
    );
    return reply.code(401).send({ error: "Invalid operator API key" });
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
