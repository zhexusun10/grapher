import assert from "node:assert/strict";
import test from "node:test";
import { plannerUserTurns } from "../src/services/plannerUserTurns.ts";

test("only completed Planner user turns replace optimistic messages", () => {
  const line = (type: string, content: string) => JSON.stringify({
    type, message: { role: "user", content: [{ type: "text", text: content }] },
  });
  assert.deepEqual(plannerUserTurns([
    line("message_start", "User query:\n\nOriginal"),
    line("message_end", "User query:\n\nOriginal"),
    line("message_start", "still pending"),
    line("message_end", "Current graph node status:\n- worker: done\n\n继续优化"),
    "{incomplete",
  ].join("\n")), ["Original", "继续优化"]);
});
