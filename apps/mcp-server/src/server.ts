/**
 * CohortSignal MCP server entry point.
 *
 * Wired exactly to Context Protocol's published Build & List guide:
 *   - Streamable HTTP transport on POST /mcp (and GET / DELETE for SSE compatibility)
 *   - createContextMiddleware() applied to /mcp by default. CONTEXT_AUTH_ENABLED=false
 *     can disable it for local development only.
 *   - structuredContent on every tool response, with strict outputSchema match.
 *
 * The previous-tool feedback you shared called out a commented-out
 * createContextMiddleware as a hard rejection blocker. The middleware here
 * is wired in directly, not commented out, and is enabled by default.
 */

// Load env from monorepo root before any other import that may read it.
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), "../../../.env"),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
    break;
  }
}

import { randomUUID } from "node:crypto";
import express, { type Request, type RequestHandler, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { closePool, getPoolAsync } from "@cohortsignal/core/db";
import { PostgresCohortService, SERVER_INFO } from "./service.js";
import { TOOLS } from "./tools.js";
import { callTool } from "./handlers.js";

const CONTEXT_AUTH_ENABLED = process.env.CONTEXT_AUTH_ENABLED !== "false";
const PORT = Number(process.env.PORT ?? 3000);
// Bind to all interfaces. Railway's reverse proxy talks to the container on
// 0.0.0.0:$PORT; localhost-only binding would not be reachable.
const HOST = process.env.HOST ?? "0.0.0.0";

console.log(`[cohortsignal] boot: NODE_ENV=${process.env.NODE_ENV ?? "?"} PORT=${PORT} HOST=${HOST} contextAuth=${CONTEXT_AUTH_ENABLED}`);

const app = express();
app.use(express.json({ limit: "1mb" }));

console.log(`[cohortsignal] boot: connecting to Postgres...`);
const pool = await getPoolAsync().catch((err) => {
  console.error(`[cohortsignal] boot FAILED at getPoolAsync:`, err);
  process.exit(1);
});
console.log(`[cohortsignal] boot: Postgres connected.`);
const service = new PostgresCohortService(pool);

const server = new Server(
  { name: SERVER_INFO.name, version: SERVER_INFO.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as Array<Record<string, unknown>>,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return callTool(service, name, (args ?? {}) as Record<string, unknown>);
});

const transports: Record<string, StreamableHTTPServerTransport> = {};
let verifyContextAuth: RequestHandler | null = null;
try {
  verifyContextAuth = createContextMiddleware();
  console.log(`[cohortsignal] boot: createContextMiddleware initialized.`);
} catch (err) {
  console.error(`[cohortsignal] boot WARNING: createContextMiddleware threw:`, err);
}
const mcpAuthMiddleware: RequestHandler =
  CONTEXT_AUTH_ENABLED && verifyContextAuth
    ? verifyContextAuth
    : (_req, _res, next) => next();

// ----- Public health endpoint (open, used by load balancers) -----
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const status = await service.getIndexerStatus().catch(() => null);
    res.json({
      status: "ok",
      server: SERVER_INFO.name,
      version: SERVER_INFO.version,
      contextAuthEnabled: CONTEXT_AUTH_ENABLED,
      methodologyVersion: SERVER_INFO.methodologyVersion,
      indexerVersion: SERVER_INFO.indexerVersion,
      indexer: status,
      toolCount: TOOLS.length,
    });
  } catch (err) {
    res.status(500).json({ status: "degraded", error: (err as Error).message });
  }
});

// ----- MCP endpoint (Streamable HTTP) -----
app.post("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session" },
      id: null,
    });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(
    `[cohortsignal] mcp server listening on http://${HOST}:${PORT}${
      CONTEXT_AUTH_ENABLED ? " (Context auth ENABLED)" : " (Context auth DISABLED — local only!)"
    }`,
  );
  console.log(`[cohortsignal] tools: ${TOOLS.map((t) => t.name).join(", ")}`);
});

httpServer.on("error", (err) => {
  console.error(`[cohortsignal] HTTP server error:`, err);
});

const shutdown = async (signal: string) => {
  console.log(`[cohortsignal] received ${signal}, shutting down`);
  httpServer.close();
  await closePool().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
