import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const TOOL_NAME = "find_brand_sponsors";
const ACTOR_ID = "PPgK6xrgOmvL7Nrys";
const ARGS = {"niche": "health and fitness", "window_days": "90"};

// Call the tool over stdio against the built server with fetch replaced by a
// fake Apify API (test/mock-fetch.mjs). Returns the tools/call result and the
// list of requests the server made.
function callTool(mode, args = ARGS, rows, extraEnv = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "mcp-mock-")), "requests.log");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(join(here, "mock-fetch.mjs")).href, join(repo, "build", "index.js")],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, APIFY_TOKEN: "test-token", MOCK_LOG: log, MOCK_MODE: mode, ...(rows ? { MOCK_ROWS: String(rows) } : {}), ...extraEnv } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          // No log file means the server made no request at all.
          const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
          resolve({ result: msg.result, requests });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrapper-test", version: "0.0.0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME, arguments: args } }) + "\n");
  });
}

test("starts the run and polls it, never the run-sync endpoint", async () => {
  const { result, requests } = await callTool("ok");
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), [{ row_status: "ok", error_reason: null }]);
  assert.ok(requests[0].startsWith(`POST https://api.apify.com/v2/acts/${ACTOR_ID}/runs?`), requests[0]);
  assert.ok(requests.some((r) => r.includes("/v2/actor-runs/run1")), "never polled the run");
  assert.ok(requests.some((r) => r.includes("/v2/datasets/ds1/items")), "never read the dataset");
  assert.ok(!requests.some((r) => r.includes("run-sync")), "called a run-sync endpoint");
});

test("a run that does not succeed is an error naming the run", async () => {
  const { result } = await callTool("fail");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /run1/);
  assert.match(result.content[0].text, /FAILED/);
});

const paging = (result) => JSON.parse(result.content[1].text);

test("a call with defaults returns at most 50 rows and a cursor for the rest", async () => {
  const { result, requests } = await callTool("ok", ARGS, 634);
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.equal(JSON.parse(result.content[0].text).length, 50);
  const p = paging(result);
  assert.equal(p.total_rows, 634);
  assert.equal(p.rows_returned, 50);
  assert.ok(p.next_cursor);
  assert.equal(requests.filter((r) => r.startsWith("POST ")).length, 1);
  assert.ok(requests.some((r) => r.includes("/v2/datasets/ds1/items") && r.includes("offset=0") && r.includes("limit=50")));
});

test("max_rows and cursor are wrapper settings, never sent to the actor", async () => {
  const { requests } = await callTool("ok", { ...ARGS, max_rows: "10" }, 634);
  const start = requests.find((r) => r.startsWith("POST "));
  const body = JSON.parse(start.slice(start.indexOf(" {") + 1));
  assert.ok(!("max_rows" in body) && !("cursor" in body), start);
  assert.equal(body.niche, ARGS.niche);
});

test("max_rows is capped at 200 and a bad value is refused before any run", async () => {
  const big = await callTool("ok", { ...ARGS, max_rows: "5000" }, 634);
  assert.equal(JSON.parse(big.result.content[0].text).length, 200);
  const bad = await callTool("ok", { ...ARGS, max_rows: "ten" }, 634);
  assert.equal(bad.result.isError, true);
  assert.equal(bad.requests.length, 0);
});

test("paging with the cursor starts no run and returns every row exactly once", async () => {
  const first = await callTool("ok", { ...ARGS, max_rows: "200" }, 634);
  const seen = JSON.parse(first.result.content[0].text).map((r) => r.row_index);
  let cursor = paging(first.result).next_cursor;
  let calls = 0;
  while (cursor) {
    const page = await callTool("ok", { cursor, max_rows: "200" }, 634);
    assert.ok(!page.result.isError, page.result.content?.[0]?.text);
    assert.equal(page.requests.filter((r) => r.startsWith("POST ")).length, 0, "a cursor call started a run");
    assert.ok(!page.requests.some((r) => r.includes("/v2/actor-runs/") || r.includes("/v2/acts/")), "a cursor call touched the run");
    seen.push(...JSON.parse(page.result.content[0].text).map((r) => r.row_index));
    cursor = paging(page.result).next_cursor;
    calls += 1;
  }
  assert.equal(calls, 3);
  assert.equal(seen.length, 634);
  assert.equal(new Set(seen).size, 634);
});

test("a cursor this server did not issue is refused with no request", async () => {
  const { result, requests } = await callTool("ok", { cursor: "not-a-cursor" }, 634);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /next_cursor/);
  assert.equal(requests.length, 0);
});

test("a stale row count never ends paging early", async () => {
  const env = { MOCK_STALE_TOTAL: "100" };
  const first = await callTool("ok", { ...ARGS, max_rows: "100" }, 250, env);
  const seen = JSON.parse(first.result.content[0].text).map((r) => r.row_index);
  let cursor = paging(first.result).next_cursor;
  assert.ok(cursor, "a full page reported as the last one");
  while (cursor) {
    const page = await callTool("ok", { cursor, max_rows: "100" }, 250, env);
    seen.push(...JSON.parse(page.result.content[0].text).map((r) => r.row_index));
    cursor = paging(page.result).next_cursor;
  }
  assert.equal(new Set(seen).size, 250);
});
