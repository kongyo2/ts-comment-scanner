import { describe, it, expect } from "vitest";
import * as api from "./index.js";

describe("public API", () => {
  it("exposes the scanning and formatting functions", () => {
    expect(typeof api.scanComments).toBe("function");
    expect(typeof api.collectFiles).toBe("function");
    expect(typeof api.scanFile).toBe("function");
    expect(typeof api.scanPaths).toBe("function");
    expect(typeof api.formatText).toBe("function");
    expect(typeof api.formatJson).toBe("function");
  });

  it("scans a string end to end through the public entry", () => {
    expect(api.scanComments("// hi")).toHaveLength(1);
  });

  it("exposes the comment-removal functions", () => {
    expect(typeof api.stripComments).toBe("function");
    expect(typeof api.stripFile).toBe("function");
    expect(typeof api.stripPaths).toBe("function");
    expect(typeof api.formatStripSummary).toBe("function");
  });

  it("strips comments from a string through the public entry", () => {
    expect(api.stripComments("const x = 1; // hi")).toBe("const x = 1;");
  });
});
