import { describe, it, expect } from "vitest";
import { scanComments } from "./scanner.js";

describe("scanComments", () => {
  it("detects a single-line comment", () => {
    const comments = scanComments("// hello");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "line", text: "// hello" });
  });

  it("detects a block comment", () => {
    const comments = scanComments("/* hello */");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "block", text: "/* hello */" });
  });

  it("returns an empty array when there are no comments", () => {
    expect(scanComments("const x = 1;")).toEqual([]);
  });

  it("ignores // inside a string literal", () => {
    expect(scanComments('const s = "// not a comment";')).toEqual([]);
  });

  it("ignores /* inside a string literal", () => {
    expect(scanComments('const s = "/* not a comment */";')).toEqual([]);
  });

  it("returns comments in source order", () => {
    const comments = scanComments("// first\n/* second */\n// third");

    expect(comments.map((comment) => comment.text)).toEqual(["// first", "/* second */", "// third"]);
  });

  it("reports 1-based line and column of the comment start", () => {
    const comments = scanComments("const x = 1;\nconst y = 2; // here");

    expect(comments[0]).toMatchObject({ line: 2, column: 14 });
  });

  it("reports absolute start and end offsets", () => {
    const comments = scanComments("ab// c");

    expect(comments[0]).toMatchObject({ start: 2, end: 6 });
  });

  it("captures a multi-line block comment as a single comment", () => {
    const source = "/**\n * doc\n */";

    const comments = scanComments(source);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "block", text: source, line: 1 });
  });

  it("detects a trailing comment after code on the same line", () => {
    const comments = scanComments("const x = 1; // trailing");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "line", text: "// trailing", column: 14 });
  });

  it("does not report a shebang line as a comment", () => {
    expect(scanComments("#!/usr/bin/env node\nconst x = 1;")).toEqual([]);
  });

  it("does not treat a regex literal's slashes as comments", () => {
    expect(scanComments("const r = /[/*]/;\nconst keep = 1;")).toEqual([]);
    expect(scanComments("const x = /[//]/;\nconst keep = 2;")).toEqual([]);
  });

  it("does not treat JSX text as a comment in tsx mode", () => {
    expect(scanComments("const e = <div>http://example.com</div>;", { jsx: true })).toEqual([]);
  });

  it("detects a real comment inside a JSX expression container", () => {
    const comments = scanComments("const e = <div>{/* hi */}</div>;", { jsx: true });

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "block", text: "/* hi */" });
  });
});
