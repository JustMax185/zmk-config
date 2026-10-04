-- =====================================================================
-- Einnahmen & Ausgaben – sichere Tabellen für Supabase
--
-- Ausführen: Supabase Dashboard → SQL Editor → einfügen → Run.
-- Das Skript kann mehrfach ausgeführt werden (idempotent).
--
-- Sicherheitsmodell:
--   * Jede Zeile gehört einem Benutzer (user_id = auth.uid()).
--   * Row Level Security ist aktiv und erzwungen: Jeder angemeldete
--     Benutzer sieht und ändert nur seine eigenen Zeilen.
--   * Die Rolle "anon" (nur Anon Key, nicht angemeldet) hat keinerlei
--     Rechte – auch nicht lesend.
-- =====================================================================

-- ---------- Gemeinsame Hilfsfunktion: updated_at pflegen ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;


-- ---------- Ausgaben ----------

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  date        date not null default current_date,
  amount      numeric(12, 2) not null check (amount > 0),
  category    text not null default 'Sonstiges'
                check (char_length(category) between 1 and 50),
  description text check (char_length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.expenses is 'Ausgaben, eine Zeile pro Buchung. Betrag immer positiv.';


-- ---------- Einnahmen ----------

create table if not exists public.income (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  date        date not null default current_date,
  amount      numeric(12, 2) not null check (amount > 0),
  category    text not null default 'Sonstiges'
                check (char_length(category) between 1 and 50),
  description text check (char_length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.income is 'Einnahmen, eine Zeile pro Buchung. Betrag immer positiv.';


-- ---------- Indizes, Trigger, Rechte und RLS für beide Tabellen ----------

do $$
declare
  t text;
begin
  foreach t in array array['expenses', 'income'] loop
    -- Schnelle Abfragen "meine Buchungen, neueste zuerst"
    execute format('create index if not exists %I on public.%I (user_id, date desc)', t || '_user_date_idx', t);

    -- updated_at automatisch setzen
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t);

    -- Rechte: anon gar nichts, authenticated nur die vier CRUD-Rechte
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    -- Row Level Security einschalten und auch für den Tabellenbesitzer erzwingen
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    -- Policies: nur eigene Zeilen
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);

    execute format('create policy "own rows: select" on public.%I for select to authenticated
                    using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: insert" on public.%I for insert to authenticated
                    with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: update" on public.%I for update to authenticated
                    using ((select auth.uid()) = user_id)
                    with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: delete" on public.%I for delete to authenticated
                    using ((select auth.uid()) = user_id)', t);
  end loop;
end;
$$;
