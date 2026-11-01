import { describe, it, expect } from "vitest";
import { analyzeSource } from "./scanner.js";

/** The JSX layout of a TSX source. */
const layoutOf = (source: string) => analyzeSource(source, { jsx: true }).jsx;

/** Each stretch's rendered strings as [TypeScript, esbuild, Babel]. */
const renderingsOf = (source: string): string[][][] =>
  layoutOf(source).segments.map((segment) => JSON.parse(segment) as string[][]);

/** The strings the only stretch of a `<p>` renders, when all three conventions agree. */
function rendered(children: string): string[] {
  const [[typescript, esbuild, babel]] = renderingsOf(`const e = <p>${children}</p>;\n`) as [string[][]];
  expect(esbuild).toEqual(typescript);
  expect(babel).toEqual(typescript);
  return typescript as string[];
}

describe("JSX layout renderings", () => {
  it("trims whitespace at line breaks and joins the remaining lines with single spaces", () => {
    expect(rendered("a\n  b")).toEqual(["a b"]);
    expect(rendered("\n  first line  \n  second line\n")).toEqual(["first line second line"]);
    expect(rendered("a\r\nb\rc")).toEqual(["a b c"]);
  });

  it("keeps the whitespace that does not touch a line break", () => {
    expect(rendered("  a  ")).toEqual(["  a  "]);
    expect(rendered(" ")).toEqual([" "]);
    expect(rendered("  a\n b  ")).toEqual(["  a b  "]);
  });

  it("renders nothing for whitespace around a line break", () => {
    expect(rendered("\n  ")).toEqual([]);
    expect(rendered("  \n\n  ")).toEqual([]);
  });

  it("passes string literal children on as they are and skips empty containers", () => {
    expect(rendered('a{" "}b')).toEqual(["a", " ", "b"]);
    expect(rendered("a{}b{/* c */}d")).toEqual(["a", "b", "d"]);
  });

  it("ends a stretch at tags and at every other expression", () => {
    const renderings = renderingsOf("const e = <p>a<b />c{x}d{...y}e</p>;\n").map(([typescript]) => typescript);

    expect(renderings).toEqual([["a"], ["c"], ["d"], ["e"]]);
  });

  it("follows TypeScript's whitespace in the TypeScript rendering and esbuild's in the esbuild one", () => {
    // NEL and the zero-width space are whitespace to tsc only.
    expect(renderingsOf("const e = <p>a\n\u0085b​\nc</p>;\n")[0]).toEqual([
      ["a b c"],
      ["a \u0085b​ c"],
      ["a \u0085b​ c"],
    ]);
  });

  it("follows Babel's rules in the Babel rendering", () => {
    // Babel trims spaces only, after turning tabs into spaces, and only
    // breaks lines at CR and LF.
    expect(renderingsOf("const e = <p>a\tb\n\tc \n d</p>;\n")[0]).toEqual([["a\tb c d"], ["a\tb c d"], ["a b c   d"]]);
  });

  it("decodes numeric entities before trimming in the Babel rendering only", () => {
    // tsc and esbuild trim first and decode the entity afterwards, so the
    // encoded space survives at the end of the line.
    expect(renderingsOf("const e = <p>a&#32;\nb&#x20;\nc&#x110000;\nd</p>;\n")[0]).toEqual([
      ["a&#32; b&#x20; c&#x110000; d"],
      ["a&#32; b&#x20; c&#x110000; d"],
      ["a b c&#x110000; d"],
    ]);
  });

  it("lays out fragments like elements and records where tags open and close", () => {
    const source = "const e = <><b>x</b>{/* c */}</>;\n";
    const layout = layoutOf(source);

    expect(layout.segments.map((segment) => (JSON.parse(segment) as string[][])[0])).toEqual([[], [], ["x"]]);
    expect([...layout.openingTagEnds].map((offset) => source.slice(offset - 3, offset))).toEqual([" <>", "<b>"]);
    expect([...layout.closingTagStarts].map((offset) => source.slice(offset, offset + 3))).toEqual(["</>", "</b"]);
  });
});

describe("JSX layout containers", () => {
  it("finds the containers that hold nothing but comments", () => {
    const source = "const e = <p>{/* a */}{ /* b */ /* c */ }{// d\n}{/* e */ x}{ }{...y}</p>;\n";
    const layout = layoutOf(source);

    expect(layout.containers.map((container) => source.slice(container.start, container.end))).toEqual([
      "{/* a */}",
      "{ /* b */ /* c */ }",
      "{// d\n}",
    ]);
  });

  it("does not count a container holding trivia other than comments", () => {
    // A merge-conflict marker is trivia to the parser, but not a comment.
    expect(layoutOf("const e = <p>{ /* c */\n<<<<<<< HEAD\n}</p>;\n").containers).toEqual([]);
    expect(layoutOf("const e = <p>{\n<<<<<<< HEAD\n/* c */ }</p>;\n").containers).toEqual([]);
  });

  it("flags containers next to text that renders something", () => {
    const source = [
      "const e = (",
      "  <div>",
      "    {/* lone */}",
      "    <A /> {/* after a space */}",
      "    {/* before text */}",
      "    Hello{/* inside text */}",
      "  </div>",
      ");",
      "",
    ].join("\n");
    const layout = layoutOf(source);

    expect(
      layout.containers.map((container) => [source.slice(container.start, container.end), container.suspect]),
    ).toEqual([
      ["{/* lone */}", false],
      ["{/* after a space */}", true],
      ["{/* before text */}", true],
      ["{/* inside text */}", true],
    ]);
  });

  it("links each container to the comment-only container after it, past line-broken whitespace", () => {
    const source =
      "const e = (\n  <div>\n    {/* a */}\n    {/* b */} {/* c */}x{/* d */}<i />{/* e */}\n  </div>\n);\n";
    const layout = layoutOf(source);
    const nextOf = layout.containers.map((container) =>
      container.next === undefined ? undefined : source.slice(container.next.start, container.next.end),
    );

    expect(nextOf).toEqual(["{/* b */}", undefined, undefined, undefined, undefined]);
  });

  it("assigns containers to the stretch they sit in, in document order", () => {
    const source = "const e = <div>{/* a */}<p>{/* b */}</p>{/* c */}</div>;\n";
    const layout = layoutOf(source);

    expect(
      layout.containers.map((container) => [source.slice(container.start, container.end), container.segment]),
    ).toEqual([
      ["{/* a */}", 0],
      ["{/* b */}", 2],
      ["{/* c */}", 1],
    ]);
  });

  it("finds no JSX in a source parsed without it", () => {
    const layout = analyzeSource("const e = <T>(x);\n").jsx;

    expect(layout).toEqual({ segments: [], containers: [], openingTagEnds: new Set(), closingTagStarts: new Set() });
  });
});
