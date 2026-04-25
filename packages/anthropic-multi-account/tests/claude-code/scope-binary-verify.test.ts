import { describe, expect, test } from "bun:test";
import { filterScopesByBinaryPresence } from "../../src/claude-code/oauth-config/detect";

const EXPECTED = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

describe("filterScopesByBinaryPresence", () => {
  test("returns all expected scopes when all quoted literals are present", () => {
    const buffer = Buffer.from('"org:create_api_key" "user:profile" "user:inference" "user:sessions:claude_code" "user:mcp_servers" "user:file_upload"');

    expect(filterScopesByBinaryPresence(buffer, EXPECTED)).toEqual(EXPECTED);
  });

  test("returns only the quoted subset that is present", () => {
    const buffer = Buffer.from('"org:create_api_key" "user:profile" "user:inference" "user:sessions:claude_code" "user:mcp_servers"');

    expect(filterScopesByBinaryPresence(buffer, EXPECTED)).toEqual(EXPECTED.slice(0, 5));
  });

  test("returns five scopes when org:create_api_key is missing", () => {
    const buffer = Buffer.from('"user:profile" "user:inference" "user:sessions:claude_code" "user:mcp_servers" "user:file_upload"');

    expect(filterScopesByBinaryPresence(buffer, EXPECTED)).toEqual(EXPECTED.slice(1));
  });

  test("returns an empty array when no expected scopes are present", () => {
    expect(filterScopesByBinaryPresence(Buffer.from("totally unrelated bytes"), EXPECTED)).toEqual([]);
  });

  test("does not false-positive on a bare substring without quotes", () => {
    expect(filterScopesByBinaryPresence(Buffer.from("user:profile without quotes"), ["user:profile"])).toEqual([]);
  });

  test("does not false-positive on single-quoted scope literals", () => {
    expect(filterScopesByBinaryPresence(Buffer.from("'user:profile'"), ["user:profile"])).toEqual([]);
  });

  test("returns an empty array for an empty expected list", () => {
    expect(filterScopesByBinaryPresence(Buffer.from('"user:profile"'), [])).toEqual([]);
  });
});
