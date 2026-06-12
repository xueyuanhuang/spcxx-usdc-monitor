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
  participant_count integer not null default 0,
  balance_raw text not null,
  rpc_url text,
  created_at timestamptz not null default now()
);

alter table public.spcxx_usdc_metrics
  add column if not exists participant_count integer not null default 0;

create index if not exists spcxx_usdc_metrics_checked_at_desc
  on public.spcxx_usdc_metrics (checked_at desc);

create table if not exists public.spcxx_usdc_participants (
  address text primary key,
  first_seen_at timestamptz,
  first_seen_block bigint not null,
  last_seen_at timestamptz,
  last_seen_block bigint not null,
  transfer_count integer not null default 0,
  total_in_raw text not null default '0',
  total_in_usdc numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists spcxx_usdc_participants_first_seen_at
  on public.spcxx_usdc_participants (first_seen_at asc);

create index if not exists spcxx_usdc_participants_total_in_usdc_desc
  on public.spcxx_usdc_participants (total_in_usdc desc);

alter table public.spcxx_usdc_metrics enable row level security;
alter table public.spcxx_usdc_participants enable row level security;

drop policy if exists "Allow public read access to SPCXx metrics"
  on public.spcxx_usdc_metrics;

create policy "Allow public read access to SPCXx metrics"
  on public.spcxx_usdc_metrics
  for select
  using (true);

drop policy if exists "Allow public read access to SPCXx participants"
  on public.spcxx_usdc_participants;

create policy "Allow public read access to SPCXx participants"
  on public.spcxx_usdc_participants
  for select
  using (true);

grant select on public.spcxx_usdc_metrics to anon, authenticated, service_role;
grant insert, update on public.spcxx_usdc_metrics to service_role;
grant usage, select on sequence public.spcxx_usdc_metrics_id_seq to service_role;

grant select on public.spcxx_usdc_participants to anon, authenticated, service_role;
grant insert, update on public.spcxx_usdc_participants to service_role;
