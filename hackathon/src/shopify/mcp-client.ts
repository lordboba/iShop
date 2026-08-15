const TIMEOUT_MS = 10_000;

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpTimeoutError extends McpError {
  constructor(tool: string) {
    super(`MCP tool ${tool} timed out after ${TIMEOUT_MS / 1000}s`);
    this.name = "McpTimeoutError";
  }
}

type JsonRpcResponse = {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
};

export async function callMcpTool<T>(input: {
  endpoint: string;
  tool: string;
  arguments: unknown;
  bearerToken?: string;
  profileUrl: string;
}): Promise<T> {
  const { endpoint, tool, bearerToken, profileUrl } = input;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "ucp-agent-profile": profileUrl,
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: input.arguments },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new McpTimeoutError(tool);
    throw new McpError(`MCP tool ${tool} request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    throw new McpError(`MCP tool ${tool} returned HTTP ${response.status}`, response.status);
  }

  const rpc = (await response.json().catch(() => null)) as JsonRpcResponse | null;
  if (!rpc) throw new McpError(`MCP tool ${tool} returned a non-JSON body`);
  if (rpc.error) {
    throw new McpError(`MCP tool ${tool} error: ${rpc.error.message ?? "unknown"}`, rpc.error.code);
  }

  const result = rpc.result;
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (result?.isError) {
    throw new McpError(`MCP tool ${tool} reported an error: ${text ?? "no detail"}`);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent as T;
  if (text !== undefined) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpError(`MCP tool ${tool} returned unparseable text content`);
    }
  }
  return result as T;
}
