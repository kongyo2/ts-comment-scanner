import { describe, it, expect } from "vitest";
import { removeComments } from "./remove.js";

/** Removes the comments of a TSX source. */
const strip = (source: string) => removeComments(source, { jsx: true });

/** Wraps JSX lines in a statement, indented as an element's children. */
const tsx = (...lines: string[]) => ["const e = (", ...lines.map((line) => `  ${line}`), ");", ""].join("\n");

describe("removeComments with comment-only JSX containers", () => {
  it("drops a container on a line of its own together with the line", () => {
    const result = strip(tsx("<div>", "  {/* header */}", "  <Header />", "</div>"));

    expect(result.code).toBe(tsx("<div>", "  <Header />", "</div>"));
    expect(result.removed.map((comment) => comment.text)).toEqual(["/* header */"]);
  });

  it("drops a container whose line comment spans several lines", () => {
    const result = strip(tsx("<div>", "  {", "    // explanation", "  }", "  <A />", "</div>"));

    expect(result.code).toBe(tsx("<div>", "  <A />", "</div>"));
  });

  it("drops a container holding several comments", () => {
    expect(strip("const e = <div>{/* a */ /* b */}</div>;\n").code).toBe("const e = <div></div>;\n");
  });

  it("drops a container right behind or in front of a tag", () => {
    expect(strip(tsx("<p>", "  <a>T</a>{/* c */}", "  <a>P</a>", "</p>")).code).toBe(
      tsx("<p>", "  <a>T</a>", "  <a>P</a>", "</p>"),
    );
    expect(strip(tsx("<p>", "  {/* c */}<a>P</a>", "</p>")).code).toBe(tsx("<p>", "  <a>P</a>", "</p>"));
  });

  it('puts {" "} in place of a container held off a tag by a rendered space', () => {
    // `<a>T</a> {...}` renders a space between the links: dropping the
    // container with the space before it would glue them together.
    expect(strip(tsx("<p>", "  <a>T</a> {/* legal link */}", "  <a>P</a>", "</p>")).code).toBe(
      tsx("<p>", '  <a>T</a>{" "}', "  <a>P</a>", "</p>"),
    );
    expect(strip(tsx("<p>", "  {/* c */} <a>P</a>", "</p>")).code).toBe(tsx("<p>", '  {" "}<a>P</a>', "</p>"));
  });

  it("keeps the braces of a container that keeps two texts apart", () => {
    // Without the braces the texts would merge into one string, `Hello world`
    // instead of `Hello` and `world` side by side.
    expect(strip(tsx("<p>", "  Hello", "  {/* c */}", "  world", "</p>")).code).toBe(
      tsx("<p>", "  Hello", "  {}", "  world", "</p>"),
    );
    expect(strip("const e = <p>Hello {/* c */} world</p>;\n").code).toBe("const e = <p>Hello {} world</p>;\n");
    expect(strip(tsx("<p>", "  Some text {/* c */}", "  more text", "</p>")).code).toBe(
      tsx("<p>", "  Some text {}", "  more text", "</p>"),
    );
    expect(strip("const e = <p>Hello{/* a\n b */}world</p>;\n").code).toBe("const e = <p>Hello{}world</p>;\n");
  });

  it('keeps the braces of a multi-line container where {" "} would have to take its place', () => {
    expect(strip(tsx("<p>", "  <a>T</a> {/* c", "  d */}", "  <a>P</a>", "</p>")).code).toBe(
      tsx("<p>", "  <a>T</a> {}", "  <a>P</a>", "</p>"),
    );
  });

  it("settles the containers of one stretch one at a time", () => {
    // The trailing container needs {" "}; the next one can go entirely.
    expect(strip(tsx("<div>", "  <A /> {/* trailing */}", "  {/* section */}", "  Hello", "</div>")).code).toBe(
      tsx("<div>", '  <A />{" "}', "  Hello", "</div>"),
    );
  });

  it("settles separate stretches independently", () => {
    const source = tsx(
      "<div>",
      "  <A /> {/* one */}",
      "  <B />",
      "  Hi {/* two */} {/* three */}",
      "  there",
      "</div>",
    );

    expect(strip(source).code).toBe(tsx("<div>", '  <A />{" "}', "  <B />", '  Hi {}{" "}', "  there", "</div>"));
  });

  it("keeps the braces of a crowd of containers in one stretch without trying each", () => {
    const words = Array.from({ length: 18 }, (_, index) => `w${index}`);

    expect(strip(`const e = <p>${words.join(" {/* c */} ")}</p>;\n`).code).toBe(
      `const e = <p>${words.join(" {} ")}</p>;\n`,
    );
  });

  it("drops blank lines left against the tags along with the containers", () => {
    expect(strip(tsx("<div>", "  {/* a */}", "", "  <A />", "", "  {/* b */}", "</div>")).code).toBe(
      tsx("<div>", "  <A />", "</div>"),
    );
  });

  it("removes only the comment of an attribute's empty expression", () => {
    expect(strip("const e = <p a={/* c */}>x</p>;\n").code).toBe("const e = <p a={}>x</p>;\n");
  });

  it("keeps the braces around a kept comment", () => {
    const result = strip("const e = <p>{/* eslint-disable-line */ /* gone */}</p>;\n");

    expect(result.code).toBe("const e = <p>{/* eslint-disable-line */}</p>;\n");
    expect(result.removed.map((comment) => comment.text)).toEqual(["/* gone */"]);
  });
});

describe("removeComments keeps JSX containers that directives reach", () => {
  it("keeps the container a {/* prettier-ignore */} would otherwise skip over", () => {
    // prettier applies the ignore comment to the next sibling: with the note
    // gone, `<A   b />` would no longer be formatted.
    const sameLine = tsx("<div>", "  {/* prettier-ignore */}{/* note */}", "  <A   b />", "</div>");
    const nextLine = tsx("<div>", "  {/* prettier-ignore */}", "  {/* note */}", "  <A   b />", "</div>");

    expect(strip(sameLine).changed).toBe(false);
    expect(strip(nextLine).changed).toBe(false);
  });

  it("keeps a container line below a next-line directive", () => {
    const source = tsx(
      "<div>",
      "  {/* eslint-disable-next-line */}",
      "  {/* note */}",
      "  <div dangerouslySetInnerHTML={x} />",
      "</div>",
    );

    expect(strip(source).changed).toBe(false);
  });

  it("keeps a container line tsc stops at below a suppression", () => {
    const source = tsx("<div>", "  {/* @ts-expect-error */}", "", "  {/* note */}", "  <A b={1} />", "</div>");

    expect(strip(source).changed).toBe(false);
  });

  it("does not keep a container after a range or file pragma, which targets no sibling", () => {
    const source = "const e = <div>{/* c8 ignore start */}{/* note */}<A />{/* c8 ignore stop */}</div>;\n";

    expect(strip(source).code).toBe("const e = <div>{/* c8 ignore start */}<A />{/* c8 ignore stop */}</div>;\n");
  });

  it("keeps the container after a trailing {/* prettier-ignore */}, which still applies to the next sibling", () => {
    const source = tsx("<div>", "  <B /> {/* prettier-ignore */}{/* note */}", "  <A   b />", "</div>");

    expect(strip(source).changed).toBe(false);
  });

  it("leaves a sibling container alone when its comment is kept anyway", () => {
    const source = "const e = <div>{/* prettier-ignore */}{/*! legal */}<A />\n</div>;\n";

    expect(strip(source).changed).toBe(false);
  });

  it("protects whole containers and single comments alike below a next-line directive", () => {
    // Every container reaches the line checks: one going braces and all, one
    // kept for its directive, and one whose braces stay to keep text apart.
    const source = tsx(
      "<p>",
      "  {/* eslint-disable-next-line */}",
      "  {/* a */ /* b */}",
      "  {/* eslint-disable-line */ /* c */}",
      "  Hello{/* d */}world",
      "</p>",
    );

    expect(strip(source).code).toBe(
      tsx(
        "<p>",
        "  {/* eslint-disable-next-line */}",
        "  {/* a */ /* b */}",
        "  {/* eslint-disable-line */}",
        "  Hello{}world",
        "</p>",
      ),
    );
  });
});
