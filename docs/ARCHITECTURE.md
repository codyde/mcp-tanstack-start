# mcp-start Architecture

## Overview

**mcp-start** is a TanStack Start-native MCP (Model Context Protocol) integration that lets you expose AI-callable tools from your application using Web Standard APIs.

## File Structure

```
mcp-start/
├── src/
│   ├── index.ts          # Main exports
│   ├── server.ts         # createMcpServer() - core server factory
│   ├── web-transport.ts  # WebStandardTransport - custom MCP transport using Web APIs
│   ├── tool.ts           # defineTool() and content helpers (text, image, resource)
│   ├── types.ts          # TypeScript type definitions
│   ├── middleware.ts     # withMcpAuth() authentication middleware
│   └── utils.ts          # Zod to JSON Schema converter
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## Key Components

| File | Exports | Purpose |
|------|---------|---------|
| `server.ts` | `createMcpServer()` | Creates an MCP server instance that handles requests |
| `web-transport.ts` | `WebStandardTransport` | Custom transport using `Request`/`Response` instead of Node.js http |
| `tool.ts` | `defineTool()`, `text()`, `image()`, `resource()` | Type-safe tool definition with Zod schemas |
| `middleware.ts` | `withMcpAuth()`, `extractBearerToken()` | JWT/Bearer token authentication |
| `types.ts` | All TypeScript interfaces | `ToolDefinition`, `McpServerConfig`, `AuthInfo`, etc. |

## Request Flow

```
Request → createMcpServer().handleRequest()
              ↓
        WebStandardTransport (our custom transport)
              ↓
        McpServer (SDK's high-level server)
              ↓
        Registered tools execute
              ↓
        Response ← SSE or JSON response
```

## What Makes It Special

### 1. Web Standard APIs

Uses native `Request`/`Response` instead of Node.js `http.IncomingMessage`/`ServerResponse`. This means it works on any JavaScript runtime:

- Node.js
- Deno
- Bun
- Cloudflare Workers
- Vercel Edge Functions

### 2. Custom Transport

We built `WebStandardTransport` that implements the SDK's `Transport` interface directly. This avoids the need for fake request/response adapters that other implementations use.

The transport handles:
- **POST requests**: JSON-RPC message parsing, validation, and routing
- **GET requests**: SSE streams for server-to-client notifications
- **Response management**: Tracks pending requests and resolves them when responses are ready

### 3. Zod-First Design

Tools are defined with Zod schemas for type-safe parameters:

```typescript
const myTool = defineTool({
  name: "my_tool",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(10),
  }),
  execute: async ({ query, limit }) => {
    // Fully typed parameters
  },
});
```

The Zod schema is automatically converted to JSON Schema for the MCP protocol.

### 4. TanStack Start Native

Designed specifically for TanStack Start's API routes (`createFileRoute` with `server.handlers`), not server functions. This is intentional because:

- MCP requires external HTTP access (AI clients connect over the network)
- Server functions use internal routing and auto-serialization
- API routes provide standard HTTP request/response control

### 5. Stateless Mode

No session management, making it perfect for:
- Serverless deployments
- Horizontal scaling
- Simple deployment models

## Core Components Deep Dive

### WebStandardTransport

The heart of mcp-start. Implements the `Transport` interface from `@modelcontextprotocol/sdk`:

```typescript
interface Transport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}
```

Key methods:
- `handleRequest(request: Request): Promise<Response>` - Main entry point
- `handlePostRequest()` - Parses JSON-RPC, validates headers, dispatches to SDK
- `handleGetRequest()` - Creates SSE stream for notifications
- `send()` - Called by SDK when it has a response ready

### createMcpServer

Factory function that:
1. Creates an `McpServer` instance from the SDK
2. Registers all tools with the server
3. Creates a `WebStandardTransport`
4. Returns a handler that connects them

```typescript
export function createMcpServer(config: McpServerConfig): McpServerInstance {
  const server = new McpServer({ name, version }, { capabilities, instructions });

  for (const tool of tools) {
    registerTool(server, tool);
  }

  const transport = new WebStandardTransport();

  return {
    handleRequest: async (request) => {
      await server.connect(transport);
      return transport.handleRequest(request);
    },
    addTool: (tool) => registerTool(server, tool),
    getInfo: () => ({ name, version }),
  };
}
```

### Tool Registration

Tools use the SDK's `.tool()` method with a raw Zod shape (not `z.object()`):

```typescript
function registerTool(server: McpServer, tool: ToolDefinition): void {
  const shape = extractZodShape(tool.parameters); // { message: z.string() }

  server.tool(
    tool.name,
    tool.description,
    shape,
    async (params, extra) => {
      const result = await tool.execute(params, { auth: extra.authInfo });
      return normalizeToCallToolResult(result);
    }
  );
}
```

## Usage Example

```typescript
// Define a tool
const echoTool = defineTool({
  name: "echo",
  description: "Echo back a message",
  parameters: z.object({
    message: z.string().describe("The message to echo"),
  }),
  execute: async ({ message }) => `Echo: ${message}`,
});

// Create server
const mcp = createMcpServer({
  name: "my-app",
  version: "1.0.0",
  tools: [echoTool],
});

// TanStack Start route
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => mcp.handleRequest(request),
      GET: ({ request }) => mcp.handleRequest(request),
    },
  },
});
```

## Dependencies

| Package | Type | Purpose |
|---------|------|---------|
| `@modelcontextprotocol/sdk` | dependency | McpServer class, JSON-RPC types, protocol constants |
| `zod` | peer dependency | Parameter validation and type inference |

## Protocol Details

mcp-start implements the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):

- **POST /api/mcp**: JSON-RPC 2.0 requests (initialize, tools/list, tools/call, etc.)
- **GET /api/mcp**: SSE stream for server-to-client notifications
- **Stateless mode**: No session ID management
- **SSE responses**: Tool call responses are sent as Server-Sent Events

## Lines of Code

| File | Lines | Description |
|------|-------|-------------|
| `web-transport.ts` | ~340 | Custom Web Standard transport |
| `server.ts` | ~224 | Server factory and tool registration |
| `types.ts` | ~166 | Type definitions |
| `middleware.ts` | ~161 | Auth middleware |
| `tool.ts` | ~100 | Tool helpers |
| `utils.ts` | ~160 | Zod to JSON Schema |
| **Total** | **~1,150** | Clean, maintainable code |

## Design Decisions

### Why not use the SDK's StreamableHTTPServerTransport?

The SDK's transport expects Node.js `http.IncomingMessage` and `http.ServerResponse`. Modern frameworks like TanStack Start use Web Standard `Request`/`Response`.

Options were:
1. **Adapter layer** (rejected) - Create fake IncomingMessage/ServerResponse objects. Janky, fragile, hard to maintain.
2. **Custom transport** (chosen) - Implement the Transport interface directly with Web APIs. Clean, portable, maintainable.

### Why Zod instead of JSON Schema directly?

- Type inference for tool parameters
- Better developer experience with `.describe()` for documentation
- Runtime validation before tool execution
- Ecosystem compatibility (most TypeScript projects already use Zod)

### Why stateless mode only?

- Simpler deployment model
- Works with serverless
- No Redis/database needed for session storage
- Sufficient for most use cases

Session support could be added later if needed.
