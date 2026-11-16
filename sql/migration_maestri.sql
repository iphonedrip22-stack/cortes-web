-- Cortes Studio — metas, agenda, formatos, números e diário (projeto Supabase **cortes**).
-- Cole no SQL Editor do projeto cortes (não o hs3d) e clique em Run.
-- Idempotente: pode rodar de novo sem estragar dados.
-- Enquanto este arquivo não rodar, o site continua no ar e as abas novas avisam que falta o SQL.
-- RLS: só usuário autenticado. Nada é publicado por estas tabelas.

create or replace function public.cortes_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.cortes_stamp_user() returns trigger language plpgsql as $$
begin
  if auth.jwt() ->> 'email' is not null then
    begin
      new.updated_by = auth.jwt() ->> 'email';
    exception when undefined_column then
      null;
    end;
  end if;
  return new;
end $$;

-- 1) Metas por perfil e formato (o painel é a fonte da verdade; o worker reescreve METAS.md)
create table if not exists public.metas (
  id           text primary key,
  formato      text not null,
  profile_id   uuid references public.profiles(id) on delete cascade,
  profile_nome text,
  por_dia      integer check (por_dia is null or (por_dia between 0 and 24)),
  horarios     text[] not null default '{}',
  plataformas  text[] not null default array['instagram','tiktok','youtube'],
  status       text,
  ativo        boolean not null default true,
  ordem        integer not null default 0,
  updated_by   text default (auth.jwt() ->> 'email'),
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create unique index if not exists metas_profile_formato_idx on public.metas(profile_id, formato);

-- 2) Agenda: horário por corte e plataforma. Agendar NÃO autoriza postar.
create table if not exists public.agenda (
  id           uuid primary key default gen_random_uuid(),
  cut_id       text not null references public.cuts(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete set null,
  platform     text not null check (platform in ('instagram','tiktok','youtube')),
  scheduled_at timestamptz not null,
  note         text,
  updated_by   text default (auth.jwt() ->> 'email'),
  synced_at    timestamptz,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (cut_id, platform)
);
create index if not exists agenda_when_idx on public.agenda(scheduled_at);

-- 3) Pedidos de formato (link de referência ou criar do zero)
create table if not exists public.format_requests (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid references public.profiles(id) on delete set null,
  profile_nome    text,
  link            text,
  mode            text not null default 'link',
  name            text,
  style           text,
  premise         text,
  notes           text,
  reference_links text,
  status          text not null default 'novo',
  created_by      text default (auth.jwt() ->> 'email'),
  synced_at       timestamptz,
  status_updated_at timestamptz,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.format_requests drop constraint if exists format_requests_status_check;
  alter table public.format_requests add constraint format_requests_status_check
    check (status in ('novo','em_criacao','piloto','aprovado'));
  alter table public.format_requests drop constraint if exists format_requests_mode_check;
  alter table public.format_requests add constraint format_requests_mode_check
    check (mode in ('link','nova') and (mode = 'nova' or coalesce(trim(link),'') <> ''));
exception when others then
  raise notice 'format_requests constraints: %', sqlerrm;
end $$;

-- 4) Liberação de formato (10 revisados + 80% aprovados → o Matheus libera)
create table if not exists public.formats (
  id            text primary key,
  nome          text not null,
  profile_id    uuid references public.profiles(id) on delete cascade,
  profile_nome  text,
  status        text not null default 'em_teste',
  min_reviews   integer not null default 10 check (min_reviews between 1 and 100),
  min_rate      numeric not null default 0.8 check (min_rate > 0 and min_rate <= 1),
  status_reason text,
  liberado_at   timestamptz,
  liberado_by   text,
  updated_by    text default (auth.jwt() ->> 'email'),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
do $$ begin
  alter table public.formats drop constraint if exists formats_status_check;
  alter table public.formats add constraint formats_status_check
    check (status in ('em_teste','liberado','pausado'));
exception when others then
  raise notice 'formats status: %', sqlerrm;
end $$;
create unique index if not exists formats_profile_nome_idx on public.formats(profile_id, nome);

-- 5) Etapas extra (o worker do Mac espelha status_override.json; não disputa o upsert de cuts da nuvem)
create table if not exists public.cut_stages (
  cut_id             text primary key references public.cuts(id) on delete cascade,
  stage              text,
  note               text,
  formato            text,
  avaliador_verdict  text,
  auto_aprovado      boolean not null default false,
  auto_aprovado_at   timestamptz,
  updated_at         timestamptz not null default now()
);
do $$ begin
  alter table public.cut_stages drop constraint if exists cut_stages_verdict_check;
  alter table public.cut_stages add constraint cut_stages_verdict_check
    check (avaliador_verdict is null or avaliador_verdict in ('aprovado','reprovado','approved','rejected'));
exception when others then
  raise notice 'cut_stages verdict: %', sqlerrm;
end $$;

-- 6) Diário e outros valores simples
create table if not exists public.panel_kv (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 7) Contas e números (o painel só lança source=manual; agente/auto vêm do worker)
create table if not exists public.social_accounts (
  id                   text primary key,
  profile_id           uuid references public.profiles(id) on delete cascade,
  profile_nome         text,
  platform             text not null,
  handle               text,
  url                  text,
  external_id          text,
  auto                 boolean not null default false,
  connect_status       text not null default 'manual',
  refresh_requested_at timestamptz,
  ordem                integer not null default 0,
  updated_at           timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique (profile_id, platform)
);
do $$ begin
  alter table public.social_accounts drop constraint if exists social_accounts_platform_check;
  alter table public.social_accounts add constraint social_accounts_platform_check
    check (platform in ('instagram','tiktok','youtube'));
exception when others then
  raise notice 'social_accounts platform: %', sqlerrm;
end $$;

create table if not exists public.stats (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid references public.profiles(id) on delete cascade,
  platform     text not null,
  scope        text not null default 'conta',
  video_ref    text,
  video_title  text,
  followers    bigint,
  views        bigint,
  views_period text,
  likes        bigint,
  comments     bigint,
  shares       bigint,
  saves        bigint,
  posts        integer,
  video_date   date,
  source       text not null default 'manual',
  note         text,
  captured_at  timestamptz not null default now(),
  created_by   text default (auth.jwt() ->> 'email'),
  created_at   timestamptz not null default now()
);
do $$ begin
  alter table public.stats drop constraint if exists stats_platform_check;
  alter table public.stats add constraint stats_platform_check
    check (platform in ('instagram','tiktok','youtube'));
  alter table public.stats drop constraint if exists stats_scope_check;
  alter table public.stats add constraint stats_scope_check
    check (scope in ('conta','video'));
  alter table public.stats drop constraint if exists stats_source_check;
  alter table public.stats add constraint stats_source_check
    check (source in ('auto','manual','agente'));
exception when others then
  raise notice 'stats checks: %', sqlerrm;
end $$;
create index if not exists stats_profile_idx on public.stats(profile_id, platform, scope, captured_at desc);

-- triggers
drop trigger if exists metas_touch on public.metas;
create trigger metas_touch before update on public.metas
  for each row execute function public.cortes_touch();
drop trigger if exists metas_stamp on public.metas;
create trigger metas_stamp before insert or update on public.metas
  for each row execute function public.cortes_stamp_user();

drop trigger if exists agenda_touch on public.agenda;
create trigger agenda_touch before update on public.agenda
  for each row execute function public.cortes_touch();
drop trigger if exists agenda_stamp on public.agenda;
create trigger agenda_stamp before insert or update on public.agenda
  for each row execute function public.cortes_stamp_user();

drop trigger if exists format_requests_touch on public.format_requests;
create trigger format_requests_touch before update on public.format_requests
  for each row execute function public.cortes_touch();

drop trigger if exists formats_touch on public.formats;
create trigger formats_touch before update on public.formats
  for each row execute function public.cortes_touch();
drop trigger if exists formats_stamp on public.formats;
create trigger formats_stamp before insert or update on public.formats
  for each row execute function public.cortes_stamp_user();

drop trigger if exists cut_stages_touch on public.cut_stages;
create trigger cut_stages_touch before update on public.cut_stages
  for each row execute function public.cortes_touch();

drop trigger if exists panel_kv_touch on public.panel_kv;
create trigger panel_kv_touch before update on public.panel_kv
  for each row execute function public.cortes_touch();

drop trigger if exists social_accounts_touch on public.social_accounts;
create trigger social_accounts_touch before update on public.social_accounts
  for each row execute function public.cortes_touch();

-- RLS
alter table public.metas            enable row level security;
alter table public.agenda           enable row level security;
alter table public.format_requests  enable row level security;
alter table public.formats          enable row level security;
alter table public.cut_stages       enable row level security;
alter table public.panel_kv         enable row level security;
alter table public.social_accounts  enable row level security;
alter table public.stats            enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('metas','agenda','format_requests','formats','cut_stages','panel_kv','social_accounts','stats')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy metas_auth_all on public.metas for all to authenticated using (true) with check (true);
create policy agenda_auth_all on public.agenda for all to authenticated using (true) with check (true);
create policy format_requests_select on public.format_requests for select to authenticated using (true);
create policy format_requests_insert on public.format_requests for insert to authenticated with check (status = 'novo');
create policy format_requests_update on public.format_requests for update to authenticated using (true) with check (true);
create policy formats_auth_all on public.formats for all to authenticated using (true) with check (true);
create policy cut_stages_select on public.cut_stages for select to authenticated using (true);
create policy panel_kv_select on public.panel_kv for select to authenticated using (true);
create policy social_accounts_auth_all on public.social_accounts for all to authenticated using (true) with check (true);
create policy stats_select on public.stats for select to authenticated using (true);
create policy stats_insert_manual on public.stats for insert to authenticated with check (source = 'manual');
create policy stats_delete_manual on public.stats for delete to authenticated using (source = 'manual');

grant select, insert, update, delete on public.metas, public.agenda, public.formats, public.social_accounts to authenticated;
grant select, insert, update on public.format_requests to authenticated;
grant select on public.cut_stages, public.panel_kv to authenticated;
grant select, insert, delete on public.stats to authenticated;
revoke all on public.metas, public.agenda, public.format_requests, public.formats,
  public.cut_stages, public.panel_kv, public.social_accounts, public.stats from anon;

notify pgrst, 'reload schema';
