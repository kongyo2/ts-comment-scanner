import ts from "typescript";
import { LINE_TERMINATOR, isBlank } from "./lines.js";
import { byStart, rangesWithin, type Range } from "./ranges.js";

/**
 * JSX layout for comment removal.
 *
 * JSX has no comment syntax of its own: a comment among JSX children sits in
 * an expression container, `{/* note *​/}`, which renders nothing. Removing
 * the comment should take the braces along, but the braces also split the
 * text around them into separate children, and the JSX transforms turn text
 * into strings by trimming whitespace at line breaks — so dropping a
 * container can merge two strings into one, or change the whitespace one of
 * them keeps. The layout records what every stretch of children renders, so
 * a removal can prove its output renders exactly the same.
 */

/** An expression container among JSX children that holds nothing but comments: `{/* note *​/}`. */
export interface JsxContainer extends Range {
  /** Index into {@link JsxLayout.segments} of the stretch of children the container sits in. */
  segment: number;
  /**
   * Whether a neighbouring child is JSX text that renders something. Only
   * then can dropping the container change what the element renders: text
   * that is nothing but indentation around line breaks renders nothing,
   * however it is merged or trimmed.
   */
  suspect: boolean;
  /**
   * The comment-only container that comes next among the siblings, past
   * whitespace holding a line break (the gap prettier skips when it looks
   * for the node a `{/* prettier-ignore *​/}` applies to), if any.
   */
  next: JsxContainer | undefined;
}

export interface JsxLayout {
  /**
   * What each stretch of children between two tags or expressions renders —
   * the strings the JSX transforms pass on, under every whitespace
   * convention they follow — in a fixed traversal order. Removing comments
   * must leave every entry unchanged.
   */
  segments: string[];
  /** Comment-only containers among JSX children, in document order. */
  containers: JsxContainer[];
  /** Offsets just past every opening tag (`<div>`, `<>`). */
  openingTagEnds: ReadonlySet<number>;
  /** Offsets of every closing tag (`</div>`, `</>`). */
  closingTagStarts: ReadonlySet<number>;
}

/**
 * Lays out the children of the given JSX elements and fragments. `comments`
 * are the source's comments, sorted, so containers holding nothing but
 * comments can be told apart from empty or malformed ones.
 */
export function jsxLayout(
  source: string,
  sourceFile: ts.SourceFile,
  parents: readonly (ts.JsxElement | ts.JsxFragment)[],
  comments: readonly Range[],
): JsxLayout {
  const segments: string[] = [];
  const containers: JsxContainer[] = [];
  const openingTagEnds = new Set<number>();
  const closingTagStarts = new Set<number>();

  for (const parent of parents) {
    const [opening, closing] = ts.isJsxElement(parent)
      ? [parent.openingElement, parent.closingElement]
      : [parent.openingFragment, parent.closingFragment];
    openingTagEnds.add(opening.end);
    closingTagStarts.add(closing.getStart(sourceFile));

    const children = parent.children;
    const own = children.map((child) => commentOnlyContainer(source, sourceFile, child, comments));
    for (const [index, container] of own.entries()) {
      if (container === undefined) continue;
      container.suspect = rendersText(children[index - 1]) || rendersText(children[index + 1]);
      let next = index + 1;
      while (isPrettierBlank(children[next])) next += 1;
      container.next = own[next];
    }

    let parts: RenderedPart[] = [];
    for (const [index, child] of children.entries()) {
      const container = own[index];
      if (container !== undefined) {
        container.segment = segments.length;
        containers.push(container);
        continue;
      }
      const part = renderedPart(child);
      if (part === BOUNDARY) {
        segments.push(renderParts(parts));
        parts = [];
      } else if (part !== undefined) {
        parts.push(part);
      }
    }
    segments.push(renderParts(parts));
  }

  containers.sort(byStart);
  return { segments, containers, openingTagEnds, closingTagStarts };
}

const BOUNDARY = Symbol("boundary");

/**
 * What a child contributes to its stretch of rendered strings: text, a
 * string literal (`{" "}` is passed on as the very string a text child
 * would be), nothing at all (an empty container), or a boundary that ends
 * the stretch (a tag or any other expression).
 */
function renderedPart(child: ts.JsxChild): RenderedPart | typeof BOUNDARY | undefined {
  if (ts.isJsxText(child)) return { text: child.text };
  if (!ts.isJsxExpression(child) || child.dotDotDotToken !== undefined) return BOUNDARY;
  if (child.expression === undefined) return undefined;
  return ts.isStringLiteral(child.expression) ? { literal: child.expression.text } : BOUNDARY;
}

/**
 * The child as a comment-only container: an expression container without an
 * expression whose braces enclose nothing but whitespace and at least one
 * comment. Anything else (an expression, a spread, `{}`, a container the
 * parser had to recover from) is not one.
 */
function commentOnlyContainer(
  source: string,
  sourceFile: ts.SourceFile,
  child: ts.JsxChild,
  comments: readonly Range[],
): JsxContainer | undefined {
  if (!ts.isJsxExpression(child) || child.expression !== undefined || child.dotDotDotToken !== undefined) {
    return undefined;
  }
  // The parser only leaves the expression out when a closing brace follows
  // the opening one, so the container spans exactly `{` to `}`. What lies
  // between them is trivia: whitespace and comments, but possibly also a
  // merge-conflict marker, which is no comment.
  const start = child.getStart(sourceFile);
  const end = child.end;
  const inside = rangesWithin(comments, { start, end });
  let cursor = start + 1;
  let uncommented = "";
  for (const comment of inside) {
    uncommented += source.slice(cursor, comment.start);
    cursor = comment.end;
  }
  uncommented += source.slice(cursor, end - 1);
  return inside.length > 0 && isBlank(uncommented)
    ? { start, end, segment: -1, suspect: false, next: undefined }
    : undefined;
}

// Text made of nothing but spaces, tabs and at least one line break renders
// nothing under any of the conventions below, and stays that way when it
// loses spaces or tabs or is merged with more of its kind.
const INERT_TEXT = /^[ \t]*(?:(?:\r\n?|\n)[ \t]*)+$/;

function rendersText(child: ts.JsxChild | undefined): boolean {
  return child !== undefined && ts.isJsxText(child) && !INERT_TEXT.test(child.text);
}

/** Text prettier steps over looking for an ignore comment's target: its JSX whitespace with a line feed. */
function isPrettierBlank(child: ts.JsxChild | undefined): boolean {
  return child !== undefined && ts.isJsxText(child) && /^[ \t\r\n]*$/.test(child.text) && child.text.includes("\n");
}

type RenderedPart = { text: string } | { literal: string };

/** The strings a stretch of children renders, under every whitespace convention, as one comparable value. */
function renderParts(parts: readonly RenderedPart[]): string {
  return JSON.stringify(
    TEXT_RENDERINGS.map((render) =>
      parts.flatMap((part) => {
        if ("literal" in part) return [part.literal];
        const rendered = render(part.text);
        return rendered === undefined ? [] : [rendered];
      }),
    ),
  );
}

/** The string a JSX transform makes of a JSX text, or undefined when the text renders nothing. */
type TextRendering = (text: string) => string | undefined;

/**
 * The convention of the transforms that trim before they decode entities —
 * TypeScript's `fixupWhitespaceAndDecodeEntities` (tsc 6 and 7 alike) and
 * esbuild's `fixWhitespaceAndDecodeJSXEntities`: every line loses the
 * whitespace at its ends, except that the first line keeps its leading and
 * the last line its trailing whitespace; lines left empty are dropped and
 * the rest joined with single spaces. Entities stay encoded here — both
 * decode them line by line after trimming, so equal spellings decode equally.
 */
function trimThenDecode(space: RegExp): TextRendering {
  return (text) => {
    let rendered: string | undefined;
    let first = 0;
    let last = -1;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string;
      if (LINE_TERMINATOR.test(char)) {
        if (first !== -1 && last !== -1) rendered = joinLine(rendered, text.slice(first, last + 1));
        first = -1;
      } else if (!space.test(char)) {
        last = index;
        if (first === -1) first = index;
      }
    }
    return first === -1 ? rendered : joinLine(rendered, text.slice(first));
  };
}

function joinLine(rendered: string | undefined, line: string): string {
  return rendered === undefined ? line : `${rendered} ${line}`;
}

// Babel decodes numeric entities into the text before trimming it, so
// `&#32;` and `&#10;` count as the space and line break they spell. (Its
// named entities — the XHTML set — never decode to a space, tab or line
// break, so they can stay encoded.)
const NUMERIC_ENTITY = /&#(?:(\d+)|x([\da-fA-F]+));/g;

function decodeNumericEntity(entity: string, decimal: string | undefined, hex: string | undefined): string {
  const codePoint = decimal === undefined ? Number.parseInt(hex as string, 16) : Number.parseInt(decimal, 10);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/**
 * Babel's convention (`cleanJSXElementLiteralChild`), which React's and most
 * other Babel-based JSX transforms share: the decoded text is split at CR,
 * LF and CRLF, tabs become spaces, and lines lose the spaces touching a line
 * break before the non-empty ones are joined with single spaces.
 */
function decodeThenTrim(text: string): string | undefined {
  const lines = text.replace(NUMERIC_ENTITY, decodeNumericEntity).split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (const [index, line] of lines.entries()) {
    if (/[^ \t]/.test(line)) lastNonEmptyLine = index;
  }
  let rendered = "";
  for (const [index, line] of lines.entries()) {
    let trimmed = line.replace(/\t/g, " ");
    if (index !== 0) trimmed = trimmed.replace(/^ +/, "");
    if (index !== lines.length - 1) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed === "") continue;
    rendered += index === lastNonEmptyLine ? trimmed : `${trimmed} `;
  }
  return rendered === "" ? undefined : rendered;
}

const TEXT_RENDERINGS: readonly TextRendering[] = [
  // TypeScript's isWhiteSpaceSingleLine (tsc 6 and the Go port).
  trimThenDecode(/[ \t\v\f\u0085   -​  　﻿]/),
  // esbuild's IsWhitespace, which lacks NEL and the zero-width space.
  trimThenDecode(/[ \t\v\f   -   　﻿]/),
  decodeThenTrim,
];
