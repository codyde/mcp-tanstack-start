import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCError,
  isJSONRPCNotification,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpRequestOptions, SessionStore, SessionData } from "./types.js";

/**
 * Default protocol version to assume when MCP-Protocol-Version header is missing
 * Per spec: "the server SHOULD assume protocol version 2025-03-26"
 */
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/**
 * Supported protocol versions
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

/**
 * Configuration options for WebStandardTransport
 */
export interface WebStandardTransportOptions {
  /**
   * Enable stateful session mode.
   *
   * When false (default): Stateless mode - works on serverless, edge, and distributed environments.
   * Sessions are not persisted; if a session is not found, requests are processed gracefully.
   * Server-to-client push notifications are not available in this mode.
   *
   * When true: Stateful mode - enables persistent sessions for SSE push notifications.
   * Requires either in-memory storage (single instance only) or a custom sessionStore.
   *
   * Default: false (stateless)
   */
  stateful?: boolean;

  /**
   * Custom session store for persistent sessions.
   * Only used when stateful: true.
   * If not provided, uses in-memory storage (not suitable for distributed deployments).
   */
  sessionStore?: SessionStore;

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
   * Request timeout in milliseconds.
   * Default: 30000 (30 seconds)
   */
  requestTimeout?: number;

  /**
   * Session timeout in milliseconds. Sessions inactive for this duration will be cleaned up.
   * Only applies in stateful mode.
   * Default: 3600000 (1 hour)
   */
  sessionTimeout?: number;

  /**
   * Allowed origins for Origin header validation.
   * If not provided, defaults to allowing localhost origins only.
   * Set to ["*"] to allow all origins (NOT recommended for production).
   */
  allowedOrigins?: string[];

  /**
   * Whether to enable SSE event IDs for resumability.
   * Only applies in stateful mode.
   * Default: true
   */
  enableResumability?: boolean;
}

/**
 * Represents a single SSE stream connection (stateful mode only)
 */
interface SseStream {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  active: boolean;
  lastEventId: number;
  messageHistory: Array<{ id: number; message: JSONRPCMessage }>;
}

/**
 * Pending request waiting for a response
 */
interface PendingRequest {
  requestId: string | number;
  resolve: (response: Response) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  resolved: boolean;
  sessionId: string;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  eventId: number;
}

/**
 * Full session state (stateful mode)
 */
interface FullSession extends SessionData {
  initializing: boolean;
  sseStreams: Map<string, SseStream>;
  pendingRequests: Map<string | number, PendingRequest>;
  timeoutId?: ReturnType<typeof setTimeout>;
  eventIdCounter: number;
  messageHistory: Map<string, Array<{ id: number; message: JSONRPCMessage }>>;
}

/**
 * In-memory session store implementation
 */
class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  get(id: string): SessionData | null {
    return this.sessions.get(id) ?? null;
  }

  set(id: string, session: SessionData, ttlMs: number): void {
    this.sessions.set(id, session);

    // Clear existing timeout if any
    const existingTimeout = this.timeouts.get(id);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      this.sessions.delete(id);
      this.timeouts.delete(id);
    }, ttlMs);
    this.timeouts.set(id, timeout);
  }

  delete(id: string): void {
    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }
    this.sessions.delete(id);
  }
}

/**
 * Generate a cryptographically secure session ID
 */
function generateSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Generate a unique stream ID
 */
function generateStreamId(): string {
  return `stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Web Standard Transport for MCP
 *
 * This transport implements the MCP Streamable HTTP specification (2025-06-18)
 * using Web Standard APIs (Request/Response).
 *
 * Two modes of operation:
 *
 * **Stateless Mode (Default)**:
 * - Works on serverless, edge, and distributed environments
 * - No persistent sessions - each request is handled independently
 * - If a session ID is not found, requests are processed gracefully
 * - Server-to-client push notifications are not available
 *
 * **Stateful Mode (Opt-in)**:
 * - Enables persistent sessions for SSE push notifications
 * - Supports custom session stores (Redis, DynamoDB, etc.)
 * - Falls back to in-memory storage if no store provided
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */
export class WebStandardTransport implements Transport {
  private _started = false;
  private _stateful: boolean;
  private _sessionStore: SessionStore | null;
  private _enableJsonResponse: boolean;
  private _maxBodySize: number;
  private _requestTimeout: number;
  private _sessionTimeout: number;
  private _allowedOrigins: string[];
  private _enableResumability: boolean;

  // Current request options (auth, signal, etc.)
  private _currentOptions?: McpRequestOptions;

  // Stateful mode: Full session management
  private _fullSessions = new Map<string, FullSession>();

  // Current session ID being processed (set during request handling)
  private _currentSessionId?: string;

  // Current POST response stream for interleaved messages
  private _currentPostStream?: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    eventId: number;
  };

  // Transport callbacks (set by the SDK when connecting)
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: WebStandardTransportOptions = {}) {
    this._stateful = options.stateful ?? false;
    this._enableJsonResponse = options.enableJsonResponse ?? false;
    this._maxBodySize = options.maxBodySize ?? 1048576; // 1MB default
    this._requestTimeout = options.requestTimeout ?? 30000; // 30 seconds default
    this._sessionTimeout = options.sessionTimeout ?? 3600000; // 1 hour default
    this._enableResumability = options.enableResumability ?? true;
    this._allowedOrigins = options.allowedOrigins ?? [
      "http://localhost",
      "https://localhost",
      "http://127.0.0.1",
      "https://127.0.0.1",
    ];

    // Set up session store for stateful mode
    if (this._stateful) {
      this._sessionStore = options.sessionStore ?? new InMemorySessionStore();
    } else {
      this._sessionStore = null;
    }
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
   * Close the transport and clean up all sessions.
   */
  async close(): Promise<void> {
    // Clean up stateful sessions
    for (const session of this._fullSessions.values()) {
      this.cleanupFullSession(session);
    }
    this._fullSessions.clear();
    this.onclose?.();
  }

  /**
   * Validate the Origin header to prevent DNS rebinding attacks.
   * Per spec: "Servers MUST validate the Origin header on all incoming connections"
   */
  private validateOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");

    if (!origin) {
      return true;
    }

    if (this._allowedOrigins.includes("*")) {
      return true;
    }

    for (const allowed of this._allowedOrigins) {
      if (origin === allowed || origin.startsWith(allowed + ":")) {
        return true;
      }
    }

    return false;
  }

  /**
   * Create a new session ID (for both stateless and stateful modes)
   */
  private createSessionId(): string {
    return generateSessionId();
  }

  /**
   * Create a full session for stateful mode
   */
  private createFullSession(id?: string): FullSession {
    const sessionId = id ?? this.createSessionId();
    const session: FullSession = {
      id: sessionId,
      initialized: false,
      initializing: false,
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      lastActivity: Date.now(),
      sseStreams: new Map(),
      pendingRequests: new Map(),
      eventIdCounter: 0,
      messageHistory: new Map(),
    };

    // Set up session timeout
    session.timeoutId = setTimeout(() => {
      this.terminateSession(sessionId);
    }, this._sessionTimeout);

    this._fullSessions.set(sessionId, session);

    // Also store in session store if available
    if (this._sessionStore) {
      const sessionData: SessionData = {
        id: sessionId,
        initialized: false,
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        lastActivity: Date.now(),
      };
      this._sessionStore.set(sessionId, sessionData, this._sessionTimeout);
    }

    return session;
  }

  /**
   * Get a session (stateful mode) or create a temporary one (stateless mode)
   */
  private async getOrCreateSession(
    sessionId: string | null,
    isInitialization: boolean
  ): Promise<{ session: FullSession; isNew: boolean; isRecovered: boolean }> {
    // Initialization always creates a new session
    if (isInitialization) {
      // In stateful mode, terminate existing session if any
      if (this._stateful && sessionId) {
        this.terminateSession(sessionId);
      }
      return { session: this.createFullSession(), isNew: true, isRecovered: false };
    }

    // Stateful mode: Look up existing session
    if (this._stateful) {
      if (sessionId) {
        const existing = this._fullSessions.get(sessionId);
        if (existing) {
          this.refreshSessionTimeout(existing);
          return { session: existing, isNew: false, isRecovered: false };
        }

        // Check session store if not in memory
        if (this._sessionStore) {
          const stored = await this._sessionStore.get(sessionId);
          if (stored) {
            // Recreate full session from stored data
            const session = this.createFullSession(sessionId);
            session.initialized = stored.initialized;
            session.protocolVersion = stored.protocolVersion;
            return { session, isNew: false, isRecovered: true };
          }
        }
      }

      // Session not found in stateful mode - this is an error
      throw new SessionNotFoundError("Session does not exist or has expired");
    }

    // Stateless mode: Create a temporary session for this request
    // This allows us to process the request even without persistent state
    const tempSession: FullSession = {
      id: sessionId ?? this.createSessionId(),
      initialized: true, // Assume previously initialized
      initializing: false,
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      lastActivity: Date.now(),
      sseStreams: new Map(),
      pendingRequests: new Map(),
      eventIdCounter: 0,
      messageHistory: new Map(),
    };

    return { session: tempSession, isNew: false, isRecovered: !sessionId };
  }

  /**
   * Refresh the session timeout (stateful mode)
   */
  private refreshSessionTimeout(session: FullSession): void {
    session.lastActivity = Date.now();
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(() => {
      this.terminateSession(session.id);
    }, this._sessionTimeout);

    // Update session store
    if (this._sessionStore) {
      const sessionData: SessionData = {
        id: session.id,
        initialized: session.initialized,
        protocolVersion: session.protocolVersion,
        lastActivity: session.lastActivity,
      };
      this._sessionStore.set(session.id, sessionData, this._sessionTimeout);
    }
  }

  /**
   * Terminate a session and clean up resources
   */
  terminateSession(sessionId: string): boolean {
    const session = this._fullSessions.get(sessionId);
    if (!session) {
      // Also try to delete from store
      this._sessionStore?.delete(sessionId);
      return false;
    }

    this.cleanupFullSession(session);
    this._fullSessions.delete(sessionId);
    this._sessionStore?.delete(sessionId);
    return true;
  }

  /**
   * Clean up full session resources
   */
  private cleanupFullSession(session: FullSession): void {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }

    // Close all SSE streams
    for (const stream of session.sseStreams.values()) {
      this.closeStream(stream);
    }
    session.sseStreams.clear();

    // Reject any pending requests
    for (const pending of session.pendingRequests.values()) {
      if (!pending.resolved) {
        clearTimeout(pending.timeoutId);
        pending.resolved = true;
        pending.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Session terminated" },
              id: pending.requestId,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          )
        );
      }
    }
    session.pendingRequests.clear();
    session.messageHistory.clear();
  }

  /**
   * Close an SSE stream
   */
  private closeStream(stream: SseStream): void {
    if (stream.controller && stream.active) {
      try {
        stream.controller.close();
      } catch {
        // May already be closed
      }
    }
    stream.active = false;
  }

  /**
   * Get the next event ID for a session
   */
  private getNextEventId(session: FullSession): number {
    return ++session.eventIdCounter;
  }

  /**
   * Format an SSE event with optional ID for resumability
   */
  private formatSseEvent(message: JSONRPCMessage, eventId?: number): string {
    const lines: string[] = [];
    if (eventId !== undefined && this._enableResumability && this._stateful) {
      lines.push(`id: ${eventId}`);
    }
    lines.push(`event: message`);
    lines.push(`data: ${JSON.stringify(message)}`);
    lines.push("", "");
    return lines.join("\n");
  }

  /**
   * Send a message (response or notification) back to the client.
   * Called by the MCP server when it has a response ready.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    // Handle responses/errors - find the pending request
    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      const requestId = message.id;

      // Search all sessions for this request
      for (const session of this._fullSessions.values()) {
        const pending = session.pendingRequests.get(requestId);
        if (pending && !pending.resolved) {
          pending.resolved = true;
          clearTimeout(pending.timeoutId);
          session.pendingRequests.delete(requestId);

          if (pending.streamController) {
            try {
              const eventId = this._stateful
                ? this.getNextEventId(session)
                : undefined;
              const sseEvent = this.formatSseEvent(message, eventId);
              pending.streamController.enqueue(
                new TextEncoder().encode(sseEvent)
              );
              pending.streamController.close();
            } catch {
              // Stream may have been closed
            }
          } else {
            pending.resolve(
              new Response(JSON.stringify(message), {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Mcp-Session-Id": session.id,
                },
              })
            );
          }
          return;
        }
      }
      return;
    }

    // For server-to-client requests and notifications (stateful mode only)
    if (!this._stateful) {
      // In stateless mode, try the current POST stream if available
      if (this._currentPostStream?.controller) {
        try {
          const sseEvent = this.formatSseEvent(message);
          this._currentPostStream.controller.enqueue(
            new TextEncoder().encode(sseEvent)
          );
          return;
        } catch {
          // Stream may have been closed
        }
      }
      return;
    }

    // Stateful mode: Send on POST stream or GET SSE streams
    if (this._currentPostStream?.controller) {
      try {
        const session = this._currentSessionId
          ? this._fullSessions.get(this._currentSessionId)
          : null;
        const eventId = session ? this.getNextEventId(session) : undefined;
        const sseEvent = this.formatSseEvent(message, eventId);
        this._currentPostStream.controller.enqueue(
          new TextEncoder().encode(sseEvent)
        );
        return;
      } catch {
        // Stream may have been closed, fall through to GET streams
      }
    }

    if (this._currentSessionId) {
      const session = this._fullSessions.get(this._currentSessionId);
      if (session) {
        for (const stream of session.sseStreams.values()) {
          if (stream.active && stream.controller) {
            try {
              const eventId = this.getNextEventId(session);
              const sseEvent = this.formatSseEvent(message, eventId);
              stream.controller.enqueue(new TextEncoder().encode(sseEvent));

              if (this._enableResumability) {
                stream.messageHistory.push({ id: eventId, message });
                if (stream.messageHistory.length > 100) {
                  stream.messageHistory.shift();
                }
              }
              return;
            } catch {
              stream.active = false;
            }
          }
        }
      }
    }
  }

  /**
   * Handle an incoming HTTP request.
   * This is the main entry point for the transport.
   */
  async handleRequest(
    request: Request,
    options?: McpRequestOptions
  ): Promise<Response> {
    this._currentOptions = options;

    try {
      // Validate Origin header (DNS rebinding protection)
      if (!this.validateOrigin(request)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Forbidden: Origin not allowed",
            },
            id: null,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      if (request.method === "GET") {
        return await this.handleGetRequest(request);
      }

      if (request.method === "POST") {
        return await this.handlePostRequest(request);
      }

      if (request.method === "DELETE") {
        return await this.handleDeleteRequest(request);
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed. Use GET, POST, or DELETE.",
          },
          id: null,
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            Allow: "GET, POST, DELETE",
          },
        }
      );
    } finally {
      this._currentOptions = undefined;
      this._currentSessionId = undefined;
      this._currentPostStream = undefined;
    }
  }

  /**
   * Handle DELETE requests to terminate a session
   */
  private async handleDeleteRequest(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");

    if (!sessionId) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Missing Mcp-Session-Id header",
          },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // In stateless mode, just acknowledge the delete
    if (!this._stateful) {
      return new Response(null, { status: 204 });
    }

    const terminated = this.terminateSession(sessionId);

    if (!terminated) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Found: Session does not exist",
          },
          id: null,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(null, { status: 204 });
  }

  /**
   * Handle GET requests for SSE stream (server-to-client notifications)
   */
  private async handleGetRequest(request: Request): Promise<Response> {
    const acceptHeader = request.headers.get("accept") || "";
    const sessionId = request.headers.get("mcp-session-id");
    const lastEventId = request.headers.get("last-event-id");

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

    // In stateless mode, SSE streams are not persistent
    // Return a stream that stays open but won't receive push notifications
    if (!this._stateful) {
      if (!sessionId) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: Missing Mcp-Session-Id header. Note: Server is running in stateless mode; SSE push notifications are not available.",
            },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Return an SSE stream that stays open but won't receive messages
      // This maintains protocol compatibility
      const stream = new ReadableStream<Uint8Array>({
        start: () => {
          // Stream is open but no messages will be pushed in stateless mode
        },
        cancel: () => {
          // Client disconnected
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Mcp-Session-Id": sessionId,
        },
      });
    }

    // Stateful mode: Full SSE support
    if (!sessionId) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Missing Mcp-Session-Id header",
          },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const session = this._fullSessions.get(sessionId);
    if (!session) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Found: Session does not exist or has expired",
          },
          id: null,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    this._currentSessionId = sessionId;
    this.refreshSessionTimeout(session);

    const streamId = generateStreamId();
    const sseStream: SseStream = {
      id: streamId,
      controller: null as unknown as ReadableStreamDefaultController<Uint8Array>,
      active: false,
      lastEventId: 0,
      messageHistory: [],
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sseStream.controller = controller;
        sseStream.active = true;
        session.sseStreams.set(streamId, sseStream);

        // Handle resumability - replay messages after Last-Event-ID
        if (lastEventId && this._enableResumability) {
          const lastId = parseInt(lastEventId, 10);
          if (!isNaN(lastId)) {
            for (const [, otherStream] of session.sseStreams) {
              for (const entry of otherStream.messageHistory) {
                if (entry.id > lastId) {
                  try {
                    const sseEvent = this.formatSseEvent(
                      entry.message,
                      entry.id
                    );
                    controller.enqueue(new TextEncoder().encode(sseEvent));
                  } catch {
                    // Controller may have issues
                  }
                }
              }
            }
          }
        }
      },
      cancel: () => {
        sseStream.active = false;
        session.sseStreams.delete(streamId);
      },
    });

    request.signal.addEventListener(
      "abort",
      () => {
        sseStream.active = false;
        session.sseStreams.delete(streamId);
        try {
          sseStream.controller?.close();
        } catch {
          // May already be closed
        }
      },
      { once: true }
    );

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Mcp-Session-Id": sessionId,
      },
    });
  }

  /**
   * Check if an Accept header includes a specific media type
   */
  private acceptsMediaType(acceptHeader: string, mediaType: string): boolean {
    const parts = acceptHeader
      .split(",")
      .map((p) => p.trim().split(";")[0].trim());
    return parts.some(
      (p) =>
        p === mediaType ||
        p === "*/*" ||
        p === mediaType.split("/")[0] + "/*"
    );
  }

  /**
   * Handle POST requests containing JSON-RPC messages
   */
  private async handlePostRequest(request: Request): Promise<Response> {
    // Validate Accept header
    const acceptHeader = request.headers.get("accept") || "";
    const acceptsJson = this.acceptsMediaType(acceptHeader, "application/json");
    const acceptsSse = this.acceptsMediaType(acceptHeader, "text/event-stream");

    if (!acceptsJson || !acceptsSse) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Not Acceptable: Client must accept both application/json and text/event-stream",
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
            message:
              "Unsupported Media Type: Content-Type must be application/json",
          },
          id: null,
        }),
        { status: 415, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check Content-Length
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

    // Parse request body
    let rawMessage: unknown;
    try {
      const text = await request.text();

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

    // No batch support per 2025-06-18 spec
    if (Array.isArray(rawMessage)) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message:
              "Invalid Request: Batch requests are not supported. Send a single JSON-RPC message.",
          },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate JSON-RPC message
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(rawMessage);
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

    const isInitialization =
      isJSONRPCRequest(message) && isInitializeRequest(message);
    const isResponse = isJSONRPCResponse(message) || isJSONRPCError(message);
    const isNotification = isJSONRPCNotification(message);
    const isRequest = isJSONRPCRequest(message);

    const requestSessionId = request.headers.get("mcp-session-id");

    // Get or create session
    let session: FullSession;
    let isNewSession = false;
    try {
      const result = await this.getOrCreateSession(
        requestSessionId,
        isInitialization
      );
      session = result.session;
      isNewSession = result.isNew;

      // Store session for later cleanup in stateless mode
      if (!this._stateful && !isNewSession) {
        // Temporarily add to sessions map for request handling
        this._fullSessions.set(session.id, session);
      }
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Not Found: Session does not exist or has expired",
            },
            id: null,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      throw error;
    }

    if (isInitialization) {
      session.initializing = true;
    }

    this._currentSessionId = session.id;

    // Validate protocol version for non-initialization requests
    if (!isInitialization && this._stateful) {
      const protocolVersion = request.headers.get("mcp-protocol-version");
      const effectiveVersion = protocolVersion || DEFAULT_PROTOCOL_VERSION;

      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effectiveVersion)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `Bad Request: Unsupported protocol version '${effectiveVersion}' (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
            },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      session.protocolVersion = effectiveVersion;
    }

    // Handle client responses
    if (isResponse) {
      this.onmessage?.(message);
      this.cleanupStatelessSession(session);
      return new Response(null, {
        status: 202,
        headers: { "Mcp-Session-Id": session.id },
      });
    }

    // Handle notifications
    if (isNotification && !isRequest) {
      this.onmessage?.(message);

      if (isInitialization) {
        session.initialized = true;
        session.initializing = false;
      }

      this.cleanupStatelessSession(session);
      return new Response(null, {
        status: 202,
        headers: { "Mcp-Session-Id": session.id },
      });
    }

    // Handle requests
    if (isRequest) {
      const requestId = (message as { id: string | number }).id;

      if (this._enableJsonResponse) {
        // JSON response mode
        return new Promise<Response>((resolve) => {
          const timeoutId = setTimeout(() => {
            const pending = session.pendingRequests.get(requestId);
            if (pending && !pending.resolved) {
              pending.resolved = true;
              session.pendingRequests.delete(requestId);
              this.cleanupStatelessSession(session);
              resolve(
                new Response(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32001, message: "Request timed out" },
                    id: requestId,
                  }),
                  {
                    status: 408,
                    headers: {
                      "Content-Type": "application/json",
                      "Mcp-Session-Id": session.id,
                    },
                  }
                )
              );
            }
          }, this._requestTimeout);

          const pending: PendingRequest = {
            requestId,
            resolve: (response) => {
              this.cleanupStatelessSession(session);
              resolve(response);
            },
            timeoutId,
            resolved: false,
            sessionId: session.id,
            eventId: this._stateful ? this.getNextEventId(session) : 0,
          };

          session.pendingRequests.set(requestId, pending);

          this.onmessage?.(message);

          if (isInitialization) {
            session.initialized = true;
            session.initializing = false;
          }
        });
      } else {
        // SSE response mode
        return new Promise<Response>((resolve) => {
          let streamController: ReadableStreamDefaultController<Uint8Array>;

          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              streamController = controller;

              this._currentPostStream = {
                controller,
                eventId: this._stateful ? this.getNextEventId(session) : 0,
              };

              const timeoutId = setTimeout(() => {
                const pending = session.pendingRequests.get(requestId);
                if (pending && !pending.resolved) {
                  pending.resolved = true;
                  session.pendingRequests.delete(requestId);
                  try {
                    const errorEvent = this.formatSseEvent(
                      {
                        jsonrpc: "2.0",
                        error: { code: -32001, message: "Request timed out" },
                        id: requestId,
                      } as JSONRPCMessage,
                      this._stateful ? this.getNextEventId(session) : undefined
                    );
                    controller.enqueue(new TextEncoder().encode(errorEvent));
                    controller.close();
                  } catch {
                    // May already be closed
                  }
                  this.cleanupStatelessSession(session);
                }
              }, this._requestTimeout);

              const pending: PendingRequest = {
                requestId,
                resolve: () => {},
                timeoutId,
                resolved: false,
                sessionId: session.id,
                streamController: controller,
                eventId: this._stateful ? this.getNextEventId(session) : 0,
              };

              session.pendingRequests.set(requestId, pending);

              this.onmessage?.(message);

              if (isInitialization) {
                session.initialized = true;
                session.initializing = false;
              }
            },
            cancel: () => {
              this._currentPostStream = undefined;
              const pending = session.pendingRequests.get(requestId);
              if (pending && !pending.resolved) {
                clearTimeout(pending.timeoutId);
                session.pendingRequests.delete(requestId);
              }
              this.cleanupStatelessSession(session);
            },
          });

          request.signal.addEventListener(
            "abort",
            () => {
              this._currentPostStream = undefined;
              const pending = session.pendingRequests.get(requestId);
              if (pending && !pending.resolved) {
                clearTimeout(pending.timeoutId);
                session.pendingRequests.delete(requestId);
              }
              try {
                streamController?.close();
              } catch {
                // May already be closed
              }
              this.cleanupStatelessSession(session);
            },
            { once: true }
          );

          resolve(
            new Response(stream, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Mcp-Session-Id": session.id,
              },
            })
          );
        });
      }
    }

    // Fallback
    this.cleanupStatelessSession(session);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Clean up temporary session in stateless mode
   */
  private cleanupStatelessSession(session: FullSession): void {
    if (!this._stateful) {
      this._fullSessions.delete(session.id);
    }
  }

  /**
   * Reset all sessions (for testing)
   */
  resetSession(): void {
    for (const session of this._fullSessions.values()) {
      this.cleanupFullSession(session);
    }
    this._fullSessions.clear();
  }
}

/**
 * Error thrown when a session is not found (stateful mode only)
 */
class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
