# Agentic Web Inspector

**Can other agent sites call yours?** Paste a network URL and find out, in your own browser.

**Live site:** https://kimdooo-a.github.io/agentic-web-inspector/  
**Network URL:** `https://kimdooo-a.github.io/agentic-web-inspector/agentic_web_inspector`

The Agentic Web Inspector checks an open agentic website against the
[Open Agentic Web MVP specification](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md)
(Profile 0.2). It reads the site's public agent files the same way a caller site does,
validates the network with the reference runtime's own validator, and turns every rule into
a result with its spec section and a fix.

It is itself an open agentic website: its two-agent network runs in your browser on the
LLM key you choose, can inspect sites for you after you confirm, explains each check and
plans the fixes. Other agent sites can call it too.

## Why

Publishing an agentic website means getting several static files exactly right:
`agent-manifest.json`, a resolved `.network.json`, `links.json`, CORS headers, a peer
policy, no keys. When one is wrong, nothing tells you: the site works on its own page and
silently fails when another site tries to load it.

The key question, whether another origin may read your files, is decided by the browser's
CORS rules. A command-line check can only read headers. The Inspector asks the browser
itself: if this page, on its own origin, can read your manifest and network, so can other
agent sites. If the browser blocks the read, the Inspector tells "reachable but not shared"
apart from "unreachable".

## What it checks

25 checks, grouped as they appear in the report:

| Group | Checks | Spec |
| --- | --- | --- |
| Address | network URL or site folder, HTTPS (loopback HTTP noted) | 3.2 (1), 3.3 |
| Public files | manifest reachable, CORS, valid JSON, complete entries; `links.json`; optional `/.well-known/nsdeploy.json` | 3.3, 3.4 |
| Resolution | exact network name, definition fetch, definition CORS | 3.2 (5)(6), 3.3 |
| Network | resolved JSON, data only (no includes, `${...}` substitutions or local paths), reference validator, front agent agrees with the manifest, descriptions and instructions, input schemas, two or more agents | 2, 2.1, 2.2, 3.1, 6 |
| Inference | default router metadata, no keys or tokens in public files (masked in the report) | 3.3, 4 |
| Trust | peer policy, allowed peers are origins, external networks and MCP servers allowed by the policy, private context only by named fields, coded-tool integrity | 2.1, 3.2 (4), 5 |

The report gives two verdicts: **conformance** (no failing check) and **callable by other
agent sites** (the manifest and network load from another origin over HTTPS). A site may
conform with a same-origin deployment and still not be callable: the report says which.

Every inspection is read only. It fetches public files without cookies or credentials,
never runs the inspected site's code or agents, and masks anything that looks like a key.

## The agent network

`agentic_web_inspector.hocon` (built into `agentic_web_inspector.network.json`):

| Agent | Job | Tools |
| --- | --- | --- |
| `inspector_desk` (front) | Inspects on request, reports verdicts, explains checks | `website_get_inspection`, `website_get_checklist`, `website_inspect_site`, `fix_planner` |
| `fix_planner` | Turns failing checks into an ordered fix plan, using only the check catalog | `website_get_checklist` |

Site actions (`site-actions.js`), each a method of the page object in `app.js` that the
page's own form also uses:

| Action | Effect | What it does |
| --- | --- | --- |
| `get_inspection` | read | Latest report summary, history, known sites |
| `get_checklist` | read | Check catalog: spec section, why, fix |
| `inspect_site` | irreversible | Contacts the given website. The browser asks you first, showing the origin and the files it will read |

Network URL: the folder that holds `agent-manifest.json`, then `agentic_web_inspector`.
Other agent sites that call it get no site tools, so their assistant points to this page.

The assistant sends your messages, and the report it reads, to the LLM provider you pick
in **⚙ AI model settings**, on your own key. The site pays for no model calls. It also
works with a local model and no key at all: choose Ollama
(`http://127.0.0.1:11434/v1`, for example `gemma4:e4b`) when you run the site locally.
To remove a saved key, open **Advanced settings (optional)**, select **Delete setup**,
and close the tab.

## Run it locally

Needs Node.js 22 or newer. No dependencies.

```shell
node tools/serve.mjs . --port 8080
```

Open http://127.0.0.1:8080/ and press one of the **Try** buttons.

To see a real cross-origin block, serve the broken example on a second origin without
CORS headers and inspect it from the first:

```shell
node tools/serve.mjs examples/broken_site --port 8081 --host localhost --no-cors
# then inspect http://localhost:8081/helpdesk from http://127.0.0.1:8080/
```

## Command line and CI

The same checks run in a terminal. Without a browser, the CORS checks read the
`Access-Control-Allow-Origin` header instead.

```shell
node tools/inspect.mjs https://your.site/agents/my_network          # readable report
node tools/inspect.mjs https://your.site/agents/my_network --json   # machine-readable
node tools/inspect.mjs https://your.site/agents/my_network --strict # fail on warnings too
```

Exit code 0 when the site conforms, 1 when a check fails (or warns, with `--strict`).

## Tests

```shell
npm test
```

20 tests: the inspection engine against real local servers (this site, the broken example,
this site without CORS) and simulated browser CORS outcomes; and the agent network with the
real runtime and a scripted model (tool table, read tools, the confirmation gate, a decline
that contacts no one, an approved inspection that matches the page's own form).

To rebuild the network after editing the `.hocon`, use the build script from the
[agentic-web](https://github.com/cognizant-ai-labs/agentic-web) repository:

```shell
node <agentic-web>/skills/agentify-website/scripts/build_network.mjs agentic_web_inspector.hocon --manifest agent-manifest.json
```

## Deploy

Any static host works. `_headers` (Netlify, Cloudflare Pages) sends
`Access-Control-Allow-Origin: *` on the public agent files only and the sandbox CSP on
`runtime/sandbox-worker.js`. For GitHub Pages, which sends `Access-Control-Allow-Origin: *`
on every file, no configuration is needed; the `.nojekyll` file keeps `.well-known/`
published.

## Files

```text
index.html, styles.css, app.js    the inspector page; app.js holds the page object (App.page)
inspector/checks.js               the inspection engine (browser and Node)
inspector/catalog.js              the 25 checks: spec section, why, fix
inspector/graph.js                network map (SVG, no libraries)
inspector/directory.js            known agentic websites for the Try buttons
site.js, site-actions.js          mounts the assistant; registers the site actions
assistant.css                     assistant layout
agentic_web_inspector.hocon       the agent network (source)
agentic_web_inspector.network.json, agent-manifest.json, links.json, agent-mcp.json,
.well-known/, bridge/             the published agent files (built)
runtime/                          the browser runtime from the agentic-web repository, unchanged
examples/broken_site/             a deliberately broken site for demos and tests
tools/serve.mjs, tools/inspect.mjs  local server with the right headers; command-line inspector
tests/                            node:test suites
```

## Add your site to the list

The **Try** buttons come from `inspector/directory.js`. Pull requests that add public
agentic websites are welcome. The community list lives in the
[agentic-web repository](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/agentic_websites.md).

## License

MIT, see `LICENSE`. `runtime/` is the nsdeploy browser runtime, Apache License 2.0, see
`runtime/LICENSE.txt` and `runtime/README.md`.
