import { describe, it, expect } from "vitest";
import { analyzeSource } from "./scanner.js";

/**
 * Each gap the import sorters and linters read, as its text, the sorters it
 * starts a group for and the linters that find their empty line in it.
 */
const gaps = (source: string): Array<[string, string[]]> =>
  analyzeSource(source).importGroups.map((gap) => [source.slice(gap.start, gap.end), [...gap.splits, ...gap.spaced]]);

const b = 'import { b } from "./b";';
const a = 'import { a } from "./a";';

describe("import group gaps", () => {
  it("reads the gap before every import past the first", () => {
    expect(gaps(`${b}\n${a}\nimport { c } from "./c";\n`)).toEqual([
      ["\n", []],
      ["\n", []],
    ]);
    expect(gaps(`${a}\n`)).toEqual([]);
  });

  it("starts a group after a comment line or a blank line, for organizeImports and dprint alike", () => {
    expect(gaps(`${b}\n// note\n${a}\n`)).toEqual([["\n// note\n", ["typescript", "dprint"]]]);
    expect(gaps(`${b}\n/* note\n   more */\n${a}\n`)).toEqual([["\n/* note\n   more */\n", ["typescript", "dprint"]]]);
    expect(gaps(`${b}\n\n${a}\n`)).toEqual([["\n\n", ["typescript", "dprint"]]]);
  });

  it("starts no group at comments that share a line with either declaration", () => {
    expect(gaps(`${b} // note\n${a}\n`)).toEqual([[" // note\n", []]]);
    expect(gaps(`${b}\n/* note */ ${a}\n`)).toEqual([["\n/* note */ ", []]]);
  });

  it("counts the line breaks inside a comment for dprint, which counts lines, and not for TypeScript", () => {
    expect(gaps(`${b}\n/* note\n */ ${a}\n`)).toEqual([["\n/* note\n */ ", ["dprint"]]]);
    expect(gaps(`${b} /* note\n */\n${a}\n`)).toEqual([[" /* note\n */\n", ["dprint"]]]);
  });

  it("counts the line breaks of TypeScript's scanner for it, and line feeds alone for dprint", () => {
    expect(gaps(`${b}\r\n// note\r\n${a}\r\n`)).toEqual([["\r\n// note\r\n", ["typescript", "dprint"]]]);
    expect(gaps(`${b}\r// note\n${a}\n`)).toEqual([["\r// note\n", ["typescript"]]]);
    expect(gaps(`${b}\n// note\r${a}\n`)).toEqual([["\n// note\r", ["typescript"]]]);
    expect(gaps(`${b} // note\n${a}\n`)).toEqual([[" // note\n", []]]);
    expect(gaps(`${b}\n ${a}\n`)).toEqual([["\n ", []]]);
  });

  it("follows TypeScript's imports across other statements, where dprint's run ends", () => {
    expect(gaps(`${b}\nf();\n// note\n${a}\n`)).toEqual([
      ["\n", []],
      ["\n// note\n", ["typescript"]],
    ]);
    expect(gaps(`${b}\nf();\n${a}\n`)).toEqual([
      ["\n", []],
      ["\n", []],
    ]);
  });

  it("leaves imports without specifiers to TypeScript, which sorts them too", () => {
    expect(gaps('import "./s";\n// note\nimport "./t";\n')).toEqual([["\n// note\n", ["typescript"]]]);
    expect(gaps(`import {} from "./e";\n${a}\n`)).toEqual([["\n", []]]);
    expect(gaps(`import d from "./d";\nimport * as n from "./n";\n${a}\n`)).toEqual([
      ["\n", []],
      ["\n", []],
    ]);
  });

  it("reads the gaps between `export … from`s, across other statements only for TypeScript", () => {
    expect(gaps('export * from "./b";\n// note\nexport { a } from "./a";\n')).toEqual([
      ["\n// note\n", ["typescript", "dprint"]],
    ]);
    expect(gaps('export * from "./b";\nf();\n// note\nexport * from "./a";\n')).toEqual([
      ["\n// note\n", ["typescript"]],
    ]);
  });

  it("ends tsc 6's run of exports past the declarations right after a local export", () => {
    const source = 'export * from "./b";\nexport { x };\n// note\nexport * from "./a";\nf();\nexport * from "./c";\n';

    expect(gaps(source)).toEqual([
      ["\n", []],
      ["\n// note\n", ["typescript"]],
    ]);
  });

  it("reads ambient modules' imports for TypeScript, which leaves their exports in one run", () => {
    const source = [
      'declare module "m" {',
      `  ${b}`,
      "  // note",
      `  ${a}`,
      '  export * from "./x";',
      "  // note",
      '  export * from "./y";',
      "}",
      "declare global {",
      `  ${b}`,
      `  ${a}`,
      "}",
      'declare module "shorthand";',
      "namespace N {",
      "  export const n = 1;",
      "}",
      "",
    ].join("\n");

    expect(gaps(source)).toEqual([
      ["\n  // note\n  ", ["typescript"]],
      ["\n  ", []],
      ["\n  ", []],
    ]);
  });
});

// Checked against the real eslint-plugin-import 2.32.0, eslint-plugin-import-x
// 4.17.1 and eslint-plugin-import-lite 0.6.0 on ESLint 9.39.5 with
// typescript-eslint 8.72.1, and oxlint 1.91.0, with their default options.
describe("the gaps the newline-after-import rules read", () => {
  it("finds the empty line where the next statement starts two lines or more below the import", () => {
    expect(gaps(`${a}\n// note\nf();\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\n\nf();\n`)).toEqual([["\n\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\n/* note\n */ f();\n`)).toEqual([["\n/* note\n */ ", ["eslint", "oxlint"]]]);
    expect(gaps(`${a} /* note\n */\nf();\n`)).toEqual([[" /* note\n */\n", ["eslint", "oxlint"]]]);
  });

  it("finds none where a comment shares a line with the import or the statement", () => {
    expect(gaps(`${a}\nf();\n`)).toEqual([["\n", []]]);
    expect(gaps(`${a} // note\nf();\n`)).toEqual([[" // note\n", []]]);
    expect(gaps(`${a}\n/* note */ f();\n`)).toEqual([["\n/* note */ ", []]]);
  });

  it("reads `import x = …` as an import unless it is exported, and no gap between imports or after the last statement", () => {
    expect(gaps("import n = N.m;\n// note\nf();\n")).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\nimport n = require("n");\nf();\n`)).toEqual([["\n", []]]);
    expect(gaps(`${a}\n// note\nexport import n = N.m;\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps("export import n = N.m;\n// note\nf();\n")).toEqual([]);
    expect(gaps(`${a}\n// note\n`)).toEqual([]);
  });

  it("reads the gap in front of an `export … from` after an import, which no sorter reads", () => {
    expect(gaps(`${a}\n// note\nexport * from "./b";\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
  });

  it("measures a class from its first decorator, past an `export` in front of it", () => {
    expect(gaps(`${a}\n// note\n@d\nclass C {}\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\nexport\n// note\n@d class C {}\n`)).toEqual([["\nexport\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\nexport default @d class {}\n`)).toEqual([["\nexport default ", []]]);
    expect(gaps(`${a}\n@d export class C {}\n`)).toEqual([["\n", []]]);
    expect(gaps(`${a}\nexport class C {}\n`)).toEqual([["\n", []]]);
  });

  it("counts every line break for eslint-plugin-import, and line feeds alone for oxlint", () => {
    expect(gaps(`${a}\r\n// note\r\nf();\r\n`)).toEqual([["\r\n// note\r\n", ["eslint", "oxlint"]]]);
    expect(gaps(`${a}\r// note\rf();\r`)).toEqual([["\r// note\r", ["eslint"]]]);
    expect(gaps(`${a}\u2028// note\u2029f();\n`)).toEqual([["\u2028// note\u2029", ["eslint"]]]);
  });

  it("reads the imports of modules and namespaces, nested ones included, for eslint-plugin-import alone", () => {
    const source = [
      'declare module "m" {',
      `  ${a}`,
      "  // note",
      "  const x: number;",
      "  namespace N.O {",
      "    import n = M.n;",
      "    // note",
      "    export const y = n;",
      "  }",
      "}",
      'declare module "shorthand";',
      "",
    ].join("\n");

    expect(gaps(source)).toEqual([
      ["\n  // note\n  ", ["eslint"]],
      ["\n    // note\n    ", ["eslint"]],
    ]);
  });

  it("reads a module body with more statements than a function takes arguments", () => {
    const source = `namespace N {\n  import n = M.n;\n  // note\n  ${";".repeat(200_000)}\n}\n`;

    expect(gaps(source)).toEqual([["\n  // note\n  ", ["eslint"]]]);
  });
});

describe("the requires the newline-after-import rules read", () => {
  it("reads the gap after a top-level statement holding a require, unless the next one holds one too", () => {
    expect(gaps('const x = require("x");\n// note\nf(x);\n')).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    expect(gaps('const x = require("x");\nconst y = require("y");\nf(x, y);\n')).toEqual([["\n", []]]);
    expect(gaps(`const x = require("x");\n// note\n${a}\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
  });

  it("finds a require wherever no function, block, object literal or decorator holds it", () => {
    const outside = [
      'f(require("x"));',
      'if (x) require("x");',
      'namespace N {\n  export const x = require("x");\n}',
      'class C {\n  static {\n    require("x");\n  }\n}',
      'class C {\n  [require("x")]() {}\n}',
      'class C {\n  get [require("x")]() {\n    return 1;\n  }\n}',
      'class C {\n  x = require("x");\n}',
      'class C extends require("x") {}',
      'try {\n} catch ({ x = require("x") }) {}',
      'const { x = require("x") } = o;',
      '({ x = require("x") } = o);',
      '[{ x: { y = require("x") } }] = o;',
      '[...{ x = require("x") }] = o;',
      'for ({ x = require("x") } of o);',
      'for ({ x = require("x") } in o);',
      'const x = requ\\u0069re("x");',
      'require?.("x");',
    ];
    for (const statement of outside) {
      expect(gaps(`${statement}\n// note\nf();\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    }
  });

  it("reads the requires eslint-plugin-import alone takes for oxlint too", () => {
    // oxlint skips functions without a body, and takes `require` only bare and
    // with a bare string; eslint-plugin-import reads the gaps after these.
    const eslintOnly = [
      'abstract class C {\n  abstract m(x = require("x")): void;\n}',
      'declare function f(x?: string = require("x")): void;',
      '(require)("x");',
      'require(("x"));',
    ];
    for (const statement of eslintOnly) {
      expect(gaps(`${statement}\n// note\nf();\n`)).toEqual([["\n// note\n", ["eslint", "oxlint"]]]);
    }
  });

  it("finds none inside a function, block, object literal or decorator", () => {
    const inside = [
      'function f() {\n  require("x");\n}',
      'const f = () => require("x");',
      'const f = function () {\n  return require("x");\n};',
      '{\n  require("x");\n}',
      'const o = { x: require("x") };',
      'const o = { x: { y: require("x") } };',
      '({ x: y = { z: require("x") } } = o);',
      'x = { y: require("x") };',
      'for (const x of { y: require("x") });',
      'class C {\n  m() {\n    require("x");\n  }\n}',
      'class C {\n  constructor() {\n    require("x");\n  }\n}',
      'class C {\n  set m(v) {\n    require("x");\n  }\n}',
      'class C {\n  m(x?: string): void;\n  m(x = require("x")) {}\n}',
      'class C {\n  @d(require("x")) x = 1;\n}',
      '@d(require("x"))\nclass C {}',
    ];
    for (const statement of inside) expect(gaps(`${statement}\n// note\nf();\n`)).toEqual([]);
  });

  it("looks for a require in very deeply nested expressions without overflowing the call stack", () => {
    const deep = `const y = ${Array(50_000).fill("a").join("+")};`;

    expect(gaps(`const x = require("x");\n${deep}\n`)).toEqual([["\n", []]]);
  });

  it("takes `require` with a single string literal alone", () => {
    const others = ['require("x", 1)', "require(x)", "require(`x`)", 'require("x" as string)', 'module.require("x")'];
    for (const call of [...others, 'requires("x")', 'new require("x")', '(0, require)("x")']) {
      expect(gaps(`${call};\n// note\nf();\n`)).toEqual([]);
    }
  });

  it("reads the requires of the file's own statements alone, not of a namespace's", () => {
    expect(gaps('namespace N {\n  const x = require("x");\n  // note\n  f(x);\n}\n')).toEqual([]);
  });

  it("never reads a require out of a comment", () => {
    expect(gaps('const x = 1;\n// require("x")\nf(x);\n')).toEqual([]);
  });
});
