# Ausgaben & Einnahmen – Übersicht (PWA)

Kleine Web-App fürs Handy, die die Tabellen `ausgaben` und `einnahmen` aus Supabase liest und darstellt:

- Ausgaben im Monat mit Vergleich zum Vormonat (im laufenden Monat bis zum selben Tag)
- Monatsbilanz: Einnahmen, Ausgaben, Gespart (`art = Sparen`), Übrig und Sparquote
- Geldfluss als Sankey-Diagramm: Einnahmen → Ausgaben / Gespart / Übrig → Kategorien
- Monatsbeginn einstellbar (⚙ → „Monat beginnt am“), z. B. 15. bis 14. passend zum Gehaltseingang
- Ø pro Tag, Prognose zum Monatsende, Anzahl Buchungen, Ø pro Monat
- Kumulierter Verlauf im Monat vs. Vormonat (antippen/ziehen für Werte)
- Kategorien-Ranking der Ausgaben (antippen filtert die Buchungsliste)
- Ausgaben und Einnahmen der letzten Monate (antippen wählt den Monat)
- Buchungsliste nach Tagen, filterbar nach Alle / Ausgaben / Sparen / Einnahmen
- Hell-/Dunkelmodus, offline mit den zuletzt geladenen Daten, nach unten ziehen = neu laden

Sparbeträge zählen nicht als Ausgaben, sondern werden in der Bilanz extra ausgewiesen.
Kein Build-Schritt, keine Abhängigkeiten – nur statische Dateien.

## 1. Supabase vorbereiten

`supabase/schema.sql` im *SQL Editor* ausführen. Es legt zwei Tabellen an, deren Spalten
den Feldern des iPhone-Kurzbefehls entsprechen:

| Tabelle | Spalten aus dem Kurzbefehl | automatisch |
|---|---|---|
| `ausgaben` | `datum`, `betrag`, `art` (`Ausgabe` oder `Sparen`), `kategorie`, `beschreibung` | `id`, `user_id`, `created_at`, `updated_at` |
| `einnahmen` | `datum`, `betrag`, `beschreibung` | `id`, `user_id`, `created_at`, `updated_at` |

Absicherung:
- Row Level Security ist aktiv und erzwungen: Jeder angemeldete Benutzer sieht und ändert nur seine eigenen Zeilen.
- `user_id` wird beim Einfügen automatisch auf den angemeldeten Benutzer gesetzt und kann nicht auf jemand anderen umgestellt werden.
- Ohne Login (nur mit dem Anon Key) gibt es keinerlei Zugriff – weder lesen noch schreiben.
- Prüfungen: `betrag` > 0, `art` nur `Ausgabe`/`Sparen` (Groß-/Kleinschreibung und Leerzeichen werden korrigiert),
  `kategorie` bis 50, `beschreibung` bis 500 Zeichen. `datum` als `JJJJ-MM-TT`.

Das Skript ist wiederholbar und löscht keine Daten. Wer die erste Version (`expenses`/`income`)
schon ausgeführt hat, bekommt Tabellen und Spalten automatisch umbenannt.

Danach unter *Authentication → Users → Add user* deinen Benutzer anlegen und unter
*Authentication → Sign In / Providers* „Allow new users to sign up“ ausschalten, damit sich niemand sonst registrieren kann.

### Kurzbefehl anpassen

Weil ohne Login nichts mehr geht, muss sich der Kurzbefehl vor dem Speichern anmelden:

1. **Inhalte von URL abrufen** – `POST https://<projekt>.supabase.co/auth/v1/token?grant_type=password`
   - Header: `apikey: <Anon Key>`
   - JSON: `email`, `password`
2. **Wörterbuchwert abrufen** – `access_token` aus der Antwort.
3. **Inhalte von URL abrufen** – `POST https://<projekt>.supabase.co/rest/v1/ausgaben` (bzw. `/einnahmen`)
   - Header: `apikey: <Anon Key>`, `Authorization: Bearer <access_token>`, `Content-Type: application/json`
   - JSON: `datum`, `betrag`, `art`, `kategorie`, `beschreibung` (bei Einnahmen nur `datum`, `betrag`, `beschreibung`)

Niemals den `service_role`-Key in den Kurzbefehl legen – der umgeht alle Schutzregeln.

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

Beim ersten Start auf **Anmelden** tippen und E-Mail + Passwort deines Supabase-Benutzers eingeben.
Projekt-URL ist vorausgefüllt; den Publishable/Anon Key unter „Supabase-Verbindung“ einmalig eintragen
(*Supabase → Project Settings → API Keys*).

Das Passwort wird nicht gespeichert, nur die Anmeldung (verlängert sich selbst). Beim Abmelden
werden auch die zwischengespeicherten Daten vom Gerät gelöscht.

