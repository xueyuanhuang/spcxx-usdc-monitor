create table if not exists public.spcxx_usdc_metrics (
  id bigserial primary key,
  sample_bucket timestamptz not null unique,
  checked_at timestamptz not null,
  chain text not null default 'BNB Smart Chain',
  block_number bigint not null,
  campaign_contract text not null,
  usdc_contract text not null,
  implementation text,
  paused boolean not null default false,
  staked_usdc numeric not null,
  balance_raw text not null,
  rpc_url text,
  created_at timestamptz not null default now()
);

create index if not exists spcxx_usdc_metrics_checked_at_desc
  on public.spcxx_usdc_metrics (checked_at desc);

alter table public.spcxx_usdc_metrics enable row level security;

create policy "Allow public read access to SPCXx metrics"
  on public.spcxx_usdc_metrics
  for select
  using (true);
