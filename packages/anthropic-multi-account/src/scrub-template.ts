import type { TemplateData } from "./fingerprint-capture";

interface ScrubTemplateOptions {
  dropMcpTools?: boolean;
}

const HOST_CONTEXT_SECTION_NAMES = new Set([
  "environment",
  "automemory",
  "claudemd",
  "useremail",
  "currentdate",
  "gitstatus",
]);

const USER_PATH_REPLACEMENTS = [
  {
    pattern: /\/Users\/(?!user(?:\/|$))[A-Za-z0-9._-]+/g,
    replacement: "/Users/user",
  },
  {
    pattern: /\/home\/(?!user(?:\/|$))[A-Za-z0-9._-]+/g,
    replacement: "/home/user",
  },
  {
    pattern: /([A-Za-z]:\\Users\\)(?!user(?:\\|$))[A-Za-z0-9._-]+/g,
    replacement: "$1user",
  },
] as const;

const USER_PATH_HIT_PATTERNS = [
  /\/Users\/(?!user(?:\/|$))[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g,
  /\/home\/(?!user(?:\/|$))[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g,
  /[A-Za-z]:\\Users\\(?!user(?:\\|$))[A-Za-z0-9._-]+(?:\\[^\s"'`<>)]*)?/g,
] as const;

function normalizeSectionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanupRemovedSections(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(?:\s*\n)+/, "")
    .replace(/(?:\n\s*)+$/, "");
}

export function scrubText(text: string): string {
  let scrubbed = text;

  for (const { pattern, replacement } of USER_PATH_REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }

  return scrubbed;
}

export function findUserPathHits(text: string): string[] {
  const hits = USER_PATH_HIT_PATTERNS.flatMap((pattern) => text.match(pattern) ?? []);
  return [...new Set(hits)];
}

export function removeHostContextSections(systemPrompt: string): string {
  const lines = systemPrompt.split("\n");
  const keptLines: string[] = [];
  let skippedHeadingDepth: number | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);

    if (headingMatch) {
      const headingMarks = line.match(/^\s{0,3}(#{1,6})\s+/)?.[1];
      const headingDepth = headingMarks?.length ?? 0;
      const sectionName = normalizeSectionName(headingMatch[1] ?? "");
      const startsSkippedSection = HOST_CONTEXT_SECTION_NAMES.has(sectionName);

      if (startsSkippedSection) {
        skippedHeadingDepth = headingDepth;
        continue;
      }

      if (skippedHeadingDepth !== null && headingDepth > skippedHeadingDepth) {
        continue;
      }

      skippedHeadingDepth = null;
      keptLines.push(line);
      continue;
    }

    if (skippedHeadingDepth !== null) {
      continue;
    }

    keptLines.push(line);
  }

  return cleanupRemovedSections(keptLines.join("\n"));
}

export function scrubObjectStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubObjectStrings(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubObjectStrings(entry)]),
    );
  }

  return value;
}

export function scrubTemplate(data: TemplateData, options?: ScrubTemplateOptions): TemplateData {
  const systemPrompt = scrubText(removeHostContextSections(data.system_prompt));
  const dropMcpTools = options?.dropMcpTools ?? true;
  const tools = data.tools
    .filter((tool) => !dropMcpTools || !tool.name.startsWith("mcp__"))
    .map((tool) => scrubObjectStrings(tool) as TemplateData["tools"][number]);

  return {
    ...data,
    agent_identity: scrubText(data.agent_identity),
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((tool) => tool.name),
    header_order: data.header_order ? [...data.header_order] : undefined,
    header_values: data.header_values
      ? scrubObjectStrings(data.header_values) as Record<string, string>
      : undefined,
  };
}
