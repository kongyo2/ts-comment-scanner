import v8ToIstanbul from "v8-to-istanbul";

/**
 * The rows (1-based) of the source that c8 leaves out of its report: the ones
 * v8-to-istanbul, the converter c8 reports with, marks as ignored. Every row
 * is given as never run, so the only rows that come out covered are the
 * ignored ones.
 */
export async function ignoredByC8(source: string): Promise<number[]> {
  const converter = v8ToIstanbul("/main.js", 0, { source });
  await converter.load();
  converter.applyCoverage([
    { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] },
  ]);
  const [file] = Object.values(converter.toIstanbul());
  return Object.entries(file?.s ?? {})
    .filter(([, count]) => count > 0)
    .map(([row]) => Number(row) + 1);
}
