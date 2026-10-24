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

    expect(result.code).toBe("const x = f( 1);\n");
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

  it("leaves an empty JSX expression when removing a JSX comment", () => {
    const result = removeComments("const e = <div>{/* gone */}</div>;\n", { jsx: true });

    expect(result.code).toBe("const e = <div>{ }</div>;\n");
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
        "export function f( a: number): number {",
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
  it("removes the comments after fallthrough words outside a switch", () => {
    const source = "// this helper falls through to the default handler\n// gone\nfoo();\n";

    expect(removeComments(source).code).toBe("// this helper falls through to the default handler\nfoo();\n");
  });

  it("keeps the comments before a default clause or a case block's closing brace", () => {
    const beforeDefault = "switch (x) {\n  case 1:\n    a();\n  // falls through\n  // kept\n  default:\n    b();\n}\n";
    const beforeBrace =
      "switch (x) {\n  case 1: {\n    a();\n    // falls through\n    // kept\n  }\n  case 2:\n    b();\n}\n";

    expect(removeComments(beforeDefault).changed).toBe(false);
    expect(removeComments(beforeBrace).changed).toBe(false);
  });

  it("removes the comments after a no-default comment that does not close a switch", () => {
    const source = "// no default\n// gone\nfoo();\n";

    expect(removeComments(source).code).toBe("// no default\nfoo();\n");
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
