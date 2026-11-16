import { publicationMergerCardId, type Graph, type Snapshot } from "../types";

type NodeGraph = Pick<Graph, "nodes">;

/** Presentation-only helper IDs must never take a real task's graph identity. */
export function graphCardIds(graph: NodeGraph) {
  const taskIds = new Set(graph.nodes.map(node => node.id));
  const occupied = new Set(taskIds);
  const claim = (base: string) => {
    let id = base;
    while (occupied.has(id)) id += "#";
    occupied.add(id);
    return id;
  };
  // Reserve publication even before it runs, keeping node-helper IDs stable.
  const publication = claim(publicationMergerCardId);
  const mergers = new Map<string, string>();
  for (const id of [...taskIds].sort()) mergers.set(id, claim(`merger:${id}`));
  return { publication, mergers };
}

/** Resolve helper conversations by their execution or allocated card, not an ID prefix. */
export function selectedMergerNode(
  graph: NodeGraph,
  mergers: Snapshot["mergers"],
  selected: string,
  selectedMergerId: string,
  cards = graphCardIds(graph),
): string | undefined {
  if (!selected) return;
  const execution = selectedMergerId ? mergers?.find(merger => merger.id === selectedMergerId) : undefined;
  if (execution?.node === "merger" || execution?.node.startsWith("merge:")) return execution.node;
  if (graph.nodes.some(node => node.id === selected)) return;
  if (selected === cards.publication) return "merger";
  for (const [target, id] of cards.mergers) if (selected === id) return `merge:${target}`;
}
