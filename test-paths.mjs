import { createWorkspacePaths } from './backend/resources/workspace-paths.mjs';

const paths = createWorkspacePaths('/Users/jerry/Desktop/grapher');

// If shellCommands is true (like in Node Agent):
console.log("If shellCommands = true:");
console.log(paths.command("ls -la /workspace"));

// In planner.ts, shellCommands is false. It executes the raw string.
// Let's see what happens if we view the output of `pwd`.
console.log("\nView pwd output:");
console.log(paths.view("/Users/jerry/Desktop/grapher\n"));
