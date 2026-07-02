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

  it("returns an empty array for empty source", () => {
    expect(scanComments("")).toEqual([]);
  });

  it("ignores // inside a string literal", () => {
    expect(scanComments('const s = "// not a comment";')).toEqual([]);
  });

  it("ignores /* inside a string literal", () => {
    expect(scanComments('const s = "/* not a comment */";')).toEqual([]);
  });

  it("ignores comment markers inside template literals", () => {
    expect(scanComments("const s = `// not ${1} /* nope */`;")).toEqual([]);
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

  it("reports the end position of a comment", () => {
    const comments = scanComments("// hi\nconst x = 1;");

    expect(comments[0]).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 6 });
  });

  it("detects a JSDoc comment at the end of the file", () => {
    const comments = scanComments("const c = 1;\n/** trailing docs */\n");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "block", text: "/** trailing docs */", line: 2 });
  });

  it("captures a multi-line block comment as a single comment", () => {
    const source = "/**\n * doc\n */";

    const comments = scanComments(source);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "block", text: source, line: 1, endLine: 3, endColumn: 4 });
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

  it("filters JSX text correctly across many JSX children", () => {
    const source = [
      "const e = (",
      "  <ul>",
      "    <li>first // nope</li>",
      "    <li>{/* yes */}</li>",
      "    <li>second /* nope */</li>",
      "  </ul>",
      ");",
    ].join("\n");

    const comments = scanComments(source, { jsx: true });

    expect(comments.map((comment) => comment.text)).toEqual(["/* yes */"]);
  });

  it("tags directive comments with their canonical name", () => {
    const comments = scanComments("// @ts-expect-error\nconst x: number = null as any;\n// plain note");

    expect(comments[0]?.directive).toBe("@ts-expect-error");
    expect(comments[1]?.directive).toBeUndefined();
  });

  it("treats @ts-nocheck as a directive only before the first token, like TypeScript", () => {
    const early = scanComments("// @ts-nocheck\nconst x = 1;");
    const late = scanComments("const x = 1;\n// @ts-nocheck");

    expect(early[0]?.directive).toBe("@ts-nocheck");
    expect(late[0]?.directive).toBeUndefined();
  });

  it("keeps honouring @ts-check behind a shebang and other leading comments", () => {
    const comments = scanComments("#!/usr/bin/env node\n// header\n// @ts-check\nconst x = 1;");

    expect(comments.map((comment) => comment.directive)).toEqual([undefined, "@ts-check"]);
  });

  it("does not position-limit next-line directives like @ts-ignore", () => {
    const comments = scanComments("const x = 1;\n// @ts-ignore\nconst y: number = null as any;");

    expect(comments[0]?.directive).toBe("@ts-ignore");
  });

  it("treats triple-slash references as directives only before the first token", () => {
    const early = scanComments('/// <reference path="./a.d.ts" />\nconst x = 1;');
    const late = scanComments('const x = 1;\n/// <reference path="./a.d.ts" />');

    expect(early[0]?.directive).toBe("triple-slash-reference");
    expect(late[0]?.directive).toBeUndefined();
  });

  it("treats test-environment pragmas as directives only in the file header", () => {
    // Assembled at runtime so vitest's own docblock detection ignores this file.
    const envPragma = ["@vitest", "environment"].join("-");
    const early = scanComments(`/** ${envPragma} jsdom */\nconst x = 1;`);
    const late = scanComments(`const x = 1;\n/** ${envPragma} jsdom */`);

    expect(early[0]?.directive).toBe(envPragma);
    expect(late[0]?.directive).toBeUndefined();
  });

  it("does not set the directive key on ordinary comments", () => {
    const comments = scanComments("// plain");

    expect(comments[0] && "directive" in comments[0]).toBe(false);
  });
});
