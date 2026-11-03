import { describe, it, expect } from "vitest";
import { analyzeSource } from "./scanner.js";

/** Each gap the import sorters read, as its text and the sorters it starts a group for. */
const gaps = (source: string): Array<[string, string[]]> =>
  analyzeSource(source).importGroups.map((gap) => [source.slice(gap.start, gap.end), gap.splits]);

const b = 'import { b } from "./b";';
const a = 'import { a } from "./a";';

describe("import group gaps", () => {
  it("reads the gap before every import past the first", () => {
    expect(gaps(`${b}\n${a}\nimport { c } from "./c";\n`)).toEqual([
      ["\n", []],
      ["\n", []],
    ]);
    expect(gaps(`${a}\nf();\n`)).toEqual([]);
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
    expect(gaps(`${b}\nf();\n// note\n${a}\n`)).toEqual([["\n// note\n", ["typescript"]]]);
    expect(gaps(`${b}\nf();\n${a}\n`)).toEqual([["\n", []]]);
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

  it("reads the imports of ambient modules for TypeScript, which leaves their exports in one run", () => {
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
    ]);
  });
});
