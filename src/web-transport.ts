import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCError,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpRequestOptions } from "./types.js";

/**
 * Configuration options for WebStandardTransport
 */
export interface WebStandardTransportOptions {
  /**
   * Whether to enable JSON responses instead of SSE for POST requests.
   * Default: false (uses SSE)
   */
  enableJsonResponse?: boolean;

  /**
   * Maximum request body size in bytes.
   * Default: 1MB (1048576 bytes)
   */
  maxBodySize?: number;

  /**
   * Maximum number of messages allowed in a batch request.
   * Default: 100
   */
  maxBatchSize?: number;

  /**
   * Request timeout in milliseconds.
   * Default: 30000 (30 seconds)
   */
  requestTimeout?: number;
}

/**
 * Tracks a batch of requests waiting for responses
 */
interface PendingBatch {
  requestIds: Set<string | number>;
  resolve: (response: Response) => void;
  responses: Map<string | number, JSONRPCMessage>;
  expectedCount: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

/**
 * Web Standard Transport for MCP
 *
 * This transport implements the MCP Streamable HTTP specification using
 * Web Standard APIs (Request/Response) instead of Node.js http module.
 *
 * Designed for modern JavaScript runtimes and frameworks like:
 * - TanStack Start
 * - Remix
 * - Next.js (App Router)
 * - Cloudflare Workers
 * - Deno
 * - Bun
 */
export class WebStandardTransport implements Transport {
  private _started = false;
  private _initializing = false;
  private _initialized = false;
  private _enableJsonResponse: boolean;
  private _maxBodySize: number;
  private _maxBatchSize: number;
  private _requestTimeout: number;

  // Current request options (auth, signal, etc.)
  private _currentOptions?: McpRequestOptions;

  // Pending batches waiting for responses
  private _pendingBatches = new Map<string, PendingBatch>();

  // Map request IDs to their batch ID for fast lookup
  private _requestToBatch = new Map<string | number, string>();

  // SSE stream for server-to-client notifications (GET endpoint)
  private _sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private _sseStreamActive = false;

  // Transport callbacks (set by the SDK when connecting)
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: WebStandardTransportOptions = {}) {
    this._enableJsonResponse = options.enableJsonResponse ?? false;
    this._maxBodySize = options.maxBodySize ?? 1048576; // 1MB default
    this._maxBatchSize = options.maxBatchSize ?? 100;
    this._requestTimeout = options.requestTimeout ?? 30000; // 30 seconds default
  }

  /**
   * Get the current request options (auth info, signal, etc.)
   */
  getCurrentOptions(): McpRequestOptions | undefined {
    return this._currentOptions;
  }

  /**
   * Start the transport. Required by Transport interface.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  /**
   * Close the transport and clean up resources.
   */
  async close(): Promise<void> {
    // Close SSE stream if active
    this.cleanupSseStream();

    // Reject any pending batches
    for (const batch of this._pendingBatches.values()) {
      if (!batch.resolved) {
        clearTimeout(batch.timeoutId);
        batch.resolved = true;
        batch.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Transport closed" },
              id: null,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      // Clean up request-to-batch mappings
      for (const reqId of batch.requestIds) {
        this._requestToBatch.delete(reqId);
      }
    }
    this._pendingBatches.clear();

    this.onclose?.();
  }

  /**
   * Clean up SSE stream resources
   */
  private cleanupSseStream(): void {
    if (this._sseController) {
      try {
        this._sseController.close();
      } catch {
        // May already be closed
      }
      this._sseController = null;
    }
    this._sseStreamActive = false;
  }

  /**
   * Send a message (response or notification) back to the client.
   * Called by the MCP server when it has a response ready.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    // If it's a response/error, find the pending batch and add the response
    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      const requestId = message.id;
      const batchId = this._requestToBatch.get(requestId);

      if (batchId) {
        const batch = this._pendingBatches.get(batchId);

        if (batch && !batch.resolved) {
          batch.responses.set(requestId, message);

          // Check if we have all expected responses
          if (batch.responses.size >= batch.expectedCount) {
            this.resolveBatch(batchId, batch);
          }
        }
      }
      return;
    }

    // For notifications/requests from server, send on SSE stream if available
    if (this._sseController && this._sseStreamActive) {
      try {
        const sseEvent = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
        this._sseController.enqueue(new TextEncoder().encode(sseEvent));
      } catch {
        // Stream may have been closed
      }
    }
  }

  /**
   * Resolve a pending batch with all its responses
   */
  private resolveBatch(batchId: string, batch: PendingBatch): void {
    if (batch.resolved) return;

    batch.resolved = true;
    clearTimeout(batch.timeoutId);

    // Clean up mappings
    for (const reqId of batch.requestIds) {
      this._requestToBatch.delete(reqId);
    }
    this._pendingBatches.delete(batchId);

    // Build response array in original request order
    const responses: JSONRPCMessage[] = [];
    for (const reqId of batch.requestIds) {
      const response = batch.responses.get(reqId);
      if (response) {
        responses.push(response);
      }
    }

    if (this._enableJsonResponse) {
      // Return as JSON
      const body =
        responses.length === 1
          ? JSON.stringify(responses[0])
          : JSON.stringify(responses);

      batch.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    } else {
      // Return as SSE
      const sseData = responses
        .map((r) => `event: message\ndata: ${JSON.stringify(r)}\n\n`)
        .join("");

      batch.resolve(
        new Response(sseData, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      );
    }
  }

  /**
   * Handle an incoming HTTP request.
   * This is the main entry point for the transport.
   */
  async handleRequest(request: Request, options?: McpRequestOptions): Promise<Response> {
    // Store options for access during tool execution
    this._currentOptions = options;

    try {
      if (request.method === "GET") {
        return await this.handleGetRequest(request);
      }

      if (request.method === "POST") {
        return await this.handlePostRequest(request);
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. Use GET or POST." },
          id: null,
        }),
        {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "GET, POST" },
        }
      );
    } finally {
      // Clear options after request is handled
      this._currentOptions = undefined;
    }
  }

  /**
   * Handle GET requests for SSE stream (server-to-client notifications)
   */
  private async handleGetRequest(request: Request): Promise<Response> {
    const acceptHeader = request.headers.get("accept") || "";

    // Must accept text/event-stream
    if (!this.acceptsMediaType(acceptHeader, "text/event-stream")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept text/event-stream",
          },
          id: null,
        }),
        { status: 406, headers: { "Content-Type": "application/json" } }
      );
    }

    // Only one SSE stream allowed at a time
    if (this._sseStreamActive) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Conflict: Only one SSE stream is allowed per session",
          },
          id: null,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create SSE stream
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this._sseController = controller;
        this._sseStreamActive = true;
      },
      cancel: () => {
        this.cleanupSseStream();
      },
    });

    // Handle client disconnect via abort signal (using once: true for auto-cleanup)
    request.signal.addEventListener(
      "abort",
      () => {
        this.cleanupSseStream();
      },
      { once: true }
    );

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Check if an Accept header includes a specific media type
   */
  private acceptsMediaType(acceptHeader: string, mediaType: string): boolean {
    // Parse Accept header properly
    const parts = acceptHeader.split(",").map((p) => p.trim().split(";")[0].trim());
    return parts.some(
      (p) => p === mediaType || p === "*/*" || p === mediaType.split("/")[0] + "/*"
    );
  }

  /**
   * Handle POST requests containing JSON-RPC messages
   */
  private async handlePostRequest(request: Request): Promise<Response> {
    // Validate Accept header - must accept at least one of JSON or SSE
    const acceptHeader = request.headers.get("accept") || "";
    const acceptsJson = this.acceptsMediaType(acceptHeader, "application/json");
    const acceptsSse = this.acceptsMediaType(acceptHeader, "text/event-stream");

    if (!acceptsJson && !acceptsSse) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Not Acceptable: Client must accept application/json or text/event-stream",
          },
          id: null,
        }),
        { status: 406, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unsupported Media Type: Content-Type must be application/json",
          },
          id: null,
        }),
        { status: 415, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check Content-Length if available
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > this._maxBodySize) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Payload Too Large: Maximum body size is ${this._maxBodySize} bytes`,
          },
          id: null,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse the request body
    let rawMessage: unknown;
    try {
      const text = await request.text();

      // Check actual body size
      if (text.length > this._maxBodySize) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Payload Too Large: Maximum body size is ${this._maxBodySize} bytes`,
            },
            id: null,
          }),
          { status: 413, headers: { "Content-Type": "application/json" } }
        );
      }

      rawMessage = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check batch size limit
    if (Array.isArray(rawMessage) && rawMessage.length > this._maxBatchSize) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Batch Too Large: Maximum ${this._maxBatchSize} messages per batch`,
          },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse and validate JSON-RPC messages
    let messages: JSONRPCMessage[];
    try {
      if (Array.isArray(rawMessage)) {
        messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg));
      } else {
        messages = [JSONRPCMessageSchema.parse(rawMessage)];
      }
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Invalid Request: Not a valid JSON-RPC message",
          },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check for initialization request
    const isInitializationRequest = messages.some(isInitializeRequest);

    if (isInitializationRequest) {
      // Only allow single initialization request
      if (messages.length > 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: Only one initialization request is allowed",
            },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Prevent re-initialization with atomic check
      if (this._initialized || this._initializing) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: Server already initialized",
            },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      this._initializing = true;
    } else {
      // Validate protocol version for non-initialization requests
      const protocolVersion = request.headers.get("mcp-protocol-version");
      if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Bad Request: Unsupported protocol version (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
            },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Check if the batch contains requests (not just notifications)
    const requests = messages.filter(isJSONRPCRequest);
    const hasRequests = requests.length > 0;

    if (!hasRequests) {
      // Only notifications - process and return 202 Accepted
      for (const message of messages) {
        this.onmessage?.(message);
      }

      // Mark as initialized if this was an initialization
      if (isInitializationRequest) {
        this._initialized = true;
        this._initializing = false;
      }

      return new Response(null, { status: 202 });
    }

    // Create a promise that will resolve when we have all responses
    return new Promise<Response>((resolve) => {
      // Generate unique batch ID
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        const batch = this._pendingBatches.get(batchId);
        if (batch && !batch.resolved) {
          batch.resolved = true;

          // Clean up mappings
          for (const reqId of batch.requestIds) {
            this._requestToBatch.delete(reqId);
          }
          this._pendingBatches.delete(batchId);

          // Build timeout response including any responses we did receive
          const responses: JSONRPCMessage[] = [];
          for (const reqId of batch.requestIds) {
            const existingResponse = batch.responses.get(reqId);
            if (existingResponse) {
              responses.push(existingResponse);
            } else {
              // Create timeout error for missing responses
              responses.push({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Request timed out" },
                id: reqId,
              } as JSONRPCMessage);
            }
          }

          const body =
            responses.length === 1
              ? JSON.stringify(responses[0])
              : JSON.stringify(responses);

          resolve(
            new Response(body, {
              status: 408,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
      }, this._requestTimeout);

      // Track the batch
      const requestIds = new Set(requests.map((r) => r.id));
      const batch: PendingBatch = {
        requestIds,
        resolve,
        responses: new Map(),
        expectedCount: requests.length,
        timeoutId,
        resolved: false,
      };

      this._pendingBatches.set(batchId, batch);

      // Map each request ID to this batch
      for (const reqId of requestIds) {
        this._requestToBatch.set(reqId, batchId);
      }

      // Dispatch messages to the MCP server
      for (const message of messages) {
        this.onmessage?.(message);
      }

      // Mark as initialized after dispatching if this was initialization
      if (isInitializationRequest) {
        this._initialized = true;
        this._initializing = false;
      }
    });
  }
}
