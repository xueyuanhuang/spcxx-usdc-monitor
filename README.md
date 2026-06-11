# SPCXx USDC Monitor

Live monitor for the BSC USDC balance staked into the Binance Wallet SPCXx campaign contract.

## What It Tracks

- Campaign contract: `0xE79feA13F06c919FEda975e418be66c10c8caE32`
- BSC USDC contract: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- Metric: `USDC.balanceOf(campaignContract)` on BNB Smart Chain
- Campaign intro post: <https://x.com/ai_yuanhuang/status/2064908389382263067?s=20>
- Follow updates: <https://twitter.com/intent/follow?screen_name=ai_yuanhuang>

The monitor does not estimate allocation, refunds, or final SPCXx distribution. It only reads public on-chain state.

## Run Locally

```bash
npm install
npm run dev
```

Open the local URL printed by Wrangler.

## Deploy

The repo includes `cloudflare-pages.github-actions.yml`, a GitHub Actions workflow template that deploys to Cloudflare Pages on every push to `main`.

To enable it, copy it to:

```text
.github/workflows/deploy.yml
```

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare Pages project name is:

```text
spcxx-usdc-monitor
```

## Optional Environment Variables

Set these in Cloudflare Pages if you want to override defaults:

- `BSC_RPC_URLS`: comma-separated RPC endpoints
- `CAMPAIGN_CONTRACT`
- `USDC_CONTRACT`
- `BSC_CHAIN_NAME`
- `SUPABASE_TABLE`
- `HISTORY_LIMIT`

## Supabase Storage

Create the table with:

```sql
\i supabase/schema.sql
```

Then set these Cloudflare Pages environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The API persists a row only when called with:

```text
/api/metrics?persist=1
```

The included `.github/workflows/collect.yml` calls that URL every five minutes, so Supabase keeps collecting samples even when nobody has the page open.
