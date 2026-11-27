import { describe, expect, it } from "vitest";
import { analyzeSource, type ScanOptions } from "./scanner.js";

// formatters.ts works out the stretch between two sibling nodes in which
// oxfmt reads the comments one after another, and the stretch behind a
// comment across which Biome holds the comment back. The node edges were
// checked against what oxfmt 0.79.0 and 0.80.0 and Biome 2.6.9 leave as
// written over generated sources (November 2026); the tests of the removal
// next to a formatter suppression (remove.formatters.test.ts) give the
// comments that stay.

/** The text of one of the stretches around the source's `/* here *​/` comment. */
function around(which: "stretch" | "heldBack", source: string, options: ScanOptions = {}): string {
  const analysis = analyzeSource(source, options);
  const comment = analysis.comments.find(({ text }) => text === "/* here */");
  if (comment === undefined) throw new Error("the source holds no comment to look around");
  const { start, end } = analysis[which](comment);
  return source.slice(start, end);
}

/** The stretch between the nodes around the comment, as its text. */
const stretch = (source: string, options?: ScanOptions): string => around("stretch", source, options);

/** The stretch behind the comment across which Biome holds it back, as its text. */
const heldBack = (source: string): string => around("heldBack", source);

describe("the stretch between the nodes around a comment", () => {
  it("runs from the end of the node in front to the start of the node behind", () => {
    expect(stretch("f(a /* here */ , b);")).toBe(" /* here */ , ");
    expect(stretch("f(a, /* here */ b);")).toBe(", /* here */ ");
    expect(stretch("x = a /* here */ + b;")).toBe(" /* here */ + ");
    expect(stretch("const v = c ? a : /* here */ b;")).toBe(" : /* here */ ");
  });

  it("takes a name, a literal and a keyword that is a value or a type for a node", () => {
    expect(stretch("this /* here */ .a;")).toBe(" /* here */ .");
    expect(stretch("x = this.#p /* here */ + 1;")).toBe(" /* here */ + ");
    expect(stretch("x = 1 /* here */ + null;")).toBe(" /* here */ + ");
    expect(stretch("x = `a${b}c` /* here */ + true;")).toBe(" /* here */ + ");
    expect(stretch("let v: string /* here */ = 's';")).toBe(" /* here */ = ");
  });

  it("ends at a node that starts or ends with a token of its own", () => {
    expect(stretch("x = [1, 2] /* here */ .length;")).toBe(" /* here */ .");
    expect(stretch("x = /* here */ -y;")).toBe(" = /* here */ ");
    expect(stretch("if (a) b(); else /* here */ c();")).toBe("; else /* here */ ");
  });

  it("crosses a statement's own semicolon in front of the comment, and ends at one behind it", () => {
    expect(stretch("a()\n;\n/* here */\nb();")).toBe("\n;\n/* here */\n");
    expect(stretch("a() /* here */ ;\nb();")).toBe(" /* here */ ");
  });

  it("ends at the brackets of a call, of a head and of a body", () => {
    expect(stretch("f /* here */ (a);")).toBe(" /* here */ ");
    expect(stretch("f( /* here */ );")).toBe(" /* here */ ");
    expect(stretch("if (a) /* here */ { b(); }")).toBe(" /* here */ ");
    expect(stretch("class C /* here */ { m() {} }")).toBe(" /* here */ ");
    expect(stretch("class C { static /* here */ { a(); } }")).toBe(" /* here */ ");
  });

  it("crosses the tokens of what is no node to the formatters", () => {
    // The parentheses around an expression, which oxfmt's parser drops.
    expect(stretch("x = (a) /* here */ + b;")).toBe(") /* here */ + ");
    expect(stretch("x = a + ( /* here */ b);")).toBe(" + ( /* here */ ");
    expect(stretch("type T = (A) /* here */ | B;")).toBe(") /* here */ | ");
    // The braces of named imports and exports, and of a switch.
    expect(stretch('import { a } /* here */ from "m";')).toBe(" } /* here */ from ");
    expect(stretch('export { a } /* here */ from "m";')).toBe(" } /* here */ from ");
    expect(stretch("switch (x) /* here */ { case 1: }")).toBe(") /* here */ { ");
    // `extends`, the brackets of a computed name, and the `*` of a namespace export.
    expect(stretch("class A /* here */ extends B {}")).toBe(" /* here */ extends ");
    expect(stretch("const o = { [k] /* here */ : 1 };")).toBe("] /* here */ : ");
    expect(stretch('export * /* here */ as ns from "m";')).toBe(" * /* here */ as ");
    // The `)` that oxfmt drops, where the node around the parentheses ends with it too.
    expect(stretch("g = (a /* here */ );")).toBe(" /* here */ )");
    expect(stretch("x = (a) /* here */ ;")).toBe(") /* here */ ");
    // The `with` of import attributes: oxc's with clause is the braces alone.
    expect(stretch('import d from "m" /* here */ with { type: "json" };')).toBe(" /* here */ with ");
    expect(stretch('export * from "m" with /* here */ { type: "json" };')).toBe(" with /* here */ ");
    expect(stretch("with (o) /* here */ a();")).toBe(" /* here */ ");
  });

  it("crosses the brackets oxfmt reads on over", () => {
    // The head of a switch: the discriminant and the first clause stand next to each other.
    expect(stretch("switch (x /* here */ ) { case 1: }")).toBe(" /* here */ ) { ");
    expect(stretch("switch /* here */ (x) { case 1: }")).toBe(" /* here */ (");
    // The `(` of a `new` expression, and the one behind the type arguments of a call.
    expect(stretch("new K /* here */ (a);")).toBe(" /* here */ (");
    expect(stretch("f<T> /* here */ (a);")).toBe("> /* here */ (");
    expect(stretch("new K(a /* here */ ) + b;")).toBe(" /* here */ ");
  });

  it("runs to the start and the end of the source where no node stands there", () => {
    expect(stretch("/* here */ a();")).toBe("/* here */ ");
    expect(stretch("a() /* here */")).toBe(" /* here */");
  });

  it("reads JSX and JavaScript the same way", () => {
    expect(stretch("const e = <a b={1} /* here */ c />;", { jsx: true })).toBe(" /* here */ ");
    expect(stretch("f(a, /* here */ b);", { javascript: true })).toBe(", /* here */ ");
  });
});

describe("the stretch Biome holds a comment back across", () => {
  it("runs from the token behind the comment to the next token that starts a node", () => {
    expect(heldBack("for (i = 0 /* here */ ; ; i++) {}")).toBe(" ; ");
    expect(heldBack("for (i = 0 /* here */ ; ; ) {}")).toBe(" ; ) ");
    expect(heldBack("do a(); /* here */ while (b);")).toBe(" (");
    expect(heldBack("f(a /* here */ , b);")).toBe(" ");
  });

  it("is empty where the token behind the comment starts a node, or none follows", () => {
    expect(heldBack("a(); /* here */ b();")).toBe("");
    expect(heldBack("a(); /* here */")).toBe("");
  });

  it("runs to the end of the source where no node starts any more", () => {
    expect(heldBack("f(a /* here */ , );")).toBe(" );");
  });

  it("takes what is a token to Biome for one", () => {
    // The `target` of `new.target`, and the braces of a switch.
    expect(heldBack("x = new /* here */ . target + 1;")).toBe(" target + ");
    expect(heldBack("switch (x /* here */ ) { case 1: }")).toBe(" { ");
  });

  it("skips the tokens that hold no text", () => {
    expect(heldBack("x = [a /* here */ , , b];")).toBe(" , ");
  });
});
