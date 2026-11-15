// Checks the inspection engine against real local servers: this site, the broken
// example, and this site served without CORS headers. No network beyond 127.0.0.1.
// Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "../tools/serve.mjs";
import { findNonPortable, findSecrets, inspect, parseTarget, peerAllowed } from "../inspector/checks.js";
import { CHECKS } from "../inspector/catalog.js";
import { layout } from "../inspector/graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const servers = [];
let site;
let bare;

/** Start a server on a free port and return its base URL. */
async function start(options) {
  const server = await serve({ port: 0, host: "127.0.0.1", ...options });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}

before(async () => {
  site = await start({ root: ROOT });
  bare = await start({ root: ROOT, cors: false });
});

after(() => {
  for (const server of servers) {
    server.close();
  }
});

/** The ids of results with a given status. */
function ids(report, status) {
  return report.results.filter((r) => r.status === status).map((r) => r.id).sort();
}

test("parseTarget reads network URLs, folders and manifest URLs", () => {
  assert.deepEqual(
    (({ base, network, form }) => ({ base, network, form }))(parseTarget("https://a.example/agents/pizza")),
    { base: "https://a.example/agents/", network: "pizza", form: "network URL" },
  );
  assert.equal(parseTarget("https://a.example/agents/").network, null);
  assert.equal(parseTarget("https://a.example/agents/agent-manifest.json").base, "https://a.example/agents/");
  assert.equal(parseTarget("a.example/x/net").url, "https://a.example/x/net");
  assert.equal(parseTarget("https://a.example/x/net?y=1#z").url, "https://a.example/x/net");
  assert.equal(parseTarget("ftp://a.example/x").ok, false);
  assert.equal(parseTarget("https://user:pw@a.example/x").ok, false);
  assert.equal(parseTarget("").ok, false);
  assert.equal(parseTarget(`https://a.example/${"x".repeat(500)}`).ok, false);
});

test("secrets are found and masked, placeholders are not secrets", () => {
  const found = findSecrets({ llm: { api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" }, note: "use otk_ABCDEFGHIJKLMNOP" }, "f.json");
  assert.equal(found.length, 3);
  for (const item of found) {
    assert.ok(!item.includes("abcdefghijklmnop"), `secret leaked into the report: ${item}`);
  }
  assert.deepEqual(findSecrets({ api_key: "", apiKey: "<your key>", token_hint: "demo" }, "f.json"), []);
});

test("non-portable values are found; placeholders in braces are allowed", () => {
  const found = findNonPortable({
    a: "${HOME}/x",
    b: "Answer from C:\\data\\faq.txt",
    c: "file:///etc/passwd",
    d: "Use {grounding_rules} and https://example.com/home/page",
    include: "x.hocon",
  });
  assert.equal(found.length, 4, found.join("\n"));
  assert.ok(found.some((f) => f.startsWith("a:")));
  assert.ok(found.some((f) => f.includes("C:\\data\\faq.txt")));
});

test("peerAllowed mirrors the runtime's policy", () => {
  assert.equal(peerAllowed("https://p.example/agents/x", { allowed_peers: ["https://p.example"] }), true);
  assert.equal(peerAllowed("https://q.example/agents/x", { allowed_peers: ["https://p.example"] }), false);
  assert.equal(peerAllowed("https://q.example/x", { peer_policy: { mode: "open", deny_origins: ["https://q.example"] } }), false);
  assert.equal(peerAllowed("https://r.example/x", { peer_policy: { mode: "open" } }), true);
});

test("this site conforms and is callable on this machine", async () => {
  const report = await inspect(`${site}agentic_web_inspector`, { pageOrigin: null });
  assert.deepEqual(ids(report, "fail"), []);
  assert.deepEqual(ids(report, "warn"), []);
  assert.equal(report.verdict, "conforms");
  assert.equal(report.callable, true);
  assert.equal(report.callableScope, "local");
  assert.equal(report.results.length, CHECKS.length);
  assert.equal(report.networks[0].frontMan, "inspector_desk");
  assert.equal(report.networks[0].agents, 2);
});

test("the broken example fails exactly the checks it was built to fail", async () => {
  const report = await inspect(`${site}examples/broken_site/helpdesk`, { pageOrigin: null });
  assert.deepEqual(ids(report, "fail"), [
    "definition.data_only",
    "definition.front_agent",
    "definition.validates",
    "secrets.none",
  ]);
  assert.deepEqual(ids(report, "warn"), [
    "definition.agents_complete",
    "definition.externals",
    "definition.private_context",
    "definition.schemas",
    "links.file",
    "manifest.allowed_peers",
    "manifest.router",
  ]);
  assert.equal(report.verdict, "does-not-conform");
  assert.equal(report.callable, false);
  const secrets = report.results.find((r) => r.id === "secrets.none");
  assert.equal(secrets.details.length, 1);
  assert.ok(!JSON.stringify(report).includes("EXAMPLEnotARealKey"), "the report repeats the key");
  const dataOnly = report.results.find((r) => r.id === "definition.data_only");
  assert.equal(dataOnly.details.length, 2);
});

test("a site without CORS headers conforms but is not callable", async () => {
  const report = await inspect(`${bare}agentic_web_inspector`, { pageOrigin: null });
  assert.deepEqual(ids(report, "fail"), []);
  assert.ok(ids(report, "warn").includes("manifest.cors"));
  assert.ok(ids(report, "warn").includes("definition.cors"));
  assert.equal(report.callable, false);
});

test("an exact network name is required", async () => {
  const report = await inspect(`${site}Agentic_Web_Inspector`, { pageOrigin: null });
  const exact = report.results.find((r) => r.id === "manifest.exact_match");
  assert.equal(exact.status, "fail");
  assert.match(exact.message, /differs only in case/);
});

test("a missing site is reported as unreachable, and nothing after it runs", async () => {
  const report = await inspect(`${site}no/such/network`, { pageOrigin: null });
  assert.equal(report.results.find((r) => r.id === "manifest.reachable").status, "fail");
  assert.equal(report.results.find((r) => r.id === "definition.validates").status, "skip");
});

test("in a browser, a blocked cross-origin read is a CORS warning and an incomplete report", async () => {
  // A stand-in for the browser's fetch: CORS mode throws, no-cors mode gets an opaque answer.
  const fetchImpl = async (url, init) => {
    if (init && init.mode === "no-cors") {
      return { ok: false, status: 0, type: "opaque" };
    }
    throw new TypeError("Failed to fetch");
  };
  const report = await inspect("https://peer.example/agents/net", { pageOrigin: "https://inspector.example", fetchImpl });
  assert.equal(report.mode, "browser");
  assert.equal(report.results.find((r) => r.id === "manifest.cors").status, "warn");
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.callable, false);
});

test("in a browser, a successful cross-origin read proves CORS without reading the header", async () => {
  const files = {
    "https://peer.example/agents/agent-manifest.json": { networks: [{ name: "net", front_man: "a", hocon: "./net.network.json" }], llm_router: { base_url: "https://r.example/v1" }, peer_policy: { mode: "closed" } },
    "https://peer.example/agents/net.network.json": { tools: [{ name: "a", function: { description: "A" }, instructions: "Do A", tools: ["b"] }, { name: "b", function: { description: "B", parameters: { type: "object", properties: {} } }, instructions: "Do B", tools: [] }] },
    "https://peer.example/agents/links.json": { version: 1, networks: { net: {} } },
  };
  const fetchImpl = async (url) => {
    const body = files[url];
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      url,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  const report = await inspect("https://peer.example/agents/net", { pageOrigin: "https://inspector.example", fetchImpl });
  assert.deepEqual(ids(report, "fail"), []);
  assert.equal(report.results.find((r) => r.id === "manifest.cors").status, "pass");
  assert.equal(report.callable, true);
  assert.equal(report.callableScope, "public");
});

test("the network map places the front agent first and every node once", () => {
  const graph = {
    front: "a",
    nodes: [{ id: "a", kind: "front", label: "a" }, { id: "b", kind: "agent", label: "b" }, { id: "x", kind: "agent", label: "x" }, { id: "https://p.example/n", kind: "remote", label: "https://p.example/n" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "https://p.example/n" }],
  };
  const placed = layout(graph);
  assert.equal(placed.nodes.size, 4);
  assert.equal(placed.nodes.get("a").x, placed.nodes.get("x").x, "an unreached root starts in column 0");
  assert.ok(placed.nodes.get("b").x > placed.nodes.get("a").x);
  assert.ok(placed.nodes.get("https://p.example/n").x > placed.nodes.get("b").x);
});
