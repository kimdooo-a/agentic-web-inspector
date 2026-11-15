#!/usr/bin/env node
// Command-line inspector: the same checks as the web page, for CI and scripts.
//
//   node tools/inspect.mjs <network URL | site folder URL> [--json] [--strict]
//
// Exit code 0 when the site conforms, 1 when a check fails, 2 on bad usage.
// --strict also fails on warnings. Under Node there is no browser to enforce CORS, so
// the CORS checks read the Access-Control-Allow-Origin header instead.

import { inspect } from "../inspector/checks.js";

const ICON = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO", skip: "SKIP" };

/** Print a report as readable text. */
function printReport(report) {
  const lines = [];
  lines.push(`Agentic Web Inspector — ${report.target.url || report.target.reason}`);
  lines.push(`Mode: ${report.mode === "browser" ? "browser (CORS enforced by the browser)" : "headers (CORS read from response headers)"}`);
  lines.push("");
  let group = "";
  for (const result of report.results) {
    if (result.group !== group) {
      group = result.group;
      lines.push(group);
    }
    lines.push(`  [${ICON[result.status]}] ${result.title} (spec ${result.section})`);
    lines.push(`         ${result.message}`);
    for (const detail of result.details || []) {
      lines.push(`         - ${detail}`);
    }
  }
  lines.push("");
  const c = report.counts;
  lines.push(`Verdict: ${report.verdict} · ${c.pass} pass · ${c.fail} fail · ${c.warn} warn · ${c.info} info · ${c.skip} skipped`);
  lines.push(`Callable by other agent sites: ${report.callable ? (report.callableScope === "public" ? "yes" : "yes, on this machine (loopback HTTP)") : "no"}`);
  for (const network of report.networks) {
    lines.push(`Network URL: ${network.url} (front agent ${network.frontMan}, ${network.agents} agent${network.agents === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
if (!target) {
  console.error("Usage: node tools/inspect.mjs <network URL | site folder URL> [--json] [--strict]");
  process.exit(2);
}
const report = await inspect(target, { pageOrigin: null });
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : printReport(report));
const failed = report.counts.fail > 0 || (args.includes("--strict") && report.counts.warn > 0);
process.exit(failed ? 1 : 0);
