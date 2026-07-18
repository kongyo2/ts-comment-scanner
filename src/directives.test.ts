import { describe, it, expect } from "vitest";
import { detectDirective, isLegalComment } from "./directives.js";

describe("detectDirective", () => {
  it.each([
    ["// @ts-ignore", "@ts-ignore"],
    ["// @ts-expect-error reason", "@ts-expect-error"],
    ["// @ts-nocheck", "@ts-nocheck"],
    ["// @ts-check", "@ts-check"],
    ["//@ts-ignore no space", "@ts-ignore"],
    ["///@ts-ignore triple-slash form", "@ts-ignore"],
    ["/// @ts-expect-error triple-slash form", "@ts-expect-error"],
  ])("detects TypeScript compiler directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("treats commented-out directives with extra slashes as ordinary comments", () => {
    expect(detectDirective("line", "//// @ts-ignore")).toBeUndefined();
    expect(detectDirective("line", "// / @ts-ignore")).toBeUndefined();
    expect(detectDirective("line", "/// eslint-disable-next-line no-console")).toBeUndefined();
    expect(detectDirective("line", "///# sourceMappingURL=x.map")).toBeUndefined();
    expect(detectDirective("line", "///#region")).toBeUndefined();
  });

  it.each([
    ["// eslint-disable-next-line no-console", "eslint-disable-next-line"],
    ["// eslint-disable-line", "eslint-disable-line"],
    ["// eslint-enable", "eslint-enable"],
    ["// oxlint-disable-next-line", "oxlint-disable-next-line"],
    ["// biome-ignore lint: reason", "biome-ignore"],
    ["// deno-lint-ignore no-explicit-any", "deno-lint-ignore"],
    ["// prettier-ignore", "prettier-ignore"],
    ["// oxfmt-ignore", "oxfmt-ignore"],
    ["// tslint:disable-next-line:no-any", "tslint:disable-next-line"],
    ["// jshint ignore:line", "jshint"],
    ["// jscs:disable requireCurlyBraces", "jscs:disable"],
    ["// jscs:enable", "jscs:enable"],
    ["// jscs: enable", "jscs:enable"],
    ["// jscs:ignore requireCurlyBraces", "jscs:ignore"],
  ])("detects linter directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("detects block-form jshint option comments", () => {
    expect(detectDirective("block", "/* jshint esversion: 6 */")).toBe("jshint");
    expect(detectDirective("block", "/* jshint ignore:start */")).toBe("jshint");
    expect(detectDirective("block", "/* jshint -W034 */")).toBe("jshint");
  });

  it("follows label-plus-options directives onto later lines", () => {
    expect(detectDirective("block", "/* jshint\n   esversion: 6\n*/")).toBe("jshint");
    expect(detectDirective("block", '/* eslint\n   quotes: ["error", "double"]\n*/')).toBe("eslint");
    expect(detectDirective("block", "/* globals\n   window, document\n*/")).toBe("globals");
    // The label still has to open the comment.
    expect(detectDirective("block", "/* notes\n   jshint esversion: 6\n*/")).toBeUndefined();
  });

  it("splits joined directives on every JS line terminator", () => {
    expect(detectDirective("block", "/* jshint\r * esversion: 6\r */")).toBe("jshint");
    expect(detectDirective("block", "/* jshint\u2028 * esversion: 6\u2028 */")).toBe("jshint");
    expect(detectDirective("block", "/* jshint\u2029 * esversion: 6\u2029 */")).toBe("jshint");
  });

  it("keeps bare or prose mentions of the legacy tools ordinary", () => {
    expect(detectDirective("line", "// jshint")).toBeUndefined();
    expect(detectDirective("line", "// jshint is no longer used here")).toBeUndefined();
    expect(detectDirective("line", "// jscs:configuration notes")).toBeUndefined();
    expect(detectDirective("line", "// oxfmt-ignores nothing")).toBeUndefined();
  });

  it("rejects hyphenated lookalikes of the formatter suppressions", () => {
    expect(detectDirective("line", "// oxfmt-ignore-more")).toBeUndefined();
    expect(detectDirective("line", "// prettier-ignore-more")).toBeUndefined();
    expect(detectDirective("line", "// prettier-ignore-start")).toBe("prettier-ignore-start");
  });

  it("requires formatter suppressions to be the whole comment, like their parsers", () => {
    expect(detectDirective("line", "// oxfmt-ignore is obsolete")).toBeUndefined();
    expect(detectDirective("line", "// prettier-ignore because it is hand-aligned")).toBeUndefined();
    expect(detectDirective("block", "/* oxfmt-ignore\nprose */")).toBeUndefined();
    expect(detectDirective("block", "/* prettier-ignore\nprose */")).toBeUndefined();
    expect(detectDirective("block", "/* oxfmt-ignore */")).toBe("oxfmt-ignore");
  });

  it("detects block-form eslint directives", () => {
    expect(detectDirective("block", "/* eslint-disable no-console */")).toBe("eslint-disable");
    expect(detectDirective("block", '/* eslint eqeqeq: "error" */')).toBe("eslint");
    expect(detectDirective("block", "/* global describe, it */")).toBe("global");
    expect(detectDirective("block", "/* globals window */")).toBe("globals");
    expect(detectDirective("block", "/* exported helper */")).toBe("exported");
  });

  it("does not treat eslint config or global forms as directives in line comments", () => {
    expect(detectDirective("line", "// eslint is a nice tool")).toBeUndefined();
    expect(detectDirective("line", "// global state is bad")).toBeUndefined();
  });

  it.each([
    ["/* istanbul ignore next */", "istanbul-ignore-next"],
    ["/* istanbul ignore file */", "istanbul-ignore-file"],
    ["/* c8 ignore start */", "c8-ignore-start"],
    ["/* c8 ignore next */", "c8-ignore-next"],
    ["/* v8 ignore next 3 */", "v8-ignore-next"],
    ["/* node:coverage disable */", "node:coverage-disable"],
    ["/* node:coverage ignore next */", "node:coverage-ignore"],
  ])("detects coverage directives with their mode: %s", (text, expected) => {
    expect(detectDirective("block", text)).toBe(expected);
  });

  it("detects coverage pragmas in line comments too, like Vitest's v8 provider", () => {
    // The c8 CLI and Node core only parse block comments, but
    // ast-v8-to-istanbul (Vitest coverage) strips `//` as well, so a line
    // comment can be an active hint and has to stay protected.
    expect(detectDirective("line", "// c8 ignore next")).toBe("c8-ignore-next");
    expect(detectDirective("line", "// v8 ignore next")).toBe("v8-ignore-next");
    expect(detectDirective("line", "// node:coverage ignore next")).toBe("node:coverage-ignore");
    expect(detectDirective("line", "// istanbul ignore next")).toBe("istanbul-ignore-next");
  });

  it("matches @ts suppression directives by prefix, like the compiler", () => {
    expect(detectDirective("line", "// @ts-ignoreTODO fix later")).toBe("@ts-ignore");
    expect(detectDirective("block", "/* note\n@ts-expect-errorfoo */")).toBe("@ts-expect-error");
  });

  it("keeps the compiler's case rules: suppressions are case-sensitive, check pragmas are not", () => {
    expect(detectDirective("line", "// @ts-IGNORE")).toBeUndefined();
    expect(detectDirective("line", "// @TS-NOCHECK")).toBe("@ts-nocheck");
    expect(detectDirective("line", "// @ts-nocheckfoo")).toBeUndefined();
    expect(detectDirective("line", "// @ts-nocheck extra words")).toBe("@ts-nocheck");
  });

  it("honours block @ts directives only on the block's last line, like TypeScript", () => {
    expect(detectDirective("block", "/* @ts-ignore */")).toBe("@ts-ignore");
    expect(detectDirective("block", "/* note\n@ts-expect-error */")).toBe("@ts-expect-error");
    expect(detectDirective("block", "/* note\n * @ts-ignore */")).toBe("@ts-ignore");
    expect(detectDirective("block", "/* note\n  * @ts-ignore */")).toBe("@ts-ignore");
    expect(detectDirective("block", "/* note\r@ts-ignore */")).toBe("@ts-ignore");
    expect(detectDirective("block", "/* @ts-ignore\nnote */")).toBeUndefined();
  });

  it("treats a block whose closing line is blank as ordinary, matching tsc exactly", () => {
    // tsc slices the literal last line of the comment; when the directive sits
    // on an earlier line the comment is inert, so it must stay removable.
    expect(detectDirective("block", "/* @ts-ignore\n */")).toBeUndefined();
    expect(detectDirective("block", "/* @ts-expect-error\n\t*/")).toBeUndefined();
    expect(detectDirective("block", "/* @ts-ignore\u2028*/")).toBeUndefined();
  });

  it("rejects marker runs broken by whitespace, matching tsc's block regex", () => {
    // tsc allows whitespace, then one run of `/`/`*`, then whitespace before
    // the directive; `/ * @ts-ignore */` interleaves them and is inert.
    expect(detectDirective("block", "/* / * @ts-ignore */")).toBeUndefined();
    expect(detectDirective("block", "/*@ts-ignore*/")).toBe("@ts-ignore");
    expect(detectDirective("block", "/** @ts-expect-error */")).toBe("@ts-expect-error");
  });

  it("keeps block-form check pragmas ordinary, since TypeScript ignores them", () => {
    expect(detectDirective("block", "/* @ts-nocheck */")).toBeUndefined();
    expect(detectDirective("block", "/* @ts-check */")).toBeUndefined();
  });

  it("treats leading stars in line comments as content, not markers", () => {
    expect(detectDirective("line", "// * eslint-disable-next-line no-console")).toBeUndefined();
    expect(detectDirective("line", "// * prettier-ignore")).toBeUndefined();
  });

  // The pragma names are assembled at runtime so vitest's own docblock-environment
  // detection does not pick them up from this test file's source.
  const jestPragma = ["@jest", "environment"].join("-");
  const vitestPragma = ["@vitest", "environment"].join("-");

  it.each([
    ['/* webpackChunkName: "chunk" */', "webpack-magic-comment"],
    ["/* turbopackIgnore: true */", "turbopack-magic-comment"],
    ["/* turbopackOptional: true */", "turbopack-magic-comment"],
    ["/* @vite-ignore */", "@vite-ignore"],
    ["/* #__PURE__ */", "#__PURE__"],
    ["/* @__NO_SIDE_EFFECTS__ */", "@__NO_SIDE_EFFECTS__"],
    ["/* @jsxImportSource preact */", "@jsxImportSource"],
    [`/** ${jestPragma} jsdom */`, jestPragma],
    [`/** ${vitestPragma} happy-dom */`, vitestPragma],
  ])("detects bundler and tooling pragmas: %s", (text, expected) => {
    expect(detectDirective("block", text)).toBe(expected);
  });

  it("detects triple-slash references only for line comments", () => {
    expect(detectDirective("line", '/// <reference path="./a.d.ts" />')).toBe("triple-slash-reference");
    expect(detectDirective("line", '/// <amd-module name="m" />')).toBe("triple-slash-amd-module");
    expect(detectDirective("line", "/// just a heavy comment")).toBeUndefined();
  });

  it("detects editor folding regions", () => {
    expect(detectDirective("line", "//#region helpers")).toBe("#region");
    expect(detectDirective("line", "// #endregion")).toBe("#endregion");
  });

  it("detects source map pragmas", () => {
    expect(detectDirective("line", "//# sourceMappingURL=index.js.map")).toBe("sourceMappingURL");
    expect(detectDirective("line", "//@ sourceMappingURL=legacy.js.map")).toBe("sourceMappingURL");
    expect(detectDirective("line", "//# sourceURL=eval.js")).toBe("sourceURL");
    expect(detectDirective("block", "/*# sourceMappingURL=styles.css.map */")).toBe("sourceMappingURL");
  });

  it("looks past jsdoc stars for the first content line", () => {
    expect(detectDirective("block", `/**\n * ${jestPragma} jsdom\n */`)).toBe(jestPragma);
  });

  it("finds docblock pragmas on later lines too", () => {
    expect(detectDirective("block", "/** docs first\n * @jsxImportSource preact\n */")).toBe("@jsxImportSource");
    expect(detectDirective("block", `/** docs first\n * ${vitestPragma} jsdom\n */`)).toBe(vitestPragma);
  });

  it("keeps line-form docblock pragmas ordinary", () => {
    expect(detectDirective("line", "// @jsx h")).toBeUndefined();
  });

  it("detects test-environment pragmas the way Vitest matches them", () => {
    // Vitest runs a bare regex over the file (also accepting the @jest-
    // spellings), so line comments, later lines, mid-text hits and the
    // -options form are all live. A tag without a value is inert.
    expect(detectDirective("line", `// ${jestPragma} jsdom`)).toBe(jestPragma);
    expect(detectDirective("line", `// ${vitestPragma} happy-dom`)).toBe(vitestPragma);
    expect(detectDirective("line", `// see ${vitestPragma} jsdom`)).toBe(vitestPragma);
    expect(detectDirective("block", `/** ${vitestPragma}-options {"url": "https://example.com"} */`)).toBe(
      `${vitestPragma}-options`,
    );
    expect(detectDirective("line", `// ${vitestPragma}`)).toBeUndefined();
    expect(detectDirective("line", `// ${vitestPragma}-options`)).toBeUndefined();
  });

  it("detects Vitest module tags right after the comment marker", () => {
    const tag = ["@module", "tag"].join("-");
    expect(detectDirective("line", `// ${tag} slow`)).toBe("@module-tag");
    expect(detectDirective("block", `/* ${tag} integration/db */`)).toBe("@module-tag");
    expect(detectDirective("line", `// see ${tag} slow`)).toBeUndefined();
    expect(detectDirective("line", `// ${tag}`)).toBeUndefined();
  });

  it("detects prettier pragma-mode pragmas only in docblocks", () => {
    expect(detectDirective("block", "/** @format */")).toBe("@format");
    expect(detectDirective("block", "/**\n * @prettier\n */")).toBe("@prettier");
    expect(detectDirective("block", "/** @noformat */")).toBe("@noformat");
    expect(detectDirective("block", "/** @noprettier */")).toBe("@noprettier");
    // jest-docblock keys run through `-`/`_`, so this is a different pragma.
    expect(detectDirective("block", "/** @prettier-plugin notes */")).toBeUndefined();
    expect(detectDirective("line", "// @format")).toBeUndefined();
  });

  it.each([
    ["// rome-ignore lint(correctness/noUnusedVariables): not used yet", "rome-ignore"],
    ["// rome-ignore format: hand aligned", "rome-ignore"],
    ["// ROME_IGNORE lint: legacy casing", "rome-ignore"],
    ["/* rome-ignore parse: why */", "rome-ignore"],
  ])("detects Rome suppressions: %s", (text, expected) => {
    const kind = text.startsWith("//") ? "line" : "block";
    expect(detectDirective(kind, text)).toBe(expected);
  });

  it("requires Rome's mandatory colon and known categories", () => {
    // Without the colon Rome reports MissingColon and the suppression is inert.
    expect(detectDirective("line", "// rome-ignore format explanation")).toBeUndefined();
    expect(detectDirective("line", "// rome-ignore banana: reason")).toBeUndefined();
  });

  it("detects JSLint directives only when they hug the comment marker", () => {
    expect(detectDirective("block", "/*jslint devel, browser*/")).toBe("jslint");
    expect(detectDirective("line", "//jslint devel")).toBe("jslint");
    expect(detectDirective("block", "/*property a, b*/")).toBe("property");
    expect(detectDirective("block", "/* jslint devel */")).toBeUndefined();
    expect(detectDirective("block", "/*jslint*/")).toBeUndefined();
    expect(detectDirective("block", "/*JSLINT devel*/")).toBeUndefined();
    expect(detectDirective("block", "/*jslint-disable*/")).toBe("jslint-disable");
    expect(detectDirective("block", "/*jslint-enable*/")).toBe("jslint-enable");
    expect(detectDirective("line", "//jslint-ignore-line")).toBe("jslint-ignore-line");
    expect(detectDirective("line", "//jslint-quiet")).toBe("jslint-quiet");
    expect(detectDirective("line", "// jslint-quiet")).toBeUndefined();
  });

  it.each([
    ['// @deno-types="npm:@types/express"', "@deno-types"],
    ["// @deno-types=./mod.d.ts", "@deno-types"],
    ['// @ts-types="npm:@types/lodash"', "@ts-types"],
    ['// @TS-Types="case-insensitive"', "@ts-types"],
    ["// @ts-self-types='./mod.d.ts'", "@ts-self-types"],
  ])("detects Deno type directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("requires the Deno type directives' assignment shape", () => {
    expect(detectDirective("line", "// @deno-types")).toBeUndefined();
    // The newer names require a quoted specifier, unlike @deno-types.
    expect(detectDirective("line", "// @ts-types=bare")).toBeUndefined();
    expect(detectDirective("line", "// the @deno-types directive is neat")).toBeUndefined();
  });

  it("detects dprint pragmas the way dprint bounds them", () => {
    expect(detectDirective("line", "// dprint-ignore")).toBe("dprint-ignore");
    expect(detectDirective("line", "// dprint-ignore because it is hand-aligned")).toBe("dprint-ignore");
    expect(detectDirective("line", "// keep (dprint-ignore) as is")).toBe("dprint-ignore");
    expect(detectDirective("line", "// dprint-ignore-file")).toBe("dprint-ignore-file");
    // The TS plugin has no start/end pair, but the bounded substring check
    // still fires on the hyphenated form, exactly like dprint itself.
    expect(detectDirective("line", "// dprint-ignore-start")).toBe("dprint-ignore");
    // A JSDoc star defeats dprint's whitespace-only skip for the file form,
    // but the node-level substring search still finds it.
    expect(detectDirective("block", "/** dprint-ignore-file */")).toBe("dprint-ignore");
    expect(detectDirective("line", "// dprint-ignored")).toBeUndefined();
  });

  it("detects the organize-imports opt-out only in its literal form", () => {
    expect(detectDirective("line", "// organize-imports-ignore")).toBe("organize-imports-ignore");
    expect(detectDirective("line", "// note // organize-imports-ignore")).toBe("organize-imports-ignore");
    // The plugin greps for the literal `// organize-imports-ignore`.
    expect(detectDirective("line", "//organize-imports-ignore")).toBeUndefined();
    expect(detectDirective("block", "/* organize-imports-ignore */")).toBeUndefined();
  });

  it("detects js-beautify directive comments in their exact shape", () => {
    expect(detectDirective("block", "/* beautify ignore:start */")).toBe("beautify");
    expect(detectDirective("block", "/* beautify preserve:end */")).toBe("beautify");
    expect(detectDirective("block", "/*beautify ignore:start*/")).toBeUndefined();
    expect(detectDirective("block", "/* beautify foo:bar */")).toBeUndefined();
  });

  it.each([
    ["/* @__KEY__ */", "@__KEY__"],
    ["/* @__MANGLE_PROP__ */", "@__MANGLE_PROP__"],
    ["//@__PURE__", "@__PURE__"],
    ["/* hello @__NOINLINE__ because reasons */", "@__NOINLINE__"],
  ])("detects terser annotations as substrings like terser: %s", (text, expected) => {
    const kind = text.startsWith("//") ? "line" : "block";
    expect(detectDirective(kind, text)).toBe(expected);
  });

  it("keeps lowercase or single-underscore lookalikes of terser annotations ordinary", () => {
    expect(detectDirective("line", "// @__pure__")).toBeUndefined();
    expect(detectDirective("line", "// @_PURE_")).toBeUndefined();
  });

  it.each([
    ["// type-coverage:ignore-line", "type-coverage:ignore-line"],
    ["// type-coverage:ignore-next-line", "type-coverage:ignore-next-line"],
    ["// ts-prune-ignore-next", "ts-prune-ignore-next"],
  ])("detects TS ecosystem ignores: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("detects Stryker directives with their exact spacing and mandatory mutator list", () => {
    expect(detectDirective("line", "// Stryker disable all")).toBe("stryker-disable");
    expect(detectDirective("line", "// Stryker disable next-line all: reason")).toBe("stryker-disable-next-line");
    expect(detectDirective("line", "// Stryker restore booleans, strings")).toBe("stryker-restore");
    expect(detectDirective("line", "//Stryker disable all")).toBe("stryker-disable");
    expect(detectDirective("block", "/* Stryker restore all */")).toBe("stryker-restore");
    // Two spaces, lowercase, or a missing mutator list defeat the
    // instrumenter's /^\s?Stryker .../ regex.
    expect(detectDirective("line", "//  Stryker disable all")).toBeUndefined();
    expect(detectDirective("line", "// stryker disable all")).toBeUndefined();
    expect(detectDirective("line", "// Stryker disable")).toBeUndefined();
  });

  it("detects typescript-strict-plugin pragmas by token equality", () => {
    expect(detectDirective("line", "// @ts-strict-ignore")).toBe("@ts-strict-ignore");
    expect(detectDirective("line", "// @ts-strict")).toBe("@ts-strict");
    // The CLI splits lines on spaces, so the token matches anywhere.
    expect(detectDirective("line", "// legacy file @ts-strict-ignore")).toBe("@ts-strict-ignore");
    expect(detectDirective("line", "// @ts-strict-ignored")).toBeUndefined();
  });

  it("detects Flow pragmas and suppressions", () => {
    expect(detectDirective("line", "// @flow")).toBe("@flow");
    expect(detectDirective("line", "// @flow strict")).toBe("@flow");
    expect(detectDirective("block", "/**\n * @flow strict-local\n */")).toBe("@flow");
    expect(detectDirective("line", "// @noflow")).toBe("@noflow");
    expect(detectDirective("line", "// @flowfoo")).toBeUndefined();
    expect(detectDirective("line", "// $FlowFixMe[incompatible-call] reason")).toBe("$FlowFixMe");
    expect(detectDirective("line", "//$FlowExpectedError[prop-missing]")).toBe("$FlowExpectedError");
    expect(detectDirective("line", "// $FlowIssue")).toBe("$FlowIssue");
    expect(detectDirective("line", "// see $FlowFixMe above")).toBeUndefined();
    expect(detectDirective("line", "// flowlint sketchy-null:off")).toBe("flowlint");
    expect(detectDirective("line", "// flowlint-next-line untyped-import:error")).toBe("flowlint-next-line");
    expect(detectDirective("line", "// flowlint is picky")).toBeUndefined();
  });

  it("requires webpack-style magic comments to put the colon right after the key", () => {
    // webpack's gate regex is /webpack[A-Z][A-Za-z]+:/ — a space before the
    // colon (or a JSDoc block, whose stars break the object-literal eval)
    // keeps the comment inert.
    expect(detectDirective("block", '/* webpackChunkName : "chunk" */')).toBeUndefined();
    expect(detectDirective("block", '/** webpackChunkName: "chunk" */')).toBeUndefined();
    expect(detectDirective("block", "/** turbopackIgnore: true */")).toBeUndefined();
  });

  it("detects the Bun pragma only as the literal line prefix", () => {
    expect(detectDirective("line", "// @bun")).toBe("@bun");
    expect(detectDirective("line", "// @bun @bytecode")).toBe("@bun");
    expect(detectDirective("line", "//@bun")).toBeUndefined();
    expect(detectDirective("block", "/* @bun */")).toBeUndefined();
  });

  it("detects fast-refresh pragmas", () => {
    expect(detectDirective("line", "// @refresh reset")).toBe("@refresh-reset");
    expect(detectDirective("block", "/* @refresh reset */")).toBe("@refresh-reset");
    // react-refresh greps the whole comment for the substring.
    expect(detectDirective("line", "// please @refresh reset here")).toBe("@refresh-reset");
    // solid-refresh requires its pragma to be the entire comment.
    expect(detectDirective("line", "// @refresh skip")).toBe("@refresh-skip");
    expect(detectDirective("line", "// @refresh reload")).toBe("@refresh-reload");
    expect(detectDirective("line", "// @refresh skip extra")).toBeUndefined();
  });

  it.each([
    ["// nx-ignore-next-line", "nx-ignore-next-line"],
    ["// million-ignore", "million-ignore"],
    ["// @million skip", "@million-skip"],
    ["// @million jsx-skip", "@million-jsx-skip"],
    ["// @unocss-include", "@unocss-include"],
    ["// @unocss-ignore", "@unocss-ignore"],
    ["// @unocss-skip-start", "@unocss-skip-start"],
    ["// @unocss-skip-end", "@unocss-skip-end"],
    ["// @next-codemod-error missing await", "@next-codemod-error"],
    ["// @next-codemod-ignore", "@next-codemod-ignore"],
  ])("detects framework tooling markers: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("detects embedded-language tag comments as whole comments", () => {
    expect(detectDirective("block", "/* GraphQL */")).toBe("GraphQL");
    // graphql-tag-pluck trims and lowercases, so line comments count too.
    expect(detectDirective("line", "// graphql")).toBe("GraphQL");
    expect(detectDirective("block", "/* GraphQL query */")).toBeUndefined();
    expect(detectDirective("block", "/* HTML */")).toBe("HTML");
    expect(detectDirective("block", "/* html */")).toBeUndefined();
    expect(detectDirective("line", "// HTML")).toBeUndefined();
  });

  it("detects NOSONAR as a case-insensitive comment prefix", () => {
    expect(detectDirective("line", "// NOSONAR")).toBe("NOSONAR");
    expect(detectDirective("line", "// nosonar because reasons")).toBe("NOSONAR");
    expect(detectDirective("block", "/** NOSONAR */")).toBe("NOSONAR");
    expect(detectDirective("line", "// fix NOSONAR")).toBeUndefined();
  });

  it("detects semgrep suppressions", () => {
    expect(detectDirective("line", "// nosemgrep")).toBe("nosemgrep");
    expect(detectDirective("line", "// nosemgrep: rule-id-1, rule-id-2")).toBe("nosemgrep");
    expect(detectDirective("line", "// nosem")).toBe("nosemgrep");
    expect(detectDirective("line", "// suppressed via nosemgrep")).toBe("nosemgrep");
    expect(detectDirective("line", "// nosemantic analysis")).toBeUndefined();
  });

  it("detects CodeQL and LGTM suppressions in single-line comments only", () => {
    expect(detectDirective("line", "// lgtm[js/sql-injection]")).toBe("lgtm");
    expect(detectDirective("line", "// LGTM [js/xss]")).toBe("lgtm");
    expect(detectDirective("line", "// lgtm")).toBe("lgtm");
    expect(detectDirective("line", "// fixed; lgtm")).toBe("lgtm");
    expect(detectDirective("line", "// looks good, lgtm!")).toBeUndefined();
    expect(detectDirective("block", "/* note\nlgtm[js/xss] */")).toBeUndefined();
    expect(detectDirective("line", "// codeql[js/redundant-operation]")).toBe("codeql");
    expect(detectDirective("line", "// codeql")).toBeUndefined();
  });

  it.each([
    ["// skipcq: JS-0002, JS-0003", "skipcq"],
    ["// legacy API skipcq", "skipcq"],
    ["// deepcode ignore Ssrf: test helper", "deepcode-ignore"],
    ["// file deepcode ignore HardcodedPassword: fixture", "deepcode-ignore"],
    ["// no-dd-sa", "no-dd-sa"],
    ["// no-dd-sa:javascript-code-style/one-liner", "no-dd-sa"],
    ["// datadog-disable ruleset/rule", "datadog-disable"],
    ["// test secret gitleaks:allow", "gitleaks:allow"],
    ["// trufflehog:ignore", "trufflehog:ignore"],
    ["// pragma: allowlist secret", "pragma-allowlist-secret"],
    ["// pragma: whitelist secret", "pragma-allowlist-secret"],
    ["// pragma: allowlist nextline secret", "pragma-allowlist-nextline-secret"],
    ["// pragma: allowlist-secret", "pragma-allowlist-secret"],
  ])("detects security scanner suppressions: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("keeps docblock stars in front of datadog markers inert, like the analyzer", () => {
    expect(detectDirective("block", "/* no-dd-sa */")).toBe("no-dd-sa");
    expect(detectDirective("block", "/** no-dd-sa */")).toBeUndefined();
  });

  it.each([
    ["// cspell:disable", "cspell:disable"],
    ["// cSpell:ignore façade naïve", "cspell:ignore"],
    ["// spell-checker: disable-next-line", "cspell:disable-next-line"],
    ["// spellchecker:enable", "cspell:enable"],
    ["// spell:words foo bar", "cspell:words"],
    ["// cspell::ignore x", "cspell:ignore"],
    ["// cspell:ignoreRegExp /x+/g", "cspell:ignoreregexp"],
    ["// cspell:dictionaries typescript", "cspell:dictionaries"],
    ["// LocalWords: teh alot", "LocalWords"],
  ])("detects cspell in-document directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it("keeps cspell-less prose ordinary", () => {
    expect(detectDirective("line", "// cspell: check this wording")).toBeUndefined();
    expect(detectDirective("line", "// misspelled words here")).toBeUndefined();
    expect(detectDirective("line", "// localwords: not the marker")).toBeUndefined();
  });

  it("detects codespell ignores only after a punctuation boundary", () => {
    expect(detectDirective("line", "// codespell:ignore")).toBe("codespell:ignore");
    expect(detectDirective("line", "// codespell:ignore alot,teh")).toBe("codespell:ignore");
    expect(detectDirective("line", "// x; codespell:ignore teh")).toBe("codespell:ignore");
    expect(detectDirective("line", "// codespell:ignore-next-line")).toBe("codespell:ignore-next-line");
    expect(detectDirective("line", "// prose codespell:ignore")).toBeUndefined();
  });

  it("detects JetBrains suppressions and injections", () => {
    expect(detectDirective("line", "// noinspection JSUnusedGlobalSymbols")).toBe("noinspection");
    expect(detectDirective("line", "//noinspection SpellCheckingInspection,JSUnresolvedReference")).toBe(
      "noinspection",
    );
    expect(detectDirective("block", "/* noinspection JSUnusedLocalSymbols */")).toBeUndefined();
    expect(detectDirective("line", "// noinspection")).toBeUndefined();
    expect(detectDirective("line", '// <editor-fold desc="Setup">')).toBe("editor-fold");
    expect(detectDirective("line", "// </editor-fold>")).toBe("editor-fold-end");
    expect(detectDirective("line", "// language=SQL")).toBe("language-injection");
    expect(detectDirective("line", "//language=RegExp prefix=a suffix=b")).toBe("language-injection");
    expect(detectDirective("line", "// the language= setting")).toBeUndefined();
  });

  it("detects ReSharper suppressions as line comments", () => {
    expect(detectDirective("line", "// ReSharper disable once InconsistentNaming")).toBe("resharper-disable");
    expect(detectDirective("line", "// ReSharper restore All")).toBe("resharper-restore");
    expect(detectDirective("block", "/* ReSharper disable Foo */")).toBeUndefined();
    expect(detectDirective("line", "// resharper disable Foo")).toBeUndefined();
  });

  it("returns undefined for ordinary comments", () => {
    expect(detectDirective("line", "// TODO: fix this")).toBeUndefined();
    expect(detectDirective("block", "/* explanation of the algorithm */")).toBeUndefined();
    expect(detectDirective("block", "/** documented API */")).toBeUndefined();
    expect(detectDirective("line", "//")).toBeUndefined();
  });

  it("does not report a directive mentioned mid-sentence", () => {
    expect(detectDirective("line", "// remove the @ts-ignore above")).toBeUndefined();
    expect(detectDirective("block", "/* docs mention eslint-disable here */")).toBeUndefined();
  });

  it("requires the magic-comment key form for turbopack, like webpack", () => {
    expect(detectDirective("block", "/* turbopack */")).toBeUndefined();
    expect(detectDirective("line", "// turbopack is fast")).toBeUndefined();
  });
});

describe("isLegalComment", () => {
  it.each([
    "/*! preserved banner */",
    "//! rust-style banner",
    "/* @license MIT */",
    "/**\n * @preserve\n */",
    "// @copyright 2026 someone",
    "// SPDX-License-Identifier: MIT",
    "/* SPDX-FileCopyrightText: 2026 someone <someone@example.com> */",
    "// spdx-license-identifier: Apache-2.0",
  ])("recognises %s", (text) => {
    expect(isLegalComment(text)).toBe(true);
  });

  it("does not treat prose mentioning SPDX as legal", () => {
    expect(isLegalComment("// add an SPDX-License-Identifier here later")).toBe(false);
  });

  it("returns false for ordinary comments", () => {
    expect(isLegalComment("// just a note")).toBe(false);
    expect(isLegalComment("/* block */")).toBe(false);
  });
});
