// Checks that the inspector's network, manifest and site actions work together with
// the real browser runtime and a scripted model. No LLM provider is called.
// Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ActionRegistry } from "../runtime/actions.js";
import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { buildToolTable, dispatchToolCall, runAgent } from "../runtime/runner.js";
import { TraceBus } from "../runtime/trace.js";
import { ScriptedModel } from "./scripted_model.mjs";
import { serve } from "../tools/serve.mjs";

const NETWORK_NAME = "agentic_web_inspector";
const BASE = "http://localhost:8080";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const { registerActions } = await import("../site-actions.js");
const { App } = await import("../app.js");
const { AssistantMount } = await import("../site.js");

let server;
let local;

before(async () => {
  server = await serve({ root: ROOT, port: 0 });
  local = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

async function load() {
  const config = JSON.parse(await readFile(new URL(`../${NETWORK_NAME}.network.json`, import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../agent-manifest.json", import.meta.url), "utf8"));
  return { config, manifest, network: new AgentNetwork(config, NETWORK_NAME) };
}

const scope = () => ({ base: BASE, network: NETWORK_NAME });

async function registry() {
  const r = new ActionRegistry();
  await registerActions({ register: r.register.bind(r, scope()) });
  return r;
}

function context(loaded, reg, model, confirm) {
  return {
    network: loaded.network,
    manifest: loaded.manifest,
    actions: reg,
    baseOrigin: BASE,
    displayOrigin: new URL(BASE).host,
    trace: new TraceBus(),
    isTop: true,
    frontMan: loaded.network.findFrontMan(),
    history: [],
    llm: model,
    confirmWebsiteActions: confirm,
  };
}

async function tool(loaded, ctx, name, agent = loaded.network.findFrontMan()) {
  const table = await buildToolTable(ctx, loaded.network.getAgentSpec(agent), [], null);
  return table.toolByName.get(`website_${name}`);
}

test("the network is valid, has two agents and keeps the template's peer rules", async () => {
  const loaded = await load();
  const result = validateNetwork(loaded.network);
  assert.deepEqual(result.errors, []);
  assert.equal(loaded.network.findFrontMan(), loaded.manifest.networks[0].front_man);
  assert.equal(loaded.config.tools.length, 2);
  const text = JSON.stringify(loaded.config);
  assert.ok(!text.includes("demo_mode"));
  assert.ok(!/TODO|<[a-z_]+>/.test(text), "template text left in the network");
  assert.match(loaded.network.getAgentSpec("inspector_desk").instructions, /When you have no website_\* tools/);
});

test("agentTools are registered local-only actions, each named in the instructions", async () => {
  const loaded = await load();
  const reg = await registry();
  const registered = new Map(reg.catalog(scope()).map((e) => [e.name, e]));
  const instructions = loaded.config.tools.map((t) => t.instructions).join("\n");
  for (const name of loaded.manifest.actions.agentTools) {
    assert.ok(registered.has(name), `${name} is not registered`);
    assert.equal(registered.get(name).availability, "local-only");
    assert.match(instructions, new RegExp(`website_${name}(?![\\w-])`));
  }
  assert.equal(registered.get("inspect_site").effect, "irreversible");
  assert.equal(registered.get("get_inspection").effect, "read");
});

test("the front agent reads the page through website_get_inspection", async () => {
  const loaded = await load();
  const reg = await registry();
  const model = new ScriptedModel([{ tool: "website_get_inspection", arguments: {} }, { text: "Nothing inspected yet." }]);
  const ctx = context(loaded, reg, model, async () => true);
  const result = await runAgent(ctx, ctx.frontMan, "What does the report say?", null, []);
  assert.ok(model.toolNames(0).includes("website_get_inspection"));
  const receipt = model.toolResults(1)[0];
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.latestInspection, null);
  assert.ok(receipt.result.knownSites.length >= 3);
  assert.match(result.text, /Nothing inspected/);
});

test("the checklist tool returns one check with its spec section and fix", async () => {
  const loaded = await load();
  const reg = await registry();
  const ctx = context(loaded, reg, new ScriptedModel([]), async () => true);
  const entry = await tool(loaded, ctx, "get_checklist", "fix_planner");
  const receipt = await dispatchToolCall(ctx, entry, { checkId: "manifest.cors" }, null, []);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.checks.length, 1);
  assert.match(receipt.result.checks[0].specSection, /3\.4/);
  await assert.rejects(dispatchToolCall(ctx, entry, { checkId: "made.up" }, null, []), /Invalid arguments/);
});

test("inspect_site needs confirmation, and a decline contacts no one", async () => {
  const loaded = await load();
  const reg = await registry();
  const unconfirmed = context(loaded, reg, new ScriptedModel([]), undefined);
  assert.equal(await tool(loaded, unconfirmed, "inspect_site"), undefined);
  const declining = context(loaded, reg, new ScriptedModel([]), async () => false);
  const entry = await tool(loaded, declining, "inspect_site");
  assert.ok(entry);
  const before = App.page.getState();
  const receipt = await dispatchToolCall(declining, entry, { url: `${local}agentic_web_inspector` }, null, []);
  assert.equal(receipt.status, "cancelled");
  const afterState = App.page.getState();
  assert.equal(afterState.version, before.version);
  assert.deepEqual(afterState.history, before.history);
});

test("an approved inspect_site runs the same inspection as the page's form", async () => {
  const loaded = await load();
  const reg = await registry();
  const approving = context(loaded, reg, new ScriptedModel([]), async () => true);
  const entry = await tool(loaded, approving, "inspect_site");
  const receipt = await dispatchToolCall(approving, entry, { url: `${local}examples/broken_site/helpdesk` }, null, []);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.ok, true);
  assert.equal(receipt.result.inspection.verdict, "does-not-conform");
  const failing = receipt.result.inspection.problems.filter((p) => p.status === "fail").map((p) => p.checkId).sort();
  assert.deepEqual(failing, ["definition.data_only", "definition.front_agent", "definition.validates", "secrets.none"]);
  // The page's own form calls the same method and gets the same verdict.
  const direct = await App.page.inspect(`${local}examples/broken_site/helpdesk`);
  assert.deepEqual(direct.inspection.problems, receipt.result.inspection.problems);
  assert.equal(App.page.getState().history.length, 1, "the same address is listed once");
});

test("a bad address is refused by the site and changes nothing", async () => {
  const before = App.page.getState();
  const refused = await App.page.inspect("ftp://nope.example/x");
  assert.equal(refused.ok, false);
  assert.equal(refused.field, "url");
  assert.equal(App.page.getState().version, before.version);
});

test("the dialog names the website and what is sent, and refuses a bad address", () => {
  const item = { action: "inspect_site", origin: BASE, effect: "irreversible", arguments: { url: "https://peer.example/agents/net" } };
  const content = AssistantMount.dialogContent(item);
  assert.equal(content.title, "Contact this website?");
  assert.equal(content.details.Website, "https://peer.example");
  assert.match(content.details["Sent with the requests"], /no cookies, no keys/);
  assert.equal(content.refusal, undefined);
  assert.match(content.exact, /inspect_site on http:\/\/localhost:8080/);
  const bad = AssistantMount.dialogContent({ ...item, arguments: { url: "mailto:x@example.com" } });
  assert.ok(bad.refusal);
  assert.ok(!/TODO/.test(AssistantMount.GREETING));
});
