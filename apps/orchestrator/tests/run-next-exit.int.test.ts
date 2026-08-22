import { describe, it, expect, jest, beforeAll, afterAll } from "@jest/globals";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));

jest.setTimeout(30_000);

describe("run-next process exit lifecycle", () => {
  let server: Server;
  let baseUrl: string;
  let runsDir: string;
  let sawStreamRequest = false;
  let clientLeftBeforeServerEnd = false;

  const sendJson = (res: import("node:http").ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  beforeAll(async () => {
    runsDir = mkdtempSync(join(tmpdir(), "run-next-exit-"));
    // Pre-existing run namespace the launcher resumes.
    mkdirSync(join(runsDir, "exit-test-run"), { recursive: true });
    writeFileSync(
      join(runsDir, "exit-test-run", "run.json"),
      JSON.stringify({
        topic: "Exit Test Topic",
        pillar: "Psychology",
        projectId: "video-exit-1",
        createdAt: new Date().toISOString(),
        threadHistory: [],
      }),
    );

    server = createServer((req, res) => {
      req.resume(); // drain request bodies
      if (req.method === "POST" && req.url === "/assistants/search") {
        req.on("end", () =>
          sendJson(res, [{ graph_id: "agent", assistant_id: "ast-exit-test" }]),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/threads") {
        req.on("end", () => sendJson(res, { thread_id: "thread-exit-test" }));
        return;
      }
      if (
        req.method === "POST" &&
        req.url === "/threads/thread-exit-test/runs/stream"
      ) {
        sawStreamRequest = true;
        clientLeftBeforeServerEnd = false;
        res.on("close", () => {
          clientLeftBeforeServerEnd = true;
        });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              event: "values",
              data: { execution: { status: "complete" } },
            })}\n\n`,
          );
          // Deliberately never end the response: the stub server outlives
          // the launcher exactly like `pnpm dev` does.
        });
        return;
      }
      sendJson(res, {});
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.closeAllConnections();
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    rmSync(runsDir, { recursive: true, force: true });
    return closed;
  });

  it("child process exits on its own once the graph run completes while the server stays up", async () => {
    const child = spawn(
      process.execPath,
      [join(__dirname, "fixtures", "run-next-exit-child.mjs")],
      {
        env: {
          ...process.env,
          LANGGRAPH_URL: baseUrl,
          ARTIFACT_STORE_DIR: runsDir,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `run-next child did not exit within timeout — still alive while the stub server holds the SSE connection open.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }, 20_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(sawStreamRequest).toBe(true);
    expect(stdout).toContain("CHILD_DONE");
    expect(stderr).not.toContain("pipeline run failed");
    expect(exitCode).toBe(0);
    // The launcher hung up as soon as the terminal event was observed; the
    // stub server never ended the response itself.
    expect(clientLeftBeforeServerEnd).toBe(true);
  });
});
