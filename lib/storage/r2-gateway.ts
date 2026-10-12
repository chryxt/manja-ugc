type GatewayConfig = {
  baseUrl: string;
  token: string;
};

function readGatewayConfig(): GatewayConfig {
  const baseUrl = process.env.R2_GATEWAY_URL?.replace(/\/$/, "");
  const token = process.env.R2_GATEWAY_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("R2 gateway is not configured");
  }
  return { baseUrl, token };
}

async function gatewayRequest(method: "GET" | "PUT" | "DELETE", key: string, body?: BodyInit, contentType?: string) {
  const { baseUrl, token } = readGatewayConfig();
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "x-r2-key": key,
  });
  if (contentType) headers.set("content-type", contentType);

  const response = await fetch(`${baseUrl}/object`, {
    method,
    headers,
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`R2 gateway ${method} failed with ${response.status}`);
  }
  return response;
}

export async function uploadViaR2Gateway(key: string, body: BodyInit, contentType: string) {
  await gatewayRequest("PUT", key, body, contentType);
}

export async function deleteViaR2Gateway(key: string) {
  await gatewayRequest("DELETE", key);
}

export async function readViaR2Gateway(key: string) {
  return gatewayRequest("GET", key);
}
