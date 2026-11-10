import * as prettier from "prettier";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";

// In a JavaScript file tsc takes its types from JSDoc comments, so a comment
// holding a tag it reads is no documentation to remove. These tests run the
// real compiler — the typescript@6 package the scanner parses with — over a
// file before and after the removal: the diagnostics have to stay the same.

/** What tsc 6 reports for a JavaScript file it checks: the code of each diagnostic and the text it points at. */
function diagnostics(text: string, options: ts.CompilerOptions = {}): string[] {
  const fileName = "/main.js";
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noEmit: true,
    strict: true,
    types: [],
    allowJs: true,
    checkJs: true,
    ...options,
  };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName ? ts.createSourceFile(name, text, languageVersion, true) : undefined;
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  const program = ts.createProgram([fileName], compilerOptions, host);
  const file = program.getSourceFile(fileName);
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (diagnostic) =>
      `${diagnostic.code}: ${text.slice(diagnostic.start, (diagnostic.start ?? 0) + (diagnostic.length ?? 0))}`,
  );
}

const javascript = { javascript: true };

describe("removeComments on the JSDoc comments tsc reads in JavaScript, against tsc 6", () => {
  // Each file gets a diagnostic, or loses one, through the tag: without the
  // comment tsc reports something else.
  it.each<[string, string, string, ts.CompilerOptions?]>([
    [
      "@typedef and @type",
      '/** @typedef {{x: number}} Point */\n/** @type {Point} */\nconst p = { x: "1" }; // note\n',
      '/** @typedef {{x: number}} Point */\n/** @type {Point} */\nconst p = { x: "1" };\n',
    ],
    [
      "@param",
      '// Adds one.\n/** @param {number} a */\nfunction f(a) { return a; }\nf("x");\n',
      '/** @param {number} a */\nfunction f(a) { return a; }\nf("x");\n',
    ],
    [
      "@param without a type",
      "/** @param a the first */\nfunction f(a) {}\nf(); // note\n",
      "/** @param a the first */\nfunction f(a) {}\nf();\n",
    ],
    [
      "@returns",
      '/**\n * Doubles.\n * @returns {number}\n */\nfunction f() { return "x"; } // note\n',
      '/**\n * Doubles.\n * @returns {number}\n */\nfunction f() { return "x"; }\n',
    ],
    [
      "@template",
      "/**\n * @template T\n * @param {T} x\n * @returns {T}\n */\nfunction id(x) { return x; }\n/** @type {string} */\nconst s = id(1); // note\n",
      "/**\n * @template T\n * @param {T} x\n * @returns {T}\n */\nfunction id(x) { return x; }\n/** @type {string} */\nconst s = id(1);\n",
    ],
    [
      "@callback",
      "/**\n * @callback Cb\n * @param {number} n\n * @returns {void}\n */\n// The callback.\n/** @type {Cb} */\nconst cb = (n) => { n.x; };\n",
      "/**\n * @callback Cb\n * @param {number} n\n * @returns {void}\n */\n/** @type {Cb} */\nconst cb = (n) => { n.x; };\n",
    ],
    [
      "@enum",
      '/** @enum {number} */\nconst E = { A: "x" }; // note\n',
      '/** @enum {number} */\nconst E = { A: "x" };\n',
    ],
    [
      "@this",
      "/** @this {{x: number}} */\nfunction f() { return this.y; } // note\n",
      "/** @this {{x: number}} */\nfunction f() { return this.y; }\n",
    ],
    [
      "@implements",
      "/** @typedef {{m(): void}} I */\n/** @implements {I} */\nclass A {} // note\n",
      "/** @typedef {{m(): void}} I */\n/** @implements {I} */\nclass A {}\n",
    ],
    [
      "@private",
      "class A {\n  /** @private */\n  x = 1; // note\n}\nnew A().x;\n",
      "class A {\n  /** @private */\n  x = 1;\n}\nnew A().x;\n",
    ],
    [
      "@readonly",
      "class A {\n  /** @readonly */\n  x = 1; // note\n}\nnew A().x = 2;\n",
      "class A {\n  /** @readonly */\n  x = 1;\n}\nnew A().x = 2;\n",
    ],
    [
      "@override",
      "class B { m() {} }\nclass A extends B {\n  /** @override */\n  m() {} // note\n}\n",
      "class B { m() {} }\nclass A extends B {\n  /** @override */\n  m() {}\n}\n",
      { noImplicitOverride: true },
    ],
    [
      "@satisfies",
      '/** @satisfies {{a: number}} */\nconst c = { a: "x" }; // note\n',
      '/** @satisfies {{a: number}} */\nconst c = { a: "x" };\n',
    ],
    [
      "@import",
      '/** @import { X } from "./x" */\nconst a = 1; // note\n',
      '/** @import { X } from "./x" */\nconst a = 1;\n',
    ],
    [
      "@overload",
      "/**\n * @overload\n * @param {string} a\n * @returns {string}\n */\n/**\n * @param {string | number} a\n * @returns {string | number}\n */\nfunction f(a) { return a; }\nf(1); // note\n",
      "/**\n * @overload\n * @param {string} a\n * @returns {string}\n */\n/**\n * @param {string | number} a\n * @returns {string | number}\n */\nfunction f(a) { return a; }\nf(1);\n",
    ],
    [
      "@class",
      "/** @class */\nfunction C() { this.x = 1; }\nC(); // note\n",
      "/** @class */\nfunction C() { this.x = 1; }\nC();\n",
    ],
    [
      "a @type cast",
      'const n = /** @type {number} */ ("x"); // note\nn.x;\n',
      'const n = /** @type {number} */ ("x");\nn.x;\n',
    ],
  ])("keeps the comment holding %s", (_, source, expected, options) => {
    const result = removeComments(source, javascript);
    const bare = removeComments(source, { javascript: true, removeDirectives: true });

    expect(result.code).toBe(expected);
    expect(diagnostics(result.code, options)).toEqual(diagnostics(source, options));
    expect(diagnostics(bare.code, options)).not.toEqual(diagnostics(source, options));
  });

  it.each([
    // Documentation, and tags tsc reads nothing from.
    [
      "/** Adds two numbers. */\nfunction add(a, b) { return a + b; }\nadd(1);\n",
      "function add(a, b) { return a + b; }\nadd(1);\n",
    ],
    [
      "/**\n * Adds.\n * @returns the sum\n * @deprecated\n * @see sum\n * @throws {Error}\n * @example add(1, 2)\n */\nfunction add(a, b) { return a + b; }\nadd(1);\n",
      "function add(a, b) { return a + b; }\nadd(1);\n",
    ],
    // No node holds these, so tsc reads no tag from them.
    [
      'function f() {\n  return 1;\n  /** @typedef {number} N */\n}\n/** @type {N} */\nconst n = "x";\n',
      'function f() {\n  return 1;\n}\n/** @type {N} */\nconst n = "x";\n',
    ],
    ["class A { /** @private */ x = 1; }\nnew A().x;\n", "class A { x = 1; }\nnew A().x;\n"],
  ])("removes the JSDoc comment tsc reads nothing from in %j", (source, expected) => {
    const result = removeComments(source, javascript);

    expect(result.code).toBe(expected);
    expect(diagnostics(result.code)).toEqual(diagnostics(source));
  });

  it("keeps the last JSDoc comment of a node where it keeps the tags of an earlier one off the node", () => {
    // tsc takes `@param` from the node's last JSDoc comment alone: with the
    // description gone, the parameter would be a string.
    const source = "/** @param {string} a */\n/** Describes f. */\nfunction f(a) { return a; }\nf(1);\n";

    const result = removeComments(source, javascript);

    expect(result.code).toBe(source);
    expect(result.kept.map((comment) => comment.text)).toEqual(["/** @param {string} a */", "/** Describes f. */"]);
    expect(diagnostics("/** @param {string} a */\nfunction f(a) { return a; }\nf(1);\n")).not.toEqual(
      diagnostics(source),
    );
  });

  it("removes a JSDoc comment between a declaring tag and the node, which tsc reads from every comment", () => {
    const source = '/** @typedef {number} N */\n/** note */\n/** @type {N} */\nconst n = "x";\n';

    const result = removeComments(source, javascript);

    expect(result.code).toBe('/** @typedef {number} N */\n/** @type {N} */\nconst n = "x";\n');
    expect(diagnostics(result.code)).toEqual(diagnostics(source));
  });

  it("removes them from a TypeScript file, where tsc reads no type from JSDoc", () => {
    const source = "/** @typedef {{x: number}} Point */\n/** @param {Point} p */\nfunction f(p: { x: number }) {}\n";

    expect(removeComments(source).code).toBe("function f(p: { x: number }) {}\n");
  });

  it("removes them along with the other directives when asked to", () => {
    const source = "/** @param {number} a */\nfunction f(a) {}\n";

    expect(removeComments(source, { javascript: true, removeDirectives: true }).code).toBe("function f(a) {}\n");
  });
});

describe("removeComments in JavaScript, parsed as tsc parses it", () => {
  it("removes the comment after a regular expression that follows a comparison", () => {
    // Read as TypeScript, `a < b >` would take type arguments and the slash
    // divide: the `/*` in the expression would open a comment.
    const source = "const r = a < b > /x\\/*y/.test(c); /* note */\n";

    expect(removeComments(source, javascript).code).toBe("const r = a < b > /x\\/*y/.test(c);\n");
  });

  it("removes the comments around JSX", () => {
    const source = "const view = <div>{/* note */}// text</div>; // note\n";

    expect(removeComments(source, javascript).code).toBe("const view = <div>// text</div>;\n");
  });
});

// Prettier keeps the parentheses after a JSDoc type cast while nothing but
// whitespace stands between the comment and them, under its Babel parsers.
describe("removeComments between a type cast comment and its parentheses, against prettier", () => {
  const format = (source: string): Promise<string> => prettier.format(source, { parser: "babel" });
  /** The formatted code without its comments and whitespace: what the formatter made of the code itself. */
  const formattedCode = async (source: string): Promise<string> =>
    removeComments(await format(source), { javascript: true, removeDirectives: true }).code.replace(/\s+/g, "");

  it.each([
    // One comment in between leaves the cast out of effect, so the last one stays.
    ["const a = /** @type {number} */ /* note */ (foo);\n", "const a = /** @type {number} */ /* note */ (foo);\n"],
    [
      "const a = /** @type {number} */ /* one */ /* two */ (foo);\n",
      "const a = /** @type {number} */ /* two */ (foo);\n",
    ],
    ["const a = /** @type {number} */ // note\n  (foo);\n", "const a = /** @type {number} */ // note\n  (foo);\n"],
    ["const a = /** @satisfies {X} */ /* note */ ({});\n", "const a = /** @satisfies {X} */ /* note */ ({});\n"],
    // Comments elsewhere go.
    ["const a = /** @type {number} */ (foo); // note\n", "const a = /** @type {number} */ (foo);\n"],
    ["const a = /* note */ /** @type {number} */ (foo);\n", "const a = /** @type {number} */ (foo);\n"],
    // No parentheses follow, so there is no cast to bring into effect.
    ["const a = /** @type {number} */ /* note */ foo;\n", "const a = /** @type {number} */ foo;\n"],
  ])("leaves prettier formatting the code of %j the same", async (source, expected) => {
    const result = removeComments(source, javascript);

    expect(result.code).toBe(expected);
    expect(await formattedCode(result.code)).toBe(await formattedCode(source));
  });

  it("would have prettier keep the parentheses were the comment in between removed", async () => {
    expect(await format("const a = /** @type {number} */ /* note */ (foo);\n")).toContain(" foo;");
    expect(await format("const a = /** @type {number} */ (foo);\n")).toContain("(foo);");
  });

  it("keeps the comment in a TypeScript file too, which prettier may format with a Babel parser", () => {
    const source = "const a = /** @type {number} */ /* note */ (foo);\n";

    expect(removeComments(source).code).toBe(source);
  });
});
