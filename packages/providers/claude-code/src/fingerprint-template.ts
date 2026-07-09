import fingerprintData from "./fingerprint-data";

type TemplateTool = {
  name: string;
  [key: string]: unknown;
};

interface FingerprintTemplate {
  agent_identity?: string;
  anthropic_beta?: string;
  body_field_order?: string[];
  cc_version?: string;
  header_order?: string[];
  header_values?: Record<string, string>;
  system_prompt?: string;
  system_prompt_fable?: string;
  tool_names?: string[];
  tools: TemplateTool[];
}

const template = fingerprintData as FingerprintTemplate;
const toolNames = new Set(template.tools.map((tool) => tool.name));

export function getClaudeCodeTemplateTools(): TemplateTool[] {
  return template.tools.map((tool) => ({ ...tool }));
}

export function isClaudeCodeTemplateToolName(name: string): boolean {
  return toolNames.has(name);
}

export function getClaudeCodeTemplateMetadata(): {
  agentIdentity?: string;
  anthropicBeta?: string;
  bodyFieldOrder?: string[];
  ccVersion?: string;
  headerValues: Record<string, string>;
  headerOrder?: string[];
  systemPrompt?: string;
  systemPromptFable?: string;
  toolNames: string[];
} {
  return {
    agentIdentity: template.agent_identity,
    anthropicBeta: template.anthropic_beta,
    bodyFieldOrder: template.body_field_order ? [...template.body_field_order] : undefined,
    ccVersion: template.cc_version,
    headerValues: { ...template.header_values },
    headerOrder: template.header_order ? [...template.header_order] : undefined,
    systemPrompt: template.system_prompt,
    systemPromptFable: template.system_prompt_fable,
    toolNames: template.tool_names ? [...template.tool_names] : template.tools.map((tool) => tool.name),
  };
}
