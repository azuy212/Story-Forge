#!/usr/bin/env node
// Lower-level Google network diagnostic.
//
// Verifies DNS → IPv4 TCP → HTTPS → fetch() after network-runtime init.
// HTTP 404 from GET https://oauth2.googleapis.com/token is success (the
// endpoint requires POST); only DNS/TCP/TLS/connect failures are errors.
//
// Usage (from repo root or apps/orchestrator):
//   pnpm exec node apps/orchestrator/scripts/test-google-network.mjs

import "../src/runtime/network.mjs";

import dns from "node:dns/promises";
import net from "node:net";
import { request as httpsRequest } from "node:https";
import { getNetworkRuntimeState } from "../src/runtime/network.mjs";

const HOST = "oauth2.googleapis.com";
const PORT = 443;
const URL = "https://oauth2.googleapis.com/token";

function section(title) {
  console.log(title);
  console.log("-".repeat(title.length));
}

function printRuntime() {
  const s = getNetworkRuntimeState();
  console.log(`DNS result order: ${s.dnsResultOrder}`);
  console.log(`Auto-select family: ${s.autoSelectFamily}`);
}

async function testDns() {
  try {
    const records = await dns.lookup(HOST, { all: true });
    const v4 = records.filter((r) => r.family === 4);
    const v6 = records.filter((r) => r.family === 6);
    console.log(`DNS lookup: OK (${v4.length} A, ${v6.length} AAAA)`);
    if (v4.length === 0) {
      throw Object.assign(new Error(`no A records for ${HOST}`), {
        stage: "DNS failure",
      });
    }
    console.log(`IPv4 address: ${v4[0].address}`);
    return v4[0].address;
  } catch (err) {
    throw Object.assign(err, { stage: "DNS failure" });
  }
}

async function testTcp(address) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: address,
      port: PORT,
      family: 4,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        Object.assign(new Error("TCP connect timed out"), {
          stage: "TCP failure",
        }),
      );
    }, 10_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(
        Object.assign(err, {
          stage: err.code === "ENOTFOUND" ? "DNS failure" : "TCP failure",
        }),
      );
    });
  });
  console.log("IPv4 connectivity: OK");
}

function testHttps() {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: HOST,
        port: PORT,
        path: "/token",
        method: "GET",
        family: 4,
        timeout: 15_000,
        headers: { Host: HOST },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          // 404 (or any HTTP response) means TLS+HTTP reached Google.
          if (status >= 200 && status < 500) {
            console.log(`HTTPS connectivity: OK (HTTP ${status})`);
            resolve(status);
            return;
          }
          reject(
            Object.assign(new Error(`unexpected HTTP ${status}: ${body}`), {
              stage: "HTTP failure",
              statusCode: status,
            }),
          );
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        Object.assign(new Error("HTTPS request timed out"), {
          stage: "TLS failure",
        }),
      );
    });
    req.on("error", (err) => {
      reject(
        Object.assign(err, {
          stage:
            err.code === "ENOTFOUND"
              ? "DNS failure"
              : err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT"
                ? "TCP failure"
                : err.code === "CERT" || err.code === "ERR_TLS"
                  ? "TLS failure"
                  : "TLS failure",
        }),
      );
    });
    req.end();
  });
}

async function testFetch() {
  try {
    // Normal Node fetch after network init — this is the path that was
    // failing with bare ETIMEDOUT before setDefaultAutoSelectFamily(false).
    const res = await fetch(URL, { method: "GET" });
    console.log(`fetch() connectivity: OK (HTTP ${res.status})`);
    return res.status;
  } catch (err) {
    throw Object.assign(err, {
      stage: err?.cause?.code === "ENOTFOUND" ? "DNS failure" : "TCP failure",
    });
  }
}

async function main() {
  section("Google network diagnostic");
  printRuntime();
  console.log("");

  try {
    const address = await testDns();
    await testTcp(address);
    await testHttps();
    await testFetch();
    console.log("\nAll network checks passed.");
  } catch (err) {
    console.error(`\n${err.stage ?? "failure"}: ${err.message}`);
    if (err.code) console.error(`Error code: ${err.code}`);
    if (err.cause) {
      const cause = err.cause;
      console.error(`Cause: ${cause.code ?? cause.message ?? String(cause)}`);
    }
    process.exitCode = 1;
  }
}

main();
