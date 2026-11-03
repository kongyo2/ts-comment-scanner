import { describe, it, expect } from "vitest";
import { removeComments } from "./remove.js";
import { scanComments } from "./scanner.js";

describe("removeComments", () => {
  it("removes a whole-line comment including its line", () => {
    const result = removeComments("// gone\nconst x = 1;\n");

    expect(result.code).toBe("const x = 1;\n");
    expect(result.removed).toHaveLength(1);
    expect(result.changed).toBe(true);
  });

  it("removes an indented whole-line comment", () => {
    const result = removeComments("function f() {\n  // gone\n  return 1;\n}\n");

    expect(result.code).toBe("function f() {\n  return 1;\n}\n");
  });

  it("removes a trailing comment and the gap before it", () => {
    const result = removeComments("const x = 1; // gone\n");

    expect(result.code).toBe("const x = 1;\n");
  });

  it("removes a multi-line block comment occupying whole lines", () => {
    const result = removeComments("/**\n * docs\n */\nconst x = 1;\n");

    expect(result.code).toBe("const x = 1;\n");
  });

  it("keeps tokens apart when a block comment separates them", () => {
    const result = removeComments("const a = 1;/* gone */const b = 2;\n");

    expect(result.code).toBe("const a = 1; const b = 2;\n");
  });

  it("collapses the gap of an inline comment surrounded by spaces", () => {
    const result = removeComments("const a = 1; /* gone */ const b = 2;\n");

    expect(result.code).toBe("const a = 1; const b = 2;\n");
  });

  it("removes a comment at the start of a line before code", () => {
    const result = removeComments("/* gone */ const x = 1;\n");

    expect(result.code).toBe("const x = 1;\n");
  });

  it("preserves indentation when removing a leading inline comment", () => {
    const result = removeComments("  /* gone */ return 1;\n");

    expect(result.code).toBe("  return 1;\n");
  });

  it("keeps a line break where a removed multi-line comment separated code", () => {
    const result = removeComments("const x = 1 /* gone\nstill gone */ + 2;\n");

    expect(result.code).toBe("const x = 1\n + 2;\n");
  });

  it("does not merge statements separated only by a multi-line comment", () => {
    const result = removeComments("const a = 1/* note\nspanning lines */const b = 2;\n");

    expect(result.code).toBe("const a = 1\nconst b = 2;\n");
  });

  it("preserves automatic semicolon insertion after return", () => {
    const result = removeComments("function f() {\n  return /* explanation\n over two lines */ g();\n}\n");

    expect(result.code).toBe("function f() {\n  return\n g();\n}\n");
  });

  it("still collapses a single-line block comment between code without a line break", () => {
    const result = removeComments("const x = f(/* arg */ 1);\n");

    expect(result.code).toBe("const x = f(1);\n");
  });

  it("handles several comments on the same line", () => {
    const result = removeComments("const a = 1; /* one */ const b = 2; // two\n");

    expect(result.code).toBe("const a = 1; const b = 2;\n");
  });

  it("drops a line that only contained two block comments", () => {
    const result = removeComments("/* a */ /* b */\nconst x = 1;\n");

    expect(result.code).toBe("const x = 1;\n");
  });

  it("returns the source unchanged when there is nothing to remove", () => {
    const source = "const x = 1;\n";
    const result = removeComments(source);

    expect(result.code).toBe(source);
    expect(result.changed).toBe(false);
    expect(result.removed).toEqual([]);
  });

  it("returns the source unchanged when every comment is protected", () => {
    const source = "// @ts-nocheck\nconst x = 1;\n";
    const result = removeComments(source);

    expect(result.code).toBe(source);
    expect(result.changed).toBe(false);
    expect(result.kept).toHaveLength(1);
  });

  it("produces an empty file when the source was only comments", () => {
    expect(removeComments("// one\n// two\n").code).toBe("");
  });

  it("handles a comment on the last line without a trailing newline", () => {
    expect(removeComments("const x = 1;\n// gone").code).toBe("const x = 1;\n");
    expect(removeComments("const x = 1; // gone").code).toBe("const x = 1;");
  });

  it("preserves CRLF line endings", () => {
    const result = removeComments("const x = 1; // gone\r\nconst y = 2;\r\n");

    expect(result.code).toBe("const x = 1;\r\nconst y = 2;\r\n");
  });

  it("removes whole CRLF comment lines", () => {
    const result = removeComments("// gone\r\nconst x = 1;\r\n");

    expect(result.code).toBe("const x = 1;\r\n");
  });

  it("inserts a CRLF line break when splitting code around a CRLF multi-line comment", () => {
    const result = removeComments("const a = 1 /* gone\r\nstill gone */ + 2;\r\n");

    expect(result.code).toBe("const a = 1\r\n + 2;\r\n");
  });

  it("does not touch comment-looking text inside strings or templates", () => {
    const source = 'const s = "// keep";\nconst t = `/* keep */`;\n';
    const result = removeComments(source);

    expect(result.code).toBe(source);
    expect(result.changed).toBe(false);
  });

  it("removes a JSX comment together with its braces", () => {
    const result = removeComments("const e = <div>{/* gone */}</div>;\n", { jsx: true });

    expect(result.code).toBe("const e = <div></div>;\n");
  });

  it("keeps directives by default and reports them as kept", () => {
    const source = "// @ts-expect-error broken types\nconst x: number = null;\n// gone\n";
    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error broken types\nconst x: number = null;\n");
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.directive).toBe("@ts-expect-error");
  });

  it("removes directives when removeDirectives is set", () => {
    const source = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const result = removeComments(source, { removeDirectives: true });

    expect(result.code).toBe("console.log(1);\n");
  });

  it("keeps license comments by default and removes them with removeLegal", () => {
    const source = "/*! (c) kongyo2 */\nconst x = 1;\n";

    expect(removeComments(source).code).toBe(source);
    expect(removeComments(source, { removeLegal: true }).code).toBe("const x = 1;\n");
  });

  it("honours a custom shouldRemove predicate", () => {
    const source = "// TODO keep me\n// gone\nconst x = 1;\n";
    const result = removeComments(source, {
      shouldRemove: (comment) => !comment.text.includes("TODO"),
    });

    expect(result.code).toBe("// TODO keep me\nconst x = 1;\n");
    expect(result.skipped).toHaveLength(1);
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
  });

  it("reports protected and predicate-skipped comments separately", () => {
    const source = "// @ts-nocheck\n// note\nconst x = 1;\n";
    const result = removeComments(source, { shouldRemove: (comment) => comment.directive === undefined });

    expect(result.code).toBe("// @ts-nocheck\nconst x = 1;\n");
    expect(result.skipped.map((comment) => comment.directive)).toEqual(["@ts-nocheck"]);
    expect(result.kept).toEqual([]);
  });

  it("keeps the shebang line", () => {
    const source = "#!/usr/bin/env node\n// gone\nconst x = 1;\n";

    expect(removeComments(source).code).toBe("#!/usr/bin/env node\nconst x = 1;\n");
  });

  it("keeps a comment sitting between a next-line directive and its code", () => {
    const source = "// eslint-disable-next-line no-console\n// shielded\nconsole.log(1);\n// gone\n";
    const result = removeComments(source);

    expect(result.code).toBe("// eslint-disable-next-line no-console\n// shielded\nconsole.log(1);\n");
    expect(result.kept.map((comment) => comment.text)).toEqual([
      "// eslint-disable-next-line no-console",
      "// shielded",
    ]);
  });

  it("shields comments below @ts-expect-error the same way", () => {
    const source = "// @ts-expect-error\n// shielded\nconst x: number = null;\n";
    const result = removeComments(source);

    expect(result.code).toBe(source);
    expect(result.removed).toEqual([]);
  });

  it("still removes a trailing comment on the line after a next-line directive", () => {
    const source = "// @ts-expect-error\nconst x: number = null; // gone\n";
    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error\nconst x: number = null;\n");
  });

  it("removes the shielding comment when the directive itself is removed", () => {
    const source = "// eslint-disable-next-line no-console\n// note\nconsole.log(1);\n";
    const result = removeComments(source, { removeDirectives: true });

    expect(result.code).toBe("console.log(1);\n");
  });

  it("does not shield comments below range or file directives", () => {
    const source = "// @ts-nocheck\n// gone\nconst x = 1;\n";
    const result = removeComments(source);

    expect(result.code).toBe("// @ts-nocheck\nconst x = 1;\n");
  });

  it("does not shield comments below range-scoped coverage pragmas", () => {
    const source = "/* c8 ignore start */\n// gone\nconst x = 1;\n/* c8 ignore stop */\n";
    const result = removeComments(source);

    expect(result.code).toBe("/* c8 ignore start */\nconst x = 1;\n/* c8 ignore stop */\n");
  });

  it("shields comments below next-statement coverage pragmas", () => {
    const source = "/* istanbul ignore next */\n// shielded\nfunction f() {}\n";
    const result = removeComments(source);

    expect(result.code).toBe(source);
  });

  it("shields every line covered by a counted ignore-next pragma", () => {
    const source = "/* c8 ignore next 2 */\n// shielded one\n// shielded two\nconst x = 1;\n// gone\n";
    const result = removeComments(source);

    expect(result.code).toBe("/* c8 ignore next 2 */\n// shielded one\n// shielded two\nconst x = 1;\n");
    expect(result.kept).toHaveLength(3);
  });

  it("shields below a bare deno-coverage-ignore", () => {
    const source = "// deno-coverage-ignore\n// shielded\nconst x = 1;\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("shields below formatter suppressions targeting the next node", () => {
    const source = "// oxfmt-ignore\n// shielded\nconst matrix = [1, 2, 3];\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("does not shield below a trailing formatter suppression", () => {
    const oxfmt = "const a = [1, 2]; // oxfmt-ignore\n// gone\nconst b = 3;\n";
    expect(removeComments(oxfmt).code).toBe("const a = [1, 2]; // oxfmt-ignore\nconst b = 3;\n");

    const prettier = "const c = [4, 5]; // prettier-ignore\n// gone\nconst d = 6;\n";
    expect(removeComments(prettier).code).toBe("const c = [4, 5]; // prettier-ignore\nconst d = 6;\n");
  });

  it("shields below the newly covered next-line directives", () => {
    const dprint = "// dprint-ignore\n// shielded\nconst matrix = [1, 2, 3];\n";
    expect(removeComments(dprint).code).toBe(dprint);

    const denoTypes = '// @deno-types="./x.d.ts"\n// shielded\nimport y from "./y.js";\n';
    expect(removeComments(denoTypes).code).toBe(denoTypes);

    const flow = "// $FlowFixMe[incompatible-call]\n// shielded\ncall(1);\n";
    expect(removeComments(flow).code).toBe(flow);

    const nx = "// nx-ignore-next-line\n// shielded\nimport z from './z.js';\n";
    expect(removeComments(nx).code).toBe(nx);

    const semgrep = "// nosemgrep: rule-id\n// shielded\ndanger();\n";
    expect(removeComments(semgrep).code).toBe(semgrep);
  });

  it("shields below stylelint-disable-next-line, which targets the line after the comment", () => {
    const line = "// stylelint-disable-next-line declaration-no-important\n// shielded\nimportant();\n";
    expect(removeComments(line).code).toBe(line);

    const block = "/* stylelint-disable-next-line block-no-empty */\n// shielded\nconst empty = css``;\n";
    expect(removeComments(block).code).toBe(block);

    // stylelint disables the line after the comment's end line, so the
    // trailing form still targets the next line rather than its own.
    const trailing = "const a = 1; /* stylelint-disable-next-line */\n// shielded\nconst b = 2;\n";
    expect(removeComments(trailing).code).toBe(trailing);
  });

  it("does not shield below stylelint-disable-line or the stylelint range commands", () => {
    const ownLine = "const a = 1; /* stylelint-disable-line */\n// gone\nconst b = 2;\n";
    expect(removeComments(ownLine).code).toBe("const a = 1; /* stylelint-disable-line */\nconst b = 2;\n");

    const range = "/* stylelint-disable */\n// gone\nconst c = 3;\n/* stylelint-enable */\n";
    expect(removeComments(range).code).toBe("/* stylelint-disable */\nconst c = 3;\n/* stylelint-enable */\n");
  });

  it("does not shield below trailing scanner suppressions that target their own line", () => {
    const semgrep = "danger(); // nosemgrep\n// gone\nsafe();\n";
    expect(removeComments(semgrep).code).toBe("danger(); // nosemgrep\nsafe();\n");

    const dprint = "const a = [1]; // dprint-ignore\n// gone\nconst b = 2;\n";
    expect(removeComments(dprint).code).toBe("const a = [1]; // dprint-ignore\nconst b = 2;\n");
  });

  it("treats every JS line terminator as ending a suppression's line", () => {
    // With U+2028 or a lone \r as the break, the suppression still stands on
    // its own line and must shield the comment below it.
    const lineSeparator = "// oxfmt-ignore\u2028// shielded\u2028const x = 1;\n";
    expect(removeComments(lineSeparator).code).toBe(lineSeparator);

    const bareCr = "// oxfmt-ignore\r// shielded\rconst x = 1;\r";
    expect(removeComments(bareCr).code).toBe(bareCr);

    const paragraphSeparator = "// oxfmt-ignore\u2029// shielded\u2029const x = 1;\n";
    expect(removeComments(paragraphSeparator).code).toBe(paragraphSeparator);

    const crlf = "// oxfmt-ignore\r\n// shielded\r\nconst x = 1;\r\n";
    expect(removeComments(crlf).code).toBe(crlf);
  });

  it("tidies lines on exotic line terminators the same way as on LF", () => {
    // Lone-CR / U+2028 / U+2029 sources get the same treatment as \n and
    // \r\n ones: a comment-only line vanishes with its terminator, and the
    // gap before a trailing comment is trimmed.
    expect(removeComments("// gone\rconst b = 2;\r").code).toBe("const b = 2;\r");
    expect(removeComments("const a = 1; // gone\rconst b = 2;\r").code).toBe("const a = 1;\rconst b = 2;\r");
    expect(removeComments("// gone\u2028const b = 2;\u2028").code).toBe("const b = 2;\u2028");
    expect(removeComments("// gone\u2029const b = 2;\u2029").code).toBe("const b = 2;\u2029");
  });

  it("shields below node:coverage ignore next but not below its range forms", () => {
    const nextForm = "/* node:coverage ignore next */\n// shielded\nconst a = 1;\n";
    expect(removeComments(nextForm).code).toBe(nextForm);

    const rangeForm = "/* node:coverage disable */\n// gone\nconst b = 1;\n";
    expect(removeComments(rangeForm).code).toBe("/* node:coverage disable */\nconst b = 1;\n");
  });

  it("keeps mid-file coverage ignore-file pragmas, which stay live for istanbul and Vitest", () => {
    const source = "const a = 1;\n/* istanbul ignore file */\nconst b = 2;\n// v8 ignore file\n";
    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.directive)).toEqual(["istanbul-ignore-file", "v8-ignore-file"]);
  });

  it("shields below line-comment coverage hints, which Vitest's v8 provider honours", () => {
    const source = "// v8 ignore next\n// shielded\nfunction f() {}\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("removes a block @ts-ignore that neither tsc nor Flow reads, being on neither its first nor its last line", () => {
    const source = "/* note\n * @ts-ignore\n */\nconst x = 1;\n";
    const result = removeComments(source);

    expect(result.code).toBe("const x = 1;\n");
    expect(result.removed).toHaveLength(1);
  });

  it("keeps a block @ts-ignore that opens the comment, which Flow honours in TypeScript files", () => {
    const source = "/* @ts-ignore\n */\nconst x = 1;\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("keeps a byte-order mark when removing the first line", () => {
    const result = removeComments("\uFEFF// gone\nconst x = 1;\n");

    expect(result.code).toBe("\uFEFFconst x = 1;\n");
  });

  it("reports ranges that index into the given source, byte-order mark included", () => {
    // The string APIs agree with each other: removeComments sees the same
    // comments (positions, columns, directives) scanComments reports for the
    // very same string, so slicing the input with a reported range always
    // yields the comment text.
    const source = "\uFEFF// gone\nconst x = 1;\n";
    const result = removeComments(source);

    expect(result.removed).toEqual(scanComments(source));
    expect(result.removed[0]?.start).toBe(1);
    expect(source.slice(result.removed[0]?.start, result.removed[0]?.end)).toBe("// gone");
  });

  it("passes source-indexed comments to shouldRemove for a source with a byte-order mark", () => {
    const source = "\uFEFF// a\n// b\nconst x = 1;\n";
    const result = removeComments(source, {
      shouldRemove: (comment) => source.slice(comment.start, comment.end) === comment.text,
    });

    expect(result.skipped).toEqual([]);
    expect(result.code).toBe("\uFEFFconst x = 1;\n");
  });

  it("treats // @bun behind a byte-order mark as inert, matching scanComments", () => {
    // The string does not start with `// @bun` (its first character is the
    // mark), so the marker is no directive here, and Bun itself would not
    // treat such file bytes as pre-transpiled either. File scans see the
    // decoded, BOM-stripped text instead, where the marker does count.
    const source = "\uFEFF// @bun\nconst x = 1;\n";

    expect(scanComments(source)[0]?.directive).toBeUndefined();
    expect(removeComments(source).code).toBe("\uFEFFconst x = 1;\n");
  });

  it("survives a stress mix of comments and code", () => {
    const source = [
      "/* header */",
      "import ts from 'typescript'; // side note",
      "",
      "/** docs */",
      "export function f(/* arg docs */ a: number): number {",
      "  const url = 'http://example.com'; // keep the string",
      "  return a /* mid */ + 1; // done",
      "}",
      "",
    ].join("\n");

    const result = removeComments(source);

    expect(result.code).toBe(
      [
        "import ts from 'typescript';",
        "",
        "export function f(a: number): number {",
        "  const url = 'http://example.com';",
        "  return a + 1;",
        "}",
        "",
      ].join("\n"),
    );
    expect(result.removed).toHaveLength(7);
  });
});

describe("removeComments next-line shielding by whole lines", () => {
  it("keeps every comment of a comment-only line under @ts-expect-error", () => {
    // Removing both block comments would delete the physical line and move
    // the suppression onto the code below, silently masking its type error.
    const source = '// @ts-expect-error\n/* one */ /* two */\nconst x: number = "bad";\n';

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
    expect(result.kept.map((comment) => comment.text)).toEqual(["// @ts-expect-error", "/* one */", "/* two */"]);
  });

  it("keeps a multi-line block comment whose first line is shielded", () => {
    const source = "// @ts-expect-error\n/* multi\nline */\nconst x: number = null;\n// gone\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error\n/* multi\nline */\nconst x: number = null;\n");
  });

  it("still removes a comment on a shielded line that also holds code", () => {
    const source = "// @ts-expect-error\n/* gone */ const x: number = null;\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error\nconst x: number = null;\n");
  });

  it("still removes a comment when a kept comment holds the shielded line open", () => {
    const source = "// @ts-expect-error\n/*! legal */ /* gone */\nconst x: number = null;\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error\n/*! legal */\nconst x: number = null;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["/* gone */"]);
  });

  it("chains shields through comments that were re-protected", () => {
    // The skipped @ts-expect-error shields the @ts-ignore line; the kept
    // @ts-ignore then shields the plain comment, so nothing may be removed.
    const source = "// @ts-expect-error\n// @ts-ignore\n// plain\nbroken();\n";

    const result = removeComments(source, {
      removeDirectives: true,
      shouldRemove: (comment) => comment.directive !== "@ts-expect-error",
    });

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("does not treat prose like 'ignore next 3' in a directive reason as a counted shield", () => {
    const source = "// @ts-expect-error we ignore next 3 legacy calls\nconst x: number = null;\n// A\n// B\n// C\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-expect-error we ignore next 3 legacy calls\nconst x: number = null;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["// A", "// B", "// C"]);
  });

  it("honours counted coverage pragmas with five or more digits", () => {
    const source = "/* c8 ignore next 10000 */\nconst a = 1;\n// A\n// B\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toEqual(["/* c8 ignore next 10000 */", "// A", "// B"]);
  });

  it("shields a line targeted by two directives sharing the line above it only once", () => {
    const source = "/* @ts-ignore */ /* @ts-expect-error */\nconst x = 1; // gone\n";

    const result = removeComments(source);

    expect(result.code).toBe("/* @ts-ignore */ /* @ts-expect-error */\nconst x = 1;\n");
    expect(result.kept.map((comment) => comment.text)).toEqual(["/* @ts-ignore */", "/* @ts-expect-error */"]);
    expect(result.removed.map((comment) => comment.text)).toEqual(["// gone"]);
  });

  it("keeps a multi-line comment whose removal would pull the next line's code onto a shielded one", () => {
    // Right after an opening bracket or before closing punctuation a removed
    // comment leaves no line break behind, so `debugger` (or `bad()`) would
    // join the line the directive covers and lose its report.
    for (const source of [
      "// eslint-disable-next-line no-debugger\nfoo(/* a\n*/); debugger;\n",
      "// oxlint-disable-next-line no-debugger\nfoo([/* a\n*/]); debugger;\n",
      "// eslint-disable-next-line no-debugger\nconst x = 1 /* a\n*/; debugger;\n",
      "// @ts-expect-error\nfoo(/* a\n*/); bad();\n",
    ]) {
      expect(removeComments(source).changed).toBe(false);
    }
  });

  it("keeps a multi-line comment whose removal would pull a shielded line's code onto the one above", () => {
    const source = "/* eslint-disable-next-line no-debugger */ foo(/* a\n*/ debugger);\nbar();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("still removes a multi-line comment that trails a shielded line with nothing after it", () => {
    const source = "// @ts-expect-error -- legacy\nlegacy(); /* drop once\n   the API is gone */\nnext();\n";

    expect(removeComments(source).code).toBe("// @ts-expect-error -- legacy\nlegacy();\nnext();\n");
  });

  it("keeps a multi-line comment whose removal would join another line to a line directive's own", () => {
    const joining = "foo(/* a\n*/ bar); // eslint-disable-line no-undef\n";
    const opening = "/* a\n*/ foo(); // eslint-disable-line no-undef\n";

    expect(removeComments(joining).changed).toBe(false);
    // With nothing in front of it, the comment's removal only moves the line up whole.
    expect(removeComments(opening).code).toBe("foo(); // eslint-disable-line no-undef\n");
  });
});

describe("removeComments on the rows oxlint reads its line directives on", () => {
  // oxlint ends a row at a line feed alone: a lone CR, U+2028 or U+2029 —
  // a line break to tsc and ESLint — leaves the row open. Verified against
  // oxlint 1.90.
  it("keeps the comment-only row a next-line directive covers past a U+2028", () => {
    const source = "/* eslint-disable-next-line no-debugger */\u2028foo();\n// note\ndebugger;\n";
    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toContain("// note");
    // The row may be the file's last, with no line feed after it.
    expect(removeComments("/* eslint-disable-next-line no-debugger */\u2028foo();\n// note").changed).toBe(false);
  });

  it("keeps a comment whose line break would split the row a next-line directive covers", () => {
    // Replaced by a line feed, the U+2028 inside the comment would end the row
    // in front of `debugger`.
    const source = "// oxlint-disable-next-line no-debugger\nfoo(); /* a\u2028b */ debugger;\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("keeps the lines in front of a line directive that share its row", () => {
    const source = "foo(); /* a\u2028*/ bar(); // oxlint-disable-line no-undef\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("removes comments around a next-line directive on the file's last row as usual", () => {
    // With no line feed after it, the directive covers the rest of the file
    // whatever is removed.
    const source = "// eslint-disable-next-line no-debugger\rfoo();\r// gone\rdebugger;";

    expect(removeComments(source).code).toBe("// eslint-disable-next-line no-debugger\rfoo();\rdebugger;");
  });
});

describe("removeComments position-dependent directive protection", () => {
  it("keeps a leading comment whose removal would activate an inert @format pragma", () => {
    // The docblock is kept for its @license, and its @format is inert because
    // prettier's pragma mode only reads the file's FIRST comment. Deleting
    // `/* lead */` would promote the docblock to first comment and turn
    // --require-pragma formatting on for the whole file.
    const source = "/* lead */\n/**\n * @format\n * @license\n */\nconst x={a:1}\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((comment) => comment.text)).toEqual(["/* lead */", "/**\n * @format\n * @license\n */"]);
  });

  it("keeps a leading comment whose removal would move // @bun to the file start", () => {
    // Bun treats a file as pre-transpiled only when it literally starts with
    // `// @bun`; deleting the lead line would move the kept legal comment to
    // byte zero and activate the marker.
    const source = "// lead\n// @bun @license\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("keeps a kept comment's directive name stable instead of trading nosemgrep for @format", () => {
    const source = "/* lead */\n/** @format nosemgrep */\ndanger();\n";

    expect(scanComments(source).map((comment) => comment.directive)).toEqual([undefined, "nosemgrep"]);

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("still removes leading comments that are not needed to keep the pragma inert", () => {
    // Keeping `/* ordinary */` is enough to hold the docblock away from the
    // first-comment position; the line before it can still go.
    const source = "// lead\n/* ordinary */\n/** @format @license */\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.code).toBe("/* ordinary */\n/** @format @license */\nconst x = 1;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["// lead"]);
    expect(result.kept.map((comment) => comment.text)).toEqual(["/* ordinary */", "/** @format @license */"]);
  });

  it("applies the same protection when shouldRemove selects only the leading comment", () => {
    const source = "/* lead */\n/** @format @license */\nconst x = 1;\n";

    const result = removeComments(source, { shouldRemove: (comment) => comment.text === "/* lead */" });

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
    expect(result.skipped.map((comment) => comment.text)).toEqual(["/** @format @license */"]);
    expect(result.kept.map((comment) => comment.text)).toEqual(["/* lead */"]);
  });

  it("still removes ordinary comments behind an already active first-comment pragma", () => {
    const source = "/** @format */\n// gone\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.code).toBe("/** @format */\nconst x = 1;\n");
    expect(result.kept.map((comment) => comment.directive)).toEqual(["@format"]);
  });

  it("removes the pragma holder and its lead together when removeLegal consents", () => {
    const source = "/* lead */\n/** @format @license */\nconst x = 1;\n";

    const result = removeComments(source, { removeLegal: true });

    expect(result.code).toBe("const x = 1;\n");
    expect(result.removed).toHaveLength(2);
  });

  it("keeps a leading comment whose removal would activate a pragma masked by another directive", () => {
    // detectDirective names this docblock "eslint" before and after the
    // removal, so the canonical name alone cannot reveal that the inert
    // @format underneath just became the file's first comment.
    const source = "/* lead */\n/* eslint no-console: 0\n * @format\n * @license\n */\nconst x={a:1}\n";

    expect(scanComments(source).map((comment) => comment.directive)).toEqual([undefined, "eslint"]);

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("keeps a leading comment whose removal would move a masked // @bun to the file start", () => {
    // The type-coverage rule names the comment before the @bun rule runs;
    // the marker landing on byte zero must still be caught.
    const source = "// lead\n// @bun type-coverage:ignore-line\nconst x = 1;\n";

    expect(scanComments(source).map((comment) => comment.directive)).toEqual([undefined, "type-coverage:ignore-line"]);

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("applies the masked-pragma protection behind a shebang too", () => {
    const source = "#!/usr/bin/env node\n// lead\n/* eslint no-console: 0\n * @format\n */\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
  });

  it("still removes comments behind a pragma that was already first and active", () => {
    const source = "/* eslint no-console: 0\n * @format\n */\n// gone\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.code).toBe("/* eslint no-console: 0\n * @format\n */\nconst x = 1;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["// gone"]);
  });
});

describe("removeComments positional protection for the October 2026 tool sources", () => {
  it("keeps a leading comment whose removal would move // @bun to the line after a shebang", () => {
    // Bun reads its marker at the file start or right after a `#!` line.
    const source = "#!/usr/bin/env bun\n// lead\n// @bun @license\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toEqual(["// lead", "// @bun @license"]);
  });

  it("keeps a leading comment whose removal would make deno-coverage-ignore-file the first comment", () => {
    // Deno only honours the pragma as the file's first comment; the license
    // keeps the inert one from going with the lead comment.
    const source = "// lead\n// deno-coverage-ignore-file @license MIT\nconst x = 1;\n";

    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toEqual([
      "// lead",
      "// deno-coverage-ignore-file @license MIT",
    ]);
  });
});

describe("removeComments below tsc suppressions", () => {
  it("keeps the first comment line tsc cannot step over between a suppression and its code", () => {
    // tsc looks past blank and `//` lines for the line a suppression applies
    // to; a block-comment line stops it, so the suppression has no target.
    // Deleting that line would let it reach the assignment instead.
    const source = '// @ts-expect-error\n\n/* blocker */\nconst a: number = "x";\n';

    const result = removeComments(source);

    expect(result.changed).toBe(false);
  });

  it("still removes the `//` lines tsc steps over, below the line Flow targets", () => {
    const source = "// @ts-ignore\n// note\n\n// gone\nfoo();\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-ignore\n// note\n\nfoo();\n");
  });

  it("treats a line tsc 7 does not step over as blocking, though tsc 6 would", () => {
    // tsc 7 skips only spaces and tabs before the `//` of a comment line.
    const source = "// @ts-ignore\n\n\u00a0// note\nfoo();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("removes comments on a blocking line that a kept comment opens", () => {
    const source = "// @ts-ignore\n\n/*! legal */ /* gone */\nfoo();\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-ignore\n\n/*! legal */\nfoo();\n");
  });

  it("keeps the line each compiler stops at when the two stop at different lines", () => {
    // tsc 7 stops at the vertical-tab line, which tsc 6 trims away and steps
    // over before stopping at the block comment.
    const source = "// @ts-ignore\n\v\n/* stop */\nfoo();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("still removes the `//` lines both compilers step over behind a whitespace-only blocking line", () => {
    const source = "// @ts-ignore\n\v\n// gone\nfoo();\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-ignore\n\v\nfoo();\n");
  });

  it("keeps a multi-line comment that starts on the suppression's line and blocks the next one", () => {
    const source = "/* @ts-ignore */ /* note\n   more */\nfoo();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("removes blocking comments when no code follows the suppression at all", () => {
    const source = "// @ts-ignore\n\n/* gone */\n";

    const result = removeComments(source);

    expect(result.code).toBe("// @ts-ignore\n\n");
  });
});

describe("removeComments for directives that must stay the last comment before their target", () => {
  it("keeps every comment between @deno-types and its import, trailing ones included", () => {
    // deno_graph reads the directive from the import's last leading comment:
    // with another comment after it the directive is inert, and deleting
    // that comment would activate it.
    const apart = '// @deno-types="./x.d.ts"\n\n// note\nimport y from "./y.js";\n';
    const inline = '// @deno-types="./x.d.ts"\n/* note */ import y from "./y.js";\n';

    expect(removeComments(apart).changed).toBe(false);
    expect(removeComments(inline).changed).toBe(false);
  });

  it("keeps the comments between a GraphQL tag and its template", () => {
    const source = "const q = /* GraphQL */ /* note */ `query { a }`;\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("keeps the comments between ESLint's fallthrough and default-case comments and their target", () => {
    const source = [
      "switch (x) {",
      "  case 1:",
      "    a();",
      "    // falls through",
      "",
      "    // TODO: split",
      "  case 2:",
      "    b();",
      "    break;",
      "  // no default",
      "  // reviewed",
      "}",
      "",
    ].join("\n");

    expect(removeComments(source).changed).toBe(false);
  });

  it("removes ordinary comments after the target as usual", () => {
    const spaced = "const q = /* GraphQL */ `query { a }`; // gone\n";
    const tight = "const q = /* GraphQL */`query { a }`; // gone\n";

    expect(removeComments(spaced).code).toBe("const q = /* GraphQL */ `query { a }`;\n");
    expect(removeComments(tight).code).toBe("const q = /* GraphQL */`query { a }`;\n");
  });
});

describe("removeComments shields from directives that mention another tool's marker", () => {
  it("keeps the next-line shield of a directive whose text mentions a JSX pragma", () => {
    const source = "// nosemgrep: react-dangerously-set-inner-html -- @jsx h below\n// note\nrender();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("does not shield the line below a node:coverage range pragma", () => {
    const source = "/* node:coverage ignore start */\n// gone\nfoo();\n/* node:coverage ignore stop */\n";

    expect(removeComments(source).code).toBe(
      "/* node:coverage ignore start */\nfoo();\n/* node:coverage ignore stop */\n",
    );
  });
});

describe("removeComments gaps before code no last-comment directive reads", () => {
  it("removes fallthrough words outside a switch like any other comment", () => {
    const source = "// this helper falls through to the default handler\n// gone\nfoo();\n";

    expect(removeComments(source).code).toBe("foo();\n");
  });

  it("keeps the comments before a default clause or a case block's closing brace", () => {
    const beforeDefault = "switch (x) {\n  case 1:\n    a();\n  // falls through\n  // kept\n  default:\n    b();\n}\n";
    const beforeBrace =
      "switch (x) {\n  case 1: {\n    a();\n    // falls through\n    // kept\n  }\n  case 2:\n    b();\n}\n";

    expect(removeComments(beforeDefault).changed).toBe(false);
    expect(removeComments(beforeBrace).changed).toBe(false);
  });

  it("removes a no-default comment that does not close a switch like any other comment", () => {
    const source = "// no default\n// gone\nfoo();\n";

    expect(removeComments(source).code).toBe("foo();\n");
  });

  it("removes the comments after a last-comment directive with no code left to target", () => {
    const source = 'foo();\n// @deno-types="./x.d.ts"\n// gone\n';

    expect(removeComments(source).code).toBe('foo();\n// @deno-types="./x.d.ts"\n');
  });
});

describe("removeComments below a tsc suppression that shares its line with code", () => {
  it("keeps the first line tsc stops at below the line of the suppression and its code", () => {
    const source = '/* @ts-expect-error */ const b = 1;\n\n/* stop */\nconst a: number = "x";\n';

    expect(removeComments(source).changed).toBe(false);
  });

  it("looks past a block comment that opens on the suppression's line and closes below it", () => {
    // The comment's closing line already stops tsc, so the comment stays and
    // the block comment further down may go.
    const source = '/* @ts-expect-error */ const b = 1; /* note\n */\n\n/* gone */\nconst a: number = "x";\n';

    const result = removeComments(source);

    expect(result.code).toBe('/* @ts-expect-error */ const b = 1; /* note\n */\n\nconst a: number = "x";\n');
  });

  it("finds nothing to keep below a suppression on the last line", () => {
    const source = "/* gone */ foo(); // @ts-ignore";

    expect(removeComments(source).code).toBe("foo(); // @ts-ignore");
  });
});

describe("removeComments keeps the shields of directives that open a comment", () => {
  it("keeps the next-line shield of a suppression that mentions an earlier rule's marker", () => {
    // The gitleaks rule comes first in the table, but the comment opens with
    // detect-secrets' next-line pragma, which keeps its name and shield.
    const source = '// pragma: allowlist nextline secret (gitleaks:allow too)\n// note\nconst key = "x";\n';

    expect(removeComments(source).changed).toBe(false);
  });
});

describe("removeComments keeps what tools read in large real-world codebases", () => {
  const jestPragma = ["@jest", "environment"].join("-");

  it("keeps stripInternal's @internal markers, so the emitted declarations stay as narrow", () => {
    const source = "/** @internal */\nexport function track(): void {}\n// gone\nexport const x = 1;\n";

    expect(removeComments(source).code).toBe(
      "/** @internal */\nexport function track(): void {}\nexport const x = 1;\n",
    );
    expect(removeComments(source, { removeDirectives: true }).code).toBe(
      "export function track(): void {}\nexport const x = 1;\n",
    );
  });

  it("keeps a Jest docblock that picks a scoped-package environment", () => {
    const source = `/**\n * ${jestPragma} @edge-runtime/jest-environment\n */\n// gone\nimport { x } from "y";\n`;

    expect(removeComments(source).code).toBe(
      `/**\n * ${jestPragma} @edge-runtime/jest-environment\n */\nimport { x } from "y";\n`,
    );
  });

  it("keeps the comment in front of a kept Jest docblock that removing it would make the first", () => {
    // The docblock stays for its license tag; as the second comment Jest
    // ignores its pragma, so the comment holding it there stays too.
    const docblock = `/**\n * @license MIT\n * ${jestPragma} ./env.js\n */`;
    const source = `// lead\n${docblock}\ntest("x", () => {});\n`;
    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toEqual(["// lead", docblock]);
  });

  it("removes an inert Jest docblock that is not the first comment along with the rest", () => {
    const source = `// lead\n/** ${jestPragma} ./env.js */\ntest("x", () => {});\n`;

    expect(removeComments(source).code).toBe('test("x", () => {});\n');
  });

  it("shields the line below a standalone ast-grep suppression", () => {
    const source = "// ast-grep-ignore: no-eval\n// why\neval(x);\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("shields the line below an ast-grep block comment that code follows but nothing precedes", () => {
    // ast-grep only asks what precedes the comment on its line: nothing does,
    // so it suppresses the next line, not `foo()`. Dropping `// filler` would
    // move `bar()` onto that line.
    const source = "/* ast-grep-ignore */ foo();\n// filler\nbar();\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("shields nothing below an ast-grep suppression that trails code", () => {
    const source = "eval(x); // ast-grep-ignore: no-eval\n// gone\nfoo();\n";

    expect(removeComments(source).code).toBe("eval(x); // ast-grep-ignore: no-eval\nfoo();\n");
  });

  it("keeps the comments in front of an ast-grep suppression on its line, which make it trailing", () => {
    const standalone = "foo();\n/* note */ // ast-grep-ignore\neval(x); // gone\n";
    const trailing = "foo(\n  1,\n); /* note */ // ast-grep-ignore\n";

    expect(removeComments(standalone).code).toBe("foo();\n/* note */ // ast-grep-ignore\neval(x);\n");
    expect(removeComments(trailing).changed).toBe(false);
  });

  it("keeps the comment whose removal would move an ast-grep suppression into its file-wide position", () => {
    // On the first line, with nothing on the line below, it suppresses the whole file.
    const source = "// lead\n// ast-grep-ignore\n\neval(x);\n";
    const result = removeComments(source);

    expect(result.changed).toBe(false);
    expect(result.kept.map((comment) => comment.text)).toEqual(["// lead", "// ast-grep-ignore"]);
  });

  it("keeps the comment after an ast-grep suppression opening the file on the line it ends on", () => {
    // Deleting `/* stays */` would leave `foo()` two lines down: file-wide.
    const oneLine = "/* ast-grep-ignore */ /* stays */\n\nfoo(); // gone\n";
    const multiLine = "/* ast-grep-ignore\n */ /* stays */\nfoo(); // gone\n";
    // With nothing at all after it, ast-grep makes it file-wide too.
    const wholeFile = "/* ast-grep-ignore */ /* stays */";
    // Anywhere but on the first line, what follows it does not matter.
    const later = "x();\n/* ast-grep-ignore */ /* gone */\n\nfoo();\n";

    expect(removeComments(oneLine).code).toBe("/* ast-grep-ignore */ /* stays */\n\nfoo();\n");
    expect(removeComments(multiLine).code).toBe("/* ast-grep-ignore\n */ /* stays */\nfoo();\n");
    expect(removeComments(wholeFile).changed).toBe(false);
    expect(removeComments(later).code).toBe("x();\n/* ast-grep-ignore */\n\nfoo();\n");
  });

  it("removes the comment in front of an ast-grep suppression that stays a next-line one on the first line", () => {
    // With code right below, it suppresses that line before and after alike.
    const source = "// lead\n// ast-grep-ignore\neval(x);\n";

    expect(removeComments(source).code).toBe("// ast-grep-ignore\neval(x);\n");
  });

  it("keeps a comment that only mentions ast-grep-ignore, which suppresses up to ast-grep 0.45.2", () => {
    const source = "x();\n// TODO: drop the ast-grep-ignore below\neval(y);\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("reads the ast-grep suppression a comment carries whatever directive names it", () => {
    // `/* note */` is what the suppression trails; without it the suppression
    // would trail `foo(...)`, which starts two rows up.
    const eslint = "foo(\n  1,\n); /* note */ // eslint-disable-next-line no-eval -- ast-grep-ignore\neval(y);\n";
    const tsc = "foo(\n  1,\n); /* note */ /* ast-grep-ignore\n @ts-ignore */\neval(y);\n";

    expect(removeComments(eslint).changed).toBe(false);
    expect(removeComments(tsc).changed).toBe(false);
  });

  it("shields the row below a suppression trailing a statement that starts rows up, as releases up to 0.43 read it", () => {
    // From 0.44.0 it suppresses `foo(...)`; up to 0.43 it suppresses the next row.
    const source = "foo(\n  1,\n); // ast-grep-ignore\n// shielded\neval(y);\n";

    expect(removeComments(source).changed).toBe(false);
  });

  it("keeps the comments whose removal would join the rows an ast-grep suppression covers", () => {
    // Dropping `/* x\n */` would pull `hit(3)` onto the suppressed row below the comment,
    const below = "x();\n/* ast-grep-ignore */ hit(/* x\n */ 2);\nhit(3);\n";
    // and `hit(1)` onto the row of the node it trails (its own row up to 0.43).
    const trailed = "hit(/* x\n */ 1); /* y\n */ /* ast-grep-ignore */\nfoo();\n";
    const own = "x(); /* ast-grep-ignore */ y(/* x\n */ hit(1));\n";

    expect(removeComments(below).changed).toBe(false);
    expect(removeComments(trailed).changed).toBe(false);
    expect(removeComments(own).changed).toBe(false);
  });

  it("removes the comments in front of the last token before a trailing ast-grep suppression", () => {
    // They decide neither what it trails nor which rows it covers.
    const source = "foo(/* inline */ a); // ast-grep-ignore: no-eval\n";

    expect(removeComments(source).code).toBe("foo(a); // ast-grep-ignore: no-eval\n");
  });

  it("shields nothing below an ast-grep block comment spanning three rows, which covers its own second row", () => {
    const source = "x();\n/* ast-grep-ignore: no-eval\n   because of y\n */\n// gone\neval(y);\n";

    expect(removeComments(source).code).toBe("x();\n/* ast-grep-ignore: no-eval\n   because of y\n */\neval(y);\n");
  });

  it("counts ast-grep's rows by line feeds, which a lone CR or U+2028 does not end", () => {
    // `foo();` shares the comment's row, so the row it covers is the next one.
    const bareCr = "x();\n// ast-grep-ignore\rfoo();\n// shielded\neval(y);\n";
    const separator = "x();\n// ast-grep-ignore\u2028foo();\n// shielded\neval(y);\n";
    // `x();` shares the comment's row, so the comment trails it and covers no row below.
    const trailing = "x();\r// ast-grep-ignore\n// gone\neval(y);\n";

    expect(removeComments(bareCr).changed).toBe(false);
    expect(removeComments(separator).changed).toBe(false);
    expect(removeComments(trailing).code).toBe("x();\r// ast-grep-ignore\neval(y);\n");
  });

  it("shields no row below an ast-grep suppression in JSX braces, which trails the brace", () => {
    const source = "x(\n  <div>\n    {/* ast-grep-ignore */}\n    {/* gone */}\n    <b />\n  </div>,\n);\n";

    expect(removeComments(source, { jsx: true }).code).toBe(
      "x(\n  <div>\n    {/* ast-grep-ignore */}\n    <b />\n  </div>,\n);\n",
    );
  });

  it("keeps copyright headers in their conventional wording", () => {
    const header = [
      "/*---------------------------------------------------------------------------------------------",
      " *  Copyright (c) Microsoft Corporation. All rights reserved.",
      " *  Licensed under the MIT License. See License.txt in the project root for license information.",
      " *--------------------------------------------------------------------------------------------*/",
    ].join("\n");
    const source = `${header}\n\n// gone\nexport const x = 1;\n`;

    expect(removeComments(source).code).toBe(`${header}\n\nexport const x = 1;\n`);
    expect(removeComments(source, { removeLegal: true }).code).toBe("export const x = 1;\n");
  });

  it("removes fall-through words in front of a block's closing brace outside a case", () => {
    const source = [
      "if (ready) {",
      "  run();",
      "  // Listed but not yet valid: fall through to wait and re-poll.",
      "  // Deliberately no early give-up here.",
      "} else {",
      "  wait();",
      "}",
      "",
    ].join("\n");

    expect(removeComments(source).code).toBe("if (ready) {\n  run();\n} else {\n  wait();\n}\n");
  });

  it("keeps what the keep predicate claims, like a directive, and reports it as kept", () => {
    const source = "// INJECT:nextConfigOutput\n// gone\nconst x = 1;\n";
    const result = removeComments(source, {
      removeDirectives: true,
      keep: (comment) => comment.text.startsWith("// INJECT"),
    });

    expect(result.code).toBe("// INJECT:nextConfigOutput\nconst x = 1;\n");
    expect(result.kept.map((comment) => comment.text)).toEqual(["// INJECT:nextConfigOutput"]);
  });
});

describe("removeComments in blocks that hold nothing but comments", () => {
  it("keeps the comment that keeps an empty catch block off no-empty's report", () => {
    const source = "try {\n  run();\n} catch {\n  // ignore\n}\n// gone\n";
    const result = removeComments(source);

    expect(result.code).toBe("try {\n  run();\n} catch {\n  // ignore\n}\n");
    expect(result.kept.map((comment) => comment.directive)).toEqual(["empty-block"]);
    expect(removeComments(source, { removeDirectives: true }).code).toBe("try {\n  run();\n} catch {\n}\n");
  });

  it("keeps the comments of empty function bodies, static blocks and switches", () => {
    const source = [
      "const noop = () => {",
      "  /* noop */",
      "};",
      "class C {",
      "  static {",
      "    // nothing to set up",
      "  }",
      "}",
      "switch (kind) {",
      "  // no kinds yet",
      "}",
      "",
    ].join("\n");

    expect(removeComments(source).changed).toBe(false);
  });

  it("removes the comments of blocks that hold code as usual", () => {
    const source = "if (a) {\n  // gone\n  run();\n}\n";

    expect(removeComments(source).code).toBe("if (a) {\n  run();\n}\n");
  });

  it("tells the comment of an empty function body from one in a body that holds code", () => {
    const source = "function f() {\n  // gone\n  return;\n}\nfunction g() {\n  // kept\n}\n";
    const result = removeComments(source);

    expect(result.code).toBe("function f() {\n  return;\n}\nfunction g() {\n  // kept\n}\n");
    expect(scanComments(result.code).map((comment) => comment.directive)).toEqual(["empty-block"]);
  });

  it("keeps a comment between `static` and the brace of an empty static block, which oxlint counts", () => {
    const source = "class C {\n  /* gone */ static /* kept */ {}\n}\n";
    const result = removeComments(source);

    expect(result.code).toBe("class C {\n  static /* kept */ {}\n}\n");
    expect(result.kept.map((comment) => comment.directive)).toEqual(["empty-block"]);
  });
});

describe("removeComments in files that hold no code", () => {
  it("keeps the `///` comments that keep no-empty-file from reporting the file", () => {
    const source = '"use strict";\n/// placeholder until the API lands\n// TODO: fill in\n';
    const result = removeComments(source);

    expect(result.code).toBe('"use strict";\n/// placeholder until the API lands\n');
    expect(result.kept.map((comment) => comment.directive)).toEqual(["empty-file"]);
  });

  it("removes every comment of an empty file without one, which the rules report either way", () => {
    expect(removeComments("// TODO: fill in\n/* later */\n").code).toBe("");
  });

  it("removes `///` comments like any other once the file holds code", () => {
    expect(removeComments("/// note\nexport const x = 1;\n").code).toBe("export const x = 1;\n");
  });
});

// Verified against Vitest 5.1's v8 and istanbul providers (ast-v8-to-istanbul
// 1.0.7, @vitest/istanbul-lib-instrument 2.1.0), c8 and monocart-coverage-reports.
describe("removeComments around the coverage hints Vitest's providers read", () => {
  it("keeps the comments between a next-node hint and its node, which leave ast-v8-to-istanbul's hint without a target", () => {
    const sameLine = "/* v8 ignore next */ /* see #12 */ export function f() {}\n";
    const trailing = "/* v8 ignore next */ // why\nb();\n";
    const below = "/* istanbul ignore if */\n\n// rare, see #12\nif (x) {\n  f();\n}\n";

    expect(removeComments(sameLine).code).toBe(sameLine);
    expect(removeComments(trailing).code).toBe(trailing);
    expect(removeComments(below).kept.map((comment) => comment.text)).toEqual([
      "/* istanbul ignore if */",
      "// rare, see #12",
    ]);
  });

  it("still removes the comments past the start of the node, and those after a hint no code follows", () => {
    const inside = "/* c8 ignore else */\nif (x) {\n  f(); // gone\n} else {\n  g();\n}\n";

    expect(removeComments(inside).code).toBe("/* c8 ignore else */\nif (x) {\n  f();\n} else {\n  g();\n}\n");
    expect(removeComments("f();\n/* v8 ignore next */\n\n// gone\n").code).toBe("f();\n/* v8 ignore next */\n\n");
  });

  it("does not shield the gap after a file hint, which applies wherever it stands", () => {
    expect(removeComments("/* v8 ignore file */\n\n// gone\nf();\n").code).toBe("/* v8 ignore file */\n\nf();\n");
  });

  it("shields one line below a counted istanbul hint, which only istanbul and ast-v8-to-istanbul read", () => {
    expect(removeComments("/* istanbul ignore next 2 */\nf();\n// gone\ng();\n").code).toBe(
      "/* istanbul ignore next 2 */\nf();\ng();\n",
    );
  });

  it("counts the lines monocart reads from digits glued to `next`", () => {
    const source = "// v8 ignore next3\nf();\n// kept\ng();\n// gone\nh();\n";

    expect(removeComments(source).code).toBe("// v8 ignore next3\nf();\n// kept\ng();\nh();\n");
  });

  it("keeps a comment mentioning import.meta.vitest, which makes Vitest run an includeSource file", () => {
    const inSource = ["import", "meta", "vitest"].join(".");
    const source = `// tests run through ${inSource}\nexport const a = 1;\n`;

    expect(removeComments(source).kept.map((comment) => comment.directive)).toEqual([inSource]);
  });
});

// Verified against TypeScript's organizeImports (tsc 6, and tsc 7's port by
// reading its source), prettier-plugin-organize-imports and dprint's
// TypeScript plugin; see also remove.organize.test.ts.
describe("removeComments between groups of imports", () => {
  const b = 'import { b } from "./b";';
  const a = 'import { a } from "./a";';

  it("keeps the comment line that holds two groups of imports apart for organizeImports and dprint", () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      "// local modules",
      'import { parse } from "./parse.js";',
      "",
      "export const run = () => parse(readFile); // gone",
      "",
    ].join("\n");
    const result = removeComments(source);

    expect(result.code).toBe(source.replace(" // gone", ""));
    expect(result.kept.map((comment) => comment.text)).toEqual(["// local modules"]);
  });

  it("removes it where a blank line stays to hold the groups apart", () => {
    expect(removeComments(`${b}\n// note\n\n${a}\n`).code).toBe(`${b}\n\n${a}\n`);
    expect(removeComments(`${b}\n\n// note\n${a}\n`).code).toBe(`${b}\n\n${a}\n`);
  });

  it("keeps only as much as holds the gap: the last comment line, and only its last comment", () => {
    expect(removeComments(`${b}\n// one\n// two\n${a}\n`).code).toBe(`${b}\n// two\n${a}\n`);
    expect(removeComments(`${b}\n/* one */ /* two */\n${a}\n`).code).toBe(`${b}\n/* two */\n${a}\n`);
  });

  it("prefers a comment line above the import's line to a comment that opens it", () => {
    expect(removeComments(`${b}\n// note\n/* x\n */ ${a}\n`).code).toBe(`${b}\n// note\n${a}\n`);
  });

  it("keeps the line breaks inside a comment where only dprint counts them", () => {
    const opening = `${b}\n/* note\n */ ${a}\n`;
    const trailing = `${b} /* note\n */\n${a}\n`;

    expect(removeComments(opening).code).toBe(opening);
    expect(removeComments(trailing).code).toBe(trailing);
  });

  it("keeps only the multi-line comment that dprint's line count rests on, not the ones trailing it", () => {
    expect(removeComments(`${b} /* x\n */ // y\n${a}\n`).code).toBe(`${b} /* x\n */\n${a}\n`);
  });

  it("keeps a multi-line comment a line break would take the place of, starting a group for TypeScript", () => {
    // Between code and a comment that stays, a multi-line comment goes for a
    // line break, which TypeScript counts where it counted none inside it.
    const kept = [`${b} /* note\n more */ /*! legal */\n${a}\n`, `${b}/* c1\n */ /*! k */\n${a}\n`];

    for (const source of kept) expect(removeComments(source).code).toBe(source);
    expect(removeComments(`${b} /* c1\n */ /*! k */\n/* c2\n */ ${a}\n`).code).toBe(`${b} /* c1\n */ /*! k */\n${a}\n`);
    expect(removeComments(`${b} /* c1\n */ /*! k */ /* c2\n */\n${a}\n`).code).toBe(`${b} /* c1\n */ /*! k */\n${a}\n`);
  });

  it("keeps a multi-line comment whose line break would stay with a U+2028 the comment after it ends at", () => {
    const source = 'import {} from "./x";/* note\n more */// note\u2028\nimport * as d from "z";\n';

    expect(removeComments(source).code).toBe('import {} from "./x";/* note\n more */\u2028\nimport * as d from "z";\n');
  });

  it("keeps a comment line that a lone CR opens, which TypeScript counts as a line break", () => {
    const source = `${b}\r// note\n${a}\n`;

    expect(removeComments(source).code).toBe(source);
  });

  it("still removes the comments that share a line with the declarations", () => {
    expect(removeComments(`${b} // note\n/* x */ ${a}\n`).code).toBe(`${b}\n${a}\n`);
  });

  it("keeps the comment lines between `export … from`s, in ambient modules and past other statements", () => {
    const exports = 'export * from "./b";\n// note\nexport * from "./a";\n';
    const ambient = `declare module "m" {\n  ${b}\n  // note\n  ${a}\n}\n`;
    const past = `${b}\nf();\n// note\n${a}\n`;

    expect(removeComments(exports).code).toBe(exports);
    expect(removeComments(ambient).code).toBe(ambient);
    expect(removeComments(past).code).toBe(past);
  });

  it("lets a kept directive hold the gap, so the comment lines beside it still go", () => {
    const source = `${b}\n// note\n// eslint-disable-next-line import/no-cycle\n${a}\n`;

    expect(removeComments(source).code).toBe(`${b}\n// eslint-disable-next-line import/no-cycle\n${a}\n`);
  });

  it("keeps the comment holding the gap even when it is a directive and directives go", () => {
    const source = `${b}\n// eslint-disable-next-line import/no-cycle\n${a}\n`;

    expect(removeComments(source, { removeDirectives: true }).code).toBe(source);
  });
});
