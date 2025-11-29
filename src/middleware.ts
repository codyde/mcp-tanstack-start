import type { AuthInfo, TokenVerifier } from "./types.js";

/**
 * Options for auth middleware
 */
export interface AuthMiddlewareOptions {
  /** Custom realm for WWW-Authenticate header */
  realm?: string;
  /** Required scopes for access */
  requiredScopes?: string[];
  /** Whether to allow unauthenticated requests (auth will be undefined) */
  allowUnauthenticated?: boolean;
}

/**
 * Wrap an MCP handler with authentication middleware.
 *
 * @example
 * ```typescript
 * import { withMcpAuth } from 'mcp-start'
 * import { mcp } from './mcp'
 *
 * const handler = withMcpAuth(
 *   async (request, auth) => {
 *     return mcp.handleRequest(request, { auth })
 *   },
 *   async (request) => {
 *     const token = request.headers.get('Authorization')?.replace('Bearer ', '')
 *     if (!token) return null
 *
 *     // Verify token and return auth info
 *     const claims = await verifyJWT(token)
 *     return { token, claims }
 *   }
 * )
 *
 * // Use in TanStack Start route
 * export const Route = createFileRoute('/api/mcp')({
 *   server: {
 *     handlers: {
 *       POST: handler,
 *     },
 *   },
 * })
 * ```
 */
export function withMcpAuth(
  handler: (request: Request, auth: AuthInfo) => Promise<Response>,
  verifyToken: TokenVerifier,
  options: AuthMiddlewareOptions = {}
): (request: Request) => Promise<Response> {
  const {
    realm = "MCP Server",
    requiredScopes = [],
    allowUnauthenticated = false,
  } = options;

  return async (request: Request): Promise<Response> => {
    // Extract Bearer token from Authorization header
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    // No token provided
    if (!token) {
      if (allowUnauthenticated) {
        // Allow request without auth - use explicit unauthenticated marker
        return handler(request, {
          token: "",
          claims: {},
          scopes: [],
        });
      }

      return createUnauthorizedResponse(realm, "No authorization token provided");
    }

    // Reject empty tokens (whitespace only)
    if (token.length === 0) {
      return createUnauthorizedResponse(realm, "Empty authorization token");
    }

    try {
      // Verify the token
      const authInfo = await verifyToken(request);

      if (!authInfo) {
        return createUnauthorizedResponse(realm, "Invalid or expired token");
      }

      // Check required scopes
      if (requiredScopes.length > 0) {
        const tokenScopes = authInfo.scopes || [];
        const hasAllScopes = requiredScopes.every((scope) =>
          tokenScopes.includes(scope)
        );

        if (!hasAllScopes) {
          return createForbiddenResponse(
            `Insufficient scopes. Required: ${requiredScopes.join(", ")}`
          );
        }
      }

      // Call the handler with auth info
      return handler(request, authInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Token verification failed";
      return createUnauthorizedResponse(realm, message);
    }
  };
}

/**
 * Create a 401 Unauthorized response
 */
function createUnauthorizedResponse(realm: string, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: `Unauthorized: ${message}`,
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="${realm}"`,
      },
    }
  );
}

/**
 * Create a 403 Forbidden response
 */
function createForbiddenResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: `Forbidden: ${message}`,
      },
      id: null,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Simple helper to extract bearer token from request
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}
