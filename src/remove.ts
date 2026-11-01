import { activePositionalDirectives, bunMarkerOffset, isLegalComment, type DirectivePlacement } from "./directives.js";
import type { JsxContainer } from "./jsx.js";
import { LINE_TERMINATOR, isBlank, lineStartOffsets } from "./lines.js";
import { firstIndexAtOrAfter, type Range } from "./ranges.js";
import { analyzeSource } from "./scanner.js";
import { applyEdits, blankLineEdits, type Edit } from "./splice.js";
import type { Comment } from "./types.js";

export interface RemoveOptions {
  jsx?: boolean;
  /** Also remove compiler/linter directive comments. Default: false (kept for safety). */
  removeDirectives?: boolean;
  /** Also remove license/legal comments. Default: false (kept for safety). */
  removeLegal?: boolean;
  /** Extra predicate: return false to leave a comment out of the removal entirely. */
  shouldRemove?: (comment: Comment) => boolean;
}

export interface RemoveResult {
  /** Source with the removed comments spliced out. */
  code: string;
  removed: Comment[];
  /**
   * Comments kept because they are protected: directives, license headers,
   * comments whose removal would shift code under a next-line directive or
   * that sit between a directive and the code it reaches past them for (or
   * the JSX sibling it applies to), and comments whose removal would move a
   * position-dependent directive (prettier's first-comment pragma, Deno's
   * coverage file pragma, Bun's file-start marker) into effect.
   */
  kept: Comment[];
  /** Comments excluded from removal by the `shouldRemove` predicate. */
  skipped: Comment[];
  changed: boolean;
}

/**
 * Removes comments from TypeScript source without touching code.
 *
 * Safety properties:
 * - AST-based ranges: strings, template literals and regexes are never affected.
 * - Directives (`@ts-expect-error`, `eslint-disable`, ...) and license headers are
 *   kept by default, since deleting them changes build/lint behaviour.
 * - Surviving comments keep their directive semantics: when deleting a leading
 *   comment would newly activate a position-dependent directive in a kept
 *   comment (prettier's `@format` docblock pragma counts only as the file's
 *   first comment, Bun's `// @bun` only at the very start or right after a
 *   shebang line), the leading comment is kept instead.
 * - A space is inserted where removing a block comment would merge two tokens,
 *   and a line break is kept where the comment acted as one (ASI stays intact).
 * - A JSX comment goes with its braces (`{/* note *​/}`), unless that would
 *   change what the element renders: the braces split the text around them
 *   into separate strings, so where they stand between text that renders,
 *   `{" "}` takes their place when that keeps the strings identical, and
 *   otherwise the braces stay as `{}`. The output is re-parsed to prove every
 *   element renders the same strings, under the whitespace rules of
 *   TypeScript, esbuild and Babel alike.
 * - Blank lines that only separated a removed comment from the code around it
 *   go with it: no pile-up of blank lines where a comment stood between two
 *   of them, and at the start or end of the file or of a block only the blank
 *   lines already against that edge stay.
 * - A leading byte-order mark is preserved. Reported positions index into the
 *   `source` string exactly as `scanComments(source)` reports them (a BOM
 *   counts as its first character).
 * - The result is re-scanned; if the remaining comments do not match the kept
 *   set, an error is thrown instead of returning corrupted output.
 */
export function removeComments(source: string, options: RemoveOptions = {}): RemoveResult {
  const jsx = options.jsx === true;
  const analysis = analyzeSource(source, { jsx });
  const comments = analysis.comments;

  let removed: Comment[] = [];
  const kept: Comment[] = [];
  const skipped: Comment[] = [];
  for (const comment of comments) {
    if (options.shouldRemove?.(comment) === false) {
      skipped.push(comment);
    } else if (isProtected(comment, options)) {
      kept.push(comment);
    } else {
      removed.push(comment);
    }
  }

  const containers = attachContainers(source, analysis.jsx.containers, comments);
  const containerOf = new Map<Comment, Container>();
  for (const container of containers) {
    for (const comment of container.comments) containerOf.set(comment, container);
  }
  const context: ShieldContext = { containerOf, skippable: skippableRanges(comments, containerOf, new Set(removed)) };
  const search = containerSearch(containers);
  // Collapsing blank lines can only move a surviving comment to the very
  // start of the file (or of the line after a shebang), where Bun reads its
  // marker; when that changes a survivor's meaning, the attempt is repeated
  // without the collapse before any removal is given up.
  let tidyBlankLines = true;

  for (;;) {
    const shielding = shieldNextLineDirectives(source, removed, kept, skipped, context);
    removed = shielding.removed;

    if (removed.length === 0) {
      return { code: source, removed, kept, skipped, changed: false };
    }

    const removing = new Set(removed);
    search.track(new Set(containers.filter((container) => container.comments.every((c) => removing.has(c)))));
    const edits = removalEdits(removed, containerOf, search.droppable);
    const deletions = edits.filter((edit) => edit.replacement === undefined);
    const blankEdits = tidyBlankLines ? blankLineEdits(source, deletions, comments, shielding.lines, analysis.jsx) : [];
    const code = editKeepingBom(source, [...edits, ...blankEdits].sort(byStart));
    const output = analyzeSource(code, { jsx });

    if (search.adjust(changedSegments(analysis.jsx.segments, output.jsx.segments))) continue;

    const survivor = firstChangedSurvivor(source, code, output.comments, kept, skipped);
    if (survivor === undefined) {
      return { code, removed, kept, skipped, changed: true };
    }
    if (blankEdits.length > 0) {
      tidyBlankLines = false;
      continue;
    }

    // A surviving comment changed meaning: with everything before it deleted
    // it became the file's first comment (or its very first bytes), turning a
    // previously inert positional directive live. Re-protect the removal
    // candidate closest before it and try again: that comment then keeps
    // holding the survivor away from the activating position, exactly as the
    // input did. (Looping, because the re-protected comment can itself be a
    // next-line directive that shields further lines.)
    const blocker = closestRemovalBefore(removed, survivor);
    if (blocker === undefined) {
      throw unexpectedResult();
    }
    removed = removed.filter((comment) => comment !== blocker);
    kept.push(blocker);
    kept.sort(byStart);
    tidyBlankLines = true;
  }
}

function unexpectedResult(): Error {
  return new Error("comment removal produced an unexpected result; refusing to continue");
}

/** Sort comparator for document order: ranges are ordered by where they start. */
function byStart(a: Range, b: Range): number {
  return a.start - b.start;
}

/**
 * Compares the spliced output's comments against the comments meant to
 * survive, in document order (removal never reorders them). Throws when the
 * texts themselves differ (the output would be corrupted) and returns the
 * first surviving comment whose directive semantics changed, or undefined
 * when the output is exactly as expected. Besides the canonical directive
 * name, the position-dependent pragmas are compared on their own: a comment
 * can carry an inert `@format` underneath the directive an earlier rule
 * already named (an eslint config block, say), and that pragma going live
 * must not hide behind the unchanged name.
 */
function firstChangedSurvivor(
  source: string,
  code: string,
  actual: Comment[],
  kept: Comment[],
  skipped: Comment[],
): Comment | undefined {
  const expected = [...kept, ...skipped].sort(byStart);
  if (actual.length !== expected.length) {
    throw unexpectedResult();
  }
  for (const [index, comment] of expected.entries()) {
    const survivor = actual[index] as Comment;
    if (survivor.text !== comment.text) {
      throw unexpectedResult();
    }
    if (survivor.directive !== comment.directive) return comment;
    const before = activePositionalDirectives(comment.kind, comment.text, positionalPlacement(source, comment));
    const after = activePositionalDirectives(survivor.kind, survivor.text, positionalPlacement(code, survivor));
    if (before.join("\n") !== after.join("\n")) return comment;
  }
  return undefined;
}

/**
 * The placement bits the position-dependent directives care about, derived
 * without a parse: the comment is the file's first comment when nothing but
 * whitespace (or a shebang) precedes it — any earlier comment's text keeps
 * the slice non-blank — and it sits at the file start when it begins where
 * Bun reads its marker. Header status needs the token structure, but
 * removing comments never moves a comment across the first token, so the
 * positional check does not consult it.
 */
function positionalPlacement(text: string, comment: Comment): DirectivePlacement {
  const shebangLength = /^#!.*/.exec(text)?.[0].length ?? 0;
  return {
    header: false,
    firstComment: isBlank(text.slice(shebangLength, comment.start)),
    fileStart: comment.start === bunMarkerOffset(text),
  };
}

/** The removal candidate that starts closest before the comment, if any. */
function closestRemovalBefore(removals: readonly Comment[], comment: Comment): Comment | undefined {
  let closest: Comment | undefined;
  for (const removal of removals) {
    if (removal.start < comment.start) closest = removal;
  }
  return closest;
}

/**
 * Applies the edits, restoring the byte-order mark when dropping a
 * comment-only first line took it along: the mark is an encoding artifact,
 * not line content.
 */
function editKeepingBom(source: string, edits: readonly Edit[]): string {
  if (!source.startsWith("﻿")) return applyEdits(source, edits);
  // The editing itself works on the BOM-less body (with ranges shifted to
  // match) so its line handling never sees the mark, then the mark is
  // re-attached; this keeps `﻿// gone\n...` from losing the mark with
  // the dropped line.
  const shifted = edits.map((edit) => ({ ...edit, start: edit.start - 1, end: edit.end - 1 }));
  return `﻿${applyEdits(source.slice(1), shifted)}`;
}

function isProtected(comment: Comment, options: RemoveOptions): boolean {
  if (comment.directive !== undefined && options.removeDirectives !== true) return true;
  if (isLegalComment(comment.text) && options.removeLegal !== true) return true;
  return false;
}

/**
 * How a comment-only JSX container goes once all its comments do: braces
 * and all; replaced by `{" "}` together with the spaces that held it off its
 * neighbour; or with its braces kept, only the comments going.
 */
type ContainerMode = "drop" | "space" | "keep";

/** A comment-only JSX container (`{/* note *​/}`) with the comments in it. */
interface Container extends Range {
  segment: number;
  suspect: boolean;
  /** The comment-only container right after it among the siblings, if any. */
  next: Container | undefined;
  comments: Comment[];
  mode: ContainerMode;
  /** What `{" "}` would replace, when the container shares its line and is held off by spaces. */
  spaceRange: Range | undefined;
}

function attachContainers(source: string, layouts: readonly JsxContainer[], comments: readonly Comment[]): Container[] {
  const containers = new Map<JsxContainer, Container>();
  for (const layout of layouts) {
    const inside: Comment[] = [];
    let index = firstIndexAtOrAfter(comments, layout.start, (comment) => comment.start);
    for (let comment = comments[index]; comment !== undefined && comment.end < layout.end; comment = comments[index]) {
      inside.push(comment);
      index += 1;
    }
    containers.set(layout, {
      start: layout.start,
      end: layout.end,
      segment: layout.segment,
      suspect: layout.suspect,
      next: undefined,
      comments: inside,
      mode: "drop",
      spaceRange: spaceRange(source, layout),
    });
  }
  for (const [layout, container] of containers) {
    if (layout.next !== undefined) container.next = containers.get(layout.next);
  }
  return [...containers.values()];
}

const isHorizontalSpace = (char: string | undefined): boolean => char === " " || char === "\t";

/**
 * The range `{" "}` would take the place of: a one-line container and the
 * spaces before it when code precedes it on its line (`<b /> {/* x *​/}`), or
 * the spaces after it when it opens its line and code follows. Undefined when
 * no spaces hold it off anything on its line.
 */
function spaceRange(source: string, container: Range): Range | undefined {
  if (LINE_TERMINATOR.test(source.slice(container.start, container.end))) return undefined;
  let lineStart = container.start;
  while (lineStart > 0 && !LINE_TERMINATOR.test(source[lineStart - 1] as string)) lineStart -= 1;
  let before = container.start;
  while (isHorizontalSpace(source[before - 1])) before -= 1;
  let after = container.end;
  while (isHorizontalSpace(source[after])) after += 1;

  if (!isBlank(source.slice(lineStart, container.start))) {
    return before < container.start ? { start: before, end: container.end } : undefined;
  }
  const codeAfter = after < source.length && !LINE_TERMINATOR.test(source[after] as string);
  return codeAfter && after > container.end ? { start: container.start, end: after } : undefined;
}

/**
 * Comments, and the comment-only containers that may go along with theirs,
 * as sorted ranges: what the search for the code after a directive skips.
 * A container counts as skippable when all its comments are removal
 * candidates, even if some get protected later — skipping it then only moves
 * the found code further down, which shields more, not less.
 */
function skippableRanges(
  comments: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  candidates: ReadonlySet<Comment>,
): Range[] {
  const ranges: Range[] = [];
  for (const comment of comments) {
    const container = containerOf.get(comment);
    if (container === undefined || !container.comments.every((inside) => candidates.has(inside))) {
      ranges.push(comment);
    } else if (ranges[ranges.length - 1] !== container) {
      ranges.push(container);
    }
  }
  return ranges;
}

/** The edits that remove the comments: one per comment, or one per container going with its braces. */
function removalEdits(
  removed: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  droppable: ReadonlySet<Container>,
): Edit[] {
  const edits: Edit[] = [];
  for (const comment of removed) {
    const container = containerOf.get(comment);
    if (container === undefined || !droppable.has(container) || container.mode === "keep") {
      edits.push({ start: comment.start, end: comment.end });
    } else if (comment === container.comments[0]) {
      edits.push(
        container.mode === "drop"
          ? { start: container.start, end: container.end, jsx: true }
          : { ...(container.spaceRange as Range), replacement: '{" "}' },
      );
    }
  }
  return edits;
}

/** Indexes of the JSX stretches whose rendering differs; throws when the structure itself does. */
function changedSegments(before: readonly string[], after: readonly string[]): Set<number> {
  if (before.length !== after.length) throw unexpectedResult();
  const changed = new Set<number>();
  for (const [index, rendering] of before.entries()) {
    if (rendering !== after[index]) changed.add(index);
  }
  return changed;
}

interface ContainerSearch {
  /** Containers whose comments all go, so their braces can too. */
  readonly droppable: ReadonlySet<Container>;
  /** Records which containers can go; when that changes (comments got protected), the search starts over. */
  track(droppable: ReadonlySet<Container>): void;
  /** Adjusts the modes after an attempt rendered the given stretches differently; true when anything changed. */
  adjust(changed: ReadonlySet<number>): boolean;
}

/**
 * Decides how each comment-only container goes. Dropping the braces is tried
 * everywhere first; where the re-parsed output then renders a stretch of JSX
 * children differently, that stretch's suspect containers are settled one
 * at a time, in document order — each tries dropping, then `{" "}`, then
 * keeping its braces, while the suspects after it keep theirs — so braces
 * stay only where nothing less keeps the rendering intact. Keeping every
 * suspect's braces always does: the other containers sit between text that
 * renders nothing, which stays so however it is merged or trimmed.
 */
// The most suspects of one stretch settled one at a time; beyond that they all keep their braces.
const MAX_SUSPECTS_SETTLED = 16;

function containerSearch(containers: readonly Container[]): ContainerSearch {
  let droppable: ReadonlySet<Container> = new Set();
  /** Per stretch that rendered differently: its suspects still to settle, the first being tried. */
  const pending = new Map<number, Container[]>();

  const advance = (container: Container): boolean => {
    if (container.mode === "keep") return false;
    container.mode = container.mode === "drop" && container.spaceRange !== undefined ? "space" : "keep";
    return true;
  };

  return {
    get droppable() {
      return droppable;
    },
    track(now) {
      // Protection only ever takes comments out of the removal, so the set
      // only shrinks and its size tells whether it changed.
      if (now.size === droppable.size) return;
      droppable = now;
      pending.clear();
      for (const container of containers) container.mode = "drop";
    },
    adjust(changed) {
      let adjusted = false;
      for (const segment of changed) {
        let queue = pending.get(segment);
        if (queue === undefined) {
          // The stretch's first difference: from now on its suspects are
          // settled one at a time, the first trying to drop its braces while
          // the rest keep theirs. Every try costs a parse, so a stretch with
          // a great many of them keeps all their braces straight away.
          queue = containers.filter((c) => c.segment === segment && c.suspect && droppable.has(c));
          const giveUp = queue.length > MAX_SUSPECTS_SETTLED;
          for (const container of giveUp ? queue : queue.slice(1)) container.mode = "keep";
          pending.set(segment, giveUp ? [] : queue);
          if (giveUp || queue.length > 1) {
            adjusted = true;
            continue;
          }
        }
        // The container being tried still changes the rendering: it tries
        // the next mode. Keeping its braces cannot fail, so running out of
        // modes (or of suspects to blame) means the output is not trustworthy.
        const current = queue[0];
        if (current === undefined || !advance(current)) throw unexpectedResult();
        adjusted = true;
      }
      for (const [segment, queue] of pending) {
        if (changed.has(segment) || queue.length === 0) continue;
        // The stretch renders as before: the container being tried is
        // settled, and the next suspect tries dropping its braces.
        queue.shift();
        const next = queue[0];
        if (next !== undefined) {
          next.mode = "drop";
          adjusted = true;
        }
      }
      return adjusted;
    },
  };
}

interface ShieldContext {
  /** The comment-only JSX container each comment in one sits in. */
  containerOf: ReadonlyMap<Comment, Container>;
  /** Comments and the containers that may go with theirs, sorted: what code starts after. */
  skippable: readonly Range[];
}

interface Shielding {
  removed: Comment[];
  /** Lines (1-based) that a surviving next-line directive reaches. */
  lines: Set<number>;
}

/**
 * What deleting part of the removal takes out of the source: a single
 * comment, or a comment-only JSX container going braces and all.
 */
interface RemovalUnit extends Range {
  comments: readonly Comment[];
  container?: Container;
}

/**
 * Re-protects comments whose removal would delete a physical line sitting
 * under a surviving next-line directive (`@ts-expect-error`,
 * `eslint-disable-next-line`, ...). Dropping such a line would shift the
 * following code up, silently changing which line the directive applies to —
 * and with it the compiler or linter behaviour. Directives whose tools reach
 * further get more: below a tsc suppression the first line each compiler
 * cannot step over stays, between a directive that only counts as the
 * last comment before its target (`@deno-types`, ...) and that target every
 * comment stays, and a JSX comment container right after a directive in a
 * container (`{/* prettier-ignore *​/}`, which applies to the next sibling)
 * stays too.
 *
 * The line checks work on whole lines, not single comments: a line holding
 * several removable comments (`/* one *​/ /* two *​/`) vanishes just the same,
 * so every comment on it has to stay — and a comment-only JSX container takes
 * its braces along. Runs to a fixpoint because a re-protected comment can
 * itself be a next-line directive shielding further lines (when directives
 * are being removed selectively).
 */
function shieldNextLineDirectives(
  source: string,
  removed: Comment[],
  kept: Comment[],
  skipped: Comment[],
  context: ShieldContext,
): Shielding {
  const lineOffsets = lineStartOffsets(source);
  const totalLines = lineOffsets.length;
  const shieldedLines = new Set<number>();
  const blockingLines = new Set<number>();
  const shieldedGaps: Array<readonly [number, number]> = [];
  const siblingTargets = new Set<Container>();
  const processed = new Set<Comment>();
  let stillRemoved = removed;
  let units: RemovalUnit[] | undefined;
  const currentUnits = (): RemovalUnit[] => (units ??= removalUnits(stillRemoved, context.containerOf));

  const collectShields = (): boolean => {
    let added = false;
    for (const comment of [...kept, ...skipped]) {
      if (processed.has(comment)) continue;
      processed.add(comment);
      const directive = comment.directive;
      if (directive === undefined) continue;
      if (LAST_COMMENT_DIRECTIVES.has(directive)) {
        const codeStart = codeStartAfter(source, comment.end, context.skippable);
        if (codeStart > comment.end && codeStart < source.length) {
          shieldedGaps.push([comment.end, codeStart]);
          added = true;
        }
        continue;
      }
      if (TSC_SUPPRESSIONS.has(directive)) {
        for (const line of firstBlockingLines(source, comment, lineOffsets, context.skippable)) {
          if (blockingLines.has(line)) continue;
          blockingLines.add(line);
          added = true;
        }
      }
      if (!isNextLineDirective(directive)) continue;
      // In JSX, such a directive in braces applies to the sibling after it,
      // whatever line that is on (prettier leaves the element after
      // `{/* prettier-ignore */}` as is): a comment-only container standing
      // between them has to stay. Range and file pragmas target no sibling.
      const holder = context.containerOf.get(comment);
      if (holder?.next !== undefined && !siblingTargets.has(holder.next)) {
        siblingTargets.add(holder.next);
        added = true;
      }
      // A trailing formatter or scanner suppression (`a = [1]; // oxfmt-ignore`,
      // `secret(); // nosemgrep`) targets its own line, so it shields nothing
      // below it. In JSX, the container holding the comment is what has to
      // stand on lines of its own.
      if (TRAILING_TARGETS_OWN_LINE.has(directive) && !occupiesWholeLines(source, holder ?? comment)) {
        continue;
      }
      // Counted pragmas like `c8 ignore next 3` cover several lines.
      for (let offset = 1; offset <= shieldedLineCount(comment); offset += 1) {
        const line = comment.endLine + offset;
        if (line > totalLines) break;
        if (!shieldedLines.has(line)) {
          shieldedLines.add(line);
          added = true;
        }
      }
    }
    return added;
  };

  const protect = (group: readonly Comment[]): void => {
    const grouped = new Set(group);
    stillRemoved = stillRemoved.filter((comment) => !grouped.has(comment));
    kept.push(...group);
    units = undefined;
  };

  const protectShields = (): boolean => {
    let changed = false;
    for (const line of shieldedLines) {
      const group = vanishingLineGroup(source, line, lineOffsets, currentUnits());
      if (group === undefined) continue;
      protect(group);
      changed = true;
    }
    for (const line of blockingLines) {
      const group = lineOpeningGroup(source, line, lineOffsets, currentUnits());
      if (group === undefined) continue;
      protect(group);
      changed = true;
    }
    for (const [from, to] of shieldedGaps) {
      const group = stillRemoved.filter((comment) => comment.start >= from && comment.start < to);
      if (group.length === 0) continue;
      protect(group);
      changed = true;
    }
    for (const target of siblingTargets) {
      const group = stillRemoved.filter((comment) => target.comments.includes(comment));
      if (group.length === 0) continue;
      protect(group);
      changed = true;
    }
    return changed;
  };

  collectShields();
  while (protectShields()) {
    if (!collectShields()) break;
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort(byStart);
  }
  return { removed: stillRemoved, lines: shieldedLines };
}

/**
 * The removals as the edits delete them: a comment-only container whose
 * comments all go — and that is to go braces and all — is one unit spanning
 * its braces, every other comment a unit of its own. Sorted, as the comments.
 */
function removalUnits(removals: readonly Comment[], containerOf: ReadonlyMap<Comment, Container>): RemovalUnit[] {
  const removing = new Set(removals);
  const units: RemovalUnit[] = [];
  for (const comment of removals) {
    const container = containerOf.get(comment);
    if (
      container === undefined ||
      container.mode !== "drop" ||
      !container.comments.every((inside) => removing.has(inside))
    ) {
      units.push({ start: comment.start, end: comment.end, comments: [comment] });
    } else if (units[units.length - 1]?.container !== container) {
      units.push({ start: container.start, end: container.end, comments: container.comments, container });
    }
  }
  return units;
}

/**
 * Offset of the first character at or after `from` that is neither
 * whitespace nor inside one of the (sorted, non-overlapping) ranges, or the
 * source length when only ranges follow. `from` lies past the start of at
 * least one range (the directive the search is for); when the closest of
 * them runs past `from` — a block comment opened on the directive's line —
 * the search resumes at its end.
 */
function codeStartAfter(source: string, from: number, ranges: readonly Range[]): number {
  let next = firstIndexAtOrAfter(ranges, from, (range) => range.start);
  let index = Math.max(from, (ranges[next - 1] as Range).end);
  while (index < source.length) {
    const range = ranges[next];
    if (range !== undefined && range.start === index) {
      index = range.end;
      next += 1;
    } else if (isBlank(source[index] as string)) {
      index += 1;
    } else {
      return index;
    }
  }
  return source.length;
}

/**
 * For each TypeScript compiler, the first line between a tsc suppression and
 * the code on the lines below it that the compiler does not step over, if
 * any. Looking for the line a suppression applies to, a compiler skips the
 * lines it reads as blank or as a `//` comment (see TSC_PASSABLE_LINES); any
 * other line — one opening with a block comment, say — ends the search,
 * leaving the suppression without a target for that compiler. Deleting that
 * line would let the suppression reach the code instead, so it has to stay.
 * The two compilers can stop at different lines: a line holding only a
 * vertical tab stops tsc 7, while tsc 6 searches on to the next line it
 * cannot pass.
 */
function firstBlockingLines(
  source: string,
  comment: Comment,
  lineOffsets: readonly number[],
  ranges: readonly Range[],
): number[] {
  // A suppression applies from the line below it on, so code sharing its line
  // (`/* @ts-ignore */ foo();`) does not end the search.
  const codeStart = codeStartAfter(source, lineOffsets[comment.endLine] ?? source.length, ranges);
  if (codeStart >= source.length) return [];
  const codeLine = firstIndexAtOrAfter(lineOffsets, codeStart + 1, (offset) => offset);
  const found: number[] = [];
  for (const passable of TSC_PASSABLE_LINES) {
    for (let line = comment.endLine + 1; line < codeLine; line += 1) {
      if (!passable.test(source.slice(lineOffsets[line - 1], lineOffsets[line]))) {
        found.push(line);
        break;
      }
    }
  }
  return found;
}

/**
 * The removals on the given line when one of them opens it (holds its first
 * non-whitespace character), so that deleting them would change how the
 * line starts. Returns undefined when something that survives opens the line
 * instead, or nothing on it is to be removed.
 */
function lineOpeningGroup(
  source: string,
  line: number,
  lineOffsets: readonly number[],
  units: readonly RemovalUnit[],
): Comment[] | undefined {
  // A blocking line always lies above the code line, so the next offset exists.
  const lineStart = lineOffsets[line - 1] as number;
  const lineEnd = lineOffsets[line] as number;
  const group = units.filter((unit) => unit.start < lineEnd && unit.end > lineStart);
  let first = lineStart;
  while (first < lineEnd && isBlank(source[first] as string)) first += 1;
  return group.some((unit) => unit.start <= first && first < unit.end)
    ? group.flatMap((unit) => unit.comments)
    : undefined;
}

/**
 * The removals that would make the given line disappear: every
 * non-whitespace character of the line lies inside one of them, so deleting
 * them deletes the physical line. Returns undefined when the line survives
 * (it holds code, a kept comment, or nothing to remove at all).
 */
function vanishingLineGroup(
  source: string,
  line: number,
  lineOffsets: readonly number[],
  units: readonly RemovalUnit[],
): Comment[] | undefined {
  // collectShields never shields a line beyond the last one, so the offset exists.
  const lineStart = lineOffsets[line - 1] as number;
  const lineEnd = lineOffsets[line] ?? source.length;
  const group = units.filter((unit) => unit.start < lineEnd && unit.end > lineStart);
  if (group.length === 0) return undefined;
  for (let index = lineStart; index < lineEnd; index += 1) {
    if (isBlank(source[index] as string)) continue;
    if (!group.some((unit) => unit.start <= index && index < unit.end)) return undefined;
  }
  return group.flatMap((unit) => unit.comments);
}

// These suppressions only apply to the following node/line when they stand on
// their own line — trailing after code they target (at most) their own line.
// Other next-line directives (`@ts-ignore`, `no-dd-sa`, ...) target the next
// line even when they trail code.
const TRAILING_TARGETS_OWN_LINE = new Set([
  "prettier-ignore",
  "oxfmt-ignore",
  "dprint-ignore",
  "lgtm",
  "codeql",
  "skipcq",
  "nosemgrep",
]);

// The suppressions tsc looks past blank and `//` lines for (see
// firstBlockingLines). They stay next-line directives as well: Flow, which
// honours them in TypeScript files, applies them to the very next line.
const TSC_SUPPRESSIONS = new Set(["@ts-ignore", "@ts-expect-error"]);

// The lines each compiler steps over on its way up from a diagnostic to a
// suppression, matched against the whole line, line break included. tsc 6
// trims the line and accepts nothing or a `//` comment; tsc 7 accepts only
// spaces and tabs before the line break or the `//`.
const TSC_PASSABLE_LINES = [/^\s*(?:\/\/|$)/, /^[ \t]*(?:[\r\n]|\/\/)/];

// Directives that only count while no other comment sits between them and
// their target: deno_graph reads `@deno-types`/`@ts-types` from the last
// comment before an import, ts-prune and graphql-tag-pluck from the closest
// leading comment, and ESLint's no-fallthrough and default-case from the last
// comment before the next case or the closing brace. Deleting the comments in
// that gap would newly activate such a directive, so the whole gap is
// shielded — trailing comments in front of the code included. With no code
// left there is nothing to target, and the switch-clause comments are only
// detected in front of the `case`, `default` or `}` their rules read them
// before.
const LAST_COMMENT_DIRECTIVES = new Set([
  "@deno-types",
  "@ts-types",
  "ts-prune-ignore-next",
  "GraphQL",
  "fallthrough",
  "no-default",
]);

// Directives that target the line or node directly below them. File- and
// range-scoped pragmas (`c8 ignore start`, `istanbul ignore file`, ...) are
// absent: they do not target the following line, so they never shield it.
const NEXT_LINE_DIRECTIVES = new Set([
  "@ts-ignore",
  "@ts-expect-error",
  "biome-ignore",
  "deno-lint-ignore",
  "deno-fmt-ignore",
  "deno-coverage-ignore",
  "prettier-ignore",
  "oxfmt-ignore",
  "dprint-ignore",
  "rome-ignore",
  "istanbul-ignore",
  "istanbul-ignore-next",
  "istanbul-ignore-if",
  "istanbul-ignore-else",
  "c8-ignore",
  "c8-ignore-next",
  "c8-ignore-if",
  "c8-ignore-else",
  "v8-ignore",
  "v8-ignore-next",
  "v8-ignore-if",
  "v8-ignore-else",
  "node:coverage-ignore",
  // Directives that hang off the node or line directly below them: a
  // whole-line comment between them and their target would change what
  // they apply to, so the line below stays shielded.
  "million-ignore",
  "@million-skip",
  "@million-jsx-skip",
  "deepcode-ignore",
  "skipcq",
  "lgtm",
  "codeql",
  "nosemgrep",
  "no-dd-sa",
  "datadog-disable",
  "noinspection",
  "language-injection",
  "@next-codemod-error",
  "@next-codemod-ignore",
  "$FlowFixMe",
  "$FlowExpectedError",
  "$FlowIssue",
  "$FlowIgnore",
  "pragma-allowlist-nextline-secret",
  "cspell:disable-next",
  "HTML",
]);

function isNextLineDirective(name: string): boolean {
  return name.endsWith("-next-line") || NEXT_LINE_DIRECTIVES.has(name);
}

// The coverage pragmas that actually parse a line count after `ignore next`
// (c8 / v8-to-istanbul, Vitest's ast-v8-to-istanbul, and Node's test-runner
// coverage). Everything else — `@ts-expect-error`, `eslint-disable-next-line`
// and friends — covers exactly one line, no matter what prose like
// "we ignore next 3 legacy calls" appears in the reason text.
const COUNTED_NEXT_LINE = new Set(["istanbul-ignore-next", "c8-ignore-next", "v8-ignore-next", "node:coverage-ignore"]);

/** Number of following lines a next-line pragma covers (`c8 ignore next 3` → 3). */
function shieldedLineCount(comment: Comment): number {
  if (comment.directive === undefined || !COUNTED_NEXT_LINE.has(comment.directive)) return 1;
  const match = /\bignore\s+next\s+(\d+)\b/.exec(comment.text);
  return match ? Math.max(1, Number(match[1])) : 1;
}

/**
 * True when nothing but whitespace shares the range's first and last lines.
 * Lines are delimited by any ECMAScript line terminator, matching how the
 * scanner numbers them (a lone `\r`, U+2028 and U+2029 count too).
 */
function occupiesWholeLines(source: string, range: Range): boolean {
  for (let index = range.start - 1; index >= 0; index -= 1) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) break;
    if (!isBlank(char)) return false;
  }
  for (let index = range.end; index < source.length; index += 1) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) break;
    if (!isBlank(char)) return false;
  }
  return true;
}
