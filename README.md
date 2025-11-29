# mcp-start

MCP (Model Context Protocol) integration for [TanStack Start](https://tanstack.com/start). Build AI-powered tools that can be called by LLMs using the standardized MCP protocol.

## Installation

```bash
npm install mcp-start
```

or with your preferred package manager:

```bash
pnpm add mcp-start
yarn add mcp-start
```

**Peer dependencies:** This package requires `zod` (^3.0.0) to be installed in your project.

## Quick Start

Get up and running in 3 steps:

### 1. Define a Tool

Create a tool that LLMs can call:

```typescript
// src/mcp/tools/weather.ts
import { defineTool } from 'mcp-start'
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

### 2. Create the MCP Server

```typescript
// src/mcp/index.ts
import { createMcpServer } from 'mcp-start'
import { weatherTool } from './tools/weather'

export const mcp = createMcpServer({
  name: 'my-tanstack-app',
  version: '1.0.0',
  tools: [weatherTool],
})
```

### 3. Create the API Route

```typescript
// src/routes/api/mcp.ts
import { createAPIFileRoute } from '@tanstack/react-start/api'
import { mcp } from '../../mcp'

export const APIRoute = createAPIFileRoute('/api/mcp')({
  POST: async ({ request }) => {
    return mcp.handleRequest(request)
  },
  GET: async ({ request }) => {
    return mcp.handleRequest(request)
  },
})
```

Your MCP server is now live at `/api/mcp`.

## Adding Multiple Tools

```typescript
import { createMcpServer, defineTool } from 'mcp-start'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: 'Search the knowledge base',
  parameters: z.object({
    query: z.string(),
    limit: z.number().optional().default(10),
  }),
  execute: async ({ query, limit }) => {
    const results = await searchDatabase(query, limit)
    return JSON.stringify(results)
  },
})

const calculateTool = defineTool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = evaluate(expression)
    return `Result: ${result}`
  },
})

export const mcp = createMcpServer({
  name: 'my-app',
  version: '1.0.0',
  tools: [searchTool, calculateTool],
})
```

## Rich Content Responses

Return different content types from your tools:

```typescript
import { defineTool, text, image } from 'mcp-start'
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

Protect your MCP endpoint:

```typescript
// src/routes/api/mcp.ts
import { createAPIFileRoute } from '@tanstack/react-start/api'
import { withMcpAuth } from 'mcp-start'
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

export const APIRoute = createAPIFileRoute('/api/mcp')({
  POST: authenticatedHandler,
  GET: authenticatedHandler,
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

## License

MIT
