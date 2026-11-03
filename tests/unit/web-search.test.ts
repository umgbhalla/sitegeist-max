import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { routeSearch, searchFree, searchProvider, type SearchProvider } from "../../src/tools/web-search-core.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function handshake(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
 if (!String(input).includes("search.parallel.ai/mcp")) return;
 const body = JSON.parse(String(init?.body));
 if (body.method === "initialize") {
  assert.equal(body.params.clientInfo.name, "openclaw-parallel");
  return Response.json({result:{protocolVersion:"2025-06-18"}}, {headers:{"mcp-session-id":"test-session"}});
 }
 if (body.method === "notifications/initialized") {
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("mcp-session-id"), "test-session");
  assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
  return new Response(null, {status:202});
 }
 const headers = new Headers(init?.headers);
 assert.equal(headers.get("mcp-session-id"), "test-session");
 assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
}

for (const provider of ["tinyfish", "exa", "parallel"] as const) {
 test(`${provider} sends its documented request and returns sources`, async () => {
  globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
   const url = String(input);
   const headers = new Headers(init?.headers);
   assert.equal(headers.get("x-api-key"), "test-key");
   if (provider === "tinyfish") {
    assert.equal(new URL(url).searchParams.get("query"), "test query");
    assert.equal(init?.method, "GET");
   } else {
    assert.equal(new URL(url).hostname, provider === "exa" ? "api.exa.ai" : "api.parallel.ai");
    const body = JSON.parse(String(init?.body));
    assert.equal(provider === "exa" ? body.query : body.objective, "test query");
    if (provider === "parallel") assert.equal(body.mode, "fast");
   }
   return Response.json({ results: [{ title: "Example", url: "https://example.org", snippet: "text", excerpts: ["other"] }] });
  };
  const results = await searchProvider(provider, "test-key", "test query");
  assert.deepEqual(results, [{ title: "Example", url: "https://example.org", snippet: "text" }]);
 });
}

test("rotates and falls back after a provider error", async () => {
 const calls: string[] = [];
 globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
  calls.push(new URL(String(input)).hostname);
  return calls.length === 1 ? new Response("unavailable", { status: 429 }) : Response.json({ results: [{ url: "https://example.org", excerpts: ["evidence"] }] });
 };
 const keys: Record<SearchProvider, string> = { tinyfish: "a", exa: "b", parallel: "c" };
 const result = await routeSearch("query", keys);
 assert.equal(calls.length, 2);
 assert.equal(result.results[0].snippet, "evidence");
 assert.notEqual(calls[0], calls[1]);
});

test("cancellation prevents requests", async () => {
 const controller = new AbortController();
 controller.abort();
 await assert.rejects(routeSearch("query", { tinyfish: "a" }, controller.signal), /cancelled/);

});


test("successive searches rotate among configured providers", async () => {
 const calls: string[] = [];
 globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
  calls.push(new URL(String(input)).hostname);
  return Response.json({ results: [] });
 };
 const keys: Record<SearchProvider, string> = { tinyfish: "a", exa: "b", parallel: "c" };
 await routeSearch("first", keys);
 await routeSearch("second", keys);
 await routeSearch("third", keys);
 assert.equal(new Set(calls).size, 3);
});


test("keyless MCP JSON and event stream return sources", async () => {
 globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
  const request = JSON.parse(String(init?.body));
  if (String(input).includes("parallel")) {
   assert.equal(request.params.name, "web_search");
   return Response.json({ result: { content: [{ text: JSON.stringify({results:[{url:"https://example.com", excerpts:["parallel"]}]}) }] } });
  }
  assert.equal(request.params.name, "web_search_exa");
  return new Response('event: message\ndata: ' + JSON.stringify({ result: { content: [{ text: 'Title: Example\nURL: https://example.com\nHighlights:\nexa' }] } }) + '\n\n');
 };
 assert.equal((await searchFree("parallel-free", "query"))[0].snippet, "parallel");
 assert.equal((await searchFree("exa-free", "query"))[0].snippet, "exa");
});

test("without keys, a failing free provider falls back", async () => {
 let calls = 0;
 globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
  calls++;
  if (calls === 1) return new Response("limited", { status: 429 });
  const text = String(input).includes("parallel") ? JSON.stringify({results:[{url:"https://example.com",snippet:"ok"}]}) : "Title: Example\nURL: https://example.com\nHighlights:\nok";
  return Response.json({result:{content:[{text}]}});
 };
 const result = await routeSearch("query", {});
 assert.equal(calls, 2);
 assert.equal(result.results[0].snippet, "ok");
});


test("configured provider failure falls back to free search", async () => {
 globalThis.fetch = async (input, init) => {
  const reply = handshake(input, init);
  if (reply) return reply;
  if (String(input).includes("api.exa.ai")) return new Response("", {status: 429});
  const text = String(input).includes("parallel") ? JSON.stringify({results:[{url:"https://example.com",snippet:"ok"}]}) : "Title: Example\nURL: https://example.com\nHighlights:\nok";
  return Response.json({result:{content:[{text}]}});
 };
 const result = await routeSearch("query", {exa:"test"});
 assert.match(result.provider, /-free$/);
 assert.match(result.fallbackFrom?.[0] ?? "", /429/);
});
