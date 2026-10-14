import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { Logger } from "../utils/logger.js";
import { registerAllTools } from "../tools/index.js";
import { SERVER_CONFIG } from "../config/server.js";
import { isLoopbackHost, McpHttpServer } from "./http-server.js";
import type { ParsedArgs } from "../models/types.js";

/**
 * MCP Server class
 */
export class SshMcpServer {
  private server?: McpServer;
  private httpServer?: McpHttpServer;
  private sshManager: SSHConnectionManager;
  private shutdownHandlersRegistered = false;
  private shutdownPromise?: Promise<void>;

  constructor() {
    this.sshManager = SSHConnectionManager.getInstance();
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(SERVER_CONFIG);
    registerAllTools(server);
    return server;
  }

  private async shutdown(reason: string, exitCode?: number): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        Logger.log(`Received ${reason}, shutting down SSH MCP server...`, "info");

        try {
          await this.httpServer?.close();
        } catch (error) {
          Logger.log(
            `Failed to close HTTP server cleanly: ${(error as Error).message}`,
            "error",
          );
        }

        this.sshManager.disconnect();

        if (!this.server) {
          return;
        }

        try {
          await this.server.close();
        } catch (error) {
          Logger.log(
            `Failed to close MCP server cleanly: ${(error as Error).message}`,
            "error",
          );
        }
      })();
    }

    await this.shutdownPromise;

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  }

  private registerShutdownHandlers(transport: ParsedArgs["mcpTransport"]): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }

    const handleSignal = (signal: NodeJS.Signals) => {
      void this.shutdown(signal, 0);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    // stdio clients own the process lifetime through stdin. An HTTP server must
    // keep running after the launching shell closes its end of the pipe.
    if (transport === "stdio") {
      process.stdin.resume();
      process.stdin.once("end", () => void this.shutdown("stdin end", 0));
      process.stdin.once("close", () => void this.shutdown("stdin close", 0));
    }

    this.shutdownHandlersRegistered = true;
  }

  private logSecurityWarnings(parsedArgs: ParsedArgs): void {
    const allConfigs = Object.values(parsedArgs.configs);
    if (
      allConfigs.some(
        (c) => !c.commandWhitelist || c.commandWhitelist.length === 0
      )
    ) {
      Logger.log(
        "WARNING: Running without a command whitelist is strongly discouraged. Please configure a whitelist to restrict the commands that can be executed.",
        "info"
      );
    }
    if (
      allConfigs.some(
        (c) =>
          (c.transportMode || "exec") === "exec" &&
          (!c.allowedRemotePaths || c.allowedRemotePaths.length === 0)
      )
    ) {
      Logger.log(
        "WARNING: Running without allowedRemotePaths is strongly discouraged. SFTP upload/download can read or write any path on the remote server. Configure allowedRemotePaths to restrict the SFTP surface.",
        "info"
      );
    }

    if (parsedArgs.mcpTransport !== "http") {
      return;
    }

    if (!isLoopbackHost(parsedArgs.http.host)) {
      const exposure = parsedArgs.http.token
        ? "Requests without the bearer token are rejected."
        : "Any client that can reach this port can execute remote SSH commands.";
      Logger.log(
        `WARNING: HTTP transport is listening on ${parsedArgs.http.host}, which is not a loopback address. ${exposure}`,
        "info",
      );
    }
    if (!parsedArgs.http.token) {
      Logger.log(
        "WARNING: HTTP transport has no bearer token. Set --http-token or SSH_MCP_HTTP_TOKEN so other local processes cannot call the endpoint anonymously.",
        "info",
      );
    }
  }

  /**
   * Run the server
   */
  public async run(): Promise<void> {
    const parsedArgs = CommandLineParser.parseArgs();
    this.sshManager.setConfig(parsedArgs.configs);
    this.registerShutdownHandlers(parsedArgs.mcpTransport);

    if (parsedArgs.mcpTransport === "http") {
      this.httpServer = new McpHttpServer(parsedArgs.http, () => this.createMcpServer());
      const endpoint = await this.httpServer.listen();
      Logger.log(`MCP HTTP server listening on ${endpoint}`);
    } else {
      this.server = this.createMcpServer();
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      Logger.log("MCP server connection established");
    }

    this.logSecurityWarnings(parsedArgs);

    // Pre-connect to all servers if flag is set
    if (parsedArgs.preConnect) {
      Logger.log("Pre-connecting to all configured SSH servers...", "info");
      void this.sshManager
        .connectAll()
        .then(() => {
          Logger.log("Successfully pre-connected to all SSH servers", "info");
        })
        .catch((error) => {
          Logger.log(
            `Warning: Some SSH connections failed during pre-connect: ${(error as Error).message}`,
            "error"
          );
        });
    }
  }
}
