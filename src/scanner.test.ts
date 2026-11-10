import { describe, it, expect } from "vitest";
import { analyzeSource, scanComments, type ScanOptions } from "./scanner.js";

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

  it.each([
    ["// dprint-ignore-file", "dprint"],
    ["// deno-fmt-ignore-file", "deno-fmt"],
  ])("reports a stray %s below the header as the node pragma it still is", (comment, tool) => {
    // Out of the leading comment run it no longer skips the file, but the
    // node-level bounded substring check still matches inside it.
    const early = scanComments(`${comment}\nconst x = 1;`);
    const late = scanComments(`const x = 1;\n${comment}`);

    expect(early[0]?.directive).toBe(`${tool}-ignore-file`);
    expect(late[0]?.directive).toBe(`${tool}-ignore`);
  });

  it.each([
    ["// biome-ignore-all lint: generated", "biome-ignore-all"],
    ["// deno-lint-ignore-file no-explicit-any", "deno-lint-ignore-file"],
  ])("treats %s as live only before the first token", (comment, name) => {
    const early = scanComments(`#!/usr/bin/env node\n${comment}\nconst x = 1;`);
    const late = scanComments(`const x = 1;\n${comment}`);

    expect(early[0]?.directive).toBe(name);
    expect(late[0]?.directive).toBeUndefined();
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

  it("treats // @bun as a directive only where Bun reads it: at the start or right after a shebang line", () => {
    const atStart = scanComments("// @bun\nconst x = 1;\n");
    const afterComment = scanComments("// lead\n// @bun\nconst x = 1;\n");
    const afterShebang = scanComments("#!/usr/bin/env bun\n// @bun\nconst x = 1;\n");
    const afterCrlfShebang = scanComments("#!/usr/bin/env bun\r\n// @bun @bytecode\r\nconst x = 1;\r\n");
    const afterBlankLine = scanComments("#!/usr/bin/env bun\n\n// @bun\nconst x = 1;\n");
    const indented = scanComments("#!/usr/bin/env bun\n  // @bun\nconst x = 1;\n");

    expect(atStart[0]?.directive).toBe("@bun");
    expect(afterComment[1]?.directive).toBeUndefined();
    expect(afterShebang[0]?.directive).toBe("@bun");
    expect(afterCrlfShebang[0]?.directive).toBe("@bun");
    expect(afterBlankLine[0]?.directive).toBeUndefined();
    expect(indented[0]?.directive).toBeUndefined();
  });

  it("only counts a deno-coverage-ignore-file that is the file's first comment", () => {
    const first = scanComments("#!/usr/bin/env -S deno run\n// deno-coverage-ignore-file\nconst x = 1;\n");
    const second = scanComments("// lead\n// deno-coverage-ignore-file\nconst x = 1;\n");

    expect(first[0]?.directive).toBe("deno-coverage-ignore-file");
    expect(second[1]?.directive).toBeUndefined();
  });
});

describe("scanComments switch-clause comments", () => {
  it("reads the token after a comment past the comments that follow it", () => {
    const source = [
      "switch (x) {",
      "  case 1:",
      "    a();",
      "    // falls through",
      "    // TODO: split",
      "  case 2:",
      "    b();",
      "  // no default",
      "}",
      "// the parser falls through to the slow path",
      "foo();",
      "// falls through",
      "",
    ].join("\n");

    expect(scanComments(source).map((comment) => comment.directive)).toEqual([
      "fallthrough",
      undefined,
      "no-default",
      undefined,
      undefined,
    ]);
  });
});

describe("scanComments switch-clause slots", () => {
  const directivesOf = (source: string) => scanComments(source).map((comment) => comment.directive);

  it("reads a fall-through comment only in front of a later clause or a case block's closing brace", () => {
    const source = [
      "switch (x) {",
      "  // falls through (nothing comes before the first clause)",
      "  case 0:",
      "    a(); // falls through",
      "  case 1: {",
      "    b();",
      "    // falls through",
      "  }",
      "  case 2:",
      "    c();",
      "    { d(); /* falls through */ }",
      "  default: {",
      "    e();",
      "    // falls through (the last clause has nothing to fall into)",
      "  }",
      "}",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual([undefined, "fallthrough", "fallthrough", "fallthrough", undefined]);
  });

  it("keeps fall-through words in front of other closing braces ordinary", () => {
    const ifBlock = [
      "function f() {",
      "  if (isSymbol(component)) {",
      "    return // other built-in components: fallthrough",
      "  }",
      "  try {",
      "    g();",
      "  } catch {",
      "    // Failed to find symbol, fall through to use the first definition",
      "  }",
      "}",
      "",
    ].join("\n");
    const nestedInCase =
      "switch (x) {\n  case 0:\n    if (y) {\n      a(); // falls through\n    }\n  case 1:\n    b();\n}\n";

    // The catch block holds nothing else, so its comment is what keeps
    // no-empty quiet, though it is no fall-through comment.
    expect(directivesOf(ifBlock)).toEqual([undefined, "empty-block"]);
    expect(directivesOf(nestedInCase)).toEqual([undefined]);
  });

  it("reads a no-default comment only after the last clause of a switch without a default", () => {
    const afterLast = "switch (x) {\n  case 1:\n    a();\n  // no default\n}\n";
    const withDefault = "switch (x) {\n  case 1:\n    a();\n    break;\n  default:\n    b();\n  // no default\n}\n";
    const objectLiteral = "const schema = {\n  size: { type: 'number' }, // no default\n};\n";
    const emptySwitch = "switch (x) {\n  // no default\n}\n";

    expect(directivesOf(afterLast)).toEqual(["no-default"]);
    expect(directivesOf(withDefault)).toEqual([undefined]);
    expect(directivesOf(objectLiteral)).toEqual([undefined]);
    // default-case skips a switch without clauses; no-empty reads the comment
    // as the switch's content instead.
    expect(directivesOf(emptySwitch)).toEqual(["empty-block"]);
  });

  it("also reads a no-default comment anywhere inside the last clause, as oxlint does", () => {
    const source = [
      "switch (x) {",
      "  case 1:",
      "    // no default",
      "    a();",
      "  // no default",
      "  case 2:",
      "    if (y) {",
      "      // no default",
      "    }",
      "}",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual([undefined, undefined, "no-default"]);
  });

  it("reads the slots of a nested switch's clauses on their own", () => {
    const source = [
      "switch (x) {",
      "  case 0:",
      "    switch (y) {",
      "      case 1:",
      "        a();",
      "      // falls through",
      "      case 2:",
      "        b();",
      "      // no default",
      "    }",
      "    break;",
      "  default:",
      "    c();",
      "}",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual(["fallthrough", "no-default"]);
  });
});

describe("scanComments empty blocks", () => {
  const directivesOf = (source: string, jsx = false) =>
    scanComments(source, { jsx }).map((comment) => comment.directive);

  it("names every comment of a block, function body or switch that holds nothing else", () => {
    const source = [
      "try {",
      "  run();",
      "} catch {",
      "  // ignore",
      "} finally { /* nothing to clean up */ }",
      "if (a) {",
      "  // later",
      "  /* still later */",
      "} else {}",
      "for (;;) { // spin",
      "}",
      "label: { /* x */ }",
      "switch (x) { /* no cases yet */ }",
      "switch (y) {",
      "  case 1: { /* nothing */ }",
      "}",
      "function noop() { /* noop */ }",
      "const f = () => { // noop",
      "};",
      "class C {",
      "  constructor() { /* nothing */ }",
      "  static { /* nothing */ }",
      "}",
      "const o = { m() { /* noop */ } };",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual(Array.from({ length: 13 }, () => "empty-block"));
  });

  it("leaves comments outside the braces, or in blocks that hold anything else, alone", () => {
    const source = [
      "if (a) /* before */ {} // after",
      "if (b) { run(); /* with code */ }",
      "if (c) { ; /* an empty statement */ }",
      "function f(/* param */) {}",
      'function g() { "use strict"; /* a directive prologue */ }',
      "switch (x) /* before */ {}",
      "switch (y) { case 1: /* in a clause */ }",
      "namespace N { /* namespace body */ }",
      "interface I { /* interface body */ }",
      "class C { /* class body */ }",
      "const o = { /* object literal */ };",
      "enum E { /* enum */ }",
      "type T = { /* type literal */ };",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual(Array.from({ length: 14 }, () => undefined));
  });

  it("counts the comments between `static` and the brace of an empty static block, as oxlint does", () => {
    // oxlint's no-empty-static-block (on by default) checks for comments
    // across the whole static block, whose span opens at the keyword — so
    // `static /* c */ {}` passes, and fails once the comment goes.
    const source = [
      "class C {",
      "  /* before */ static /* between */ {}",
      "  static",
      "  // on its own line",
      "  {",
      "  }",
      "  static /* with code */ { run(); }",
      "}",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual([undefined, "empty-block", "empty-block", undefined]);
  });

  it("keeps the name a rule gives a comment inside an empty block", () => {
    const source = [
      "try {",
      "  run();",
      "} catch {",
      "  // eslint-disable-next-line no-empty",
      "  // @ts-nocheck (too late in the file to count)",
      "}",
      "",
    ].join("\n");

    expect(directivesOf(source)).toEqual(["eslint-disable-next-line", "empty-block"]);
  });

  it("reads the empty blocks inside JSX attributes too", () => {
    const source = "const el = <button onClick={() => { /* noop */ }}>{/* label */}</button>;\n";

    expect(directivesOf(source, true)).toEqual(["empty-block", undefined]);
  });

  it("treats a block the parser had to make up as holding nothing", () => {
    expect(directivesOf("try\n// c\n")).toEqual([undefined]);
  });
});

describe("scanComments empty files", () => {
  const directivesOf = (source: string) => scanComments(source).map((comment) => comment.directive);

  it("names the `///` comments of a file holding no code, which keep no-empty-file quiet", () => {
    // oxlint (verified against 1.90) and eslint-plugin-unicorn leave such a
    // file alone while a line comment's value opens with `/`; other comments
    // do not count, so they stay ordinary.
    expect(directivesOf("/// placeholder until the API lands\n// TODO\n")).toEqual(["empty-file", undefined]);
    expect(directivesOf('#!/usr/bin/env node\n"use strict";\n;\n{ ; {} }\n//// note\n')).toEqual(["empty-file"]);
    expect(directivesOf("/* note */\n")).toEqual([undefined]);
  });

  it("leaves `///` comments alone once the file holds any code", () => {
    expect(directivesOf("/// note\nexport {};\n")).toEqual([undefined]);
    expect(directivesOf('/// note\n;\n"use strict";\n')).toEqual([undefined]);
    expect(directivesOf("/// note\ntype T = string;\n")).toEqual([undefined]);
    expect(directivesOf('/// note\n{ "not a directive"; }\n')).toEqual([undefined]);
  });

  it("keeps the names of real triple-slash directives at the top of an empty file", () => {
    expect(directivesOf('/// <reference types="vite/client" />\n/// note\n')).toEqual([
      "triple-slash-reference",
      "empty-file",
    ]);
  });
});

describe("analyzeSource, for ast-grep suppressions", () => {
  /** Where the node in front of the comment starts, and the last token before it ends, as source slices. */
  const preceding = (source: string, comment: string, jsx = false): { node?: string; token: string } => {
    const analysis = analyzeSource(source, { jsx });
    const found = analysis.comments.find((candidate) => candidate.text === comment);
    const node = analysis.preceding.get(found as (typeof analysis.comments)[number]);
    if (node === undefined) throw new Error("no preceding node recorded");
    return {
      ...(node.start === undefined ? {} : { node: source.slice(node.start, source.indexOf(comment)) }),
      token: source.slice(0, node.tokenEnd),
    };
  };

  it("finds the outermost node that ends with the token in front of the comment", () => {
    expect(preceding("x();\nfoo(\n  1,\n); // ast-grep-ignore\n", "// ast-grep-ignore").node).toBe("foo(\n  1,\n); ");
    expect(preceding("x(); if (a) b(); // ast-grep-ignore\n", "// ast-grep-ignore").node).toBe("if (a) b(); ");
    expect(preceding("foo(a, // ast-grep-ignore\n  b);\n", "// ast-grep-ignore").node).toBe(", ");
    expect(preceding("function f() { // ast-grep-ignore\n}\n", "// ast-grep-ignore").node).toBe("{ ");
  });

  it("takes the comment right in front of it when no token stands between them", () => {
    const source = "x(); /* a\n */ // ast-grep-ignore\n";

    expect(preceding(source, "// ast-grep-ignore")).toEqual({ node: "/* a\n */ ", token: "x();" });
  });

  it("skips empty lists, which hold no text, to the token in front", () => {
    expect(preceding("foo(/* ast-grep-ignore */);\n", "/* ast-grep-ignore */").node).toBe("(");
    expect(preceding("x(<div>{/* ast-grep-ignore */}</div>);\n", "/* ast-grep-ignore */", true).node).toBe("{");
  });

  it("records nothing in front of a comment that opens the file", () => {
    expect(preceding("// ast-grep-ignore\nfoo();\n", "// ast-grep-ignore")).toEqual({ token: "" });
    expect(preceding("#!/usr/bin/env node\n// ast-grep-ignore\n", "// ast-grep-ignore")).toEqual({ token: "" });
  });

  it("records only the comments that carry the marker", () => {
    expect(analyzeSource("x(); // note\n// ast-grep-ignore\n").preceding.size).toBe(1);
  });
});

describe("scanComments in JSX closing tags", () => {
  const texts = (source: string, options: ScanOptions = { jsx: true }): string[] =>
    scanComments(source, options).map((comment) => comment.text);

  it("finds a block comment right after the `</` of a closing tag", () => {
    // `</` is one token to the parser; split into `<` and `/`, its slash would
    // open a line comment with the one that follows.
    const source = "const view = <div><//* note */div>;\n";

    expect(scanComments(source, { jsx: true })).toMatchObject([
      { kind: "block", text: "/* note */", start: 20, end: 30, line: 1, column: 21 },
    ]);
  });

  it.each([
    ["const view = <div></ /* note */ div>;\n", ["/* note */"]],
    ["const view = <div><//* one *//* two */div>;\n", ["/* one */", "/* two */"]],
    ["const view = <div><//* over\n lines */div>;\n", ["/* over\n lines */"]],
    ["const view = <div></// note\ndiv>;\n", ["// note"]],
    ["const view = <div></// note\r\ndiv>;\r\n", ["// note"]],
    ["const view = <><//* note */>;\n", ["/* note */"]],
    ["const view = <></// note\n>;\n", ["// note"]],
    ["const view = <a.b></a./* note */b>;\n", ["/* note */"]],
    ["const view = <div></div /* note */>;\n", ["/* note */"]],
    ["const view = <div>{/* child */}<//* note */div>; // after\n", ["/* child */", "/* note */", "// after"]],
  ])("finds the comments of %j", (source, expected) => {
    expect(texts(source)).toEqual(expected);
  });

  it("finds them in a JavaScript file too", () => {
    expect(texts("const view = <div><//* note */div>;\n", { jsx: false, javascript: true })).toEqual(["/* note */"]);
  });

  it("reads `<//` followed by text as the closing `</` and a division, as the parser does", () => {
    expect(texts("const view = <div><// note\ndiv>;\n")).toEqual([]);
  });
});

describe("scanComments of JavaScript", () => {
  const javascript = { javascript: true };

  it("reads a comparison where TypeScript reads type arguments, so a regular expression after it holds no comment", () => {
    const source = "const r = a < b > /x\\/*y/.test(c); /* note */\n";

    expect(scanComments(source, javascript).map((comment) => comment.text)).toEqual(["/* note */"]);
    // Parsed as TSX, `a<b>` takes type arguments and the slash divides.
    expect(scanComments(source, { jsx: true }).map((comment) => comment.text)).toEqual(["/*y/.test(c); /* note */"]);
  });

  it("parses JSX whatever else is set, as tsc does for a `.js` file", () => {
    const source = "const view = <div>// text</div>; // note\n";

    expect(scanComments(source, javascript).map((comment) => comment.text)).toEqual(["// note"]);
    expect(scanComments(source, { javascript: true, jsx: false }).map((comment) => comment.text)).toEqual(["// note"]);
  });

  it.each([
    ["/** @typedef {{x: number}} Point */\nconst p = 1;\n", ["@typedef"]],
    ["/** @callback Cb @param {number} n */\nconst p = 1;\n", ["@callback"]],
    ["/** @enum {number} */\nconst E = { A: 1 };\n", ["@enum"]],
    ['/** @import { X } from "./x" */\nconst p = 1;\n', ["@import"]],
    ["/** @overload @param {string} a @returns {string} */\nfunction f(a) { return a; }\n", ["@overload"]],
    ["/** @type {number} */\nconst n = 1;\n", ["@type"]],
    ["/** @satisfies {Config} */\nconst config = {};\n", ["@satisfies"]],
    ["/** @param {number} a */\nfunction f(a) {}\n", ["@param"]],
    ["/** @arg {number} a */\nfunction f(a) {}\n", ["@param"]],
    ["/** @argument {number} a */\nfunction f(a) {}\n", ["@param"]],
    ["/** @param [a] optional */\nfunction f(a) {}\n", ["@param"]],
    // Without a type too: any `@param` makes the function's parameters required.
    ["/** @param a the first */\nfunction f(a) {}\n", ["@param"]],
    ["/** @returns {number} */\nfunction f() { return 1; }\n", ["@returns"]],
    ["/** @return {number} */\nfunction f() { return 1; }\n", ["@returns"]],
    ["/** @template T */\nfunction f() {}\n", ["@template"]],
    ["/** @this {Window} */\nfunction f() {}\n", ["@this"]],
    ["/** @extends {Base} */\nclass A extends Base {}\n", ["@extends"]],
    ["/** @augments {Base} */\nclass A extends Base {}\n", ["@extends"]],
    ["/** @implements {I} */\nclass A {}\n", ["@implements"]],
    ["/** @class */\nfunction C() {}\n", ["@class"]],
    ["/** @constructor */\nfunction C() {}\n", ["@class"]],
    ["class A {\n  /** @public */\n  x = 1;\n}\n", ["@public"]],
    ["class A {\n  /** @private */\n  x = 1;\n}\n", ["@private"]],
    ["class A {\n  /** @protected */\n  x = 1;\n}\n", ["@protected"]],
    ["class A {\n  /** @readonly */\n  x = 1;\n}\n", ["@readonly"]],
    ["class A extends B {\n  /** @override */\n  m() {}\n}\n", ["@override"]],
    [
      "/**\n * Adds.\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction add(a, b) { return a + b; }\n",
      ["@param", "@returns"],
    ],
  ])("names the tags tsc reads a type from in %j", (source, names) => {
    const analysis = analyzeSource(source, javascript);
    const [comment] = analysis.comments;

    expect(comment?.directive).toBe(names[0]);
    expect(analysis.typed.get(comment as (typeof analysis.comments)[number])).toEqual(names);
  });

  it.each([
    "/** Adds two numbers. */\nfunction add(a, b) { return a + b; }\n",
    // A `@returns` without a type says nothing to the compiler.
    "/**\n * Adds.\n * @returns the sum\n */\nfunction add(a, b) { return a + b; }\n",
    // tsc parses these tags and reads nothing from them, or does not know them.
    "/**\n * @deprecated\n * @see add\n * @author someone\n * @throws {Error}\n * @example add(1, 2)\n * @default 1\n */\nfunction add(a, b) { return a + b; }\n",
  ])("leaves a JSDoc comment tsc reads no type from ordinary: %j", (source) => {
    const analysis = analyzeSource(source, javascript);

    expect(analysis.comments.map((comment) => comment.directive)).toEqual([undefined]);
    expect(analysis.typed.size).toBe(0);
  });

  it("reads no type from a JSDoc comment no node holds", () => {
    // tsc attaches a JSDoc comment to the node it leads; one in front of a
    // closing brace, or sharing the line of the token before a member, leads none.
    const beforeBrace = "function f() {\n  return 1;\n  /** @typedef {number} N */\n}\n";
    const sameLine = "class A { /** @private */ m() {} }\n";

    expect(scanComments(beforeBrace, javascript).map((comment) => comment.directive)).toEqual([undefined]);
    expect(scanComments(sameLine, javascript).map((comment) => comment.directive)).toEqual([undefined]);
  });

  it("names them in a JavaScript file alone", () => {
    const source = "/** @typedef {{x: number}} Point */\n/** @param {Point} p */\nfunction f(p) {}\n";

    expect(scanComments(source).map((comment) => comment.directive)).toEqual([undefined, undefined]);
    expect(analyzeSource(source).typed.size).toBe(0);
    expect(scanComments(source, javascript).map((comment) => comment.directive)).toEqual(["@typedef", "@param"]);
  });

  it("puts the type tags behind a directive that opens the comment, and in front of one it only mentions", () => {
    const analysis = analyzeSource(
      "/** istanbul ignore next\n * @param {number} a */\nfunction f(a) {}\n/** @param {number} a -- see /* c8 ignore next */\nfunction g(a) {}\n",
      javascript,
    );

    expect(analysis.comments.map((comment) => analysis.directives.get(comment))).toEqual([
      ["istanbul-ignore-next", "@param"],
      ["@param", "c8-ignore-next"],
    ]);
  });
});

describe("analyzeSource, for the JSDoc comments of one node in JavaScript", () => {
  /** The text of each comment a later one keeps off its node, with that later comment's. */
  const shadows = (source: string): Array<[string, string]> => {
    const analysis = analyzeSource(source, { javascript: true });
    return [...analysis.shadows].map(([comment, shadow]) => [comment.text, shadow.text]);
  };

  it("records the node's last JSDoc comment for an earlier one whose tags describe the node", () => {
    // tsc takes a node's `@type` from its last JSDoc comment alone.
    expect(shadows("/** @type {string} */\n/** @type {number} */\nconst n = 1;\n")).toEqual([
      ["/** @type {string} */", "/** @type {number} */"],
    ]);
    expect(shadows("/** @param {string} a */\n/** docs */\nfunction f(a) {}\n")).toEqual([
      ["/** @param {string} a */", "/** docs */"],
    ]);
    expect(shadows("/** @private */\n/** one */\n/** two */\nfunction f() {}\n")).toEqual([
      ["/** @private */", "/** two */"],
    ]);
  });

  it("records none for the tags that declare something of their own, which tsc reads from every comment", () => {
    expect(shadows("/** @typedef {number} N */\n/** @callback Cb */\n/** docs */\nconst n = 1;\n")).toEqual([]);
    expect(shadows('/** @import { X } from "./x" */\n/** @type {X} */\nconst x = 1;\n')).toEqual([]);
  });

  it("records none for the last comment of a node, nor in TypeScript", () => {
    expect(shadows("/** docs */\n/** @type {number} */\nconst n = 1;\n")).toEqual([]);
    expect(analyzeSource("/** @type {string} */\n/** @type {number} */\nconst n = 1;\n").shadows.size).toBe(0);
  });
});

describe("analyzeSource, for the type casts prettier reads", () => {
  const casts = (source: string, options = {}): string[] =>
    [...analyzeSource(source, options).casts].map((comment) => comment.text);

  it("records a cast comment that a parenthesized expression follows, past further comments", () => {
    expect(casts("const a = /** @type {number} */ (foo);\n")).toEqual(["/** @type {number} */"]);
    expect(casts("const a = /** @type {number} */ /* note */ (foo);\n")).toEqual(["/** @type {number} */"]);
    expect(casts("const a = /** @satisfies {X} */\n  // note\n  ({});\n", { javascript: true })).toEqual([
      "/** @satisfies {X} */",
    ]);
  });

  it("records none where no parenthesized expression follows", () => {
    expect(casts("const a = /** @type {number} */ foo;\n")).toEqual([]);
    expect(casts("/** @type {number} */\nconst a = 1;\n")).toEqual([]);
    // The parenthesis of a call's arguments is no expression of its own.
    expect(casts("foo /** @type {number} */ (bar);\n")).toEqual([]);
    expect(casts("const a = /* note */ (foo);\n")).toEqual([]);
  });
});
