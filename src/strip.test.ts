import { describe, it, expect } from "vitest";
import { stripComments } from "./strip.js";

describe("stripComments", () => {
  it("returns the source unchanged when there are no comments", () => {
    expect(stripComments("const x = 1;")).toBe("const x = 1;");
  });

  it("removes a standalone line comment", () => {
    expect(stripComments("// hello")).toBe("");
  });

  it("removes a trailing line comment and the whitespace before it", () => {
    expect(stripComments("const x = 1; // hi")).toBe("const x = 1;");
  });

  it("removes a block comment", () => {
    expect(stripComments("/* hi */")).toBe("");
  });

  it("removes an inline block comment, leaving the surrounding code clean", () => {
    expect(stripComments("a /* c */ b")).toBe("a b");
  });

  it("drops the whole line of a standalone comment, keeping the following code", () => {
    expect(stripComments("// hi\nconst x = 1;")).toBe("const x = 1;");
  });

  it("preserves a pre-existing blank line", () => {
    expect(stripComments("const a = 1;\n\nconst b = 2;")).toBe("const a = 1;\n\nconst b = 2;");
  });
  it("removes several comments from one source", () => {
    expect(stripComments("// a\nconst x = 1; // b\n/* c */")).toBe("const x = 1;\n");
  });

  it("removes a multi-line block comment entirely", () => {
    expect(stripComments("/**\n * doc\n */\nconst x = 1;")).toBe("const x = 1;");
  });

  it("leaves // inside a string literal untouched", () => {
    expect(stripComments('const s = "// not";')).toBe('const s = "// not";');
  });

  it("strips comments from a JSX expression container in tsx mode", () => {
    expect(stripComments("const e = <div>{/* hi */}</div>;", { jsx: true })).toBe("const e = <div>{ }</div>;");
  });

  it("separates operator characters so they do not fuse into a different operator", () => {
    expect(stripComments("i+/*c*/+j")).toBe("i+ +j");
  });

  it("keeps a line terminator for ASI when a spanned comment sits between spaced tokens", () => {
    expect(stripComments("return /*\n*/ value")).toBe("return\n value");
  });

  it("inserts a space when a comment was the only separator between two words", () => {
    expect(stripComments("const/**/x = 1")).toBe("const x = 1");
  });

  it("separates identifiers that were joined only by an inline comment", () => {
    expect(stripComments("a/*c*/b")).toBe("a b");
  });

  it("keeps a keyword separated from its operand", () => {
    expect(stripComments("return/*c*/x")).toBe("return x");
  });

  it("uses a newline separator when the inline comment spanned lines", () => {
    expect(stripComments("a/*\n*/b")).toBe("a\nb");
  });

  it("keeps a triple-slash reference directive", () => {
    expect(stripComments('/// <reference types="node" />\nconst x = 1; // gone')).toBe(
      '/// <reference types="node" />\nconst x = 1;',
    );
  });

  it("removes a triple-slash comment that is not a directive", () => {
    expect(stripComments("/// just a note\nconst x = 1;")).toBe("const x = 1;");
  });

  it("keeps a JSX import-source pragma", () => {
    expect(stripComments("/** @jsxImportSource preact */\nconst x = 1; /* gone */")).toBe(
      "/** @jsxImportSource preact */\nconst x = 1;",
    );
  });

  it("keeps a JSX factory pragma", () => {
    expect(stripComments("/* @jsx h */\nconst x = 1;")).toBe("/* @jsx h */\nconst x = 1;");
  });

  it("keeps a // @ts-nocheck directive", () => {
    expect(stripComments("// @ts-nocheck\nconst x = 1; // gone")).toBe("// @ts-nocheck\nconst x = 1;");
  });

  it("keeps a // @ts-expect-error directive", () => {
    expect(stripComments("// @ts-expect-error\nconst x = 1;")).toBe("// @ts-expect-error\nconst x = 1;");
  });

  it("removes an ordinary comment that merely mentions @jsx", () => {
    expect(stripComments("// TODO: drop @jsx hack\nconst x = 1;")).toBe("const x = 1;");
  });
});
