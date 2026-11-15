-- Direto ao Osso — Cortes web (Supabase)
-- Apply in the SQL editor, or via setup_cloud.py when DB credentials are present.
-- No public access: RLS allows only authenticated users. The box worker uses the service role (bypasses RLS).
-- Nothing in these tables is published to social networks.

create extension if not exists pgcrypto;

-- ── jobs: a "Rodar esteira" request from the site ──────────────────────────
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  status        text not null default 'queued'
                  check (status in ('queued','running','done','error','cancelled')),
  url           text,
  storage_path  text,
  style         text not null default 'close',
  video_id      text,
  stages        jsonb not null default '{}'::jsonb,
  log_tail      text,
  note          text,
  source        text not null default 'url',
  requested_by  uuid
);

-- ── cuts: approval queue (previews live in Storage, not in this table) ─────
create table if not exists public.cuts (
  id              text primary key,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  source          text not null,
  tag             text not null default 'vod',
  video_id        text,
  cut_id          text,
  version         text,
  title           text,
  channel         text,
  hook            text,
  qc              jsonb,
  reason          text,
  live_timestamp  timestamptz,
  source_url      text,
  preview_path    text,
  cover_path      text,
  duration_s      numeric,
  mtime           timestamptz
);

-- ── decisions: approve / reject only. Never a publish flag. ────────────────
create table if not exists public.decisions (
  cut_id      text primary key references public.cuts(id) on delete cascade,
  decision    text not null check (decision in ('approved','rejected','pending')),
  at          timestamptz not null default now(),
  hook        text,
  version     text,
  source      text,
  tag         text,
  decided_by  uuid
);

-- ── lives_watchlist ────────────────────────────────────────────────────────
create table if not exists public.lives_watchlist (
  id            text primary key,
  name          text not null,
  platform      text not null default 'youtube',
  url           text not null,
  channel_id    text,
  handle        text,
  enabled       boolean not null default true,
  seed          boolean not null default false,
  verified      boolean not null default false,
  experimental  boolean not null default false,
  note          text,
  last_check    timestamptz,
  last_live     jsonb,
  last_error    text,
  added_at      timestamptz not null default now()
);

-- ── live_sessions (status only; the box does the recording) ────────────────
create table if not exists public.live_sessions (
  id            text primary key,
  channel_id    text,
  channel_name  text,
  platform      text,
  video_id      text,
  video_url     text,
  title         text,
  status        text,
  started_at    timestamptz,
  stopped_at    timestamptz,
  chunks        int not null default 0,
  moments       jsonb not null default '[]'::jsonb,
  cuts          jsonb not null default '[]'::jsonb,
  errors        jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

-- ── keywords: impact phrases used by live detection ────────────────────────
create table if not exists public.keywords (
  id          uuid primary key default gen_random_uuid(),
  word        text not null unique,
  created_at  timestamptz not null default now()
);

-- Live style / enabled flag (still a documented extra; tiny and useful)
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_jobs_updated on public.jobs;
create trigger trg_jobs_updated before update on public.jobs
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_cuts_updated on public.cuts;
create trigger trg_cuts_updated before update on public.cuts
  for each row execute function public.touch_updated_at();

-- ── Row Level Security: only a logged-in user, never anonymous ─────────────
alter table public.jobs            enable row level security;
alter table public.cuts            enable row level security;
alter table public.decisions       enable row level security;
alter table public.lives_watchlist enable row level security;
alter table public.live_sessions   enable row level security;
alter table public.keywords        enable row level security;
alter table public.app_settings    enable row level security;

-- Recreate policies idempotently
do $$
declare
  r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('jobs','cuts','decisions','lives_watchlist','live_sessions','keywords','app_settings')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy jobs_auth_all            on public.jobs            for all to authenticated using (true) with check (true);
create policy cuts_auth_all            on public.cuts            for all to authenticated using (true) with check (true);
create policy decisions_auth_all       on public.decisions       for all to authenticated using (true) with check (true);
create policy watchlist_auth_all       on public.lives_watchlist for all to authenticated using (true) with check (true);
create policy sessions_auth_all        on public.live_sessions   for all to authenticated using (true) with check (true);
create policy keywords_auth_all        on public.keywords        for all to authenticated using (true) with check (true);
create policy settings_auth_all        on public.app_settings    for all to authenticated using (true) with check (true);

-- ── Storage: private bucket "previews" ─────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'previews',
  'previews',
  false,
  104857600, -- 100 MB (source uploads); worker previews stay much smaller
  array['video/mp4','video/webm','video/quicktime','image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Wipe previous storage policies on this bucket (idempotent setup)
do $$
declare r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'cortes_%'
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

-- Logged-in user can read/sign anything in the bucket, and can upload only under uploads/
create policy cortes_preview_read on storage.objects
  for select to authenticated
  using (bucket_id = 'previews');

create policy cortes_upload_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'previews' and name like 'uploads/%');

create policy cortes_upload_update on storage.objects
  for update to authenticated
  using (bucket_id = 'previews' and name like 'uploads/%')
  with check (bucket_id = 'previews' and name like 'uploads/%');

create policy cortes_upload_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'previews' and name like 'uploads/%');

-- Realtime for the live status / queue
do $$ begin
  alter publication supabase_realtime add table public.jobs;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.cuts;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.decisions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.live_sessions;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.lives_watchlist;
exception when duplicate_object then null; end $$;
