// Core server
export { createMcpServer } from "./server.js";

// Tool helpers
export { defineTool, text, image, resource, normalizeToolResult, createErrorResult } from "./tool.js";

// Auth middleware
export { withMcpAuth, extractBearerToken } from "./middleware.js";
export type { AuthMiddlewareOptions } from "./middleware.js";

// Types
export type {
  // Tool types
  ToolDefinition,
  AnyToolDefinition,
  ToolContent,
  TextContent,
  ImageContent,
  EmbeddedResource,
  ToolResult,
  ToolExecutionContext,
  // Server types
  McpServerConfig,
  McpServerInstance,
  McpRequestOptions,
  // Auth types
  AuthInfo,
  TokenVerifier,
  AuthenticatedHandler,
  // JSON-RPC types
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  McpMethod,
} from "./types.js";
