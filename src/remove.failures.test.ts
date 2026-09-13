import { describe, it, expect, vi } from "vitest";
import { scanComments } from "./scanner.js";
import { removeComments } from "./remove.js";
import type { Comment } from "./types.js";

// The post-removal verification cannot fail through the public API (that is
// the point of it), so the re-scan is tampered with to prove the guard holds.
vi.mock("./scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scanner.js")>();
  return { ...actual, scanComments: vi.fn(actual.scanComments) };
});

describe("removeComments result verification", () => {
  it("throws instead of returning output whose comments do not match the kept set", async () => {
    const { scanComments: realScan } = await vi.importActual<typeof import("./scanner.js")>("./scanner.js");
    const ghost: Comment = {
      kind: "line",
      text: "// ghost",
      start: 0,
      end: 8,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 9,
    };
    vi.mocked(scanComments)
      .mockImplementationOnce(realScan)
      .mockImplementationOnce(() => [ghost]);

    expect(() => removeComments("// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });

  it("throws when a surviving comment's text does not match the kept one", async () => {
    const { scanComments: realScan } = await vi.importActual<typeof import("./scanner.js")>("./scanner.js");
    vi.mocked(scanComments)
      .mockImplementationOnce(realScan)
      .mockImplementationOnce((code, options) =>
        realScan(code, options).map((comment) => ({ ...comment, text: "// tampered" })),
      );

    expect(() => removeComments("// @ts-nocheck\n// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });

  it("throws when a directive changes with no removal before it to re-protect", async () => {
    // Cannot happen through the public API: a surviving comment's placement
    // only changes when a removal preceded it. Tampering with the re-scan
    // proves the guard fails closed instead of looping or returning output
    // with altered semantics.
    const { scanComments: realScan } = await vi.importActual<typeof import("./scanner.js")>("./scanner.js");
    vi.mocked(scanComments)
      .mockImplementationOnce(realScan)
      .mockImplementationOnce((code, options) =>
        realScan(code, options).map((comment) => ({ ...comment, directive: "@ts-check" })),
      );

    expect(() => removeComments("// @ts-nocheck\n// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });

  it("throws when a knip tag goes live with no removal after it to re-protect", async () => {
    // Also impossible through the public API: knip's reach only opens when a
    // block comment after the survivor was removed. The re-scan is tampered
    // to report the survivor as ending past the wall it is skipped by.
    const { scanComments: realScan } = await vi.importActual<typeof import("./scanner.js")>("./scanner.js");
    vi.mocked(scanComments)
      .mockImplementationOnce(realScan)
      .mockImplementationOnce((code, options) =>
        realScan(code, options).map((comment) =>
          comment.text === "/** @license @public */" ? { ...comment, end: code.indexOf("export") } : comment,
        ),
      );

    expect(() =>
      removeComments("// gone\n/** @license @public */ /* wall */ export const a = 1;\n", {
        shouldRemove: (comment) => comment.text !== "/* wall */",
      }),
    ).toThrow(/unexpected result/);
  });
});
