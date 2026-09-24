import { describe, expect, it } from "vitest";
import { docblockPragmas } from "./docblock.js";

describe("docblockPragmas", () => {
  it("reads the keys of a docblock's `@key value` lines, in order", () => {
    expect(docblockPragmas("/**\n * @flow\n * @format\n */")).toEqual(["flow", "format"]);
    expect(docblockPragmas("/** @format */")).toEqual(["format"]);
    expect(docblockPragmas("/* @format */")).toEqual(["format"]);
  });

  it("takes the whole non-blank run after the `@` as the key", () => {
    expect(docblockPragmas("/** @format, */")).toEqual(["format,"]);
    expect(docblockPragmas("/** @format:reason */")).toEqual(["format:reason"]);
    expect(docblockPragmas("/** @prettier-plugin notes */")).toEqual(["prettier-plugin"]);
    expect(docblockPragmas("/** @format*/")).toEqual(["format"]);
    expect(docblockPragmas("/**@format*/")).toEqual(["format"]);
  });

  it("only reads a key that opens its line, after the space-and-star gutter", () => {
    expect(docblockPragmas("/** foo @format */")).toEqual([]);
    expect(docblockPragmas("/** @format @noformat */")).toEqual(["format"]);
    expect(docblockPragmas("/**\n   * @format\n */")).toEqual(["format"]);
    expect(docblockPragmas("/**\n *   @format\n */")).toEqual(["format"]);
    // jest-docblock strips spaces, one star and one space per line, so a tab
    // or a doubled star keeps the `@` off the line start.
    expect(docblockPragmas("/**\n\t* @format\n */")).toEqual([]);
    expect(docblockPragmas("/**\n ** @format\n */")).toEqual([]);
    expect(docblockPragmas("/**\n *\t@format\n */")).toEqual([]);
  });

  it("never mistakes a line continuing a key's value for a key", () => {
    expect(docblockPragmas("/**\n * @foo one\n * two\n * @format\n */")).toEqual(["foo", "format"]);
    expect(docblockPragmas("/**\n * @foo\n * bar @format\n */")).toEqual(["foo"]);
  });

  it("lists a repeated key once", () => {
    expect(docblockPragmas("/**\n * @format\n * @format\n */")).toEqual(["format"]);
  });

  it("normalises CR and CRLF line breaks like prettier, but not U+2028/U+2029", () => {
    expect(docblockPragmas("/**\r\n * @format\r\n */")).toEqual(["format"]);
    expect(docblockPragmas("/**\r * @format\r */")).toEqual(["format"]);
    // jest-docblock's docblock regex spells line breaks as `\r?\n`, so these
    // stop the comment from being extracted at all.
    expect(docblockPragmas("/** @format  */")).toEqual([]);
    expect(docblockPragmas("/**  * @format  */")).toEqual([]);
  });

  it("returns nothing for text that does not open with a docblock", () => {
    expect(docblockPragmas("// @format")).toEqual([]);
    expect(docblockPragmas("const x = 1; /** @format */")).toEqual([]);
    expect(docblockPragmas("/**/")).toEqual([]);
    expect(docblockPragmas("")).toEqual([]);
  });

  it("skips leading whitespace and a byte-order mark, like jest-docblock's extract", () => {
    expect(docblockPragmas("\n\n  /** @format */")).toEqual(["format"]);
    expect(docblockPragmas("﻿/** @format */")).toEqual(["format"]);
  });
});
