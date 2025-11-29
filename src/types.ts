import type { z } from "zod";

/**
 * Content types that can be returned from tool execution
 */
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface EmbeddedResource {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type ToolContent = TextContent | ImageContent | EmbeddedResource;

/**
 * Result returned from tool execution
 */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Tool definition configuration
 */
export interface ToolDefinition<TParams extends z.ZodType = z.ZodType> {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Zod schema for the tool's parameters */
  parameters: TParams;
  /** Function that executes the tool */
  execute: (
    params: z.infer<TParams>,
    context: ToolExecutionContext
  ) => Promise<string | ToolContent[] | ToolResult>;
}

/**
 * Context passed to tool execution
 */
export interface ToolExecutionContext {
  /** Authentication info if auth middleware is used */
  auth?: AuthInfo;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Authentication information
 */
export interface AuthInfo {
  /** Token used for authentication */
  token: string;
  /** User-defined claims/data from token verification */
  claims?: Record<string, unknown>;
  /** Scopes granted to this token */
  scopes?: string[];
}

/**
 * MCP Server configuration
 */
export interface McpServerConfig {
  /** Name of the MCP server */
  name: string;
  /** Version of the MCP server */
  version: string;
  /** Tools to register with the server */
  tools?: ToolDefinition[];
  /** Optional instructions for the AI on how to use this server */
  instructions?: string;
}

/**
 * Options for handling MCP requests
 */
export interface McpRequestOptions {
  /** Authentication info to pass to tool execution */
  auth?: AuthInfo;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * MCP Server instance returned by createMcpServer
 */
export interface McpServerInstance {
  /** Handle an incoming MCP request */
  handleRequest: (
    request: Request,
    options?: McpRequestOptions
  ) => Promise<Response>;
  /** Add a tool to the server */
  addTool: (tool: ToolDefinition) => void;
  /** Get server info */
  getInfo: () => { name: string; version: string };
}

/**
 * Token verification function for auth middleware
 */
export type TokenVerifier = (
  request: Request
) => Promise<AuthInfo | null> | AuthInfo | null;

/**
 * Authenticated request handler
 */
export type AuthenticatedHandler = (
  request: Request,
  auth: AuthInfo
) => Promise<Response>;

/**
 * JSON-RPC types for MCP protocol
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP-specific method types
 */
export type McpMethod =
  | "initialize"
  | "initialized"
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/read"
  | "prompts/list"
  | "prompts/get"
  | "ping";
