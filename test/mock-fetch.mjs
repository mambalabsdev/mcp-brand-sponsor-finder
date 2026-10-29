// Test preload: replaces global fetch with a fake Apify API so the start and
// poll path runs offline. Every request is appended to MOCK_LOG, with the body
// of a run start. MOCK_MODE "fail" makes the run finish FAILED. MOCK_ROWS sets
// the dataset size (default 1); the items route honors offset and limit and
// sends the row count in X-Apify-Pagination-Total, as Apify does.
import { appendFileSync } from "node:fs";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method ?? "GET";
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${method} ${url}${opts.body ? " " + opts.body : ""}\n`);
  const u = String(url);
  if (method === "POST" && /\/v2\/acts\/[^/]+\/runs\?/.test(u)) {
    return json({ data: { id: "run1", status: "RUNNING", defaultDatasetId: "ds1" } }, 201);
  }
  if (u.includes("/v2/actor-runs/run1")) {
    const status = process.env.MOCK_MODE === "fail" ? "FAILED" : "SUCCEEDED";
    return json({ data: { id: "run1", status, defaultDatasetId: "ds1" } });
  }
  if (u.includes("/v2/datasets/ds1/items")) {
    const n = Number(process.env.MOCK_ROWS ?? 1);
    if (n === 1 && !process.env.MOCK_ROWS) return json([{ row_status: "ok", error_reason: null }], 200, { "x-apify-pagination-total": "1" });
    const q = new URL(u).searchParams;
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? n);
    const rows = Array.from({ length: n }, (_, i) => ({ row_index: i, row_status: "ok" })).slice(offset, offset + limit);
    // MOCK_STALE_TOTAL reports a lower row count, as Apify does just after a run ends.
    const reported = process.env.MOCK_STALE_TOTAL ?? String(n);
    return json(rows, 200, { "x-apify-pagination-total": reported });
  }
  return json({ error: { message: `unexpected request ${method} ${u}` } }, 500);
};
