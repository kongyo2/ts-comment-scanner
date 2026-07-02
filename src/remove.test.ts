import { describe, it, expect } from "vitest";
import { removeComments } from "./remove.js";

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

  it("shields below node:coverage ignore next but not below its range forms", () => {
    const nextForm = "/* node:coverage ignore next */\n// shielded\nconst a = 1;\n";
    expect(removeComments(nextForm).code).toBe(nextForm);

    const rangeForm = "/* node:coverage disable */\n// gone\nconst b = 1;\n";
    expect(removeComments(rangeForm).code).toBe("/* node:coverage disable */\nconst b = 1;\n");
  });

  it("keeps a byte-order mark when removing the first line", () => {
    const result = removeComments("\uFEFF// gone\nconst x = 1;\n");

    expect(result.code).toBe("\uFEFFconst x = 1;\n");
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
