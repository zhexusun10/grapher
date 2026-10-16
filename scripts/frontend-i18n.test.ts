import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  detectLocale, translate, localizeError, localizePlanWarning, readLanguagePreference, resolveLocale,
  restartFrontendWithLanguage, LANGUAGE_PREFERENCE_KEY,
} from "../src/i18n/index.ts";
import { en } from "../src/i18n/en.ts";

const han = /\p{Script=Han}/u;

test("primary system/browser language selects Chinese or English", () => {
  for (const tag of ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hans", "zh-Hant-TW", "ZH_cn"]) {
    assert.equal(detectLocale([tag]), "zh-CN");
  }
  for (const tag of ["en-US", "en-GB", "fr-FR", "ja-JP", "zhx"]) {
    assert.equal(detectLocale([tag]), "en");
  }
  assert.equal(detectLocale(["en-US", "zh-CN"], "zh-CN"), "en");
  assert.equal(detectLocale([], "zh-TW"), "zh-CN");
  assert.equal(detectLocale(undefined, undefined), "en");
});

test("saved language overrides the system; missing, invalid or blocked storage follows the system", () => {
  assert.equal(readLanguagePreference({ getItem: () => "en" }), "en");
  assert.equal(readLanguagePreference({ getItem: () => "zh-CN" }), "zh-CN");
  for (const value of [null, "auto", "fr", "invalid"]) {
    assert.equal(readLanguagePreference({ getItem: () => value }), "auto");
  }
  assert.equal(readLanguagePreference({ getItem: () => { throw new Error("blocked"); } }), "auto");
  assert.equal(resolveLocale("en", ["zh-CN"]), "en");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("auto", ["zh-TW"]), "zh-CN");
});

test("confirmed language changes persist before reload; auto clears the override", () => {
  const events: unknown[][] = [];
  const storage = {
    setItem: (key: string, value: string) => { events.push(["save", key, value]); },
    removeItem: (key: string) => { events.push(["remove", key]); },
  };
  restartFrontendWithLanguage("en", storage, () => { events.push(["reload"]); });
  assert.deepEqual(events, [["save", LANGUAGE_PREFERENCE_KEY, "en"], ["reload"]]);
  events.length = 0;
  restartFrontendWithLanguage("auto", storage, () => { events.push(["reload"]); });
  assert.deepEqual(events, [["remove", LANGUAGE_PREFERENCE_KEY], ["reload"]]);
  events.length = 0;
  assert.throws(() => restartFrontendWithLanguage("zh-CN", {
    ...storage, setItem: () => { throw new Error("storage blocked"); },
  }, () => { events.push(["reload"]); }), /storage blocked/);
  assert.deepEqual(events, [], "failure must not reload or discard unsaved settings");
});

test("Chinese copy and existing English stay unchanged; interpolation preserves user content", () => {
  assert.equal(translate("zh-CN", "思维链推理 (Chain of Thought)"), "思维链推理 (Chain of Thought)");
  for (const language of ["zh-CN", "en"] as const) {
    assert.equal(translate(language, "Build Anything"), "Build Anything");
  }
  const value = "用户内容 {1} $&\n```code```";
  assert.equal(translate("en", "图片 {0}", value), `Image ${value}`);
  assert.equal(translate("zh-CN", "{0}分{1}秒", 2, 5), "2分5秒");
  assert.equal(translate("en", "{0}分{1}秒", 2, 5), "2m 5s");
});

test("all English translations contain no Chinese and preserve placeholders", () => {
  for (const [key, value] of Object.entries(en)) {
    assert.doesNotMatch(value, han, key);
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test("application errors are localized without changing the Chinese version", () => {
  const message = "用户已停止本次执行；可以修改消息或重新运行。";
  assert.equal(localizeError(message, "zh-CN"), message);
  assert.equal(localizeError(message, "en"), en[message]);
  assert.equal(localizeError("Error: 后端未返回有效响应 (503)，请确认终端中的后端已启动。", "en"), "Error: The backend returned an invalid response (503). Make sure the backend is running in your terminal.");
  assert.equal(localizeError("Failed (503)", "en"), "Failed (503)");
  const warn = console.warn;
  const diagnostics: unknown[][] = [];
  try {
    console.warn = (...args) => { diagnostics.push(args); };
    assert.doesNotMatch(localizeError("未预期的本地错误", "en"), han);
    assert.ok(diagnostics.some(args => args.includes("未预期的本地错误")));
  } finally {
    console.warn = warn;
  }
});

test("provider errors include actionable hints and role localization", () => {
  const errZh = localizeError("Partitioner failed: 402: Insufficient Balance (request_id: 123)", "zh-CN");
  assert.ok(errZh.includes("任务分片器 (Partitioner) 失败: 402: Insufficient Balance"));
  assert.ok(errZh.includes("余额不足或额度耗尽"));

  const errEn = localizeError("Partitioner failed: 402: Insufficient Balance (request_id: 123)", "en");
  assert.ok(errEn.includes("Partitioner failed: 402: Insufficient Balance"));
  assert.ok(errEn.includes("Insufficient Balance"));
  assert.ok(errEn.includes("Tip:"));

  const authZh = localizeError("Planner failed: 401: Invalid API Key", "zh-CN");
  assert.ok(authZh.includes("任务规划器 (Planner) 失败:"));
  assert.ok(authZh.includes("认证失败或 API Key 无效"));

  const abortZh = localizeError("Partitioner failed: Pi exited with exit code: 0xc0000409", "zh-CN");
  assert.ok(abortZh.includes("子进程异常退出 (0xc0000409)"));
});

test("execution graph plan warnings are localized without diagnostic code prefixes", () => {
  const w303Raw =
    "W303: If <FEEDBACK> from verify_final_branch_b to integrate_branch_b is applied, the target and dependency descendants will be invalidated: integrate_branch_b, verify_final_branch_b. Completed results must be recomputed; integrate_branch_b continues from its own conversation history. Nodes outside this set are unaffected.";
  const w303Zh = localizePlanWarning(w303Raw, "zh-CN");
  assert.equal(
    w303Zh,
    "若应用从 verify_final_branch_b 到 integrate_branch_b 的 <FEEDBACK>，目标节点及其依赖后代将被置为失效：integrate_branch_b, verify_final_branch_b。已完成的结果必须重新计算；integrate_branch_b 将基于自己的会话历史继续执行。该集合之外的节点不受影响。"
  );
  assert.ok(!w303Zh.includes("W303"));

  const w303En = localizePlanWarning(w303Raw, "en");
  assert.equal(
    w303En,
    "If <FEEDBACK> from verify_final_branch_b to integrate_branch_b is applied, the target and dependency descendants will be invalidated: integrate_branch_b, verify_final_branch_b. Completed results must be recomputed; integrate_branch_b continues from its own conversation history. Nodes outside this set are unaffected."
  );
  assert.ok(!w303En.includes("W303"));

  const w301Raw = "W301: Nodes first, second have identical task text; they may duplicate work. Confirm that this is intentional.";
  assert.equal(localizePlanWarning(w301Raw, "zh-CN"), "节点 first, second 包含相同的任务描述，可能存在重复工作。请确认这是否符合预期。");
  assert.equal(localizePlanWarning(w301Raw, "en"), "Nodes first, second have identical task text; they may duplicate work. Confirm that this is intentional.");

  const w302Raw = "W302: review mentions <FEEDBACK> but has no outgoing feedback edge; the marker cannot send feedback.";
  assert.equal(localizePlanWarning(w302Raw, "zh-CN"), "review 提及了 <FEEDBACK>，但没有向外发出的反馈边；该标记无法发送反馈。");
  assert.equal(localizePlanWarning(w302Raw, "en"), "review mentions <FEEDBACK> but has no outgoing feedback edge; the marker cannot send feedback.");

  // Unrecognized warning codes have their prefix stripped
  assert.equal(localizePlanWarning("W399: Generic warning text", "en"), "Generic warning text");
  assert.equal(localizePlanWarning("W399: Generic warning text", "zh-CN"), "Generic warning text");

  // Retained warnings from older backends remain readable in both locales.
  const legacyW303 = w303Raw.replace("continues from its own conversation history", "continues its conversation");
  for (const warning of [w303Raw, legacyW303]) {
    assert.equal(localizePlanWarning(warning, "zh-CN"), w303Zh);
    assert.equal(localizePlanWarning(warning, "en"), w303En);
    assert.equal(localizeError(warning, "zh-CN"), w303Zh);
    assert.equal(localizeError(warning, "en"), w303En);
  }
});

for (const [systemLanguage, preference] of [["zh-CN", "en"], ["en-US", "zh-CN"], ["fr-FR", "auto"]]) {
  test(`settings language ${preference} overrides ${systemLanguage} after reload`, () => {
    const output = execFileSync(process.execPath, ["scripts/fixtures/frontend-i18n-smoke.mjs", systemLanguage, preference], { encoding: "utf8", timeout: 30_000 });
    assert.ok(output.includes(`UI smoke passed: ${systemLanguage}`));
  });
}

for (const language of ["en-US", "zh-CN", "zh-TW", "fr-FR"]) {
  test(`UI rendering follows ${language} on a fresh page load`, () => {
    const output = execFileSync(process.execPath, ["scripts/fixtures/frontend-i18n-smoke.mjs", language], { encoding: "utf8", timeout: 30_000 });
    assert.ok(output.includes(`UI smoke passed: ${language}`));
  });
}
