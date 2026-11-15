-- Cortes Studio — perfis / contas de cortes (multi-account)
-- Cole este arquivo INTEIRO no SQL Editor do Supabase (projeto "cortes") e clique em Run.
-- É seguro rodar mais de uma vez. Não apaga cortes, decisões, jobs nem prévias.
-- A página continua funcionando se este arquivo ainda não tiver sido aplicado;
-- depois de aplicar, libera vários perfis (ex.: Direto ao Osso + outras contas).

create extension if not exists pgcrypto;

-- ── workspaces (base para um dia vender o app a outros times) ──────────────
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  created_at  timestamptz not null default now()
);

-- ── profiles (contas de cortes: nicho, identidade, estilo padrão) ──────────
create table if not exists public.profiles (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  name           text not null,
  handle         text,
  niche          text,
  default_style  text not null default 'close'
                   check (default_style in ('close','letterbox','split','humor','storytelling')),
  theme          jsonb not null default '{"bg":"#0b0d10","accent":"#ffd400","text":"#111111"}'::jsonb,
  platforms      jsonb not null default '{"instagram":"","tiktok":"","youtube":""}'::jsonb,
  live_style     text not null default 'close',
  live_enabled   boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists profiles_workspace_handle_idx
  on public.profiles (workspace_id, lower(handle))
  where handle is not null and handle <> '';

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── additive columns on existing tables (nullable so o app antigo não quebra) ─
alter table public.cuts            add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.cuts            add column if not exists profile_id   uuid references public.profiles(id);
alter table public.jobs            add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.jobs            add column if not exists profile_id   uuid references public.profiles(id);
alter table public.decisions       add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.decisions       add column if not exists profile_id   uuid references public.profiles(id);
alter table public.lives_watchlist add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.lives_watchlist add column if not exists profile_id   uuid references public.profiles(id);
alter table public.live_sessions   add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.live_sessions   add column if not exists profile_id   uuid references public.profiles(id);
alter table public.keywords        add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.keywords        add column if not exists profile_id   uuid references public.profiles(id);
alter table public.app_settings    add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.app_settings    add column if not exists profile_id   uuid references public.profiles(id);

create index if not exists cuts_profile_idx      on public.cuts (profile_id);
create index if not exists jobs_profile_idx      on public.jobs (profile_id);
create index if not exists watchlist_profile_idx on public.lives_watchlist (profile_id);
create index if not exists keywords_profile_idx  on public.keywords (profile_id);

-- keywords: passar de "word único no projeto" para "word único por perfil"
alter table public.keywords drop constraint if exists keywords_word_key;
create unique index if not exists keywords_profile_word_idx
  on public.keywords (profile_id, lower(word));

-- ── seed: um workspace e o perfil Direto ao Osso (UUIDs fixos, idempotente) ─
insert into public.workspaces (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'Cortes Studio', 'cortes-studio')
on conflict (id) do nothing;

insert into public.workspaces (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'Cortes Studio', 'cortes-studio')
on conflict (slug) do nothing;

insert into public.profiles (
  id, workspace_id, name, handle, niche, default_style, theme, platforms
) values (
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  'Direto ao Osso',
  'diretoaosso',
  'empreendedorismo',
  'close',
  '{"bg":"#0a0a0a","accent":"#ffd400","text":"#111111"}'::jsonb,
  '{"instagram":"@diretoaosso","tiktok":"@diretoaosso","youtube":""}'::jsonb
)
on conflict (id) do nothing;

-- backfill: tudo o que já existe entra no perfil Direto ao Osso
update public.cuts
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

update public.jobs
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

update public.decisions
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

update public.lives_watchlist
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

update public.live_sessions
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

update public.keywords
   set workspace_id = '00000000-0000-4000-8000-000000000001',
       profile_id   = '00000000-0000-4000-8000-000000000011'
 where profile_id is null;

-- ── RLS: qualquer usuário autenticado do workspace (ainda um só time) ──────
alter table public.workspaces enable row level security;
alter table public.profiles   enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('workspaces','profiles')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy workspaces_auth_all on public.workspaces for all to authenticated using (true) with check (true);
create policy profiles_auth_all   on public.profiles   for all to authenticated using (true) with check (true);

-- realtime (ignore if already added)
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.workspaces;
exception when duplicate_object then null;
end $$;
