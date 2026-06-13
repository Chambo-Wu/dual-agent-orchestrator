import type { IncomingMessage, ServerResponse } from "node:http";

export function handleHelloRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const name = url.searchParams.get("name");

  if (!name || name.trim().length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      error: {
        message: "Missing required query parameter: name. Usage: /hello?name=World",
        type: "invalid_request_error",
      },
    }));
    return;
  }

  const trimmed = name.trim();
  if (trimmed.length > 200) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      error: {
        message: "Parameter 'name' must be 200 characters or fewer.",
        type: "invalid_request_error",
      },
    }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    message: `Hello, ${trimmed}!`,
    timestamp: new Date().toISOString(),
  }));
}
