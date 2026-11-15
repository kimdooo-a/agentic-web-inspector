// Known open agentic websites to try. The first public entries come from the
// community list at https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/agentic_websites.md
// Add yours with a pull request.

export const KNOWN_SITES = Object.freeze([
  {
    id: "this-site",
    name: "Agentic Web Inspector (this site)",
    url: "./agentic_web_inspector",
    note: "The inspector inspecting itself.",
  },
  {
    id: "challenge-guide",
    name: "The Open Agentic Web Challenge guide",
    url: "https://worldwideagenticweb.org/wp-content/plugins/wwaw-agent-widget/assets/worldwide_agentic_web_widget/v1.0.9/worldwide_agentic_web_widget",
    note: "Answers questions about the Open Agentic Web and the challenge.",
  },
  {
    id: "broken-example",
    name: "A deliberately broken example",
    url: "./examples/broken_site/helpdesk",
    note: "Ships with this repository: eight common publishing mistakes in one site.",
  },
]);

/** Resolve a directory entry's address against the page. */
export function resolveSite(entry, pageUrl) {
  return new URL(entry.url, pageUrl).href;
}
