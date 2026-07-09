import fingerprintData from "./fingerprint/data.json";

export interface ClaudeCodeFingerprintData {
  _version: number;
  _schemaVersion?: number;
  _captured: string;
  _source: string;
  agent_identity: string;
  system_prompt: string;
  system_prompt_fable?: string;
  tools: Array<{ name: string; [key: string]: unknown }>;
  tool_names: string[];
  anthropic_beta?: string;
  cc_version: string;
  header_order?: string[];
  header_values?: Record<string, string>;
  body_field_order?: string[];
}

export const claudeCodeFingerprintData = fingerprintData as ClaudeCodeFingerprintData;

export default claudeCodeFingerprintData;
