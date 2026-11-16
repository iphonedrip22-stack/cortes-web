-- Cortes Studio — endurecimento (projeto Supabase **cortes**, não o hs3d).
-- Cole este arquivo INTEIRO no SQL Editor e clique em Run.
-- Idempotente: pode rodar de novo. Não apaga cortes, decisões, jobs nem prévias.
-- Seguro mesmo se migration_maestri.sql / migration_ajustes.sql ainda não tiverem rodado:
--   cria as tabelas novas se faltarem e troca as policies das que já existirem.
-- Depois de rodar: só e-mails na allowlist (cortes_admins) leem ou escrevem.
-- Status "liberado" de formato só muda pela função cortes_liberar_formato(), com a regra no banco.
-- Nada é publicado por estas tabelas.

-- ── helpers ────────────────────────────────────────────────────────────────
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

-- Força autoria pelo JWT (não aceita decided_by / requested_by / created_by forjados).
create or replace function public.cortes_force_actor() returns trigger language plpgsql as $$
declare
  uid uuid := auth.uid();
  mail text := auth.jwt() ->> 'email';
begin
  if uid is null and mail is null then
    return new;
  end if;
  begin
    if tg_table_name = 'decisions' and uid is not null then
      new.decided_by := uid;
    end if;
  exception when undefined_column then null;
  end;
  begin
    if tg_table_name = 'ajustes' and uid is not null then
      new.requested_by := uid;
    end if;
  exception when undefined_column then null;
  end;
  begin
    if mail is not null then
      new.created_by := mail;
    end if;
  exception when undefined_column then null;
  end;
  begin
    if mail is not null then
      new.updated_by := mail;
    end if;
  exception when undefined_column then null;
  end;
  return new;
end $$;

-- ── allowlist ──────────────────────────────────────────────────────────────
create table if not exists public.cortes_admins (
  email      text primary key,
  created_at timestamptz not null default now()
);
insert into public.cortes_admins(email) values
  ('cortesdrip3@gmail.com'),
  ('cortes@diretoaosso.app')
on conflict (email) do nothing;

create or replace function public.cortes_is_admin() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cortes_admins
    where email = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
  ) and coalesce(auth.jwt() ->> 'aal', 'aal1') in ('aal1', 'aal2');
$$;

revoke all on function public.cortes_is_admin() from public, anon;
grant execute on function public.cortes_is_admin() to authenticated;
revoke all on public.cortes_admins from anon, authenticated;
alter table public.cortes_admins enable row level security;

-- ── tabelas do painel Maestri (se ainda não existirem) ─────────────────────
create table if not exists public.metas (
  id           text primary key,
  formato      text not null,
  profile_id   uuid,
  profile_nome text,
  por_dia      integer check (por_dia is null or (por_dia between 0 and 24)),
  horarios     text[] not null default '{}',
  plataformas  text[] not null default array['instagram','tiktok','youtube'],
  status       text,
  ativo        boolean not null default true,
  ordem        integer not null default 0,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create unique index if not exists metas_profile_formato_idx on public.metas(profile_id, formato);

create table if not exists public.agenda (
  id           uuid primary key default gen_random_uuid(),
  cut_id       text not null,
  profile_id   uuid,
  platform     text not null check (platform in ('instagram','tiktok','youtube')),
  scheduled_at timestamptz not null,
  note         text,
  updated_by   text,
  synced_at    timestamptz,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (cut_id, platform)
);
create index if not exists agenda_when_idx on public.agenda(scheduled_at);

create table if not exists public.format_requests (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid,
  profile_nome      text,
  link              text,
  mode              text not null default 'link',
  name              text,
  style             text,
  premise           text,
  notes             text,
  reference_links   text,
  status            text not null default 'novo',
  created_by        text,
  synced_at         timestamptz,
  status_updated_at timestamptz,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
do $$ begin
  alter table public.format_requests drop constraint if exists format_requests_status_check;
  alter table public.format_requests add constraint format_requests_status_check
    check (status in ('novo','em_criacao','piloto','aprovado'));
  alter table public.format_requests drop constraint if exists format_requests_mode_check;
  alter table public.format_requests add constraint format_requests_mode_check
    check (mode in ('link','nova') and (mode = 'nova' or coalesce(trim(link),'') <> ''));
  alter table public.format_requests drop constraint if exists format_requests_link_https;
  alter table public.format_requests add constraint format_requests_link_https
    check (link is null or link ~* '^https://');
exception when others then
  raise notice 'format_requests constraints: %', sqlerrm;
end $$;

create table if not exists public.formats (
  id            text primary key,
  nome          text not null,
  profile_id    uuid,
  profile_nome  text,
  status        text not null default 'em_teste',
  min_reviews   integer not null default 10 check (min_reviews between 1 and 100),
  min_rate      numeric not null default 0.8 check (min_rate > 0 and min_rate <= 1),
  status_reason text,
  liberado_at   timestamptz,
  liberado_by   text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
do $$ begin
  alter table public.formats drop constraint if exists formats_status_check;
  alter table public.formats add constraint formats_status_check
    check (status in ('em_teste','liberado','pausado'));
  -- id gerado no painel/worker: só slug seguro
  alter table public.formats drop constraint if exists formats_id_slug;
  alter table public.formats add constraint formats_id_slug
    check (id ~ '^[a-z0-9-]{1,64}$');
exception when others then
  raise notice 'formats constraints: %', sqlerrm;
end $$;
create unique index if not exists formats_profile_nome_idx on public.formats(profile_id, nome);

create table if not exists public.cut_stages (
  cut_id            text primary key,
  stage             text,
  note              text,
  formato           text,
  avaliador_verdict text,
  auto_aprovado     boolean not null default false,
  auto_aprovado_at  timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists public.panel_kv (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.social_accounts (
  id                   text primary key,
  profile_id           uuid,
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
  alter table public.social_accounts drop constraint if exists social_accounts_url_https;
  alter table public.social_accounts add constraint social_accounts_url_https
    check (url is null or url ~* '^https://');
  alter table public.social_accounts drop constraint if exists social_accounts_id_safe;
  alter table public.social_accounts add constraint social_accounts_id_safe
    check (id ~ '^[a-z0-9:._-]{1,120}$');
exception when others then
  raise notice 'social_accounts constraints: %', sqlerrm;
end $$;

create table if not exists public.stats (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid,
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
  created_by   text,
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

-- lives url https when the table exists
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='lives_watchlist') then
    alter table public.lives_watchlist drop constraint if exists lives_watchlist_url_http;
    alter table public.lives_watchlist add constraint lives_watchlist_url_http
      check (url is null or url ~* '^https?://');
  end if;
exception when others then
  raise notice 'lives url check: %', sqlerrm;
end $$;

-- ── triggers ───────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['metas','agenda','format_requests','formats','cut_stages','panel_kv','social_accounts']
  loop
    execute format('drop trigger if exists %I on public.%I', t||'_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cortes_touch()', t||'_touch', t);
  end loop;
  foreach t in array array['metas','agenda','formats']
  loop
    execute format('drop trigger if exists %I on public.%I', t||'_stamp', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.cortes_stamp_user()', t||'_stamp', t);
  end loop;
  foreach t in array array['decisions','ajustes','format_requests','stats','metas','agenda','formats']
  loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('drop trigger if exists %I on public.%I', t||'_actor', t);
      execute format('create trigger %I before insert or update on public.%I for each row execute function public.cortes_force_actor()', t||'_actor', t);
    end if;
  end loop;
end $$;

-- Status "liberado" (e qualquer troca de status) só via RPC, com flag de sessão.
create or replace function public.cortes_formats_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if current_setting('cortes.format_guard', true) is distinct from 'ok' then
      raise exception 'status do formato só muda pela função do banco (cortes_liberar_formato / cortes_set_formato_status)';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists formats_guard on public.formats;
create trigger formats_guard before update on public.formats
  for each row execute function public.cortes_formats_guard();

-- ── RPC: liberar formato (regra no banco, não no cliente) ──────────────────
create or replace function public.cortes_liberar_formato(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.formats%rowtype;
  n_rev int := 0;
  n_ok int := 0;
  rate numeric := 0;
begin
  if not public.cortes_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into f from public.formats where id = p_id;
  if not found then
    raise exception 'formato não encontrado';
  end if;
  -- conta decisões deste perfil cujo corte tem o estilo/formato correspondente
  select
    count(*) filter (where d.decision in ('approved','rejected')),
    count(*) filter (where d.decision = 'approved')
  into n_rev, n_ok
  from public.decisions d
  join public.cuts c on c.id = d.cut_id
  left join public.cut_stages s on s.cut_id = c.id
  where d.decision in ('approved','rejected')
    and (
      lower(coalesce(c.qc->>'style', c.qc->>'format', s.formato, '')) = lower(f.nome)
      or lower(coalesce(c.qc->>'style', c.qc->>'format', s.formato, '')) = lower(f.id)
    )
    and (f.profile_id is null or c.profile_id is null or c.profile_id = f.profile_id);

  if n_rev > 0 then
    rate := n_ok::numeric / n_rev::numeric;
  end if;
  if n_rev < coalesce(f.min_reviews, 10) or rate < coalesce(f.min_rate, 0.8) then
    raise exception 'ainda não atingiu a regra (% revisados, % %% aprovados; precisa % e % %%)',
      n_rev, round(rate*100), coalesce(f.min_reviews,10), round(coalesce(f.min_rate,0.8)*100);
  end if;
  perform set_config('cortes.format_guard', 'ok', true);
  update public.formats
     set status = 'liberado',
         liberado_at = now(),
         liberado_by = auth.jwt() ->> 'email',
         status_reason = 'Liberado pela regra do banco (revisões mínimas e taxa). Postar continua exigindo ok do Matheus.'
   where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'revisados', n_rev, 'aprovados', n_ok, 'rate', rate);
end $$;

create or replace function public.cortes_set_formato_status(p_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.cortes_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_status not in ('em_teste','pausado') then
    raise exception 'use cortes_liberar_formato para liberar';
  end if;
  perform set_config('cortes.format_guard', 'ok', true);
  update public.formats
     set status = p_status,
         status_reason = case p_status
           when 'pausado' then 'Pausado no painel.'
           else 'Voltado para teste no painel.'
         end
   where id = p_id;
  if not found then
    raise exception 'formato não encontrado';
  end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status);
end $$;

revoke all on function public.cortes_liberar_formato(text) from public, anon;
revoke all on function public.cortes_set_formato_status(text, text) from public, anon;
grant execute on function public.cortes_liberar_formato(text) to authenticated;
grant execute on function public.cortes_set_formato_status(text, text) to authenticated;

-- ── RLS: só admin; drop de qualquer policy antiga ──────────────────────────
do $$
declare
  r record;
  t text;
  tables text[] := array[
    'jobs','cuts','decisions','lives_watchlist','live_sessions','keywords','app_settings',
    'workspaces','profiles','ajustes',
    'metas','agenda','format_requests','formats','cut_stages','panel_kv',
    'social_accounts','stats','cortes_admins'
  ];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('alter table public.%I enable row level security', t);
      for r in
        select policyname from pg_policies where schemaname='public' and tablename=t
      loop
        execute format('drop policy if exists %I on public.%I', r.policyname, t);
      end loop;
    end if;
  end loop;
end $$;

-- Policies admin-only (SELECT/INSERT/UPDATE conforme o uso do painel; sem DELETE amplo)
do $$
declare
  t text;
begin
  -- leitura para o painel
  foreach t in array array[
    'jobs','cuts','decisions','lives_watchlist','live_sessions','keywords','app_settings',
    'workspaces','profiles','ajustes',
    'metas','agenda','format_requests','formats','cut_stages','panel_kv',
    'social_accounts','stats'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('create policy %I on public.%I for select to authenticated using (public.cortes_is_admin())', t||'_admin_select', t);
    end if;
  end loop;

  -- inserts do painel
  foreach t in array array[
    'jobs','decisions','lives_watchlist','keywords','ajustes',
    'workspaces','profiles','metas','agenda','format_requests','formats',
    'social_accounts','stats','app_settings'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format(
        'create policy %I on public.%I for insert to authenticated with check (public.cortes_is_admin())',
        t||'_admin_insert', t
      );
    end if;
  end loop;

  -- updates pontuais (cancelar job, metas, agenda, perfis, lives, contas). formats.status é bloqueado pelo trigger.
  foreach t in array array[
    'jobs','decisions','lives_watchlist','keywords','app_settings',
    'workspaces','profiles','metas','agenda','social_accounts','ajustes'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format(
        'create policy %I on public.%I for update to authenticated using (public.cortes_is_admin()) with check (public.cortes_is_admin())',
        t||'_admin_update', t
      );
    end if;
  end loop;

  -- delete só onde o painel precisa (canal da live / palavra-chave). Sem delete em agenda, stats, cuts, decisions.
  foreach t in array array['lives_watchlist','keywords'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format(
        'create policy %I on public.%I for delete to authenticated using (public.cortes_is_admin())',
        t||'_admin_delete', t
      );
    end if;
  end loop;
end $$;

-- ── GRANTs mínimos (tira UPDATE/DELETE largos do padrão do Supabase) ───────
do $$
declare
  t text;
begin
  foreach t in array array[
    'jobs','cuts','decisions','lives_watchlist','live_sessions','keywords','app_settings',
    'workspaces','profiles','ajustes',
    'metas','agenda','format_requests','formats','cut_stages','panel_kv',
    'social_accounts','stats','cortes_admins'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('revoke all on table public.%I from anon, authenticated, public', t);
    end if;
  end loop;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'jobs','cuts','decisions','lives_watchlist','live_sessions','keywords','app_settings',
    'workspaces','profiles','ajustes','metas','agenda','format_requests','formats',
    'cut_stages','panel_kv','social_accounts','stats'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('grant select on table public.%I to authenticated', t);
    end if;
  end loop;
  foreach t in array array[
    'jobs','decisions','lives_watchlist','keywords','app_settings',
    'workspaces','profiles','metas','agenda','social_accounts','ajustes'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('grant insert, update on table public.%I to authenticated', t);
    end if;
  end loop;
  foreach t in array array['format_requests','formats','stats'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('grant insert on table public.%I to authenticated', t);
    end if;
  end loop;
  foreach t in array array['lives_watchlist','keywords'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('grant delete on table public.%I to authenticated', t);
    end if;
  end loop;
end $$;
-- formats: sem UPDATE direto (status só via RPC). cut_stages / panel_kv / cuts: só SELECT no painel.

-- ── Storage: bucket previews, só admin lê / assina; worker usa service role ─
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname='storage' and tablename='objects'
      and (policyname like 'cortes_%' or policyname like 'preview_%')
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

drop policy if exists cortes_preview_read on storage.objects;
drop policy if exists cortes_upload_insert on storage.objects;
drop policy if exists cortes_upload_update on storage.objects;
drop policy if exists cortes_upload_delete on storage.objects;
drop policy if exists cortes_preview_admin_read on storage.objects;
drop policy if exists cortes_preview_admin_insert on storage.objects;
drop policy if exists cortes_preview_admin_update on storage.objects;
drop policy if exists cortes_preview_admin_delete on storage.objects;

create policy cortes_preview_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'previews' and public.cortes_is_admin());
create policy cortes_preview_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'previews' and public.cortes_is_admin());
create policy cortes_preview_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'previews' and public.cortes_is_admin())
  with check (bucket_id = 'previews' and public.cortes_is_admin());
-- sem policy de DELETE no client; o worker (service role) continua podendo limpar

notify pgrst, 'reload schema';
