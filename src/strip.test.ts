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
    expect(stripComments("const e = <div>{/* hi */}</div>;", { jsx: true })).toBe("const e = <div>{}</div>;");
  });
});
