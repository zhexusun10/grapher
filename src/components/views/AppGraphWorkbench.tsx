import type { ComponentProps } from "react";
import { GraphWorkbench } from "./GraphWorkbench";
import { TaskNode } from "../graph/TaskNode";
import { SmoothWorkflowEdge } from "../graph/WorkflowEdge";

// Keep React Flow's node and edge implementations inside the on-demand
// workbench boundary instead of pulling them into the landing page.
const nodeTypes = { work: TaskNode };
const edgeTypes = { workflow: SmoothWorkflowEdge };

type Props = Omit<ComponentProps<typeof GraphWorkbench>, "nodeTypes" | "edgeTypes">;

export function AppGraphWorkbench(props: Props) {
  return <GraphWorkbench {...props} nodeTypes={nodeTypes} edgeTypes={edgeTypes} />;
}
