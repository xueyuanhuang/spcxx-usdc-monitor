# SPCXx Token Monitor

Live monitor for the BNB Chain SPCXx tokenized stock contract, with the completed Binance Wallet USDC subscription phase kept as an archive.

## What It Tracks

- SPCXx token contract: `0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28`
- Metric: `totalSupply()` on BNB Smart Chain
- Holder count and top holders: BscScan holder table snapshot, persisted to Supabase
- Backed inventory: balance held by known Backed/xStocks operational wallets
- Distributed supply: `totalSupply - Backed/xStocks operational wallet balances`
- Token trend: reads Supabase samples for normal page loads

## Subscription Archive

- Campaign contract: `0xE79feA13F06c919FEda975e418be66c10c8caE32`
- BSC USDC contract: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- Metric: `USDC.balanceOf(campaignContract)` on BNB Smart Chain
- Trend: reads Supabase samples for normal page loads
- Chain reconstruction: available through BSC USDC `Transfer` logs where the campaign contract is either sender or receiver
- Participant count: unique incoming `from` addresses in BSC USDC `Transfer` logs where the campaign contract is the receiver
- Participant trend: reconstructs the running unique incoming address count from campaign start to the latest block
- Fallback: if BSC log reconstruction fails during a persist/reconstruct request, the API returns Supabase historical samples instead of collapsing the charts to one current point
- Campaign intro post: <https://x.com/ai_yuanhuang/status/2064908389382263067?s=20>

The monitor does not estimate Binance account allocation, refunds, or off-chain distribution. It only reads public on-chain state and BscScan holder snapshots.

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
- `BSC_LOG_RPC_URLS`: comma-separated RPC endpoints for `eth_getLogs`
- `CAMPAIGN_START_BLOCK`: default `103507500`, one block before the first observed campaign USDC transfer
- `LOG_BLOCK_RANGE`: default `10000`
- `LOG_RANGE_BATCH_SIZE`: default `6`
- `HISTORY_POINT_LIMIT`: default `220`
- `TREND_CACHE_SECONDS`: default `60`
- `TREND_REFRESH_BLOCKS`: default `240`
- `SUPABASE_TABLE`
- `SUPABASE_TOKEN_TABLE`
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
/api/token?persist=1
```

The included Cloudflare Worker collector calls both URLs every minute, so Supabase keeps collecting samples even when nobody has the page open. `.github/workflows/collect.yml` remains as a backup collector for the archived USDC metric.

To backfill the full campaign history into Supabase, run:

```bash
npm run backfill:supabase
```

The backfill script reconstructs the activity from BSC USDC `Transfer` logs, converts it into minute-level samples, and upserts those samples by `sample_bucket`.

The collector worker is deployed from `wrangler.collector.toml` and runs this cron:

```text
* * * * *
```
