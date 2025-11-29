import type { z } from "zod";
import type { ToolDefinition, ToolContent, ToolResult } from "./types.js";

/**
 * Define a tool for use with MCP server.
 *
 * @example
 * ```typescript
 * import { defineTool } from 'mcp-start'
 * import { z } from 'zod'
 *
 * export const weatherTool = defineTool({
 *   name: 'get_weather',
 *   description: 'Get current weather for a location',
 *   parameters: z.object({
 *     city: z.string().describe('City name'),
 *     units: z.enum(['celsius', 'fahrenheit']).optional(),
 *   }),
 *   execute: async ({ city, units }) => {
 *     const weather = await fetchWeather(city)
 *     return `Temperature in ${city}: ${weather.temp}°`
 *   },
 * })
 * ```
 */
export function defineTool<TParams extends z.ZodType>(
  config: ToolDefinition<TParams>
): ToolDefinition<TParams> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
  };
}

/**
 * Normalize tool execution result to ToolResult format
 */
export function normalizeToolResult(
  result: string | ToolContent[] | ToolResult
): ToolResult {
  // String result -> wrap in text content
  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }],
    };
  }

  // Array of content -> wrap in result
  if (Array.isArray(result)) {
    return {
      content: result,
    };
  }

  // Already a ToolResult
  return result;
}

/**
 * Create an error result for tool execution failures
 */
export function createErrorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Helper to create text content
 */
export function text(content: string): ToolContent {
  return { type: "text", text: content };
}

/**
 * Helper to create image content
 */
export function image(data: string, mimeType: string): ToolContent {
  return { type: "image", data, mimeType };
}

/**
 * Helper to create embedded resource content
 */
export function resource(
  uri: string,
  options?: { mimeType?: string; text?: string; blob?: string }
): ToolContent {
  return {
    type: "resource",
    resource: {
      uri,
      ...options,
    },
  };
}
