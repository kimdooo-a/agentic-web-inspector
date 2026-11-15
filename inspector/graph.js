// Draws an agent network as a layered SVG: the front agent, the agents it reaches,
// and the external networks and MCP servers at the edge. No libraries.

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 188;
const NODE_H = 40;
const COL_GAP = 64;
const ROW_GAP = 16;
const PAD = 16;

/** Place nodes in columns by their distance from the front agent. */
export function layout(graph) {
  const depth = new Map();
  const children = new Map();
  for (const edge of graph.edges) {
    if (!children.has(edge.from)) {
      children.set(edge.from, []);
    }
    children.get(edge.from).push(edge.to);
  }
  const walk = (start) => {
    depth.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift();
      for (const next of children.get(id) || []) {
        if (!depth.has(next)) {
          depth.set(next, depth.get(id) + 1);
          queue.push(next);
        }
      }
    }
  };
  const start = graph.front && graph.nodes.some((n) => n.id === graph.front) ? graph.front : graph.nodes[0]?.id;
  if (start) {
    walk(start);
  }
  // Parts the front agent does not reach start their own walk from column 0.
  const incoming = new Set(graph.edges.map((e) => e.to));
  for (const node of graph.nodes) {
    if (!depth.has(node.id) && !incoming.has(node.id)) {
      walk(node.id);
    }
  }
  for (const node of graph.nodes) {
    if (!depth.has(node.id)) {
      walk(node.id);
    }
  }
  const columns = [];
  for (const node of graph.nodes) {
    const d = depth.get(node.id);
    (columns[d] = columns[d] || []).push(node);
  }
  const placed = new Map();
  const rows = Math.max(1, ...columns.map((c) => (c ? c.length : 0)));
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;
  columns.forEach((column, c) => {
    if (!column) {
      return;
    }
    const colHeight = column.length * NODE_H + (column.length - 1) * ROW_GAP;
    const top = (height - colHeight) / 2;
    column.forEach((node, r) => {
      placed.set(node.id, {
        ...node,
        x: PAD + c * (NODE_W + COL_GAP),
        y: top + r * (NODE_H + ROW_GAP),
      });
    });
  });
  const width = PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * COL_GAP;
  return { nodes: placed, width, height };
}

/** Shorten a label to fit a node. */
function fit(text, max = 24) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Short label for an external URL: host and network name. */
function externalLabel(node) {
  try {
    const url = new URL(node.label);
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    return `${url.host}/${last}`;
  } catch {
    return node.label;
  }
}

/**
 * Render the graph into an <svg> element.
 *
 * :param graph: {front, nodes, edges} from networkGraph().
 * :param doc: The document to create elements in.
 * :return: The SVG element.
 */
export function renderGraph(graph, doc = document) {
  const { nodes, width, height } = layout(graph);
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Agent network with ${graph.nodes.length} nodes; front agent ${graph.front}.`);
  svg.classList.add("netmap");
  const edges = doc.createElementNS(SVG_NS, "g");
  edges.setAttribute("class", "netmap-edges");
  for (const edge of graph.edges) {
    const a = nodes.get(edge.from);
    const b = nodes.get(edge.to);
    if (!a || !b) {
      continue;
    }
    const path = doc.createElementNS(SVG_NS, "path");
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const backwards = x2 <= x1;
    const d = backwards
      ? `M ${a.x + NODE_W / 2} ${a.y + NODE_H} C ${a.x + NODE_W / 2} ${a.y + NODE_H + 30}, ${b.x + NODE_W / 2} ${b.y + NODE_H + 30}, ${b.x + NODE_W / 2} ${b.y + NODE_H}`
      : `M ${x1} ${y1} C ${x1 + COL_GAP / 2} ${y1}, ${x2 - COL_GAP / 2} ${y2}, ${x2} ${y2}`;
    path.setAttribute("d", d);
    path.setAttribute("class", `netmap-edge kind-${b.kind}`);
    edges.append(path);
  }
  svg.append(edges);
  for (const node of nodes.values()) {
    const g = doc.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `netmap-node kind-${node.kind}`);
    g.setAttribute("transform", `translate(${node.x} ${node.y})`);
    const rect = doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(NODE_H));
    rect.setAttribute("rx", node.kind === "remote" || node.kind === "mcp" ? "20" : "8");
    const label = doc.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(NODE_W / 2));
    label.setAttribute("y", String(NODE_H / 2 + 1));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    const text = node.kind === "remote" ? externalLabel(node) : node.label;
    label.textContent = fit(node.kind === "mcp" ? `MCP ${externalLabel(node)}` : text);
    const title = doc.createElementNS(SVG_NS, "title");
    title.textContent = `${node.kind === "front" ? "Front agent" : node.kind === "remote" ? "Peer network" : node.kind === "mcp" ? "MCP server" : node.kind === "missing" ? "Missing reference" : "Agent"}: ${node.label}`;
    g.append(title, rect, label);
    svg.append(g);
  }
  return svg;
}
