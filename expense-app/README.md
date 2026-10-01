# Ausgaben – Visualisierung (PWA)

Kleine Web-App fürs Handy, die die Ausgaben aus einer Supabase-Tabelle liest und darstellt:

- Monatssumme mit Vergleich zum Vormonat (im laufenden Monat bis zum selben Tag)
- Ø pro Tag, Prognose zum Monatsende, Anzahl Buchungen, Ø pro Monat
- Kumulierter Verlauf im Monat vs. Vormonat (antippen/ziehen für Werte)
- Kategorien-Ranking (antippen filtert die Buchungsliste)
- Säulen der letzten 12 Monate (antippen wählt den Monat)
- Buchungsliste nach Tagen gruppiert
- Hell-/Dunkelmodus, offline mit den zuletzt geladenen Daten, nach unten ziehen = neu laden

Kein Build-Schritt, keine Abhängigkeiten – nur statische Dateien.

## 1. Supabase vorbereiten

Die App liest nur (`SELECT`). Da der Anon Key im Browser steht, sollte die Tabelle
per Row Level Security geschützt sein und die App sich mit deinem Supabase-Benutzer anmelden.

```sql
-- Tabellenname ggf. anpassen
alter table public.expenses enable row level security;

-- Nur angemeldete Benutzer dürfen lesen
create policy "read own expenses"
  on public.expenses for select
  to authenticated
  using (true);   -- oder: using (auth.uid() = user_id), falls es eine user_id-Spalte gibt
```

Einen Benutzer legst du unter *Authentication → Users → Add user* an (E-Mail + Passwort).
Wenn du neue Registrierungen verhindern willst: *Authentication → Providers → Email → „Allow new users to sign up“* ausschalten.

## 2. App hosten

Variante A – GitHub Pages (Workflow liegt bei: `.github/workflows/expense-app-pages.yml`):
1. Im Repo unter *Settings → Pages → Source* „GitHub Actions“ wählen.
2. Änderungen in `expense-app/` auf den Branch `ANSI` mergen – der Workflow deployt automatisch.
3. Die App liegt dann unter `https://<user>.github.io/zmk-config/`.

Variante B – Netlify/Vercel/Cloudflare Pages: den Ordner `expense-app` als statische Seite hochladen.

Lokal testen: `cd expense-app && python3 -m http.server 8000`.

## 3. Aufs Handy

Seite im Browser öffnen →
- **iPhone (Safari):** Teilen → „Zum Home-Bildschirm“
- **Android (Chrome):** Menü → „App installieren“

Beim ersten Start ⚙ öffnen und eintragen:
- Projekt-URL und Anon/Publishable Key (*Supabase → Project Settings → API*)
- Tabellenname
- E-Mail + Passwort → „Anmelden“, dann „Speichern & laden“

Alles wird nur lokal auf dem Gerät gespeichert.

## Spalten

Die App erkennt gängige Spaltennamen automatisch:

| Feld | erkannte Namen (Auszug) |
|---|---|
| Datum | `date`, `datum`, `spent_at`, `created_at`, … |
| Betrag | `amount`, `betrag`, `price`, `preis`, `value`, … |
| Kategorie | `category`, `kategorie`, `type`, … |
| Beschreibung | `description`, `beschreibung`, `note`, `title`, `name`, … |

Abweichende Namen kannst du in den Einstellungen angeben. Beträge werden als Betrag
(ohne Vorzeichen) gezählt – negative Werte für Ausgaben funktionieren also auch.
