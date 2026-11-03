import { describe, it, expect } from "vitest";
import { removeComments } from "./remove.js";

const code = (source: string) => removeComments(source).code;

describe("removeComments blank lines", () => {
  it("leaves one blank line where a comment stood between two", () => {
    expect(code("a();\n\n// c\n\nb();\n")).toBe("a();\n\nb();\n");
    expect(code("a();\n\n// c\n\n// d\n\nb();\n")).toBe("a();\n\nb();\n");
    expect(code("a();\r\n\r\n// c\r\n\r\nb();\r\n")).toBe("a();\r\n\r\nb();\r\n");
  });

  it("keeps the widest gap the comment had on either side", () => {
    expect(code("a();\n\n\n// c\n\nb();\n")).toBe("a();\n\n\nb();\n");
    expect(code("a();\n// c\n\nb();\n")).toBe("a();\n\nb();\n");
    expect(code("a();\n\n/**\n * docs\n */\nb();\n")).toBe("a();\n\nb();\n");
  });

  it("drops the blank lines that only separated a comment from the start of the file", () => {
    expect(code("/**\n * @file module docs\n */\n\nimport a from 'a';\n")).toBe("import a from 'a';\n");
    // Blank lines the file already started with stay.
    expect(code("\n// c\n\nimport a from 'a';\n")).toBe("\nimport a from 'a';\n");
    expect(removeComments("﻿// c\n\nconst x = 1;\n").code).toBe("﻿const x = 1;\n");
  });

  it("drops the blank lines that only separated a comment from the end of the file", () => {
    expect(code("a();\n\n// c\n")).toBe("a();\n");
    expect(code("a();\n\n// c")).toBe("a();\n");
    // Blank lines the file already ended with stay.
    expect(code("a();\n\n// c\n\n")).toBe("a();\n\n");
    expect(code("// a\n\n// b\n")).toBe("");
  });

  it("drops the blank lines that only separated a comment from the edge of a block", () => {
    expect(code("function f() {\n  // c\n\n  return 1;\n}\n")).toBe("function f() {\n  return 1;\n}\n");
    expect(code("function f() {\n  return 1;\n\n  // c\n}\n")).toBe("function f() {\n  return 1;\n}\n");
    expect(code("f(\n  // c\n\n  a,\n);\nconst x = [\n  1,\n\n  // c\n];\n")).toBe(
      "f(\n  a,\n);\nconst x = [\n  1,\n];\n",
    );
    // The only comment of an empty block keeps the block off the linters'
    // empty-block reports, so only removeDirectives lets it go.
    expect(removeComments("function f() {\n\n  // c\n\n}\n", { removeDirectives: true }).code).toBe(
      "function f() {\n\n}\n",
    );
  });

  it("does not take a bracket inside a kept comment for the start of a block", () => {
    expect(code("foo(); // @license {\n// c\n\nbar();\n")).toBe("foo(); // @license {\n\nbar();\n");
  });

  it("keeps the blank lines a next-line directive reaches", () => {
    expect(code("// eslint-disable-next-line\n\n// c\n")).toBe("// eslint-disable-next-line\n\n");
    expect(code("f(); /* c8 ignore next 2 */\n\n\n// c\n")).toBe("f(); /* c8 ignore next 2 */\n\n\n");
  });

  it("only collapses lines of spaces and tabs", () => {
    // tsc 7 stops at a line holding a vertical tab, so it is content.
    expect(code("a();\n\v\n// c\n\nb();\n")).toBe("a();\n\v\n\nb();\n");
  });

  it("leaves blank lines inside kept comments and template literals alone", () => {
    expect(code("/*! keep\n\n*/\n\n// c\n\nb();\n")).toBe("/*! keep\n\n*/\n\nb();\n");
    expect(code("const s = `\n\n`;\n\n// c\n\nb();\n")).toBe("const s = `\n\n`;\n\nb();\n");
  });

  it("leaves the blank lines around a trailing comment alone", () => {
    expect(code("a(); // c\n\n\nb();\n")).toBe("a();\n\n\nb();\n");
  });

  it("keeps the line feed of a dropped line that follows another kind of line break", () => {
    // tree-sitter (and so ast-grep) starts a row at a line feed alone: the
    // lone CR goes instead, so `a();` and `b();` stay on rows of their own.
    expect(code("a();\r// c\nb();\n")).toBe("a();\nb();\n");
    expect(code("a();\u2028// c\r\nb();\r\n")).toBe("a();\r\nb();\r\n");
    expect(code("a();\r/* c\n */\nb();\n")).toBe("a();\nb();\n");
    expect(code("a();\r\n// c\rb();\n")).toBe("a();\r\nb();\n");
  });

  it("keeps the blank lines when collapsing them would move // @bun to the start of the file", () => {
    const result = removeComments("// lead\n\n// @bun @license\nconst x = 1;\n");

    expect(result.code).toBe("\n// @bun @license\nconst x = 1;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["// lead"]);
  });
});

describe("removeComments whitespace around inline comments", () => {
  it("drops the space that only held a comment off a bracket or punctuation", () => {
    expect(code("f(/* c */ a);\n")).toBe("f(a);\n");
    expect(code("f(a /* c */);\n")).toBe("f(a);\n");
    expect(code("f(a, /* c */ b);\n")).toBe("f(a, b);\n");
    expect(code("x = 1 /* c */;\n")).toBe("x = 1;\n");
  });

  it("puts no space between brackets that a comment stood between", () => {
    expect(code("[/* c */];\n({/* c */});\nf(/* c */);\n")).toBe("[];\n({});\nf();\n");
  });

  it("still keeps tokens apart", () => {
    expect(code("a/* c */b;\nif (a)/* c */{}\n")).toBe("a b;\nif (a) {}\n");
    expect(code("x = a/* c */ + b;\n")).toBe("x = a + b;\n");
    expect(code("x = a/* c *//* d */\n")).toBe("x = a\n");
  });

  it("keeps the indentation of a line a closing bracket is left alone on", () => {
    expect(code("foo(\n  a,\n  /* c */)\n")).toBe("foo(\n  a,\n  )\n");
  });

  it("needs no line break for a multi-line comment against a bracket", () => {
    expect(code("f(/* a\n b */);\nconst x = [/* a\n */ 1];\n")).toBe("f();\nconst x = [1];\n");
  });
});
