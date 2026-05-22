import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { __testables } from "../../src/index.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, number | string | string[]>();
  body = "";

  setHeader(name: string, value: number | string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) {
      this.body += String(chunk);
    }
    this.emit("finish");
    return this;
  }
}

test("v1 routes require API authorization", async () => {
  const req = {
    method: "GET",
    url: "/v1/models",
    headers: {},
  } as IncomingMessage;
  const res = new MockResponse() as unknown as ServerResponse & MockResponse;

  await __testables.handleRequest(req, res);

  const body = JSON.parse(res.body) as { error?: { type?: string } };
  assert.equal(res.statusCode, 401);
  assert.equal(body.error?.type, "authentication_error");
});
