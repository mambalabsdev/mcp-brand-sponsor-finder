# Brand Sponsor Finder MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-brand-sponsor-finder)](https://smithery.ai/servers/mambabuilt/mcp-brand-sponsor-finder) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-brand-sponsor-finder/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-brand-sponsor-finder) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-brand-sponsor-finder%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-brand-sponsor-finder&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-brand-sponsor-finder)](https://www.npmjs.com/package/@mambalabsdev/mcp-brand-sponsor-finder) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-brand-sponsor-finder)](https://www.npmjs.com/package/@mambalabsdev/mcp-brand-sponsor-finder) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-brand-sponsor-finder)](https://github.com/mambalabsdev/mcp-brand-sponsor-finder/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-brand-sponsor-finder)

Find the brands that paid creators in a niche in the last 90 days, with the public evidence for each placement. One row per brand with a recency score, and one row per sighting with its evidence link, date, and promo code.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

- Reads public YouTube video descriptions (channel feeds, or your own YouTube Data API key), podcast show notes, newsletter issues, and event sponsor pages for sponsor lines, promo codes, and sponsor slots.
- Follows shortlinks and affiliate redirects to the brand's own domain, and merges every sighting into one row per brand domain.
- Checks the brands it found for open partnership job posts (Greenhouse, Lever, Ashby) and creator or affiliate program pages, which become the brand's public contact.
- Returns only sightings inside your date window, each with an evidence link. Instagram, TikTok, and the Meta Ad Library are not read.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-brand-sponsor-finder": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-brand-sponsor-finder"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `find_brand_sponsors` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "Find brands sponsoring health and fitness creators in the last 90 days."
- "Which brands paid beauty YouTubers this month? Brand rows only."
- "List coffee brands sponsoring podcasts and newsletters, with promo codes."

## Tool

`find_brand_sponsors`. One tool. Example arguments:

```json
{
  "niche": "health and fitness",
  "window_days": "90"
}
```

## Inputs

Every buyer facing input of the actor, unchanged. Omitted inputs take the actor's own defaults. Numbers and booleans are sent as strings.

| Input | Type | Description |
|---|---|---|
| `niche` | string | The audience niche, for example "health and fitness", "beauty and skincare", or "food and beverage". Searches for channels, shows, and newsletters use it, and every row carries it. These three niches also start from a list of sources Mamba Labs has read before (turn off with use_niche_presets) |
| `audience_keywords` | string | Optional. More search terms for the audience, one per line or separated by commas, for example "strength training". Each one widens the podcast, newsletter, and (with your key) YouTube channel search. Up to 20. A text field, so a Clay column maps straight in |
| `window_days` | string | Only sightings from the last N days. Whole number, default 90, at most 365. Sent as text so Clay works Default 90 |
| `sources` | string | Optional. Which sources to run, separated by commas, any of: youtube, podcast, event, newsletter, job_post, program. Empty runs all of them. job_post and program check the brands the other sources found |
| `seed_sources` | string | Optional. YouTube channel URLs or @handles, podcast RSS feed URLs, or newsletter URLs to read first, one per line or separated by commas. Each is read even beyond the per source limits |
| `event_calendar` | string | Optional. Events whose sponsor or partner page to read, as a JSON list of objects: [{"name": "...", "url": "sponsor page URL", "date": "YYYY-MM-DD", "city": "...", "audience": "...", "size": "..."}], or one sponsor page URL per line. url is needed; the rest is optional. A dated event inside the window gives dated rows; an undated or upcoming event gives undated rows |
| `use_niche_presets` | string | true or false, default true. For health and fitness, beauty and skincare, and food and beverage, also read the channels, shows, newsletters, and event pages Mamba Labs has read before Default true |
| `include_brands` | string | true or false, default true. One row per brand domain with sighting count, last seen date, sources, creators or events, contact, and recency score Default true |
| `include_sightings` | string | true or false, default true. One row per sighting with its evidence link, date, promo code, placement type, and pitch angle Default true |
| `max_channels` | string | YouTube channels read per run. Whole number, default 20, at most 100. Sent as text so Clay works Default 20 |
| `max_videos_per_channel` | string | Newest uploads read per channel (the public feed holds 15). Whole number, default 15, at most 50. Sent as text so Clay works Default 15 |
| `max_podcasts` | string | Podcast shows read per run. Whole number, default 15, at most 100. Sent as text so Clay works Default 15 |
| `max_episodes_per_podcast` | string | Newest episodes read per show. Whole number, default 8, at most 30. Sent as text so Clay works Default 8 |
| `max_newsletters` | string | Newsletters read per run. Whole number, default 8, at most 50. Sent as text so Clay works Default 8 |
| `max_issues_per_newsletter` | string | Newest issues read per newsletter. Whole number, default 8, at most 30. Sent as text so Clay works Default 8 |
| `max_brands_to_check` | string | Brands, most sighted first, whose job boards and program pages are checked. Whole number, default 25, at most 200. Sent as text so Clay works Default 25 |
| `max_charge_usd` | string | Optional. The run stops before it would charge more than this |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `brand-row`, one brand returned as a row: domain, sighting count, last seen date, sources, creators or events it paid, public contact, and recency score | $0.02 | $0.019 | $0.018 | $0.017 |
| `sighting-row`, one public placement returned as a row: brand, source, creator or event, date, evidence link, promo code, placement type, and pitch angle | $0.005 | $0.00475 | $0.0045 | $0.00425 |
| `apify-actor-start`, per run start | $0.002 | $0.002 | $0.002 | $0.002 |

Free rows: a run with no result writes one free row that says why, and a refused input writes one free row whose error_reason starts with input_invalid:.

## Your keys

No key is needed. Your own YouTube Data API key is optional: set YOUTUBE_API_KEY in this server's environment and it is passed to the actor as youtube_api_key, so the key never goes through the conversation. With it the actor searches YouTube for channels in the niche and reads up to 50 uploads per channel.

## Full actor documentation

[apify.com/mambalabs/brand-sponsor-finder](https://apify.com/mambalabs/brand-sponsor-finder)

## License

MIT. See [LICENSE](LICENSE).
