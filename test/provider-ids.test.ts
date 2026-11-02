import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "../src/types.js";

describe("provider ids", () => {
  it("are hyphenated lowercase so consumers can validate them", () => {
    for (const id of PROVIDER_IDS) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
