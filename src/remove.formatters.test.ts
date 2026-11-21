import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";

// A formatter applies a suppression to the code it trails or to the code it
// leads, by where the comment stands on its line. Removing a comment next to
// one must leave it standing the same way. The prettier cases run the real
// formatter over a source before and after the removal; the oxfmt and Biome
// ones were checked by hand against oxfmt 0.79.0 and Biome 2.6.8, and all of
// them over generated sources (November 2026): each formatter leaves the same
// code as written before and after the removal.

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
