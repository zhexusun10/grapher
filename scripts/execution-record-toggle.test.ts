import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../src/i18n/en.ts";
import { translate } from "../src/i18n/index.ts";

test("execution record toggle copy is simplified without trailing load log text", () => {
  assert.equal(translate("zh-CN", "点击展开执行记录"), "点击展开执行记录");
  assert.equal(translate("zh-CN", "点击收起执行记录"), "点击收起执行记录");
  assert.equal(translate("en", "点击展开执行记录"), "Click to expand execution log");
  assert.equal(translate("en", "点击收起执行记录"), "Click to collapse execution log");
  assert.equal((en as Record<string, string>)["点击展开执行记录并加载日志"], undefined);
});

// Attempt expansion, collapse and scroll anchoring are exercised against the
// actual App in frontend-audit.test.mjs, including reloads and optimistic turns.
