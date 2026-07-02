import { describe, it, expect } from "vitest";
import { detectDirective, isLegalComment } from "./directives.js";

describe("detectDirective", () => {
  it.each([
    ["// @ts-ignore", "@ts-ignore"],
    ["// @ts-expect-error reason", "@ts-expect-error"],
    ["// @ts-nocheck", "@ts-nocheck"],
    ["// @ts-check", "@ts-check"],
    ["//@ts-ignore no space", "@ts-ignore"],
  ])("detects TypeScript compiler directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
  });

  it.each([
    ["// eslint-disable-next-line no-console", "eslint-disable-next-line"],
    ["// eslint-disable-line", "eslint-disable-line"],
    ["// eslint-enable", "eslint-enable"],
    ["// oxlint-disable-next-line", "oxlint-disable-next-line"],
    ["// biome-ignore lint: reason", "biome-ignore"],
    ["// deno-lint-ignore no-explicit-any", "deno-lint-ignore"],
    ["// prettier-ignore", "prettier-ignore"],
    ["// tslint:disable-next-line:no-any", "tslint:disable-next-line"],
  ])("detects linter directives: %s", (text, expected) => {
    expect(detectDirective("line", text)).toBe(expected);
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
    ["/* istanbul ignore next */", "istanbul-ignore"],
    ["/* c8 ignore start */", "c8-ignore"],
    ["/* v8 ignore next 3 */", "v8-ignore"],
    ["/* node:coverage disable */", "node:coverage"],
  ])("detects coverage directives: %s", (text, expected) => {
    expect(detectDirective("block", text)).toBe(expected);
  });

  // The pragma names are assembled at runtime so vitest's own docblock-environment
  // detection does not pick them up from this test file's source.
  const jestPragma = ["@jest", "environment"].join("-");
  const vitestPragma = ["@vitest", "environment"].join("-");

  it.each([
    ['/* webpackChunkName: "chunk" */', "webpack-magic-comment"],
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
});

describe("isLegalComment", () => {
  it.each([
    "/*! preserved banner */",
    "//! rust-style banner",
    "/* @license MIT */",
    "/**\n * @preserve\n */",
    "// @copyright 2026 someone",
  ])("recognises %s", (text) => {
    expect(isLegalComment(text)).toBe(true);
  });

  it("returns false for ordinary comments", () => {
    expect(isLegalComment("// just a note")).toBe(false);
    expect(isLegalComment("/* block */")).toBe(false);
  });
});
