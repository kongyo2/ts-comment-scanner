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

  it("treats Deno file-wide ignore directives as directives only in the header", () => {
    const early = scanComments("// deno-lint-ignore-file\nconst x = 1;");
    const late = scanComments("const x = 1;\n// deno-lint-ignore-file");

    expect(early[0]?.directive).toBe("deno-lint-ignore-file");
    expect(late[0]?.directive).toBeUndefined();
  });

  it("keeps coverage ignore-file pragmas active anywhere in the file", () => {
    // istanbul-lib-instrument and Vitest's v8 provider (ast-v8-to-istanbul)
    // scan every comment in the file for `<tool> ignore file`, so mid-file
    // occurrences are still live and must keep their directive tag.
    const istanbul = scanComments("const x = 1;\n/* istanbul ignore file */\nconst y = 2;");
    const c8 = scanComments("const x = 1;\n/* c8 ignore file */");
    const v8 = scanComments("const x = 1;\n// v8 ignore file");

    expect(istanbul[0]?.directive).toBe("istanbul-ignore-file");
    expect(c8[0]?.directive).toBe("c8-ignore-file");
    expect(v8[0]?.directive).toBe("v8-ignore-file");
  });

  it("keeps test-environment pragmas active anywhere in the file, like Vitest", () => {
    // Jest only reads the leading docblock, but Vitest matches the pragma
    // (including the @jest- spelling) with a regex over the entire file, so a
    // mid-file occurrence is live and has to keep its directive tag.
    // Assembled at runtime so vitest's own detection ignores this test file.
    const envPragma = ["@vitest", "environment"].join("-");
    const early = scanComments(`/** ${envPragma} jsdom */\nconst x = 1;`);
    const late = scanComments(`const x = 1;\n/** ${envPragma} jsdom */`);

    expect(early[0]?.directive).toBe(envPragma);
    expect(late[0]?.directive).toBe(envPragma);
  });

  it("treats prettier pragma-mode docblock pragmas as directives only in the header", () => {
    // --require-pragma and --check-ignore-pragma go through jest-docblock,
    // which only ever reads the file's first block comment.
    const early = scanComments("/** @format */\nconst x = 1;");
    const late = scanComments("const x = 1;\n/** @format */");

    expect(early[0]?.directive).toBe("@format");
    expect(late[0]?.directive).toBeUndefined();
  });

  it.each([
    ["// @bun", "@bun"],
    ["// @flow", "@flow"],
    ['// @ts-self-types="./mod.d.ts"', "@ts-self-types"],
    ["/*jslint devel*/", "jslint"],
  ])("treats %s as a directive only in the file header", (comment, name) => {
    const early = scanComments(`${comment}\nconst x = 1;`);
    const late = scanComments(`const x = 1;\n${comment}`);

    expect(early[0]?.directive).toBe(name);
    expect(late[0]?.directive).toBeUndefined();
  });

  it("keeps a stray dprint-ignore-file active below the header, as dprint's node pragma", () => {
    // Out of the leading comment run it no longer skips the file, but the
    // node-level bounded substring check still matches, so it keeps a tag
    // under the file-pragma name assigned by rule order.
    const late = scanComments("const x = 1;\n// dprint-ignore-file");

    expect(late[0]?.directive).toBe("dprint-ignore-file");
  });

  it("does not set the directive key on ordinary comments", () => {
    const comments = scanComments("// plain");

    expect(comments[0] && "directive" in comments[0]).toBe(false);
  });
});

describe("scanComments robustness", () => {
  it("scans generated sources with very deep expression nesting", () => {
    // A recursive AST walk overflows the call stack around this depth even
    // though the parse itself succeeds.
    const source = `const x=${Array(50_000).fill("a").join("+")}; // tail\n`;

    const comments = scanComments(source);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe("// tail");
  });

  it("stays fast when JSX text and comments are both plentiful", () => {
    const jsxText = Array(4_000).fill("t{1}").join("");
    const comments = Array(4_000).fill("// c").join("\n");
    const source = `const v = <p>${jsxText}</p>;\n${comments}\nconst w = 1;\n`;

    const found = scanComments(source, { jsx: true });

    expect(found).toHaveLength(4_000);
    expect(found.every((comment) => comment.text === "// c")).toBe(true);
  });
});

describe("scanComments directive fall-through", () => {
  it("finds a live directive behind a positionally dead one in the same comment", () => {
    // deno-lint-ignore-file only counts in the header, but semgrep still
    // honours the nosemgrep suppression on this line.
    const comments = scanComments("danger(); // deno-lint-ignore-file nosemgrep\n");

    expect(comments[0]?.directive).toBe("nosemgrep");
  });

  it("finds a live directive behind a mid-file check pragma", () => {
    const comments = scanComments("danger();\n// @ts-nocheck nosemgrep\n");

    expect(comments[0]?.directive).toBe("nosemgrep");
  });
});

describe("scanComments directive placement", () => {
  it("treats prettier docblock pragmas as directives only in the file's first comment", () => {
    // jest-docblock (which prettier's pragma modes use) only extracts the
    // first comment of the file, so an earlier comment disables the pragma.
    const first = scanComments("/** @format */\nconst x = 1;\n");
    const second = scanComments("/* first */\n/** @format */\nconst x = 1;\n");
    const afterLine = scanComments("// lead\n/** @format */\nconst x = 1;\n");

    expect(first[0]?.directive).toBe("@format");
    expect(second[1]?.directive).toBeUndefined();
    expect(afterLine[1]?.directive).toBeUndefined();
  });

  it("still honours a prettier docblock pragma after a shebang", () => {
    const comments = scanComments("#!/usr/bin/env node\n/** @format */\nconst x = 1;\n");

    expect(comments[0]?.directive).toBe("@format");
  });

  it("treats // @bun as a directive only at the very start of the file", () => {
    const atStart = scanComments("// @bun\nconst x = 1;\n");
    const afterComment = scanComments("// lead\n// @bun\nconst x = 1;\n");
    const afterShebang = scanComments("#!/usr/bin/env bun\n// @bun\nconst x = 1;\n");

    expect(atStart[0]?.directive).toBe("@bun");
    expect(afterComment[1]?.directive).toBeUndefined();
    expect(afterShebang[0]?.directive).toBeUndefined();
  });
});
