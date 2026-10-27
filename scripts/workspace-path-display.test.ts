import assert from "node:assert/strict";
import { test } from "node:test";
import { workspacePathDisplay } from "../src/components/layout/workspacePathDisplay.ts";

test("formats Windows workspace paths consistently for display", () => {
  assert.equal(workspacePathDisplay("C:/Users/me/project"), "C:\\Users\\me\\project");
  assert.equal(workspacePathDisplay("C:\\Users/me\\project"), "C:\\Users\\me\\project");
  assert.equal(workspacePathDisplay("\\\\?\\C:\\Users/me"), "C:\\Users\\me");
  assert.equal(workspacePathDisplay("\\\\?\\UNC\\server\\share/project"), "\\\\server\\share\\project");
});

test("leaves POSIX workspace paths unchanged", () => {
  assert.equal(workspacePathDisplay("/home/me/project"), "/home/me/project");
  assert.equal(workspacePathDisplay("/home/me/a\\b"), "/home/me/a\\b");
});
