// Inspects a published open agentic website against the MVP specification
// (Profile 0.2). Runs in the browser, where the CORS results are the browser's own
// verdict, and in Node (tools/inspect.mjs), where they are read from the headers.
//
// The inspector only reads public files: it sends no cookies, no keys and no prompts,
// and it never runs the inspected site's code or agents.

import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { CHECKS, Level, checkById } from "./catalog.js";

/** Largest file the inspector reads, in bytes. */
export const MAX_BYTES = 2_000_000;

/** Status of one check result. */
export const Status = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  INFO: "info",
  SKIP: "skip",
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Strings that look like provider credentials. Values are masked in the report.
const SECRET_PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g },
  { name: "Otari key", re: /\botk_[A-Za-z0-9_-]{12,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g },
];
const SECRET_KEY_NAMES = /^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|authorization|password)$/i;
const PLACEHOLDER_VALUE = /^(|\s*|<.*>|\*+|x+|your[_ -].*|todo.*|demo|none|null|changeme)$/i;

/** True when the host is a loopback host, where plain HTTP is accepted for local development. */
export function isLoopback(url) {
  return LOOPBACK.has(url.hostname);
}

/**
 * Work out the site base and the requested network name from an address.
 *
 * Accepts a network URL (https://host/agents/my_network), a site folder
 * (https://host/agents/) or the manifest itself (.../agent-manifest.json).
 *
 * :param input: The address as typed.
 * :return: {ok, url, base, network, form} or {ok: false, reason}.
 */
export function parseTarget(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) {
    return { ok: false, reason: "Enter the address of an agentic website." };
  }
  if (text.length > 500) {
    return { ok: false, reason: "The address is longer than 500 characters." };
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: `"${text}" is not a web address.` };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "Only http:// and https:// addresses can host an agentic website." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Remove the user name and password from the address. The inspector sends no credentials." };
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname;
  const last = path.split("/").pop();
  if (path.endsWith("/")) {
    return { ok: true, url: url.href, base: url.href, network: null, form: "site folder" };
  }
  if (last === "agent-manifest.json") {
    return { ok: true, url: url.href, base: new URL("./", url).href, network: null, form: "manifest file" };
  }
  if (last.includes(".")) {
    // A page or file such as index.html or my.network.json: inspect its folder.
    return { ok: true, url: url.href, base: new URL("./", url).href, network: null, form: "file in the site folder" };
  }
  return { ok: true, url: url.href, base: new URL("./", url).href, network: decodeURIComponent(last), form: "network URL" };
}

/**
 * Fetch one public file the way a caller site would: no cookies, no credentials.
 *
 * In a browser, a cross-origin read that succeeds proves the CORS header is there.
 * A blocked read is retried in no-cors mode, which tells "reachable but not shared"
 * from "unreachable" without reading the body.
 *
 * :return: {ok, status, text, cors, corsBasis, finalUrl, error}
 */
export async function probe(url, env) {
  const fetchImpl = env.fetchImpl;
  const crossOrigin = env.pageOrigin ? new URL(url).origin !== env.pageOrigin : true;
  let response;
  try {
    response = await fetchImpl(url, { credentials: "omit", cache: "no-store", redirect: "follow" });
  } catch (error) {
    if (env.pageOrigin && crossOrigin) {
      try {
        await fetchImpl(url, { mode: "no-cors", credentials: "omit", cache: "no-store" });
        return { ok: false, reachable: true, cors: false, corsBasis: "browser", error: "The server answered, but did not allow other origins to read it." };
      } catch {
        // Fall through: not reachable at all.
      }
    }
    return { ok: false, reachable: false, cors: null, corsBasis: "none", error: String(error && error.message || error) };
  }
  const header = response.headers.get("access-control-allow-origin");
  let cors;
  let corsBasis;
  if (env.pageOrigin && crossOrigin) {
    // The browser only hands over a cross-origin body when CORS allowed it.
    cors = true;
    corsBasis = "browser";
  } else {
    cors = header === "*" || (env.pageOrigin ? header === env.pageOrigin : header !== null);
    corsBasis = "header";
  }
  const finalUrl = response.url || url;
  let text = "";
  let truncated = false;
  if (response.ok) {
    text = await response.text();
    if (text.length > MAX_BYTES) {
      text = text.slice(0, MAX_BYTES);
      truncated = true;
    }
  }
  return {
    ok: response.ok,
    reachable: true,
    status: response.status,
    text,
    truncated,
    cors,
    corsHeader: header,
    corsBasis,
    finalUrl,
    redirectedOrigin: new URL(finalUrl).origin !== new URL(url).origin ? new URL(finalUrl).origin : null,
  };
}

/** Mask a found secret so the report never repeats it. */
function mask(value) {
  const s = String(value);
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

/** Find credential-looking strings in a parsed JSON value. */
export function findSecrets(value, file) {
  const found = [];
  const walk = (node, path) => {
    if (typeof node === "string") {
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0;
        const match = pattern.re.exec(node);
        if (match) {
          found.push(`${file} ${path}: ${pattern.name} ${mask(match[0])}`);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SECRET_KEY_NAMES.test(key) && typeof child === "string" && !PLACEHOLDER_VALUE.test(child.trim())) {
          found.push(`${file} ${childPath}: a value under "${key}" ${mask(child)}`);
        }
        walk(child, childPath);
      }
    }
  };
  walk(value, "");
  return found;
}

/** Find includes, substitutions and local file paths in a parsed network. */
export function findNonPortable(value) {
  const found = [];
  const walk = (node, path) => {
    if (typeof node === "string") {
      if (/\$\{[^}]*\}/.test(node)) {
        found.push(`${path}: substitution ${node.match(/\$\{[^}]*\}/)[0]}`);
      }
      if (/^\s*include\s+(required\()?\s*(file|url|classpath)?\(?\s*"/i.test(node)) {
        found.push(`${path}: include directive`);
      }
      const local = node.match(/file:\/\/\S*/i) || node.match(/(?:^|[\s"'(])([A-Za-z]:\\[^\s"')]*)/) || node.match(/(?:^|[\s"'(])(\/(?:home|Users|etc|var|tmp|opt)\/[^\s"')]*)/);
      if (local) {
        found.push(`${path}: local path "${(local[1] || local[0]).trim().slice(0, 60)}"`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "include" || key === "includes") {
          found.push(`${path ? `${path}.` : ""}${key}: include key`);
        }
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(value, "");
  return found;
}

/** Normalize an origin the same way the reference runtime compares peers. */
function originOf(text) {
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

/** Does the manifest's peer policy let the runtime contact this URL? (mirrors runtime/engine.js) */
export function peerAllowed(target, manifest) {
  const origin = originOf(target);
  if (!origin) {
    return false;
  }
  const policy = manifest && (manifest.peer_policy || manifest.web_policy);
  if (policy && policy.mode === "open") {
    const denied = (policy.deny_origins || policy.denied_origins || []).map(originOf);
    return !denied.includes(origin);
  }
  return (manifest && Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers : []).map(originOf).includes(origin);
}

/**
 * Build the agent graph: nodes for agents and external capabilities, edges for calls.
 *
 * :return: {front, nodes: [{id, kind, label}], edges: [{from, to}]}
 */
export function networkGraph(network, frontMan) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const add = (id, kind, label) => {
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, kind, label });
    }
  };
  for (const agent of network.config.tools || []) {
    if (agent && typeof agent.name === "string") {
      add(agent.name, agent.name === frontMan ? "front" : "agent", agent.name);
    }
  }
  for (const agent of network.config.tools || []) {
    if (!agent || typeof agent.name !== "string") {
      continue;
    }
    for (const ref of agent.tools || []) {
      const kind = network.classifyTool(ref).kind;
      const id = typeof ref === "string" ? ref : `mcp:${ref && ref.url}`;
      if (kind === "remote") {
        add(id, "remote", id);
      } else if (kind === "mcp") {
        add(id, "mcp", typeof ref === "string" ? ref : (ref && ref.url) || "MCP server");
      } else if (kind === "missing") {
        add(id, "missing", `${id} (missing)`);
      }
      edges.push({ from: agent.name, to: id });
    }
  }
  return { front: frontMan, nodes, edges };
}

/** Collects results in catalog order. */
class Report {
  constructor(target, env) {
    this.target = target;
    this.mode = env.pageOrigin ? "browser" : "headers";
    this.inspectedAt = new Date().toISOString();
    this.results = new Map();
    this.files = [];
    this.networks = [];
  }

  set(id, status, message, details = []) {
    if (!checkById(id)) {
      throw new Error(`Unknown check ${id}`);
    }
    this.results.set(id, { id, status, message, details });
  }

  /** Mark a failing check as a fail or a warning, as its catalog level says. */
  bad(id, message, details = []) {
    const level = checkById(id).level;
    const status = level === Level.FAIL ? Status.FAIL : level === Level.WARN ? Status.WARN : Status.INFO;
    this.set(id, status, message, details);
  }

  skip(id, message) {
    if (!this.results.has(id)) {
      this.set(id, Status.SKIP, message);
    }
  }

  finish() {
    for (const check of CHECKS) {
      this.skip(check.id, "Not reached: an earlier check stopped the inspection.");
    }
    const results = CHECKS.map((check) => ({
      ...this.results.get(check.id),
      title: check.title,
      group: check.group,
      section: check.section,
    }));
    const count = (status) => results.filter((r) => r.status === status).length;
    const failed = count(Status.FAIL);
    const passed = (id) => this.results.get(id)?.status === Status.PASS;
    const crossOriginOk = ["manifest.cors", "definition.cors"].every(passed);
    const httpsStatus = this.results.get("target.https")?.status;
    const resolvable = ["manifest.networks", "definition.reachable", "definition.validates"].every(passed);
    const callable = failed === 0 && crossOriginOk && resolvable && (httpsStatus === Status.PASS || httpsStatus === Status.INFO);
    const core = ["manifest.json", "definition.reachable", "definition.validates"];
    const incomplete = failed === 0 && core.some((id) => this.results.get(id)?.status === Status.SKIP);
    return {
      target: this.target,
      mode: this.mode,
      sameOrigin: this.sameOrigin === true,
      inspectedAt: this.inspectedAt,
      verdict: failed > 0 ? "does-not-conform" : incomplete ? "incomplete" : count(Status.WARN) === 0 ? "conforms" : "conforms-with-warnings",
      callable,
      callableScope: callable ? (httpsStatus === Status.PASS ? "public" : "local") : null,
      counts: {
        pass: count(Status.PASS),
        fail: failed,
        warn: count(Status.WARN),
        info: count(Status.INFO),
        skip: count(Status.SKIP),
      },
      files: this.files,
      networks: this.networks,
      results,
    };
  }
}

/** Record the CORS result of one probed file. */
function recordCors(report, id, fileLabel, result, env) {
  if (result.cors === true) {
    report.set(id, Status.PASS, result.corsBasis === "browser"
      ? `This browser read ${fileLabel} from another origin, so other agent sites can too.`
      : `${fileLabel} sends Access-Control-Allow-Origin: ${result.corsHeader}.`);
  } else if (env.pageOrigin && result.corsBasis === "header") {
    report.bad(id, `${fileLabel} is on this page's own origin and sends no Access-Control-Allow-Origin header. Pages on other origins cannot read it.`);
  } else {
    report.bad(id, `${fileLabel} does not allow other origins to read it${result.corsHeader === null || result.corsHeader === undefined ? " (no Access-Control-Allow-Origin header)" : ` (Access-Control-Allow-Origin: ${result.corsHeader})`}.`);
  }
}

/**
 * Inspect one address.
 *
 * :param input: A network URL, a site folder or a manifest URL.
 * :param env: {fetchImpl, pageOrigin, onProgress}. pageOrigin is the inspecting page's
 *   origin in a browser, and null under Node.
 * :return: The report, as plain JSON data.
 */
export async function inspect(input, env = {}) {
  const fullEnv = {
    fetchImpl: env.fetchImpl || globalThis.fetch.bind(globalThis),
    pageOrigin: env.pageOrigin === undefined ? null : env.pageOrigin,
    onProgress: env.onProgress || (() => {}),
  };
  const target = parseTarget(input);
  const report = new Report(target, fullEnv);
  if (!target.ok) {
    report.bad("target.url", target.reason);
    return report.finish();
  }
  report.set("target.url", Status.PASS, target.network
    ? `Network URL: site base ${target.base}, network "${target.network}".`
    : `Site folder ${target.base}; every network in its manifest is inspected.`);
  const baseUrl = new URL(target.base);
  report.sameOrigin = fullEnv.pageOrigin === baseUrl.origin;
  if (baseUrl.protocol === "https:") {
    report.set("target.https", Status.PASS, "Served over HTTPS.");
  } else if (isLoopback(baseUrl)) {
    report.set("target.https", Status.INFO, "Plain HTTP on a loopback host: fine for local development, but publish on HTTPS.");
  } else {
    report.bad("target.https", "Served over plain HTTP. Callers require HTTPS outside local development.");
  }

  // Manifest.
  const manifestUrl = new URL("agent-manifest.json", target.base).href;
  fullEnv.onProgress(`Reading ${manifestUrl}`);
  const m = await probe(manifestUrl, fullEnv);
  report.files.push({ file: "agent-manifest.json", url: manifestUrl, status: m.status ?? null, cors: m.cors });
  if (!m.reachable) {
    report.bad("manifest.reachable", `Could not reach ${manifestUrl}: ${m.error}`);
    return report.finish();
  }
  if (m.status === undefined) {
    // Reachable only in no-cors mode: the browser would not hand over the body.
    report.set("manifest.reachable", Status.PASS, "The server answered.");
    recordCors(report, "manifest.cors", "agent-manifest.json", m, fullEnv);
    report.skip("manifest.json", "The browser did not hand over the file, so its content could not be read.");
    return report.finish();
  }
  if (!m.ok) {
    report.bad("manifest.reachable", `${manifestUrl} answered HTTP ${m.status}.`);
    return report.finish();
  }
  report.set("manifest.reachable", Status.PASS, `HTTP ${m.status}${m.redirectedOrigin ? `, redirected to ${m.redirectedOrigin}` : ""}.`);
  recordCors(report, "manifest.cors", "agent-manifest.json", m, fullEnv);

  let manifest;
  try {
    manifest = JSON.parse(m.text);
  } catch (error) {
    report.bad("manifest.json", `agent-manifest.json is not valid JSON: ${error.message}`);
    return report.finish();
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    report.bad("manifest.json", "agent-manifest.json must be a JSON object.");
    return report.finish();
  }
  report.set("manifest.json", Status.PASS, "Valid JSON object.");

  const entries = Array.isArray(manifest.networks) ? manifest.networks : [];
  const badEntries = entries
    .map((entry, i) => [entry, i])
    .filter(([entry]) => !entry || ["name", "front_man", "hocon"].some((key) => typeof entry[key] !== "string" || !entry[key].trim()))
    .map(([, i]) => `networks[${i}] is missing name, front_man or hocon`);
  if (!entries.length) {
    report.bad("manifest.networks", "The manifest lists no networks.");
    return report.finish();
  }
  if (badEntries.length) {
    report.bad("manifest.networks", `${badEntries.length} of ${entries.length} network entries are incomplete.`, badEntries);
  } else {
    report.set("manifest.networks", Status.PASS, `${entries.length} network${entries.length === 1 ? "" : "s"}: ${entries.map((e) => e.name).join(", ")}.`);
  }

  let selected = entries.filter((entry) => entry && typeof entry.name === "string");
  if (target.network) {
    const exact = selected.filter((entry) => entry.name === target.network);
    if (!exact.length) {
      const near = selected.filter((entry) => entry.name.toLowerCase() === target.network.toLowerCase());
      report.bad("manifest.exact_match", `No network is named exactly "${target.network}".${near.length ? ` "${near[0].name}" differs only in case; the runtime will not pick it.` : ""}`, selected.map((e) => `published: ${e.name}`));
      selected = [];
    } else {
      report.set("manifest.exact_match", Status.PASS, `"${target.network}" is listed.`);
      selected = exact;
    }
  } else {
    report.set("manifest.exact_match", Status.INFO, "No network name was given, so every listed network is inspected. Callers must use one exact name.");
  }

  // Router metadata.
  const router = manifest.llm_router;
  if (!router || typeof router !== "object") {
    report.bad("manifest.router", "No llm_router block. Callers cannot see the site's default inference path.");
  } else {
    const routerUrls = [router.base_url, router.byok_router].filter((u) => typeof u === "string" && u);
    const insecure = routerUrls.filter((u) => {
      const parsed = originOf(u) ? new URL(u) : null;
      return !parsed || (parsed.protocol !== "https:" && !isLoopback(parsed));
    });
    if (!routerUrls.length) {
      report.bad("manifest.router", "llm_router has no base_url or byok_router.");
    } else if (insecure.length) {
      report.bad("manifest.router", `Router URL is not HTTPS: ${insecure.join(", ")}.`);
    } else {
      report.set("manifest.router", Status.PASS, `Default router ${router.base_url || router.byok_router}${router.mock ? " (mock)" : ""}.`);
    }
  }

  // Peer policy.
  const policy = manifest.peer_policy || manifest.web_policy;
  if (!policy || typeof policy !== "object") {
    report.bad("manifest.peer_policy", "No peer_policy block; the runtime treats the site as closed to every peer origin.");
  } else {
    report.set("manifest.peer_policy", Status.PASS, `Peer policy "${policy.mode || "closed"}"${policy.mode === "open" ? ": any HTTP(S) peer may be contacted after visitor consent" : ""}.`);
  }
  const peers = Array.isArray(manifest.allowed_peers) ? manifest.allowed_peers : [];
  const badPeers = peers.filter((peer) => {
    if (typeof peer !== "string" || peer.includes("*")) {
      return true;
    }
    const origin = originOf(peer);
    if (!origin) {
      return true;
    }
    const parsed = new URL(peer);
    return parsed.pathname.replace(/\/$/, "") !== "" || (parsed.protocol !== "https:" && !isLoopback(parsed));
  });
  if (badPeers.length) {
    report.bad("manifest.allowed_peers", `${badPeers.length} allowed_peers entr${badPeers.length === 1 ? "y is" : "ies are"} not a plain HTTPS origin.`, badPeers.map(String));
  } else {
    report.set("manifest.allowed_peers", Status.PASS, peers.length ? `${peers.length} allowed peer origin${peers.length === 1 ? "" : "s"}.` : "No peer origins listed.");
  }

  // Coded tools.
  const coded = [];
  const walkCoded = (node, path) => {
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (/coded[_-]?tool|bundle/i.test(key) && child && typeof child === "object") {
          coded.push({ path: `${path}${key}`, integrity: child.integrity || child.sri || null });
        }
        walkCoded(child, `${path}${key}.`);
      }
    }
  };
  walkCoded(manifest, "");
  if (!coded.length) {
    report.set("coded_tools.integrity", Status.PASS, "No coded-tool bundle declared: the network is data only.");
  } else if (coded.every((c) => typeof c.integrity === "string" && /^sha(256|384|512)-/.test(c.integrity))) {
    report.set("coded_tools.integrity", Status.PASS, `${coded.length} coded-tool declaration${coded.length === 1 ? "" : "s"} with an SRI digest.`);
  } else {
    report.bad("coded_tools.integrity", "A coded-tool bundle is declared without an SRI digest.", coded.map((c) => c.path));
  }

  const secrets = findSecrets(manifest, "agent-manifest.json");

  // Network definitions.
  const definitionFailures = { reachable: [], cors: [], json: [], dataOnly: [], validates: [], front: [], complete: [], schemas: [], externals: [], privateContext: [] };
  let agentCounts = [];
  for (const entry of selected) {
    if (typeof entry.hocon !== "string") {
      continue;
    }
    const defUrl = new URL(entry.hocon, target.base).href;
    fullEnv.onProgress(`Reading ${defUrl}`);
    const d = await probe(defUrl, fullEnv);
    report.files.push({ file: `${entry.name} definition`, url: defUrl, status: d.status ?? null, cors: d.cors });
    const label = `${entry.name}: `;
    if (!d.reachable || d.status === undefined || !d.ok) {
      definitionFailures.reachable.push(`${label}${d.status ? `HTTP ${d.status}` : d.error} at ${defUrl}`);
      if (d.reachable && d.status === undefined) {
        definitionFailures.cors.push(`${label}the browser did not hand over the definition`);
      }
      continue;
    }
    if (d.cors !== true) {
      definitionFailures.cors.push(`${label}${d.corsHeader ? `Access-Control-Allow-Origin: ${d.corsHeader}` : "no Access-Control-Allow-Origin header"}`);
    }
    let config;
    try {
      config = JSON.parse(d.text);
    } catch (error) {
      definitionFailures.json.push(`${label}not JSON (${error.message}). Publish the resolved .network.json.`);
      continue;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      definitionFailures.json.push(`${label}the definition is not a JSON object`);
      continue;
    }
    secrets.push(...findSecrets(config, entry.hocon));
    definitionFailures.dataOnly.push(...findNonPortable(config).map((item) => `${label}${item}`));

    const network = new AgentNetwork(config, entry.name);
    const validation = validateNetwork(network);
    definitionFailures.validates.push(...validation.errors.map((err) => `${label}${err}`));
    const front = network.findFrontMan();
    const agents = (network.config.tools || []).filter((a) => a && typeof a.name === "string");
    agentCounts.push(agents.length);
    if (!network.getAgentSpec(entry.front_man)) {
      definitionFailures.front.push(`${label}front_man "${entry.front_man}" is not an agent in the definition`);
    } else if (front && front !== entry.front_man) {
      definitionFailures.front.push(`${label}the manifest names "${entry.front_man}", but the runtime will start "${front}" (the first agent with instructions)`);
    }
    for (const agent of agents) {
      const isLlmAgent = !agent.class && !agent.toolbox;
      if (!agent.function || typeof agent.function.description !== "string" || !agent.function.description.trim()) {
        definitionFailures.complete.push(`${label}${agent.name} has no function.description`);
      }
      if (isLlmAgent && (typeof agent.instructions !== "string" || !agent.instructions.trim())) {
        definitionFailures.complete.push(`${label}${agent.name} has no instructions`);
      }
      const params = agent.function && agent.function.parameters;
      if (agent.name !== entry.front_man && (!params || params.type !== "object")) {
        definitionFailures.schemas.push(`${label}${agent.name} has no object schema in function.parameters`);
      }
      if (agent.allow) {
        for (const direction of ["to_downstream", "to_upstream"]) {
          const fields = agent.allow[direction] && agent.allow[direction].sly_data;
          const list = Array.isArray(fields) ? fields : fields && typeof fields === "object" ? Object.keys(fields) : [];
          if (list.includes("*") || fields === true) {
            definitionFailures.privateContext.push(`${label}${agent.name} forwards all private context ${direction}`);
          }
        }
      }
    }
    for (const ref of [...validation.externals, ...validation.mcps]) {
      const parsed = originOf(ref) ? new URL(ref) : null;
      if (!parsed) {
        definitionFailures.externals.push(`${label}${ref} is not an absolute URL`);
      } else if (parsed.protocol !== "https:" && !isLoopback(parsed)) {
        definitionFailures.externals.push(`${label}${ref} is not HTTPS`);
      } else if (!peerAllowed(ref, manifest)) {
        definitionFailures.externals.push(`${label}${parsed.origin} is not in allowed_peers, so the runtime refuses ${ref}`);
      }
    }
    report.networks.push({
      name: entry.name,
      frontMan: entry.front_man,
      description: entry.description || (network.metadata() && network.metadata().description) || "",
      sampleQueries: Array.isArray(entry.sample_queries) ? entry.sample_queries.slice(0, 6) : [],
      agents: agents.length,
      externals: validation.externals,
      mcps: validation.mcps,
      graph: networkGraph(network, entry.front_man),
      url: `${target.base}${entry.name}`,
    });
  }

  const resolvedCount = report.networks.length;
  const verdictFor = (id, list, passMessage) => {
    if (list.length) {
      report.bad(id, `${list.length} problem${list.length === 1 ? "" : "s"} found.`, list);
    } else if (!selected.length) {
      report.skip(id, "No network was selected.");
    } else {
      report.set(id, Status.PASS, passMessage);
    }
  };
  verdictFor("definition.reachable", definitionFailures.reachable, `${selected.length} definition${selected.length === 1 ? "" : "s"} loaded.`);
  const fetchedDefinitions = selected.length - definitionFailures.reachable.length;
  if (definitionFailures.cors.length) {
    report.bad("definition.cors", "Other origins cannot read a network definition.", definitionFailures.cors);
  } else if (fetchedDefinitions > 0) {
    report.set("definition.cors", Status.PASS, report.mode === "browser" ? "Every definition is readable from other origins." : "Every definition sends Access-Control-Allow-Origin.");
  }
  if (resolvedCount || definitionFailures.json.length) {
    verdictFor("definition.json", definitionFailures.json, "Resolved JSON.");
  }
  if (resolvedCount) {
    verdictFor("definition.data_only", definitionFailures.dataOnly, "No includes, substitutions or local paths.");
    verdictFor("definition.validates", definitionFailures.validates, "The reference validator reports no errors.");
    verdictFor("definition.front_agent", definitionFailures.front, "The manifest and the graph agree on the front agent.");
    verdictFor("definition.agents_complete", definitionFailures.complete, "Every agent has a description and instructions.");
    verdictFor("definition.schemas", definitionFailures.schemas, "Every callable agent has an object input schema.");
    verdictFor("definition.externals", definitionFailures.externals, report.networks.some((n) => n.externals.length || n.mcps.length)
      ? "Every external network and MCP server is HTTPS and allowed by the peer policy."
      : "No external networks or MCP servers: nothing leaves the site but model calls.");
    verdictFor("definition.private_context", definitionFailures.privateContext, "No agent forwards all private context.");
    const smallest = Math.min(...agentCounts);
    if (smallest >= 2) {
      report.set("definition.multi_agent", Status.PASS, `${agentCounts.join(", ")} agents.`);
    } else {
      report.bad("definition.multi_agent", `A network has ${smallest} agent${smallest === 1 ? "" : "s"}. Fine for a simple site; the interoperability checks start from two.`);
    }
  }

  // One finding per location: a key under "api_key" also matches a key pattern.
  const secretPaths = new Set();
  const uniqueSecrets = secrets.filter((item) => {
    const where = item.split(":")[0];
    if (secretPaths.has(where)) {
      return false;
    }
    secretPaths.add(where);
    return true;
  });
  secrets.length = 0;
  secrets.push(...uniqueSecrets);
  if (secrets.length) {
    report.bad("secrets.none", `${secrets.length} credential-like value${secrets.length === 1 ? "" : "s"} in public files. Values are masked here.`, secrets);
  } else {
    report.set("secrets.none", Status.PASS, "No credential-like values in the public files.");
  }

  // links.json.
  const linksUrl = new URL("links.json", target.base).href;
  fullEnv.onProgress(`Reading ${linksUrl}`);
  const l = await probe(linksUrl, fullEnv);
  report.files.push({ file: "links.json", url: linksUrl, status: l.status ?? null, cors: l.cors });
  if (!l.reachable || l.status === undefined || !l.ok) {
    report.bad("links.file", `links.json is not readable${l.status ? ` (HTTP ${l.status})` : l.reachable ? " from other origins" : ""}. Callers fall back to the URLs written in the network.`);
  } else {
    let links;
    try {
      links = JSON.parse(l.text);
    } catch (error) {
      links = null;
      report.bad("links.file", `links.json is not valid JSON: ${error.message}`);
    }
    if (links) {
      const problems = [];
      if (links.version !== 1) {
        problems.push(`version is ${JSON.stringify(links.version)}, expected 1`);
      }
      if (!links.networks || typeof links.networks !== "object") {
        problems.push("no \"networks\" object");
      } else {
        for (const [net, bindings] of Object.entries(links.networks)) {
          for (const [slot, url] of Object.entries(bindings || {})) {
            const parsed = originOf(url) ? new URL(url) : null;
            if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
              problems.push(`${net}.${slot} is not an absolute HTTP(S) URL`);
            }
          }
        }
      }
      if (l.cors !== true) {
        problems.push("other origins cannot read links.json");
      }
      if (problems.length) {
        report.bad("links.file", "links.json needs attention.", problems);
      } else {
        report.set("links.file", Status.PASS, "Published, well formed and readable from other origins.");
      }
    }
  }

  // Optional discovery metadata at the domain root.
  const wellKnown = new URL("/.well-known/nsdeploy.json", target.base).href;
  const w = await probe(wellKnown, fullEnv);
  if (w.ok && w.status) {
    report.set("discovery.well_known", Status.PASS, `${new URL(wellKnown).origin}/.well-known/nsdeploy.json is published${w.cors ? " and readable from other origins" : ""}. It describes the whole host, not one folder.`);
  } else {
    report.set("discovery.well_known", Status.INFO, "No /.well-known/nsdeploy.json at the domain root. It is optional.");
  }

  return report.finish();
}
