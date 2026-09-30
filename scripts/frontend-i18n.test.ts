import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import {
  detectLocale, translate, localizeError, readLanguagePreference, resolveLocale,
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

test("all application UI Chinese literals are localized and translation keys exist", () => {
  const root = path.resolve("src");
  let translated = 0;
  for (const file of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file) || file.startsWith("i18n")) continue;
    const full = path.join(root, file);
    const source = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const key = node.arguments[0];
        assert.ok(key && ts.isStringLiteral(key), `${file}: translation key must be static`);
        assert.ok(Object.hasOwn(en, key.text), `${file}: missing translation for ${key.text}`);
        translated++;
      }
      if (ts.isJsxText(node)) assert.doesNotMatch(node.text, han, `${file}: untranslated JSX text`);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && han.test(node.text)) {
        const parent = node.parent;
        const isKey = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "t" && parent.arguments[0] === node;
        const isBackendErrorMatch = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "includes" && file.endsWith("runtime.ts");
        assert.ok(isKey || isBackendErrorMatch, `${file}: untranslated literal ${node.text}`);
      }
      if (ts.isTemplateExpression(node)) {
        assert.doesNotMatch(node.head.text + node.templateSpans.map(span => span.literal.text).join(""), han, `${file}: untranslated template`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(translated > 400, "coverage must include the full frontend, not just navigation");
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
