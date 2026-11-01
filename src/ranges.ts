/** A span of a source string: `start` inclusive, `end` exclusive. */
export interface Range {
  start: number;
  end: number;
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
