# mcp-tanstack-start

MCP (Model Context Protocol) integration for [TanStack Start](https://tanstack.com/start). Build AI-powered tools that can be called by LLMs using the standardized MCP protocol.

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

Get up and running in 3 steps:

### 1. Create the API Route

First, set up the MCP endpoint in your TanStack Start app:

```typescript
// src/routes/api/mcp.ts
import { createFileRoute } from '@tanstack/react-router'
import { mcp } from '../../mcp'

/**
 * MCP API Route
 *
 * This endpoint handles Model Context Protocol requests.
 * AI assistants and MCP clients can connect to this endpoint
 * to interact with your app's tools.
 *
 * Endpoints:
 * - POST /api/mcp - JSON-RPC 2.0 requests
 * - GET /api/mcp - SSE stream for server-to-client notifications
 */
export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return mcp.handleRequest(request)
      },
      GET: async ({ request }) => {
        return mcp.handleRequest(request)
      },
    },
  },
})
```

### 2. Create the MCP Server

Create an MCP server instance that will manage your tools:

```typescript
// src/mcp/index.ts
import { createMcpServer } from 'mcp-tanstack-start'
import { echoTool } from './tools/echo'

export const mcp = createMcpServer({
  name: 'my-tanstack-app',
  version: '1.0.0',
  instructions: `This is my TanStack Start app with MCP tools.
You can use the available tools to interact with the application.`,
  tools: [echoTool],
})
```

### 3. Define Your Tools

Create tools that LLMs can call:

```typescript
// src/mcp/tools/echo.ts
import { defineTool } from 'mcp-tanstack-start'
import { z } from 'zod'

export const echoTool = defineTool({
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

Your MCP server is now live at `/api/mcp`!

## Adding More Tools

Create additional tools and add them to your server:

```typescript
// src/mcp/tools/weather.ts
import { defineTool } from 'mcp-tanstack-start'
import { z } from 'zod'

export const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).optional().default('celsius'),
  }),
  execute: async ({ city, units }) => {
    // Your weather API logic here
    const temp = 72
    const unit = units === 'fahrenheit' ? 'F' : 'C'
    return `The weather in ${city} is ${temp}°${unit}`
  },
})
```

```typescript
// src/mcp/tools/search.ts
import { defineTool } from 'mcp-tanstack-start'
import { z } from 'zod'

export const searchTool = defineTool({
  name: 'search',
  description: 'Search the knowledge base',
  parameters: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10).describe('Maximum results'),
  }),
  execute: async ({ query, limit }) => {
    const results = await searchDatabase(query, limit)
    return JSON.stringify(results)
  },
})
```

Add them to your server:

```typescript
// src/mcp/index.ts
import { createMcpServer } from 'mcp-tanstack-start'
import { echoTool } from './tools/echo'
import { weatherTool } from './tools/weather'
import { searchTool } from './tools/search'

export const mcp = createMcpServer({
  name: 'my-tanstack-app',
  version: '1.0.0',
  tools: [echoTool, weatherTool, searchTool],
})
```

## Rich Content Responses

Return different content types from your tools:

```typescript
import { defineTool, text, image } from 'mcp-tanstack-start'
import { z } from 'zod'

const screenshotTool = defineTool({
  name: 'take_screenshot',
  description: 'Capture a screenshot of a URL',
  parameters: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    const imageData = await captureScreenshot(url)
    return [
      text(`Screenshot of ${url}`),
      image(imageData, 'image/png'),
    ]
  },
})
```

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
      POST: authenticatedHandler,
      GET: authenticatedHandler,
    },
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
})

// Returns
mcp.handleRequest(request: Request, options?: { auth?, signal? }): Promise<Response>
mcp.addTool(tool: ToolDefinition): void
mcp.getInfo(): { name: string; version: string }
```

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

Implements [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) in stateless mode:

- **POST /api/mcp** - Main endpoint for MCP operations
- **GET /api/mcp** - SSE stream for server-to-client notifications
- JSON-RPC 2.0 message format

Supported methods: `initialize`, `initialized`, `tools/list`, `tools/call`, `ping`

## Examples

Check out the [example blog implementation](https://github.com/codyde/codyde-start) to see mcp-tanstack-start in action with:
- Blog post listing and retrieval
- Content search
- Server info tools

## License

MIT
