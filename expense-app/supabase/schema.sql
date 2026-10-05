-- =====================================================================
-- Einnahmen & Ausgaben – sichere Tabellen für Supabase
--
-- Ausführen: Supabase Dashboard → SQL Editor → einfügen → Run.
-- Das Skript kann mehrfach ausgeführt werden (idempotent) und löscht keine Daten.
--
-- Spalten passen zu den Feldern des iPhone-Kurzbefehls:
--   ausgaben:  datum, betrag, art, kategorie, beschreibung
--   einnahmen: datum, betrag, beschreibung
--
-- Sicherheitsmodell:
--   * Jede Zeile gehört einem Benutzer (user_id = auth.uid(), wird automatisch gesetzt).
--   * Row Level Security ist aktiv und erzwungen: Jeder angemeldete
--     Benutzer sieht und ändert nur seine eigenen Zeilen.
--   * Die Rolle "anon" (nur Anon Key, nicht angemeldet) hat keinerlei Rechte.
-- =====================================================================

-- ---------- Falls die erste Version (expenses / income) schon angelegt wurde: umbenennen ----------

do $$
begin
  if to_regclass('public.expenses') is not null and to_regclass('public.ausgaben') is null then
    alter table public.expenses rename to ausgaben;
  end if;
  if to_regclass('public.income') is not null and to_regclass('public.einnahmen') is null then
    alter table public.income rename to einnahmen;
  end if;
end;
$$;

do $$
declare
  t text;
  r record;
begin
  foreach t in array array['ausgaben', 'einnahmen'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for r in select * from (values ('date', 'datum'), ('amount', 'betrag'),
                                   ('category', 'kategorie'), ('description', 'beschreibung')) v(alt, neu) loop
      if exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = t and column_name = r.alt)
         and not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = t and column_name = r.neu) then
        execute format('alter table public.%I rename column %I to %I', t, r.alt, r.neu);
      end if;
    end loop;
  end loop;
end;
$$;

-- Einnahmen haben keine Kategorie
alter table if exists public.einnahmen drop column if exists kategorie;
drop index if exists public.expenses_user_date_idx;
drop index if exists public.income_user_date_idx;


-- ---------- Hilfsfunktionen ----------

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

-- "ausgabe", " SPAREN " usw. → "Ausgabe" / "Sparen"
create or replace function public.normalize_art()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.art := initcap(btrim(new.art));
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.normalize_art() from public, anon, authenticated;


-- ---------- Ausgaben ----------

create table if not exists public.ausgaben (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  datum        date not null default current_date,
  betrag       numeric(12, 2) not null check (betrag > 0),
  art          text not null default 'Ausgabe',
  kategorie    text not null default 'Sonstiges'
                 check (char_length(kategorie) between 1 and 50),
  beschreibung text check (char_length(beschreibung) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.ausgaben add column if not exists art text not null default 'Ausgabe';
alter table public.ausgaben drop constraint if exists ausgaben_art_check;
alter table public.ausgaben add constraint ausgaben_art_check check (art in ('Ausgabe', 'Sparen'));

comment on table public.ausgaben is 'Ausgaben und Sparbeträge, eine Zeile pro Buchung. Betrag immer positiv.';
comment on column public.ausgaben.art is 'Ausgabe oder Sparen';

drop trigger if exists normalize_art on public.ausgaben;
create trigger normalize_art before insert or update of art on public.ausgaben
  for each row execute function public.normalize_art();


-- ---------- Einnahmen ----------

create table if not exists public.einnahmen (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  datum        date not null default current_date,
  betrag       numeric(12, 2) not null check (betrag > 0),
  beschreibung text check (char_length(beschreibung) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.einnahmen is 'Einnahmen, eine Zeile pro Buchung. Betrag immer positiv.';


-- ---------- Indizes, Trigger, Rechte und RLS für beide Tabellen ----------

do $$
declare
  t text;
begin
  foreach t in array array['ausgaben', 'einnahmen'] loop
    -- Schnelle Abfragen "meine Buchungen, neueste zuerst"
    execute format('create index if not exists %I on public.%I (user_id, datum desc)', t || '_user_datum_idx', t);

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
