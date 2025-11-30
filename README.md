# mcp-tanstack-start

MCP (Model Context Protocol) integration for [TanStack Start](https://tanstack.com/start). Build AI-powered tools that can be called by LLMs using the standardized MCP protocol.

Implements the [MCP 2025-06-18 Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

## Installation

```bash
npm install mcp-tanstack-start @modelcontextprotocol/sdk zod
```

or with your preferred package manager:

```bash
pnpm add mcp-tanstack-start @modelcontextprotocol/sdk zod
yarn add mcp-tanstack-start @modelcontextprotocol/sdk zod
```

## Quick Start

Get up and running with a single file. Here's a complete MCP server with tools in one API route:

```typescript
// src/routes/api/mcp.ts
import { createFileRoute } from '@tanstack/react-router'
import { createMcpServer, defineTool } from 'mcp-tanstack-start'
import { z } from 'zod'

// Define a tool
const echoTool = defineTool({
  name: 'echo',
  description: 'Echo back a message',
  parameters: z.object({
    message: z.string().describe('The message to echo back'),
  }),
  execute: async ({ message }) => {
    return `You said: ${message}`
  },
})

// Create the MCP server
const mcp = createMcpServer({
  name: 'my-tanstack-app',
  version: '1.0.0',
  instructions: `This is my TanStack Start app with MCP tools.
You can use the available tools to interact with the application.`,
  tools: [echoTool],
})

// Wire up all HTTP methods with a single handler
export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      all: async ({ request }) => mcp.handleRequest(request),
    } as Record<string, (ctx: { request: Request }) => Promise<Response>>,
  },
})
```

That's it! Your MCP server is now live at `/api/mcp`.

> **Note:** We use lowercase `all` due to a case-sensitivity quirk in TanStack Start's handler lookup. The type assertion works around a mismatch between TypeScript types (which expect uppercase) and runtime behavior (which expects lowercase).

## Breaking It Down

### Setting Up the API Route

The API route is where your MCP server lives. It handles:
- **POST** - JSON-RPC requests (initialize, tools/list, tools/call, etc.)
- **GET** - SSE streams for server-to-client notifications
- **DELETE** - Session termination

The simplest approach uses a single `all` handler:

```typescript
// src/routes/api/mcp.ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      all: async ({ request }) => mcp.handleRequest(request),
    } as Record<string, (ctx: { request: Request }) => Promise<Response>>,
  },
})
```

If you prefer to be explicit about which methods your API supports, you can define each handler separately:

```typescript
// src/routes/api/mcp.ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => mcp.handleRequest(request),
      POST: async ({ request }) => mcp.handleRequest(request),
      DELETE: async ({ request }) => mcp.handleRequest(request),
    },
  },
})
```

Both approaches work identically - choose whichever style you prefer.

### Creating the MCP Server

The MCP server manages your tools and handles the protocol communication:

```typescript
const mcp = createMcpServer({
  name: 'my-tanstack-app',      // Server name
  version: '1.0.0',              // Server version
  instructions: `Optional instructions for AI assistants about how to use your tools.`,
  tools: [echoTool],             // Array of tools
})
```

### Defining Tools

Tools are the functions that LLMs can call. Each tool has a name, description, parameters (defined with Zod), and an execute function:

```typescript
import { defineTool } from 'mcp-tanstack-start'
import { z } from 'zod'

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo back a message',
  parameters: z.object({
    message: z.string().describe('The message to echo back'),
  }),
  execute: async ({ message }) => {
    return `You said: ${message}`
  },
})
```

The `parameters` object uses Zod schemas for type-safe validation. The `execute` function receives the validated parameters and returns a string response.

## Security

### Origin Validation

By default, the server only accepts requests from localhost origins to prevent [DNS rebinding attacks](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning). Configure allowed origins for production:

```typescript
const mcp = createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: [...],
  transport: {
    allowedOrigins: [
      'https://my-app.com',
      'https://api.my-app.com',
    ],
  },
})
```

> ⚠️ **Warning**: Setting `allowedOrigins: ["*"]` disables Origin validation entirely. This is NOT recommended for production deployments.

## Authentication

Protect your MCP endpoint with authentication:

```typescript
// src/routes/api/mcp.ts
import { createFileRoute } from '@tanstack/react-router'
import { withMcpAuth } from 'mcp-tanstack-start'
import { mcp } from '../../mcp'
import { verifyJWT } from '../../lib/auth'

const authenticatedHandler = withMcpAuth(
  async (request, auth) => {
    return mcp.handleRequest(request, { auth })
  },
  async (request) => {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '')
    if (!token) return null
    try {
      const claims = await verifyJWT(token)
      return { token, claims }
    } catch {
      return null
    }
  }
)

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      all: async ({ request }) => authenticatedHandler(request),
    } as Record<string, (ctx: { request: Request }) => Promise<Response>>,
  },
})
```

Access auth in tools:

```typescript
const userDataTool = defineTool({
  name: 'get_user_data',
  description: 'Get data for the authenticated user',
  parameters: z.object({}),
  execute: async (params, context) => {
    const userId = context.auth?.claims?.sub
    if (!userId) {
      return { content: [{ type: 'text', text: 'Not authenticated' }], isError: true }
    }
    const userData = await fetchUserData(userId)
    return JSON.stringify(userData)
  },
})
```

## API Reference

### `createMcpServer(config)`

Creates an MCP server instance.

```typescript
const mcp = createMcpServer({
  name: string,           // Server name
  version: string,        // Server version
  tools?: ToolDefinition[], // Array of tools
  instructions?: string,  // Optional instructions for AI
  transport?: {           // Transport configuration
    stateful?: boolean,            // Enable stateful sessions (default: false)
    sessionStore?: SessionStore,   // Custom session store (for stateful mode)
    allowedOrigins?: string[],     // Allowed origins for CORS/DNS rebinding protection
    sessionTimeout?: number,       // Session timeout in ms (default: 1 hour)
    requestTimeout?: number,       // Request timeout in ms (default: 30 seconds)
    maxBodySize?: number,          // Max request body size (default: 1MB)
    enableJsonResponse?: boolean,  // Use JSON instead of SSE for responses
    enableResumability?: boolean,  // Enable SSE event IDs for resumability
  }
})

// Returns
mcp.handleRequest(request: Request, options?: { auth?, signal? }): Promise<Response>
mcp.addTool(tool: ToolDefinition): void
mcp.getInfo(): { name: string; version: string }
```

#### Transport Modes

**Stateless Mode (Default)** - Works everywhere: serverless, edge, containers, and distributed environments. If a session is not found, requests are processed gracefully without errors. Ideal for Vercel, Netlify, Railway, Cloudflare Workers, etc.

**Stateful Mode** - Enables persistent sessions for SSE push notifications. Requires either in-memory storage (single instance only) or a custom session store for distributed deployments.

```typescript
// Stateless (default) - works on serverless/edge/distributed
const mcp = createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: [...],
});

// Stateful with in-memory sessions (single instance only)
const mcp = createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: [...],
  transport: {
    stateful: true,
    sessionTimeout: 3600000, // 1 hour
  }
});

// Stateful with custom session store (distributed deployments)
const mcp = createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: [...],
  transport: {
    stateful: true,
    sessionStore: myRedisSessionStore,
  }
});
```

#### Custom Session Store

Implement the `SessionStore` interface to persist sessions in Redis, DynamoDB, or any other storage:

```typescript
import type { SessionStore, SessionData } from 'mcp-tanstack-start';

const redisSessionStore: SessionStore = {
  async get(id: string): Promise<SessionData | null> {
    const data = await redis.get(`mcp:session:${id}`);
    return data ? JSON.parse(data) : null;
  },
  async set(id: string, session: SessionData, ttlMs: number): Promise<void> {
    await redis.set(`mcp:session:${id}`, JSON.stringify(session), 'PX', ttlMs);
  },
  async delete(id: string): Promise<void> {
    await redis.del(`mcp:session:${id}`);
  },
};
```

#### Transport Options

| Option | Default | Description |
|--------|---------|-------------|
| `stateful` | `false` | Enable stateful session mode. When false, runs in stateless mode suitable for serverless/edge/distributed. |
| `sessionStore` | In-memory | Custom session store (only used when `stateful: true`). |
| `allowedOrigins` | `["http://localhost", ...]` | Origins allowed for CORS. Set to `["*"]` to allow all (not recommended for production). |
| `sessionTimeout` | `3600000` (1 hour) | How long before inactive sessions are cleaned up (stateful mode only). |
| `requestTimeout` | `30000` (30 sec) | Timeout for individual requests. |
| `maxBodySize` | `1048576` (1MB) | Maximum request body size in bytes. |
| `enableJsonResponse` | `false` | Return JSON instead of SSE for POST responses. |
| `enableResumability` | `true` | Include SSE event IDs for client reconnection support (stateful mode only). |

### `defineTool(config)`

Defines a tool with type-safe parameters.

```typescript
defineTool({
  name: string,
  description: string,
  parameters: ZodSchema,
  execute: (params, context) => Promise<string | Content[] | ToolResult>
})
```

### `withMcpAuth(handler, verifyToken, options?)`

Wraps a handler with authentication.

```typescript
withMcpAuth(handler, verifyToken, {
  realm?: string,              // WWW-Authenticate realm
  requiredScopes?: string[],   // Required scopes
  allowUnauthenticated?: boolean,
})
```

### Content Helpers

- `text(content: string)` - Create text content
- `image(data: string, mimeType: string)` - Create image content (base64)
- `resource(uri: string, options?)` - Create embedded resource

## Protocol

Implements the [MCP 2025-06-18 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):

### Endpoints

| Method | Purpose |
|--------|---------|
| **POST** | JSON-RPC requests (single message per request, no batches) |
| **GET** | SSE stream for server-to-client notifications (stateful mode only) |
| **DELETE** | Session termination |

### Features

- **Stateless by Default** - Works on serverless, edge, and distributed environments out of the box
- **Optional Stateful Mode** - Enable persistent sessions for SSE push notifications
- **Pluggable Session Store** - Bring your own Redis, DynamoDB, or other storage for distributed deployments
- **Graceful Session Recovery** - In stateless mode, missing sessions are handled gracefully without errors
- **Origin Validation** - DNS rebinding attack protection
- **SSE Resumability** - Event IDs with `Last-Event-ID` header support (stateful mode)
- **Protocol Versioning** - `MCP-Protocol-Version` header with fallback to `2025-03-26`

### Supported Methods

`initialize`, `initialized`, `tools/list`, `tools/call`, `ping`

### Required Headers

Clients must include:
- `Accept: application/json, text/event-stream` (both required)
- `Content-Type: application/json`
- `Mcp-Session-Id: <session-id>` (after initialization)
- `MCP-Protocol-Version: <version>` (recommended)

## Examples

Check out the [example blog implementation](https://github.com/codyde/codyde-start) to see mcp-tanstack-start in action with:
- Blog post listing and retrieval
- Content search
- Server info tools

## License

MIT
