#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. The suite's
// slowest measured run on 2026-09-22 was 152 s on a seven platform search, so
// 1800 s is roughly twelve times that: headroom for a slow day without letting a
// hung run bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-brand-sponsor-finder",
  version: pkg.version,
});

// Brand Sponsor Finder (immutable actor ID PPgK6xrgOmvL7Nrys). Every buyer facing input of the actor
// is exposed. The actor takes numbers and booleans as strings, so those inputs are strings here too.
server.registerTool(
  "find_brand_sponsors",
  {
    title: "Find brands paying creators in a niche, with evidence",
    description:
      "Find brands with recent public proof of paid placement in a niche. Give a niche (for example health and fitness, beauty and skincare, food and beverage) and optionally audience keywords, seed YouTube channels, podcast feeds, or newsletters, and event sponsor pages. The actor reads public YouTube descriptions, podcast show notes, newsletter issues, event sponsor pages, partnership job posts, and brand creator program pages, and returns one row per brand domain (sighting count, last seen date, sources, creators or events sponsored, public contact, recency score) and one row per sighting (brand, domain, source, creator or event, date, evidence link, promo code, placement type, pitch angle). Instagram, TikTok, and the Meta Ad Library are not read. Input with nothing to run returns one free row whose error_reason starts with input_invalid:. A run that does not succeed is returned as an error with its run ID. Read-only; requires an APIFY_TOKEN; Apify charges per brand row, per sighting row, and per run start.",
    annotations: {
      title: "Find brands paying creators in a niche, with evidence",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      niche: z.string().optional().describe("The audience niche, for example \"health and fitness\", \"beauty and skincare\", or \"food and beverage\". Searches for channels, shows, and newsletters use it, and every row carries it. These three niches also start from a list of sources Mamba Labs has read before (turn off with use_niche_presets)."),
      audience_keywords: z.string().optional().describe("Optional. More search terms for the audience, one per line or separated by commas, for example \"strength training\". Each one widens the podcast, newsletter, and (with your key) YouTube channel search. Up to 20. A text field, so a Clay column maps straight in."),
      window_days: z.string().optional().describe("Only sightings from the last N days. Whole number, default 90, at most 365. Sent as text so Clay works. Default 90."),
      sources: z.string().optional().describe("Optional. Which sources to run, separated by commas, any of: youtube, podcast, event, newsletter, job_post, program. Empty runs all of them. job_post and program check the brands the other sources found."),
      seed_sources: z.string().optional().describe("Optional. YouTube channel URLs or @handles, podcast RSS feed URLs, or newsletter URLs to read first, one per line or separated by commas. Each is read even beyond the per source limits."),
      event_calendar: z.string().optional().describe("Optional. Events whose sponsor or partner page to read, as a JSON list of objects: [{\"name\": \"...\", \"url\": \"sponsor page URL\", \"date\": \"YYYY-MM-DD\", \"city\": \"...\", \"audience\": \"...\", \"size\": \"...\"}], or one sponsor page URL per line. url is needed; the rest is optional. A dated event inside the window gives dated rows; an undated or upcoming event gives undated rows."),
      use_niche_presets: z.string().optional().describe("true or false, default true. For health and fitness, beauty and skincare, and food and beverage, also read the channels, shows, newsletters, and event pages Mamba Labs has read before. Default true."),
      include_brands: z.string().optional().describe("true or false, default true. One row per brand domain with sighting count, last seen date, sources, creators or events, contact, and recency score. Default true."),
      include_sightings: z.string().optional().describe("true or false, default true. One row per sighting with its evidence link, date, promo code, placement type, and pitch angle. Default true."),
      max_channels: z.string().optional().describe("YouTube channels read per run. Whole number, default 20, at most 100. Sent as text so Clay works. Default 20."),
      max_videos_per_channel: z.string().optional().describe("Newest uploads read per channel (the public feed holds 15). Whole number, default 15, at most 50. Sent as text so Clay works. Default 15."),
      max_podcasts: z.string().optional().describe("Podcast shows read per run. Whole number, default 15, at most 100. Sent as text so Clay works. Default 15."),
      max_episodes_per_podcast: z.string().optional().describe("Newest episodes read per show. Whole number, default 8, at most 30. Sent as text so Clay works. Default 8."),
      max_newsletters: z.string().optional().describe("Newsletters read per run. Whole number, default 8, at most 50. Sent as text so Clay works. Default 8."),
      max_issues_per_newsletter: z.string().optional().describe("Newest issues read per newsletter. Whole number, default 8, at most 30. Sent as text so Clay works. Default 8."),
      max_brands_to_check: z.string().optional().describe("Brands, most sighted first, whose job boards and program pages are checked. Whole number, default 25, at most 200. Sent as text so Clay works. Default 25."),
      max_charge_usd: z.string().optional().describe("Optional. The run stops before it would charge more than this."),
    },
  },
  // The buyer's own YouTube Data API key comes from this server's environment,
  // never from the conversation, and is passed to the actor as a secret input.
  async (args) => runActor("PPgK6xrgOmvL7Nrys", "Brand Sponsor Finder", compact({ ...(args as Record<string, unknown>), ...(process.env.YOUTUBE_API_KEY ? { youtube_api_key: process.env.YOUTUBE_API_KEY } : {}) })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
