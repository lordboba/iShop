const TOKEN_URL = "https://api.shopify.com/auth/access_token";

// Error messages must stay free of credentials and tokens: only construct
// them from static text and HTTP status codes.
export class ShopifyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyAuthError";
  }
}

let cached: { token: string; refreshAfter: number } | null = null;

export async function getCatalogAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.refreshAfter) return cached.token;

  const clientId = process.env.SHOPIFY_CATALOG_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CATALOG_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ShopifyAuthError(
      "SHOPIFY_CATALOG_CLIENT_ID or SHOPIFY_CATALOG_CLIENT_SECRET is not set",
    );
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });
  } catch {
    throw new ShopifyAuthError("token request failed to reach api.shopify.com");
  }
  if (!response.ok) {
    throw new ShopifyAuthError(`token request rejected with HTTP ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  const token = body?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new ShopifyAuthError("token response missing access_token");
  }

  // Reuse the bearer until 60s before its JWT exp.
  cached = { token, refreshAfter: jwtExpiryMs(token) - 60_000 };
  return token;
}

function jwtExpiryMs(token: string): number {
  try {
    const payloadPart = token.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // opaque token: fall through to conservative cache below
  }
  return Date.now() + 5 * 60_000;
}

export function resetCatalogTokenCacheForTests(): void {
  cached = null;
}
