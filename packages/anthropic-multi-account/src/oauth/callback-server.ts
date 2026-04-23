import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const DEFAULT_TIMEOUT_MS = 300_000;
const SUCCESS_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/success?app=claude-code";

interface CallbackServerOptions {
  expectedState: string;
  timeoutMs?: number;
}

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServer {
  port: number;
  waitForCode: Promise<CallbackResult>;
  stop: () => void;
}

export function startCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackServer> {
  const { expectedState, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let settled = false;
    let resolveCode: ((result: CallbackResult) => void) | null = null;
    let rejectCode: ((reason: Error) => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const waitForCode = new Promise<CallbackResult>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    function settle(error: Error | null, result?: CallbackResult): void {
      if (settled) return;
      settled = true;

      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      if (error) {
        rejectCode?.(error);
      } else if (result) {
        resolveCode?.(result);
      }

      resolveCode = null;
      rejectCode = null;

      server.close();
    }

    function stop(): void {
      settle(new Error("OAuth callback server stopped"));
    }

    function sendResponse(
      res: ServerResponse,
      status: number,
      headers: Record<string, string>,
      body: string | undefined,
      onFinish: () => void,
    ): void {
      res.writeHead(status, { ...headers, Connection: "close" });
      res.end(body ?? "", onFinish);
    }

    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost`);

        if (url.pathname !== "/callback") {
          res.writeHead(404, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end("Not Found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (state !== expectedState) {
          sendResponse(
            res,
            400,
            { "Content-Type": "text/plain" },
            "State mismatch",
            () => settle(new Error("OAuth callback state mismatch")),
          );
          return;
        }

        if (!code) {
          sendResponse(
            res,
            400,
            { "Content-Type": "text/plain" },
            "Missing code",
            () => settle(new Error("OAuth callback missing code")),
          );
          return;
        }

        sendResponse(res, 302, { Location: SUCCESS_REDIRECT_URL }, undefined, () =>
          settle(null, { code, state }),
        );
      },
    );

    server.listen(0, "localhost", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;

      timeoutHandle = setTimeout(() => {
        settle(new Error("OAuth callback timed out"));
      }, timeoutMs);

      resolveServer({ port, waitForCode, stop });
    });

    server.on("error", (err: Error) => {
      if (!settled) {
        rejectServer(err);
      }
    });
  });
}
