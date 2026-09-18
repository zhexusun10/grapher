import { createWorkspacePaths } from './backend/resources/workspace-paths.mjs';

const paths = createWorkspacePaths('/Users/jerry/Desktop/grapher');

// Test 1: Absolute path to Desktop (no /workspace)
try {
  console.log("Physical for /Users/jerry/Desktop:", paths.physical("/Users/jerry/Desktop"));
} catch (e) { console.error("Test 1 Error:", e.message); }

// Test 2: Command using absolute path to Desktop
try {
  console.log("Command for 'ls /Users/jerry/Desktop':", paths.command("ls /Users/jerry/Desktop"));
} catch (e) { console.error("Test 2 Error:", e.message); }

// Test 3: Command trying to escape /workspace
try {
  console.log("Command for 'ls /workspace/..':", paths.command("ls /workspace/.."));
} catch (e) { console.error("Test 3 Error:", e.message); }
