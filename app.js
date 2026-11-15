// The inspector page. One page object, App.page, owns the state; the page's own form
// and the assistant's website_* tools call the same methods (see site-actions.js).

import { CHECKS, checkById } from "./inspector/catalog.js";
import { inspect, parseTarget } from "./inspector/checks.js";
import { renderGraph } from "./inspector/graph.js";
import { KNOWN_SITES, resolveSite } from "./inspector/directory.js";

const STATUS_LABEL = { pass: "Pass", fail: "Fail", warn: "Warning", info: "Note", skip: "Skipped" };
const VERDICT_LABEL = {
  "conforms": "Conforms to the MVP profile",
  "conforms-with-warnings": "Conforms, with warnings",
  "does-not-conform": "Does not conform yet",
  "incomplete": "Could not read the files",
};

/** Format a date as "2026-11-15" and "Sun, Nov 15, 2026". */
function today(now = new Date()) {
  return {
    iso: now.toISOString().slice(0, 10),
    label: now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  };
}

/** Turn a report into Markdown, for an issue or a pull request. */
export function reportMarkdown(report) {
  const lines = [];
  lines.push(`## Agentic Web Inspector report`);
  lines.push("");
  lines.push(`- Target: ${report.target.url || "(invalid address)"}`);
  lines.push(`- Verdict: **${VERDICT_LABEL[report.verdict]}** · callable by other agent sites: **${report.callable ? (report.callableScope === "public" ? "yes" : "yes (local)") : "no"}**`);
  lines.push(`- Inspected: ${report.inspectedAt} (${report.mode === "browser" ? "in a browser: CORS enforced by the browser" : "CORS read from headers"})`);
  lines.push("");
  lines.push("| Status | Check | Spec | Result |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of report.results) {
    const message = [r.message, ...(r.details || []).slice(0, 4)].join("<br>").replace(/\|/g, "\\|");
    lines.push(`| ${STATUS_LABEL[r.status]} | ${r.title} | §${r.section} | ${message} |`);
  }
  return lines.join("\n");
}

/** A view that draws nothing, for Node tests and the CLI. */
class NullView {
  render() {}
  busy() {}
}

/** Draws the page from the page object's state. */
class DomView {
  constructor(doc) {
    this.doc = doc;
    this.el = {
      form: doc.querySelector("#inspect-form"),
      input: doc.querySelector("#inspect-url"),
      button: doc.querySelector("#inspect-button"),
      formError: doc.querySelector("#inspect-error"),
      progress: doc.querySelector("#inspect-progress"),
      results: doc.querySelector("#results"),
      verdict: doc.querySelector("#verdict"),
      checks: doc.querySelector("#checks"),
      networks: doc.querySelector("#networks"),
      copy: doc.querySelector("#copy-report"),
      download: doc.querySelector("#download-report"),
      presets: doc.querySelector("#presets"),
      history: doc.querySelector("#history"),
    };
  }

  /** Show progress while an inspection runs. */
  busy(running, text = "") {
    this.el.button.disabled = running;
    this.el.button.textContent = running ? "Inspecting…" : "Inspect";
    this.el.progress.textContent = text;
  }

  /** Show the page's own refusal next to the address field. */
  refusal(reason) {
    this.el.formError.textContent = reason || "";
    this.el.input.setAttribute("aria-invalid", reason ? "true" : "false");
  }

  /** Render the latest report and the history. */
  render(state, report) {
    this.refusal("");
    this.renderHistory(state.history);
    if (!report) {
      return;
    }
    const doc = this.doc;
    this.el.results.hidden = false;
    // Verdict.
    const v = this.el.verdict;
    v.replaceChildren();
    v.className = `verdict verdict-${report.verdict}`;
    const cards = [
      ["Specification", VERDICT_LABEL[report.verdict], `${report.counts.fail} fail · ${report.counts.warn} warn · ${report.counts.pass} pass`],
      ["Callable by other agent sites", report.callable ? (report.callableScope === "public" ? "Yes" : "Yes, on this machine") : "No", report.callable ? "Manifest and network load from other origins." : "Another site's browser could not load this network."],
      report.mode !== "browser"
        ? ["Checked by", "Response headers", "No browser enforced CORS."]
        : report.sameOrigin
          ? ["Checked by", "This browser, same origin", "CORS read from the response headers."]
          : ["Checked by", "This browser, cross-origin", "The browser itself allowed or blocked each read."],
    ];
    for (const [label, value, note] of cards) {
      const card = doc.createElement("div");
      card.className = "verdict-card";
      const l = doc.createElement("span");
      l.className = "verdict-label";
      l.textContent = label;
      const val = doc.createElement("strong");
      val.textContent = value;
      const n = doc.createElement("span");
      n.className = "verdict-note";
      n.textContent = note;
      card.append(l, val, n);
      v.append(card);
    }
    const target = doc.createElement("p");
    target.className = "verdict-target";
    target.textContent = report.target.url || "";
    v.append(target);
    // Checks, grouped, failures first inside each group.
    const order = { fail: 0, warn: 1, info: 2, skip: 3, pass: 4 };
    const groups = new Map();
    for (const result of report.results) {
      if (!groups.has(result.group)) {
        groups.set(result.group, []);
      }
      groups.get(result.group).push(result);
    }
    this.el.checks.replaceChildren();
    // Groups with failures come first, then warnings, so the first screen shows what to fix.
    const worst = (results) => Math.min(...results.map((r) => order[r.status]));
    const sortedGroups = [...groups].sort((a, b) => worst(a[1]) - worst(b[1]));
    for (const [group, results] of sortedGroups) {
      const section = doc.createElement("section");
      section.className = "check-group";
      const h = doc.createElement("h3");
      h.textContent = group;
      section.append(h);
      const list = doc.createElement("ul");
      for (const result of [...results].sort((a, b) => order[a.status] - order[b.status])) {
        const item = doc.createElement("li");
        item.className = `check status-${result.status}`;
        item.id = `check-${result.id.replace(/\./g, "-")}`;
        const pill = doc.createElement("span");
        pill.className = "pill";
        pill.textContent = STATUS_LABEL[result.status];
        const body = doc.createElement("div");
        body.className = "check-body";
        const title = doc.createElement("div");
        title.className = "check-title";
        title.textContent = result.title;
        const sec = doc.createElement("span");
        sec.className = "check-section";
        sec.textContent = `§${result.section}`;
        title.append(" ", sec);
        const message = doc.createElement("p");
        message.className = "check-message";
        message.textContent = result.message;
        body.append(title, message);
        if (result.details && result.details.length) {
          const details = doc.createElement("ul");
          details.className = "check-details";
          for (const d of result.details.slice(0, 12)) {
            const li = doc.createElement("li");
            li.textContent = d;
            details.append(li);
          }
          body.append(details);
        }
        if (result.status === "fail" || result.status === "warn") {
          const entry = checkById(result.id);
          const fix = doc.createElement("details");
          fix.className = "check-fix";
          const summary = doc.createElement("summary");
          summary.textContent = "How to fix";
          const why = doc.createElement("p");
          why.textContent = entry.why;
          const how = doc.createElement("p");
          how.className = "check-how";
          how.textContent = entry.fix;
          fix.append(summary, why, how);
          body.append(fix);
        }
        item.append(pill, body);
        list.append(item);
      }
      section.append(list);
      this.el.checks.append(section);
    }
    // Networks and their maps.
    this.el.networks.replaceChildren();
    for (const network of report.networks) {
      const card = doc.createElement("article");
      card.className = "network-card";
      const h = doc.createElement("h3");
      h.textContent = network.name;
      const url = doc.createElement("code");
      url.textContent = network.url;
      const p = doc.createElement("p");
      p.textContent = network.description || "";
      const meta = doc.createElement("p");
      meta.className = "network-meta";
      meta.textContent = `Front agent ${network.frontMan} · ${network.agents} agent${network.agents === 1 ? "" : "s"} · ${network.externals.length} peer network${network.externals.length === 1 ? "" : "s"} · ${network.mcps.length} MCP server${network.mcps.length === 1 ? "" : "s"}`;
      const map = doc.createElement("div");
      map.className = "netmap-wrap";
      map.append(renderGraph(network.graph, doc));
      card.append(h, url, p, meta, map);
      if (network.sampleQueries.length) {
        const q = doc.createElement("ul");
        q.className = "samples";
        for (const sample of network.sampleQueries) {
          const li = doc.createElement("li");
          li.textContent = sample;
          q.append(li);
        }
        const qh = doc.createElement("h4");
        qh.textContent = "Published sample queries";
        card.append(qh, q);
      }
      this.el.networks.append(card);
    }
  }

  renderHistory(history) {
    this.el.history.replaceChildren();
    for (const item of history) {
      const li = this.doc.createElement("li");
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "history-item";
      button.dataset.url = item.url;
      button.textContent = `${item.callable ? "●" : "○"} ${item.url.replace(/^https?:\/\//, "")}`;
      button.title = `${VERDICT_LABEL[item.verdict]} · ${item.at}`;
      li.append(button);
      this.el.history.append(li);
    }
    this.el.history.parentElement.hidden = history.length === 0;
  }
}

/** The page object: state, rules and operations. */
export class InspectorPage {
  constructor(view, env = {}) {
    this.view = view;
    this.env = env;
    this.version = 0;
    this.latest = null;
    this.history = [];
    this.running = null;
  }

  /** The address of the page, for resolving relative entries. */
  pageUrl() {
    return this.env.pageUrl || (typeof location !== "undefined" ? location.href : "http://localhost/");
  }

  /** Known agentic websites, with absolute addresses. */
  knownSites() {
    return KNOWN_SITES.map((entry) => ({ ...entry, url: resolveSite(entry, this.pageUrl()) }));
  }

  /** A short form of a report for the agents: what failed, what it means. */
  summary(report) {
    if (!report) {
      return null;
    }
    return {
      target: report.target.url || null,
      inspectedAt: report.inspectedAt,
      verdict: report.verdict,
      verdictLabel: VERDICT_LABEL[report.verdict],
      callableByOtherSites: report.callable,
      callableScope: report.callableScope,
      checkedBy: report.mode,
      counts: report.counts,
      problems: report.results
        .filter((r) => r.status === "fail" || r.status === "warn")
        .map((r) => ({ checkId: r.id, status: r.status, title: r.title, specSection: r.section, message: r.message, details: (r.details || []).slice(0, 6) })),
      notes: report.results.filter((r) => r.status === "info").map((r) => ({ checkId: r.id, title: r.title, message: r.message })),
      networks: report.networks.map((n) => ({ name: n.name, networkUrl: n.url, frontAgent: n.frontMan, agents: n.agents, peerNetworks: n.externals, mcpServers: n.mcps, sampleQueries: n.sampleQueries })),
    };
  }

  /** Plain JSON state for the read action. */
  getState() {
    return {
      today: today(),
      version: this.version,
      inspecting: this.running,
      latestInspection: this.summary(this.latest),
      history: this.history.map((h) => ({ ...h })),
      knownSites: this.knownSites(),
    };
  }

  /**
   * Read-only check of an address: what an inspection would contact. Changes nothing.
   *
   * :return: {ok: true, url, origin, files} or {ok: false, reason, field}.
   */
  checkTarget(url) {
    const target = parseTarget(url);
    if (!target.ok) {
      return { ok: false, reason: target.reason, field: "url" };
    }
    if (this.running) {
      return { ok: false, reason: `An inspection of ${this.running} is still running. Wait for it to finish.`, field: "url" };
    }
    const base = new URL(target.base);
    return {
      ok: true,
      url: target.url,
      origin: base.origin,
      network: target.network,
      files: ["agent-manifest.json", "the network definition it names", "links.json", "/.well-known/nsdeploy.json"],
    };
  }

  /**
   * Inspect an address and show the report on the page.
   *
   * :return: The summary, or {ok: false, reason, field} without changing anything.
   */
  async inspect(url) {
    const check = this.checkTarget(url);
    if (!check.ok) {
      this.view.refusal?.(check.reason);
      return check;
    }
    this.running = check.url;
    this.view.busy(true, `Contacting ${check.origin}…`);
    let report;
    try {
      report = await inspect(check.url, {
        fetchImpl: this.env.fetchImpl,
        pageOrigin: this.env.pageOrigin === undefined ? (typeof location !== "undefined" ? location.origin : null) : this.env.pageOrigin,
        onProgress: (text) => this.view.busy(true, text),
      });
    } finally {
      this.running = null;
      this.view.busy(false, "");
    }
    this.latest = report;
    this.version += 1;
    this.history = [
      { url: check.url, verdict: report.verdict, callable: report.callable, at: report.inspectedAt },
      ...this.history.filter((h) => h.url !== check.url),
    ].slice(0, 6);
    this.view.render(this.getState(), report);
    return { ok: true, version: this.version, inspection: this.summary(report) };
  }

  /** The full latest report, for export. */
  latestReport() {
    return this.latest;
  }

  /** Catalog entries, all or one. */
  checklist(checkId) {
    const list = checkId ? CHECKS.filter((c) => c.id === checkId) : CHECKS;
    return list.map((c) => ({ checkId: c.id, group: c.group, title: c.title, specSection: c.section, levelWhenNotMet: c.level, why: c.why, fix: c.fix }));
  }
}

/** Wires the page's own controls to the page object. */
export class App {
  static page = null;

  static start() {
    if (typeof window === "undefined" || typeof document === "undefined" || !document.querySelector("#inspect-form")) {
      App.page = new InspectorPage(new NullView());
      return;
    }
    const view = new DomView(document);
    App.page = new InspectorPage(view);
    view.el.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void App.page.inspect(view.el.input.value);
    });
    for (const site of App.page.knownSites()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preset";
      button.textContent = site.name;
      button.title = `${site.note}\n${site.url}`;
      button.addEventListener("click", () => {
        view.el.input.value = site.url;
        void App.page.inspect(site.url);
      });
      view.el.presets.append(button);
    }
    view.el.history.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-url]");
      if (button) {
        view.el.input.value = button.dataset.url;
        void App.page.inspect(button.dataset.url);
      }
    });
    view.el.copy.addEventListener("click", async () => {
      const report = App.page.latestReport();
      if (!report) {
        return;
      }
      try {
        await navigator.clipboard.writeText(reportMarkdown(report));
        view.el.copy.textContent = "Copied";
      } catch {
        view.el.copy.textContent = "Copy failed";
      }
      setTimeout(() => { view.el.copy.textContent = "Copy as Markdown"; }, 1600);
    });
    view.el.download.addEventListener("click", () => {
      const report = App.page.latestReport();
      if (!report) {
        return;
      }
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "agentic-web-inspection.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    // ?url=... fills in the address, so a check can be shared as a link. The visitor
    // still presses Inspect: no site is contacted before they choose to.
    const shared = new URLSearchParams(location.search).get("url");
    if (shared) {
      view.el.input.value = shared;
      view.el.progress.textContent = "Press Inspect to read this site's public agent files.";
    }
  }
}

App.start();
