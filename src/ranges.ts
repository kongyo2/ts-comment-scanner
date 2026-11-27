/** A span of a source string: `start` inclusive, `end` exclusive. */
export interface Range {
  start: number;
  end: number;
}

/** Sort comparator for document order: ranges are ordered by where they start. */
export function byStart(a: Range, b: Range): number {
  return a.start - b.start;
}

/** Index of the first item whose key is at least `value`, by binary search over ascending keys. */
export function firstIndexAtOrAfter<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (key(items[middle] as T) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The range among sorted, non-overlapping ones that contains the offset, if any. */
export function rangeAt<T extends Range>(ranges: readonly T[], offset: number): T | undefined {
  const range = ranges[firstIndexAtOrAfter(ranges, offset + 1, (candidate) => candidate.start) - 1];
  return range !== undefined && offset < range.end ? range : undefined;
}

/**
 * The ranges among sorted, non-overlapping ones that lie within the span.
 * Their ends ascend as their starts do, so they are the ones from the first
 * starting at or after the span's start up to the first ending past its end.
 */
export function rangesWithin<T extends Range>(ranges: readonly T[], span: Range): T[] {
  return ranges.slice(
    firstIndexAtOrAfter(ranges, span.start, (range) => range.start),
    firstIndexAtOrAfter(ranges, span.end + 1, (range) => range.end),
  );
}

/**
 * The stretches of the span that lie outside the sorted, non-overlapping
 * ranges within it, in order: one in front of each range, and one behind
 * the last.
 */
export function gapsWithin(ranges: readonly Range[], span: Range): Range[] {
  const gaps: Range[] = [];
  let start = span.start;
  for (const range of rangesWithin(ranges, span)) {
    gaps.push({ start, end: range.start });
    start = range.end;
  }
  gaps.push({ start, end: span.end });
  return gaps;
}
