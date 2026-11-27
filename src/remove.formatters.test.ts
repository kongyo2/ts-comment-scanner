import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";

// A formatter applies a suppression to the code it trails or to the code it
// leads, by where the comment stands on its line. Removing a comment next to
// one must leave it standing the same way. The prettier cases run the real
// formatter over a source before and after the removal; the oxfmt and Biome
// ones were checked by hand against oxfmt 0.79.0 and 0.80.0 and Biome 2.6.8
// and 2.6.9, and all of them over generated sources (November 2026): each
// formatter leaves the same code as written before and after the removal.

/** The statements, written with spacing no formatter keeps, that the formatted text still holds as written. */
function asWritten(formatted: string): string[] {
  return ["a( 1,2 )", "b( 3,4 )", "[ 1,2 ]", "[ 3,4 ]"].filter((code) => formatted.includes(code));
}

describe("removeComments next to a suppression prettier places by its line, against prettier", () => {
  const format = (source: string): Promise<string> => prettier.format(source, { parser: "typescript" });

  it.each([
    // The suppression trails the call: the note would leave a line break in front of it.
    ["a( 1,2 ); /* note\n*/ // prettier-ignore\nb( 3,4 );\n", "a( 1,2 ); /* note\n*/ // prettier-ignore\nb( 3,4 );\n"],
    // Only the comment that would leave the line break stays.
    [
      "a( 1,2 ); /* one\n*/ /* two */ // prettier-ignore\nb( 3,4 );\n",
      "a( 1,2 ); /* one\n*/ // prettier-ignore\nb( 3,4 );\n",
    ],
    // Each of two would leave one.
    [
      "a( 1,2 ); /* one\n*/ /* two\n*/ // prettier-ignore\nb( 3,4 );\n",
      "a( 1,2 ); /* one\n*/ /* two\n*/ // prettier-ignore\nb( 3,4 );\n",
    ],
    // Behind the suppression, the note would leave it ending its line.
    [
      "const o = {\n  a /* prettier-ignore *//* note\n */ : [ 1,2 ],\n  b: [ 3,4 ],\n};\n",
      "const o = {\n  a /* prettier-ignore *//* note\n */ : [ 1,2 ],\n  b: [ 3,4 ],\n};\n",
    ],
    // A comment that leaves no line break goes.
    ["a( 1,2 ); /* note */ // prettier-ignore\nb( 3,4 );\n", "a( 1,2 ); // prettier-ignore\nb( 3,4 );\n"],
    // So does one that a line break already holds off the suppression.
    ["a( 1,2 ); /* note\n*/\n// prettier-ignore\nb( 3,4 );\n", "a( 1,2 );\n// prettier-ignore\nb( 3,4 );\n"],
  ])("leaves prettier ignoring the same code of %j", async (source, expected) => {
    const result = removeComments(source);

    expect(result.code).toBe(expected);
    expect(asWritten(await format(result.code))).toEqual(asWritten(await format(source)));
  });

  it("would have prettier ignore the statement below were the comment in front removed", async () => {
    expect(asWritten(await format("a( 1,2 ); /* note\n*/ // prettier-ignore\nb( 3,4 );\n"))).toEqual(["a( 1,2 )"]);
    expect(asWritten(await format("a( 1,2 );\n// prettier-ignore\nb( 3,4 );\n"))).toEqual(["b( 3,4 )"]);
  });
});

describe("removeComments next to the suppressions Biome and oxfmt place by their line", () => {
  it.each([
    "a( 1,2 ); /* note\n*/ // biome-ignore format: aligned\nb( 3,4 );\n",
    "a( 1,2 ); /* note\n*/ // rome-ignore format: aligned\nb( 3,4 );\n",
    "a( 1,2 ); /* note\n*/ // oxfmt-ignore\nb( 3,4 );\n",
  ])("keeps the comment that would leave a line break in front of the suppression in %j", (source) => {
    expect(removeComments(source).code).toBe(source);
  });

  it("removes a comment spanning lines that nothing staying on its line precedes", () => {
    // The run of comments opens its line with or without them: the
    // suppression leads the statement below either way.
    expect(removeComments("a( 1,2 );\n/* note\n*/ // biome-ignore format: aligned\nb( 3,4 );\n").code).toBe(
      "a( 1,2 );\n// biome-ignore format: aligned\nb( 3,4 );\n",
    );
    expect(removeComments("/* one */ /* two\n*/ // biome-ignore format: aligned\nb( 3,4 );\n").code).toBe(
      "// biome-ignore format: aligned\nb( 3,4 );\n",
    );
  });

  it("leaves a suppression dprint reads on a line of its own, as dprint goes by the comments in front of a node", () => {
    expect(removeComments("a( 1,2 ); /* note\n*/ // dprint-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 );\n // dprint-ignore\nb( 3,4 );\n",
    );
  });
});

describe("removeComments right next to a suppression oxfmt reads", () => {
  it.each([
    // oxfmt notes whether a line break precedes each comment, another comment in between included.
    "a( 1,2 );\n/* note */ // oxfmt-ignore\nb( 3,4 );\n",
    "a( 1,2 );\n/* note */ // prettier-ignore\nb( 3,4 );\n",
    "b( 3,4 );\n/* note */ /* oxfmt-ignore */ ;\na( 1,2 );\n",
    // And whether one follows it.
    "const a /* oxfmt-ignore */ /* note */\n  = [ 1,2 ];\n",
    "const a /* oxfmt-ignore */ // note\n  = [ 1,2 ];\n",
  ])("keeps the comment whose removal would leave the suppression at an end of its line in %j", (source) => {
    expect(removeComments(source).code).toBe(source);
  });

  it("keeps the one comment that holds the suppression off the end of its line", () => {
    expect(removeComments("/* oxfmt-ignore */ /* one */ // two\na( 1,2 );\n").code).toBe(
      "/* oxfmt-ignore */ /* one */\na( 1,2 );\n",
    );
  });

  it("removes a neighbour with something that stays on its far side", () => {
    expect(removeComments("/* oxfmt-ignore */ /* note */ a( 1,2 );\n").code).toBe("/* oxfmt-ignore */ a( 1,2 );\n");
    expect(removeComments("a( 1,2 ); /* note */ /* oxfmt-ignore */\nb( 3,4 );\n").code).toBe(
      "a( 1,2 ); /* oxfmt-ignore */\nb( 3,4 );\n",
    );
  });

  it("removes the neighbour of a suppression Biome reads, which goes by the run of comments", () => {
    expect(removeComments("a( 1,2 );\n/* note */ // biome-ignore format: aligned\nb( 3,4 );\n").code).toBe(
      "a( 1,2 );\n// biome-ignore format: aligned\nb( 3,4 );\n",
    );
  });

  it("keeps the last comment between a suppression and the semicolon that ends its statement", () => {
    // oxfmt 0.79.0 formats the import of the first source, and leaves it as
    // written once the suppression is the last comment in front of the `;`.
    const source = 'import { a,b } from "m" // oxfmt-ignore\n/* note */;\nb( 3,4 );\n';

    expect(removeComments(source).code).toBe(source);
    expect(removeComments('import { a,b } from "m" // oxfmt-ignore\n// one\n// two\n;\nb( 3,4 );\n').code).toBe(
      'import { a,b } from "m" // oxfmt-ignore\n// two\n;\nb( 3,4 );\n',
    );
  });

  it("removes the comments below a suppression that no semicolon follows", () => {
    expect(removeComments("a( 1,2 ) // oxfmt-ignore\n// note\nb( 3,4 );\n").code).toBe(
      "a( 1,2 ) // oxfmt-ignore\nb( 3,4 );\n",
    );
    expect(removeComments("a( 1,2 ) /* oxfmt-ignore */;\n// note\nb( 3,4 );\n").code).toBe(
      "a( 1,2 ) /* oxfmt-ignore */;\nb( 3,4 );\n",
    );
  });
});

// oxfmt reads the comments between two sibling nodes one after another,
// across the tokens between the nodes, and the first comment a line break
// touches decides which of the two the comments belong to. Biome reads the
// comments between the members of a union type that way. Checked by hand
// against oxfmt 0.79.0 and 0.80.0 and Biome 2.6.9, and over generated
// sources (November 2026): 70,000 for each formatter. Over 30,000 of them
// 1.23.0's removal changed what oxfmt leaves as written in 191, Biome in 6
// and Prettier in 5, and this one in none of the 70,000.
describe("removeComments in front of a suppression that oxfmt reads in sequence", () => {
  it.each([
    // Without the note the suppression ends the line of the `,` and trails `a`.
    "function f(a = [ 1,2 ]\n// note\n, // oxfmt-ignore\nb = [ 3,4 ]) {}\n",
    // In front of a statement's own `;`, oxfmt leaves the note for the statement after it.
    "a( 1,2 )\n// note\n; // oxfmt-ignore\nb( 3,4 );\n",
    // An operator stands between the nodes like a separator.
    "x = a( 1,2 ) // note\n  + // prettier-ignore\n  b( 3,4 );\n",
    // So does the `with` of import attributes: oxfmt's with clause is the braces alone.
    'import d from "m" // note\n with // oxfmt-ignore\n { type:"json" };\n',
    // And the brackets around the head of a switch, whose first clause follows the discriminant.
    "switch (a( 1,2 )\n// note\n) /* oxfmt-ignore */ {\n  case 1: b( 3,4 );\n}\n",
    "switch (a( 1,2 ) // note\n) /* oxfmt-ignore */ {\n  case 1: b( 3,4 );\n}\n",
    // The callee of a `new` expression and the type arguments of a call take the comments behind the `(`.
    "new K\n// note\n(/* oxfmt-ignore */\n[ 1,2 ]);\n",
    "f<{ a:1 }>\n// note\n(/* oxfmt-ignore */\n[ 1,2 ]);\n",
  ])("keeps the comment that makes the suppression lead the node after it in %j", (source) => {
    expect(removeComments(source).code).toBe(source);
  });

  it("keeps one comment of the run that a line break touches, the last", () => {
    expect(removeComments("a( 1,2 )\n// one\n// two\n; // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n// two\n; // oxfmt-ignore\nb( 3,4 );\n",
    );
    // A line break only follows the last comment of this run.
    expect(removeComments("a( 1,2 ) /* one */ // two\n; // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 ) // two\n; // oxfmt-ignore\nb( 3,4 );\n",
    );
    expect(removeComments("a( 1,2 ) // one\n// two\n/* three */ ; // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n/* three */ ; // oxfmt-ignore\nb( 3,4 );\n",
    );
  });

  it("keeps none where a comment that stays serves already", () => {
    // The license notice stays, on a line of its own: the note above it is not needed.
    expect(removeComments("a( 1,2 )\n// note\n/*! legal */\n; // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n/*! legal */\n; // oxfmt-ignore\nb( 3,4 );\n",
    );
    // One that only ends the line of the code serves where no line break precedes a comment.
    expect(removeComments("a( 1,2 ) /*! legal */ // note\n; // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 ) /*! legal */\n; // oxfmt-ignore\nb( 3,4 );\n",
    );
  });

  it("keeps the comment whose line break would stand between the code and the suppression", () => {
    // oxfmt leaves `a( 1,2 )` as written while the suppression ends its
    // line: the note would leave a line break in front of the `:`.
    const source = "const v = c ? a( 1,2 ) /* note\n*/ : /* oxfmt-ignore */\n b( 3,4 );\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("removes the comments in front of a suppression whose line the comments around it open", () => {
    expect(removeComments("a( 1,2 )\n// note\n;\n// oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n;\n// oxfmt-ignore\nb( 3,4 );\n",
    );
    expect(removeComments("a( 1,2 )\n// note\n;\n/*! legal */ // oxfmt-ignore\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n;\n/*! legal */ // oxfmt-ignore\nb( 3,4 );\n",
    );
  });

  it("removes the comments in front of a suppression that stands right in front of its node", () => {
    expect(removeComments("function f(a = [ 1,2 ]\n// note\n, /* oxfmt-ignore */ b = [ 3,4 ]) {}\n").code).toBe(
      "function f(a = [ 1,2 ]\n, /* oxfmt-ignore */ b = [ 3,4 ]) {}\n",
    );
    expect(removeComments("x = a( 1,2 ) // note\n  + /* oxfmt-ignore */ (b( 3,4 ));\n").code).toBe(
      "x = a( 1,2 )\n  + /* oxfmt-ignore */ (b( 3,4 ));\n",
    );
  });

  it("removes the comments on the far side of a bracket no comment crosses", () => {
    // The parentheses of a call's arguments bound what oxfmt reads together.
    expect(removeComments("f /* oxfmt-ignore */ (\n  // note\n  a( 1,2 ));\n").code).toBe(
      "f /* oxfmt-ignore */ (\n  a( 1,2 ));\n",
    );
    expect(removeComments("f(a( 1,2 ) // note\n) /* oxfmt-ignore */\n;\n").code).toBe(
      "f(a( 1,2 )\n) /* oxfmt-ignore */\n;\n",
    );
    expect(removeComments("f\n// note\n(/* oxfmt-ignore */\n[ 1,2 ]);\n").code).toBe(
      "f\n(/* oxfmt-ignore */\n[ 1,2 ]);\n",
    );
    // So do those around the head of an `if`.
    expect(removeComments("if (a( 1,2 )\n// note\n) /* oxfmt-ignore */ b( 3,4 );\n").code).toBe(
      "if (a( 1,2 )\n) /* oxfmt-ignore */ b( 3,4 );\n",
    );
  });
});

describe("removeComments behind a suppression in the middle of its line, which oxfmt reads on from", () => {
  it("keeps the comment that ends the line past a separator", () => {
    // oxfmt leaves `a( 1,2 )` as written while a comment ends the line the
    // suppression stands on, the `,` in between notwithstanding.
    const source = "f(a( 1,2 ) /* oxfmt-ignore */, // note\n  b( 3,4 ));\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("keeps the comment that ends the line past opening parentheses", () => {
    // The note makes the suppression trail `y`; without it, the suppression
    // leads the call in the parentheses, which oxfmt drops.
    const source = "x = y + /* oxfmt-ignore */ ( // note\n a( 1,2 ));\n";

    expect(removeComments(source).code).toBe(source);
    // A comment that stays ends the line as well.
    expect(removeComments("new K /* oxfmt-ignore */ ( /*! legal */ // two\n[ 1,2 ]);\n").code).toBe(
      "new K /* oxfmt-ignore */ ( /*! legal */\n[ 1,2 ]);\n",
    );
    expect(removeComments("new K /* oxfmt-ignore */ ( /* one */ // two\n[ 1,2 ]);\n").code).toBe(
      "new K /* oxfmt-ignore */ ( // two\n[ 1,2 ]);\n",
    );
  });

  it("removes a comment past a token oxfmt does not read on over", () => {
    expect(removeComments("x = a( 1,2 ) /* oxfmt-ignore */ + // note\n  b( 3,4 );\n").code).toBe(
      "x = a( 1,2 ) /* oxfmt-ignore */ +\n  b( 3,4 );\n",
    );
    expect(removeComments("x = y /* oxfmt-ignore */ + ( // note\n a( 1,2 ));\n").code).toBe(
      "x = y /* oxfmt-ignore */ + (\n a( 1,2 ));\n",
    );
    expect(removeComments("f(a( 1,2 ) /* oxfmt-ignore */,\n  // note\n  b( 3,4 ));\n").code).toBe(
      "f(a( 1,2 ) /* oxfmt-ignore */,\n  b( 3,4 ));\n",
    );
  });

  it("keeps a comment that opens its line past the parentheses oxfmt drops", () => {
    const source = "x = /* oxfmt-ignore */ (\n  // note\n  a( 1,2 ));\n";

    expect(removeComments(source).code).toBe(source);
    // Any comment of the run opens it the same way.
    expect(removeComments("x = /* oxfmt-ignore */ (\n  // one\n  /*! legal */\n  a( 1,2 ));\n").code).toBe(
      "x = /* oxfmt-ignore */ (\n  /*! legal */\n  a( 1,2 ));\n",
    );
  });

  it("keeps the comment that ends the line in front of a `=` where one spanning lines would end it instead", () => {
    // In front of a `=`, oxfmt moves the comments of a line that a block
    // comment spanning lines ends over to the right-hand side, where the
    // suppression leaves `[ 1,2 ]` as written.
    const source = "const x /* oxfmt-ignore */ /* one\n*/ // two\n = [ 1,2 ];\n";

    expect(removeComments(source).code).toBe(source);
    // The operator of a compound assignment is read like the `=`.
    for (const operator of ["+=", "**=", ">>>=", "&&=", "??="]) {
      const compound = `z /* oxfmt-ignore */ /* one\n*/ // two\n ${operator} [ 3,4 ];\n`;

      expect(removeComments(compound).code).toBe(compound);
    }
    expect(removeComments("const x /* oxfmt-ignore */ /* one */ // two\n = [ 1,2 ];\n").code).toBe(
      "const x /* oxfmt-ignore */ /* one */\n = [ 1,2 ];\n",
    );
    // Elsewhere the comment that ends the line may be of either kind.
    expect(removeComments("f(a( 1,2 ) /* oxfmt-ignore */ /* one\n*/ // two\n, b( 3,4 ));\n").code).toBe(
      "f(a( 1,2 ) /* oxfmt-ignore */ /* one\n*/\n, b( 3,4 ));\n",
    );
  });
});

describe("removeComments behind an assignment target in parentheses, where oxfmt takes the comments together", () => {
  it.each([
    // The `)` keeps the comments off the end of the target's line, and the
    // note, which a line break precedes, moves all of them over to the
    // right-hand side, where the suppression leaves `[ 1,2 ]` as written.
    "(x) // oxfmt-ignore\n/* note */\n=[ 1,2 ];\n",
    "(x /* oxfmt-ignore */ )\n\n/** note */ =[ 1,2 ];\n",
    "(x\n// note\n) /* oxfmt-ignore */ =[ 1,2 ];\n",
    "(x) /* oxfmt-ignore */\n/* note */\n **=[ 1,2 ];\n",
  ])("keeps the comment that opens its line in front of the operator in %j", (source) => {
    expect(removeComments(source).code).toBe(source);
  });

  it("keeps one such comment, the first, and none where one that stays opens its line", () => {
    expect(removeComments("(x\n/* one */\n)  // oxfmt-ignore\n// two\n=[ 1,2 ];\n").code).toBe(
      "(x\n/* one */\n)  // oxfmt-ignore\n=[ 1,2 ];\n",
    );
    expect(removeComments("(x) /* oxfmt-ignore */\n/*! legal */\n/* note */\n =[ 1,2 ];\n").code).toBe(
      "(x) /* oxfmt-ignore */\n/*! legal */\n =[ 1,2 ];\n",
    );
  });

  it("reads the comments inside the parentheses as the ones that end the target's line", () => {
    // Once the note is gone, the comment spanning lines ends the line, and
    // oxfmt moves the suppression in front of it over to the right-hand side.
    const source = "(x /* oxfmt-ignore */ /* one\n*/ // two\n)=[ 1,2 ];\n";

    expect(removeComments(source).code).toBe(source);
    // The operator follows past the comments in between as well.
    const past = "(x /* oxfmt-ignore */ /* one\n*/ /* two */\n)\n/* three */\n=[ 1,2 ];\n";

    expect(removeComments(past).code).toBe(past);
    // No operator follows these parentheses.
    expect(removeComments("(x /* oxfmt-ignore */ /* one\n*/ // two\n), y;\n[ 1,2 ];\n").code).toBe(
      "(x /* oxfmt-ignore */ /* one\n*/\n), y;\n[ 1,2 ];\n",
    );
  });

  it("removes a comment there that opens no line", () => {
    expect(removeComments("(x) /* oxfmt-ignore */ /* note */ =[ 1,2 ];\n").code).toBe(
      "(x) /* oxfmt-ignore */ =[ 1,2 ];\n",
    );
  });

  it("removes the comments where no parenthesis closes in front of the operator, or the suppression stands behind it", () => {
    expect(removeComments("x /* oxfmt-ignore */\n/* note */\n =[ 1,2 ];\n").code).toBe(
      "x /* oxfmt-ignore */\n =[ 1,2 ];\n",
    );
    expect(removeComments("(x) = /* oxfmt-ignore */\n/* note */\n [ 1,2 ];\n").code).toBe(
      "(x) = /* oxfmt-ignore */\n [ 1,2 ];\n",
    );
  });

  it("removes them behind parentheses that close in front of anything else", () => {
    expect(removeComments("f((x) /* oxfmt-ignore */\n/* note */\n, a( 1,2 ));\n").code).toBe(
      "f((x) /* oxfmt-ignore */\n, a( 1,2 ));\n",
    );
  });
});

describe("removeComments in front of a suppression between closing parentheses and its statement's semicolon", () => {
  it("keeps the comment inside the parentheses that leaves the suppression for the statement below", () => {
    // The note opens its line, and oxfmt leaves it and the comments behind
    // it, the `)` notwithstanding, for the statement after the `;`.
    const source = "g = (a\n// note\n) /* oxfmt-ignore */ ;\nb( 3,4 );\n";

    expect(removeComments(source).code).toBe(source);
    expect(
      removeComments("const g = ()=>({ a:1 } /* one */\n// two\n) /* oxfmt-ignore */\n// three\n;\nb( 3,4 );\n").code,
    ).toBe("const g = ()=>({ a:1 }\n// two\n) /* oxfmt-ignore */\n// three\n;\nb( 3,4 );\n");
  });

  it("keeps none where the parentheses hold no comment", () => {
    const source = "g = (a\n) /* oxfmt-ignore */ ;\nb( 3,4 );\n";

    expect(removeComments(source).code).toBe(source);
  });
});

describe("removeComments behind a suppression on a line of its own in front of its statement's semicolon", () => {
  it("keeps the comment that shares its line, with the one in front of it", () => {
    // oxfmt leaves the suppression for the statement below where every
    // comment from it to the `;` opens its line. `two` shares its line, and
    // would open it without `one`.
    const source = "a( 1,2 )\n// oxfmt-ignore\n/* one */ /* two */\n;\nb( 3,4 );\n";

    expect(removeComments(source).code).toBe(source);
    expect(removeComments("a( 1,2 )\n/* oxfmt-ignore */ /* one */\n// two\n;\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n/* oxfmt-ignore */ /* one */\n// two\n;\nb( 3,4 );\n",
    );
  });

  it("keeps none where a comment that stays shares its line already", () => {
    expect(removeComments("a( 1,2 )\n// oxfmt-ignore\n// zero\n/*! one */ // two\n;\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n// oxfmt-ignore\n\n/*! one */ // two\n;\nb( 3,4 );\n",
    );
  });

  it("removes the comments that open their lines, all but the last", () => {
    expect(removeComments("a( 1,2 )\n// oxfmt-ignore\n// one\n// two\n;\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n// oxfmt-ignore\n\n// two\n;\nb( 3,4 );\n",
    );
  });
});

describe("removeComments between the members of a union type, whose comments Biome reads in sequence", () => {
  it("keeps the comment that makes a suppression behind the `|` belong to the member after it", () => {
    // Biome gives the comments behind a member to that member up to the
    // first that a line break precedes, and from it on to the next member.
    const source = "type U =\n  | { a:1 }\n  // note\n  | // biome-ignore format: x\n  { b:2 };\n";

    expect(removeComments(source).code).toBe(source);
    expect(removeComments(source.replace("biome-ignore", "rome-ignore")).code).toBe(
      source.replace("biome-ignore", "rome-ignore"),
    );
  });

  it("keeps one of the comments, from the first that opens its line on", () => {
    expect(
      removeComments("type U =\n  | { a:1 } // one\n  // two\n  | // biome-ignore format: x\n  { b:2 };\n").code,
    ).toBe("type U =\n  | { a:1 }\n  // two\n  | // biome-ignore format: x\n  { b:2 };\n");
    expect(
      removeComments("type U =\n  | { a:1 }\n  /* one */ /* two */\n  | // biome-ignore format: x\n  { b:2 };\n").code,
    ).toBe("type U =\n  | { a:1 }\n  /* two */\n  | // biome-ignore format: x\n  { b:2 };\n");
  });

  it("reads past the parentheses around a member", () => {
    const behindBar = "type P = ({ a:1 })\n// note\n| /* biome-ignore format: x */\n({ b:2 });\n";

    expect(removeComments(behindBar).code).toBe(behindBar);
    // A closing parenthesis starts Biome's count of the line breaks in front
    // of a comment anew: the note inside decides for the suppression behind.
    const behindParenthesis = "type P = ({ a:1 }\n// note\n) /* biome-ignore format: x */ | { b:2 };\n";

    expect(removeComments(behindParenthesis).code).toBe(behindParenthesis);
    expect(
      removeComments("type P = ({ a:1 }\n/*! legal */\n// note\n) /* biome-ignore format: x */ | { b:2 };\n").code,
    ).toBe("type P = ({ a:1 }\n/*! legal */\n) /* biome-ignore format: x */ | { b:2 };\n");
    // Behind the parentheses of anything else the suppression is placed on its own.
    expect(removeComments("x = (a( 1,2 )\n// note\n) /* biome-ignore format: x */ + b( 3,4 );\n").code).toBe(
      "x = (a( 1,2 )\n) /* biome-ignore format: x */ + b( 3,4 );\n",
    );
  });

  it("removes the comments in front of a separator anywhere else", () => {
    expect(removeComments("a( 1,2 )\n// note\n; // biome-ignore format: x\nb( 3,4 );\n").code).toBe(
      "a( 1,2 )\n; // biome-ignore format: x\nb( 3,4 );\n",
    );
    expect(removeComments("f(a( 1,2 ) /* biome-ignore format: x */, // note\n  b( 3,4 ));\n").code).toBe(
      "f(a( 1,2 ) /* biome-ignore format: x */,\n  b( 3,4 ));\n",
    );
  });
});

// Biome holds a comment back at the token behind it until a node starts or
// ends, and a line break in front of a token it reads in the meantime turns
// the comment into one that ends its line (`visit_token` in biome_formatter's
// comments/builder.rs). Checked against Biome 2.6.9 (November 2026).
describe("removeComments behind a suppression that Biome holds back", () => {
  it("keeps the comment whose line break would stand between the tokens behind the suppression", () => {
    // The suppression leads the update. With a line break in place of the
    // note it would end its line, and trail the initializer.
    const source = "for (i = [ 1,2 ]\n// biome-ignore format: x\n; /* note\n*/ ; i += a( 3,4 )) {}\n";

    expect(removeComments(source).code).toBe(source);

    const body = "for (i = [ 1,2 ]\n// biome-ignore format: x\n; ; /* note\n*/ ) b( 3,4 );\n";

    expect(removeComments(body).code).toBe(body);

    const doWhile = "do b( 3,4 )\n// biome-ignore format: x\nwhile /* note\n*/ (a( 1,2 ));\n";

    expect(removeComments(doWhile).code).toBe(doWhile);
  });

  it("removes the comments there that leave no line break", () => {
    expect(removeComments("for (i = [ 1,2 ]\n// biome-ignore format: x\n; /* note */ ; i += a( 3,4 )) {}\n").code).toBe(
      "for (i = [ 1,2 ]\n// biome-ignore format: x\n;; i += a( 3,4 )) {}\n",
    );
    // A line break stands between the two `;` either way.
    expect(
      removeComments("for (i = [ 1,2 ]\n// biome-ignore format: x\n; /* note\n*/\n ; i += a( 3,4 )) {}\n").code,
    ).toBe("for (i = [ 1,2 ]\n// biome-ignore format: x\n;\n ; i += a( 3,4 )) {}\n");
  });

  it("removes them where the suppression is placed at once, and behind another formatter's", () => {
    // The `for` starts the node the suppression leads.
    expect(removeComments("// biome-ignore format: x\nfor (i = [ 1,2 ]; /* note\n*/ ; i += a( 3,4 )) {}\n").code).toBe(
      "// biome-ignore format: x\nfor (i = [ 1,2 ];\n ; i += a( 3,4 )) {}\n",
    );
    expect(removeComments("for (i = [ 1,2 ]\n// oxfmt-ignore\n; /* note\n*/ ; i += a( 3,4 )) {}\n").code).toBe(
      "for (i = [ 1,2 ]\n// oxfmt-ignore\n;\n ; i += a( 3,4 )) {}\n",
    );
  });
});

// Biome drops the parentheses around an expression, and the line break
// behind the `(` with them unless a comment stands between the `(` and the
// expression (`visit_parenthesized` in biome_js_formatter's
// syntax_rewriter.rs). Checked against Biome 2.6.9 (November 2026).
describe("removeComments behind a Biome suppression in front of parentheses", () => {
  it("keeps the comment that keeps the line break behind the parenthesis", () => {
    // With the line break the suppression ends its line and trails `d`.
    // Without the note Biome drops the line break, and the suppression
    // leads the call.
    const endOfLine = "y = d ?? /* biome-ignore format: x */ ( // note\n a( 1,2 ));\n";

    expect(removeComments(endOfLine).code).toBe(endOfLine);

    const ownLine = "type T = A | /* biome-ignore format: x */ (\n// note\n { a:1 });\n";

    expect(removeComments(ownLine).code).toBe(ownLine);
  });

  it("keeps the comment whose line break would stand in front of the parenthesis ahead of the suppression", () => {
    // The parentheses dropped, a line break in place of the note would put
    // the suppression on a line of its own, where it leads the call.
    const source = "y = d ?? /* note\n*/ ( /* biome-ignore format: x */\n a( 1,2 ));\n";

    expect(removeComments(source).code).toBe(source);
    // A comment there that leaves no line break goes.
    expect(removeComments("y = d ?? /* note */ ( /* biome-ignore format: x */\n a( 1,2 ));\n").code).toBe(
      "y = d ?? ( /* biome-ignore format: x */\n a( 1,2 ));\n",
    );
  });

  it("removes the comments there that keep no line break, or that one that stays keeps it for", () => {
    expect(removeComments("y = d ?? /* biome-ignore format: x */ ( /* note */ a( 1,2 ));\n").code).toBe(
      "y = d ?? /* biome-ignore format: x */ ( a( 1,2 ));\n",
    );
    expect(removeComments("y = d ?? /* biome-ignore format: x */ ( /*! legal */ // note\n a( 1,2 ));\n").code).toBe(
      "y = d ?? /* biome-ignore format: x */ ( /*! legal */\n a( 1,2 ));\n",
    );
  });
});

// Prettier takes a comment with code on both sides of it on its line for
// one that leads the node behind it only where nothing but blanks, opening
// parentheses and comments like it stand in between (`breakTies` in its
// main/comments/attach.js). Checked against Prettier 3.10.1 (November 2026).
describe("removeComments behind a suppression that Prettier reads up to the node after it", () => {
  it("keeps the comment that makes the suppression trail the code in front of it", () => {
    // Without the note the suppression leads the argument, which then stays as written.
    const ownLine = "f /* prettier-ignore */ (\n  // note\n  a( 1,2 ));\n";

    expect(removeComments(ownLine).code).toBe(ownLine);

    const endOfLine = "f /* prettier-ignore */ ( // note\n  a( 1,2 ));\n";

    expect(removeComments(endOfLine).code).toBe(endOfLine);
  });

  it("keeps none where a comment that stays opens its line or ends it then", () => {
    expect(removeComments("f /* prettier-ignore */ (\n  /*! legal */\n  // note\n  a( 1,2 ));\n").code).toBe(
      "f /* prettier-ignore */ (\n  /*! legal */\n  a( 1,2 ));\n",
    );
    expect(removeComments("f /* prettier-ignore */ ( /*! legal */ // note\n  a( 1,2 ));\n").code).toBe(
      "f /* prettier-ignore */ ( /*! legal */\n  a( 1,2 ));\n",
    );
    // This one keeps code on both sides of it.
    const source = "f /* prettier-ignore */ ( /*! legal */ ( // note\n  a( 1,2 )));\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("removes a comment there that neither opens its line nor ends it", () => {
    expect(removeComments("f /* prettier-ignore */ ( /* note */ a( 1,2 ));\n").code).toBe(
      "f /* prettier-ignore */ ( a( 1,2 ));\n",
    );
  });

  it("keeps the comment whose line break would make one that stays open its line", () => {
    const source = "f /* prettier-ignore */ ( /* one\n*/ /*! legal */ a( 1,2 ));\n";

    expect(removeComments(source).code).toBe(source);
  });

  it("removes the comments behind a suppression that opens its line or ends it", () => {
    expect(removeComments("f // prettier-ignore\n(\n  // note\n  a( 1,2 ));\n").code).toBe(
      "f // prettier-ignore\n(\n  a( 1,2 ));\n",
    );
    expect(removeComments("x = b;\n/* prettier-ignore */ f(\n  // note\n  a( 1,2 ));\n").code).toBe(
      "x = b;\n/* prettier-ignore */ f(\n  a( 1,2 ));\n",
    );
  });

  it("removes them past another token, and behind the suppression of another formatter", () => {
    expect(removeComments("f /* prettier-ignore */ + (\n  // two\n  a( 1,2 ));\n").code).toBe(
      "f /* prettier-ignore */ + (\n  a( 1,2 ));\n",
    );
    expect(removeComments("f /* oxfmt-ignore */ (\n  // note\n  a( 1,2 ));\n").code).toBe(
      "f /* oxfmt-ignore */ (\n  a( 1,2 ));\n",
    );
  });
});
