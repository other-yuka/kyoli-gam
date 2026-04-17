import * as childProcess from "node:child_process";

export interface NodeTokenRequestOptions {
  body: string;
  contentType?: string;
  endpoint: string;
  executable: string;
  timeoutMs: number;
  userAgent?: string;
}

type NodeTokenRequestRunner = (options: NodeTokenRequestOptions) => Promise<string>;

function buildNodeTokenRequestScript(): string {
  return `
const https = require("node:https");
const endpoint = process.env.ANTHROPIC_REFRESH_ENDPOINT;
const contentType = process.env.ANTHROPIC_REFRESH_CONTENT_TYPE || "application/json";
const timeoutMs = Number(process.env.ANTHROPIC_REFRESH_TIMEOUT_MS || "30000");
const payload = process.env.ANTHROPIC_REFRESH_REQUEST_BODY || "";
const userAgent = process.env.ANTHROPIC_REFRESH_USER_AGENT;

function printSuccess(body) {
  console.log(JSON.stringify({ ok: true, body }));
}

function printFailure(error) {
  console.log(JSON.stringify({ ok: false, ...error }));
}

const request = https.request(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": contentType,
    Accept: "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...(userAgent ? { "User-Agent": userAgent } : {}),
  },
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    body += chunk;
  });
  response.on("end", () => {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      printFailure({ status, body });
      return;
    }

    printSuccess(body);
  });
});

request.setTimeout(timeoutMs, () => {
  request.destroy(new Error("Request timed out after " + timeoutMs + "ms"));
});

request.on("error", (error) => {
  printFailure({ error: error instanceof Error ? error.name + ": " + error.message : String(error) });
});

request.write(payload);
request.end();
`;
}

async function defaultRunNodeTokenRequest(options: NodeTokenRequestOptions): Promise<string> {
  const script = buildNodeTokenRequestScript();
  const contentType = options.contentType ?? "application/json";

  return await new Promise<string>((resolve, reject) => {
    childProcess.execFile(
      options.executable,
      ["-e", script],
      {
        timeout: options.timeoutMs + 1000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ANTHROPIC_REFRESH_CONTENT_TYPE: contentType,
          ANTHROPIC_REFRESH_ENDPOINT: options.endpoint,
          ANTHROPIC_REFRESH_REQUEST_BODY: options.body,
          ANTHROPIC_REFRESH_TIMEOUT_MS: String(options.timeoutMs),
          ANTHROPIC_REFRESH_USER_AGENT: options.userAgent ?? "",
        },
      },
      (error, stdout, stderr) => {
        const trimmedStdout = stdout.trim();

        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        if (!trimmedStdout) {
          reject(new Error("Empty response from Node refresh helper"));
          return;
        }

        resolve(trimmedStdout);
      },
    );
  });
}

let nodeTokenRequestRunner: NodeTokenRequestRunner = defaultRunNodeTokenRequest;

export async function runNodeTokenRequest(options: NodeTokenRequestOptions): Promise<string> {
  return await nodeTokenRequestRunner(options);
}

export function setNodeTokenRequestRunnerForTest(runner: NodeTokenRequestRunner | null): void {
  nodeTokenRequestRunner = runner ?? defaultRunNodeTokenRequest;
}
