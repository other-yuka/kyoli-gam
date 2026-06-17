export function requiresCodexResetConsumeConfirmation(argv: string[]): boolean {
  return !argv.includes("--dry-run") && !argv.includes("--yes") && !argv.includes("-y");
}

export function shouldEmitJsonConfirmationRequired(argv: string[]): boolean {
  return argv.includes("--json") && requiresCodexResetConsumeConfirmation(argv);
}
