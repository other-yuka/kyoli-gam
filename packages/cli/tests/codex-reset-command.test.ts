import { describe, expect, it } from "vitest";
import {
  requiresCodexResetConsumeConfirmation,
  shouldEmitJsonConfirmationRequired,
} from "../src/codex-reset-command";

describe("codex reset command helpers", () => {
  it("requires --yes for JSON consume mode instead of prompting", () => {
    const argv = ["kyoli", "codex-reset", "consume", "acct_123", "--json"];

    expect(requiresCodexResetConsumeConfirmation(argv)).toBe(true);
    expect(shouldEmitJsonConfirmationRequired(argv)).toBe(true);
  });

  it("allows non-interactive JSON consume when --yes or --dry-run is present", () => {
    expect(shouldEmitJsonConfirmationRequired([
      "kyoli",
      "codex-reset",
      "consume",
      "acct_123",
      "--json",
      "--yes",
    ])).toBe(false);
    expect(shouldEmitJsonConfirmationRequired([
      "kyoli",
      "codex-reset",
      "consume",
      "acct_123",
      "--json",
      "--dry-run",
    ])).toBe(false);
  });
});
