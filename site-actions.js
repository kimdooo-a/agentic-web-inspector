// Registers the inspector's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// Each action wraps a method of App.page, the same methods the page's own form uses.
import { App } from "./app.js";
import { checkIds } from "./inspector/catalog.js";

/**
 * Describes the inspector's operations as actions the agents can call.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.getInspectionAction());
    actions.register(SiteActions.getChecklistAction());
    actions.register(SiteActions.inspectSiteAction());
  }

  /** The read action: the latest report on the page, the history and known sites. */
  static getInspectionAction() {
    return {
      name: "get_inspection",
      description: "Read the latest inspection shown on this page (target, verdict, whether other agent sites can call it, every failing or warning check with its spec section and details, and the networks found), the recent history, today's date, and a list of known agentic websites with their addresses. Changes nothing and contacts no one.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: () => App.page.getState(),
    };
  }

  /** The read action over the check catalog: why each check exists and how to fix it. */
  static getChecklistAction() {
    return {
      name: "get_checklist",
      description: "Read the inspector's check catalog: for each check, its title, the MVP specification section it comes from, why it matters and how to fix it. Pass checkId to read one check. Changes nothing and contacts no one.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          checkId: {
            type: "string",
            enum: checkIds(),
            description: "One check id from a report's problems, such as manifest.cors. Leave out to read all checks.",
          },
        },
      },
      execute: (args) => ({ checks: App.page.checklist(args.checkId) }),
    };
  }

  /**
   * The inspection. It contacts the website at the given address, so the visitor
   * confirms it first: "irreversible" here means "contacts someone".
   */
  static inspectSiteAction() {
    return {
      name: "inspect_site",
      description: "Inspect an agentic website: read its public agent-manifest.json, the network definition it names, links.json and /.well-known/nsdeploy.json from this browser, without cookies or keys, and show the report on this page. The browser asks the visitor first, because it contacts that website. Returns the report summary, or ok false with a reason. Does not run the site's agents or code.",
      effect: "irreversible",
      timeoutMs: 60000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "The address the visitor gave or chose from knownSites: a network URL (site folder then network name) or a site folder.",
          },
        },
      },
      execute: (args) => App.page.inspect(args.url),
    };
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
