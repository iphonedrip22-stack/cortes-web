-- Cortes Studio — pedidos de ajuste (Pedir ajuste no player)
-- Cole este arquivo INTEIRO no SQL Editor do Supabase (projeto "cortes") e clique em Run.
-- É seguro rodar mais de uma vez. Não apaga cortes, decisões, jobs nem prévias.
-- Enquanto este arquivo não for aplicado, a página mostra o campo mas avisa
-- que falta colar o SQL. Depois de aplicar, cada pedido fica salvo, o corte
-- vai para o status "ajuste pedido", e nada é publicado ou reeditado sozinho.

create extension if not exists pgcrypto;

create table if not exists public.ajustes (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  cut_id        text not null references public.cuts(id) on delete cascade,
  request       text not null,
  status        text not null default 'ajuste pedido'
                  check (status in ('ajuste pedido','em andamento','feito','recusado')),
  hook          text,
  version       text,
  workspace_id  uuid,
  profile_id    uuid,
  requested_by  uuid
);

create index if not exists ajustes_cut_id_idx
  on public.ajustes (cut_id, created_at desc);
create index if not exists ajustes_status_idx
  on public.ajustes (status, created_at);

alter table public.ajustes enable row level security;

drop policy if exists ajustes_auth_all on public.ajustes;
create policy ajustes_auth_all on public.ajustes
  for all to authenticated using (true) with check (true);

-- Allow "ajuste pedido" on the existing decisions table (status da fila).
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.decisions'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'decision'
  loop
    execute format('alter table public.decisions drop constraint if exists %I', r.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.decisions'::regclass
      and conname = 'decisions_decision_check'
  ) then
    alter table public.decisions
      add constraint decisions_decision_check
      check (decision in ('approved','rejected','pending','ajuste pedido'));
  end if;
end $$;
