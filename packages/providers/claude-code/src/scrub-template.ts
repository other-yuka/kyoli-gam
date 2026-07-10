interface ScrubTemplateOptions {
  dropMcpTools?: boolean;
}

interface TemplateToolLike {
  name: string;
  [key: string]: unknown;
}

interface TemplateLike {
  agent_identity: string;
  system_prompt: string;
  system_prompt_fable?: string;
  tools: TemplateToolLike[];
  tool_names: string[];
  header_order?: string[];
  header_values?: Record<string, string>;
}

const HOST_CONTEXT_SECTION_NAMES = new Set([
  "environment",
  "automemory",
  "claudemd",
  "useremail",
  "currentdate",
  "gitstatus",
  "language",
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
  {
    pattern: /([A-Za-z])--Users-[^\s\\`'")\]]+/g,
    replacement: "$1--Users-user-project",
  },
  {
    pattern: /(\/\.claude\/projects\/)-[A-Za-z0-9._-]+(?=\/|$)/g,
    replacement: "$1project",
  },
] as const;

const USER_PATH_HIT_PATTERNS = [
  /\/Users\/(?!user(?:\/|$))[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g,
  /\/home\/(?!user(?:\/|$))[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g,
  /[A-Za-z]:\\Users\\(?!user(?:\\|$))[A-Za-z0-9._-]+(?:\\[^\s"'`<>)]*)?/g,
  /[A-Za-z]--Users-(?!user-project\b)[^\s\\`'")\]]+/g,
  /\/\.claude\/projects\/-[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g,
] as const;

const GIT_METADATA_REPLACEMENTS = [
  {
    pattern: /^Current branch: .+$/gm,
    replacement: "Current branch: (dynamic)",
  },
  {
    pattern: /^Main branch \(you will usually use this for PRs\): .+$/gm,
    replacement: "Main branch (you will usually use this for PRs): (dynamic)",
  },
  {
    pattern: /^Git user: .+$/gm,
    replacement: "Git user: (dynamic)",
  },
] as const;

function normalizeSectionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanupRemovedSections(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let previousBlank = true;

  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) continue;
    cleaned.push(line);
    previousBlank = blank;
  }

  while (cleaned.length > 0 && cleaned[cleaned.length - 1]!.trim().length === 0) {
    cleaned.pop();
  }

  return cleaned.join("\n");
}

function removeDynamicStatusBlock(text: string): string {
  const statusStart = "\n\nStatus:\n";
  const recentStart = "\n\nRecent commits:\n";
  let scrubbed = text;
  let searchFrom = 0;

  while (true) {
    const start = scrubbed.indexOf(statusStart, searchFrom);
    if (start === -1) return scrubbed;

    const contentStart = start + statusStart.length;
    const end = scrubbed.indexOf(recentStart, contentStart);
    if (end === -1) return scrubbed;

    scrubbed = `${scrubbed.slice(0, contentStart)}(dynamic)${scrubbed.slice(end)}`;
    searchFrom = contentStart + "(dynamic)".length + recentStart.length;
  }
}

function removeDynamicRecentCommits(text: string): string {
  return text.replace(
    /(\n\nRecent commits:\n)(?:[0-9a-f]{7,}\s.*\n?)+/g,
    "$1(dynamic)\n",
  );
}

function removeDynamicGitMetadata(text: string): string {
  let scrubbed = text;

  for (const { pattern, replacement } of GIT_METADATA_REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }

  return scrubbed;
}

export function scrubText(text: string): string {
  let scrubbed = text;

  for (const { pattern, replacement } of USER_PATH_REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }

  return removeDynamicGitMetadata(scrubbed);
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
    const headingMatch = parseMarkdownHeading(line);

    if (headingMatch) {
      const headingDepth = headingMatch.depth;
      const sectionName = normalizeSectionName(headingMatch.title);
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

  return cleanupRemovedSections(removeDynamicGitMetadata(removeDynamicRecentCommits(removeDynamicStatusBlock(keptLines.join("\n")))));
}

export function scrubSystemPrompt(systemPrompt: string): string {
  return scrubText(removeHostContextSections(systemPrompt));
}

function parseMarkdownHeading(line: string): { depth: number; title: string } | null {
  const trimmedStart = line.trimStart();
  if (line.length - trimmedStart.length > 3 || !trimmedStart.startsWith("#")) {
    return null;
  }

  let depth = 0;
  while (depth < trimmedStart.length && trimmedStart[depth] === "#") {
    depth += 1;
  }

  if (depth < 1 || depth > 6 || trimmedStart[depth] !== " ") {
    return null;
  }

  const title = trimmedStart.slice(depth + 1).trim();
  return title ? { depth, title } : null;
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

export function scrubTemplate<T extends TemplateLike>(data: T, options?: ScrubTemplateOptions): T {
  const systemPrompt = scrubSystemPrompt(data.system_prompt);
  const dropMcpTools = options?.dropMcpTools ?? true;
  const tools = data.tools
    .filter((tool) => !dropMcpTools || !tool.name.startsWith("mcp__"))
    .map((tool) => scrubObjectStrings(tool) as T["tools"][number]);

  return {
    ...data,
    agent_identity: scrubText(data.agent_identity),
    system_prompt: systemPrompt,
    ...(typeof data.system_prompt_fable === "string"
      ? { system_prompt_fable: scrubSystemPrompt(data.system_prompt_fable) }
      : {}),
    tools,
    tool_names: tools.map((tool) => tool.name),
    header_order: data.header_order ? [...data.header_order] : undefined,
    header_values: data.header_values
      ? scrubObjectStrings(data.header_values) as Record<string, string>
      : undefined,
  } as T;
}
