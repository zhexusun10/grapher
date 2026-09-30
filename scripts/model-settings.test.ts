import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig, type Config } from "../src/types.ts";
import { modelRoles, planningModelRoles, roleModelConfig, updateRoleModelConfig } from "../src/modelConfig.ts";
import { RoleModelSettings } from "../src/components/RoleModelSettings.tsx";

const legacy: Config = { ...defaultConfig, model: "example/default", thinkingLevel: "high" };

test("legacy settings inherit models but Partitioner defaults to thinking off", () => {
  assert.deepEqual(roleModelConfig(legacy, "partitioner"), { model: "example/default", thinkingLevel: "off" });
  assert.deepEqual(roleModelConfig(legacy, "planner"), { model: "example/default", thinkingLevel: "high" });
  assert.deepEqual(roleModelConfig(legacy, "nodeAgent"), { model: "example/default", thinkingLevel: "high" });
});

test("role selections and thinking levels update independently and round-trip", () => {
  let config = updateRoleModelConfig(legacy, "partitioner", { model: "example/small", thinkingLevel: "off" });
  config = updateRoleModelConfig(config, "planner", { model: "example/large", thinkingLevel: "max" });
  config = updateRoleModelConfig(config, "nodeAgent", { model: "example/coder", thinkingLevel: "low" });
  config = JSON.parse(JSON.stringify(config));
  assert.equal(config.model, "example/coder");
  assert.equal(config.thinkingLevel, "low");
  assert.deepEqual(roleModelConfig(config, "partitioner"), { model: "example/small", thinkingLevel: "off" });
  assert.deepEqual(roleModelConfig(config, "planner"), { model: "example/large", thinkingLevel: "max" });
  assert.deepEqual(roleModelConfig(config, "nodeAgent"), { model: "example/coder", thinkingLevel: "low" });
  assert.equal(legacy.roleModels, undefined);
});

test("thinking-only customization keeps model inheritance; environment has precedence", () => {
  let config = updateRoleModelConfig(legacy, "planner", { thinkingLevel: "medium" });
  assert.deepEqual(roleModelConfig(config, "planner"), { model: "example/default", thinkingLevel: "medium" });
  config = updateRoleModelConfig(config, "partitioner", { thinkingLevel: "high" });
  assert.equal(roleModelConfig(config, "partitioner").thinkingLevel, "high");
  assert.deepEqual(roleModelConfig(config, "planner", { planner: "env/model", plannerThinking: "off" }), { model: "env/model", thinkingLevel: "off" });
});

test("preflight uses only the roles required for the selected mode", () => {
  assert.deepEqual(planningModelRoles("serial"), ["nodeAgent"]);
  assert.deepEqual(planningModelRoles("graph"), ["planner", "nodeAgent"]);
  assert.deepEqual(planningModelRoles("auto"), ["partitioner", "planner", "nodeAgent"]);
});

test("settings expose three model and thinking selectors with recommendations", () => {
  const markup = renderToStaticMarkup(React.createElement(RoleModelSettings, { config: legacy, setConfig: () => {}, busy: false }));
  for (const role of modelRoles) {
    assert.ok(markup.includes(`${role.label} 模型配置`));
    assert.ok(markup.includes(`${role.label} 思维等级`));
  }
  assert.ok(markup.includes("推荐选择小型"));
  assert.ok(markup.includes("推荐选择中大型"));
  assert.ok(markup.includes('value="off" selected=""'));
  assert.equal((markup.match(/class="role-model-card"/g) ?? []).length, 3);
});
