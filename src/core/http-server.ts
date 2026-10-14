import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HttpListenConfig } from "../models/types.js";
import { Logger } from "../utils/logger.js";

const JSON_RPC_HEADERS = {
  "Content-Type": "application/json",
};

function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

/**
 * Loopback bind addresses. A dotted 127.0.0.0/8 address, localhost, and ::1 stay on this machine.
 * Names that only start with "127." are not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback(normalized);
}

function hostHeaderName(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function formatEndpoint(host: string, port: number, httpPath: string): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}${httpPath}`;
}

/**
 * Host header allow-list for a concrete bind address.
 * Wildcard binds (0.0.0.0 / ::) cannot name a single legitimate Host, so protection stays off.
 */
export function allowedHostHeaders(listenHost: string, port: number): string[] | undefined {
  if (listenHost === "0.0.0.0" || listenHost === "::") {
    return undefined;
  }

  const names = new Set<string>([hostHeaderName(listenHost)]);
  if (isLoopbackHost(listenHost)) {
    names.add("127.0.0.1");
    names.add("localhost");
    names.add("[::1]");
  }

  return [...names].flatMap((name) => {
    const withPort = `${name}:${port}`;
    return port === 80 ? [withPort, name] : [withPort];
  });
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_RPC_HEADERS,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Streamable HTTP front door. Each request gets its own MCP server and transport
 * so concurrent clients do not share JSON-RPC state. SSH sessions stay in the
 * process-wide connection manager.
 */
export class McpHttpServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private allowedHosts?: string[];
  private closed = false;

  constructor(
    private readonly config: HttpListenConfig,
    private readonly createMcpServer: () => McpServer,
  ) {}

  async listen(): Promise<string> {
    const httpServer = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = httpServer;

    httpServer.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("HTTP server did not bind a TCP port"));
          return;
        }
        this.allowedHosts = allowedHostHeaders(this.config.host, address.port);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(this.config.port, this.config.host);
    });

    httpServer.on("error", (error) => {
      Logger.log(`HTTP server error: ${error.message}`, "error");
    });

    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not bind a TCP port");
    }

    return formatEndpoint(this.config.host, address.port, this.config.path);
  }

  async close(): Promise<void> {
    const httpServer = this.server;
    if (!httpServer || this.closed) {
      return;
    }
    this.closed = true;
    if (!httpServer.listening) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
  }

  private requestPath(req: IncomingMessage): string | undefined {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      return pathname.replace(/\/+$/, "") || "/";
    } catch {
      return undefined;
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.config.token;
    if (!token) {
      return true;
    }

    const header = req.headers.authorization;
    if (typeof header !== "string") {
      return false;
    }

    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
      return false;
    }

    return safeEqual(match[1], token);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = this.requestPath(req);
      if (!pathname) {
        writeJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid request URL" },
          id: null,
        });
        return;
      }

      if (pathname !== this.config.path) {
        writeJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Not found" },
          id: null,
        });
        return;
      }

      if (!this.authorized(req)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="ssh-mcp-server"');
        writeJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return;
      }

      const mcp = this.createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(this.allowedHosts
          ? {
              enableDnsRebindingProtection: true,
              allowedHosts: this.allowedHosts,
            }
          : {}),
      });
      transport.onerror = (error) => {
        Logger.log(`MCP HTTP transport error: ${error.message}`, "error");
      };

      let settled = false;
      const closeSession = () => {
        if (settled) {
          return;
        }
        settled = true;
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      };

      // Closing the transport from res "close" aborts an in-flight JSON response
      // before the SDK can settle handleRequest, so a client disconnect hangs
      // that request forever. Clean up only after the request promise finishes.
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        closeSession();
      }
    } catch (error) {
      Logger.log(`HTTP request failed: ${(error as Error).message}`, "error");
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
}
