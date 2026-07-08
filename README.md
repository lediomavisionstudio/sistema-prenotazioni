# Sistema Prenotazioni — Pizzerie & Pub

Gestionale prenotazioni per pizzerie e pub, multi-locale (ogni locale ha le
proprie zone/tavoli/turni). Stack: HTML/CSS/JS vanilla + Supabase (EU) +
Cloudflare Pages.

Stato attuale: **backend completo** + **widget cliente** + **pannello
gestionale** + **pagine privacy/cookie/termini** + **PWA**. Restano da fare:
CRM e statistiche avanzate.

## Struttura del progetto

```
supabase/
  config.toml           configurazione Supabase CLI (dev locale)
  migrations/            schema DB, in ordine di applicazione
  seed.sql               dati di esempio per sviluppo locale
public/                  frontend statico (deploy su Cloudflare Pages)
  index.html             widget prenotazione (pagina standalone: CSS+JS inline)
  privacy-policy.html    informativa GDPR per il widget pubblico
  cookie-policy.html     cookie policy
  booking-terms.html     condizioni di prenotazione
  admin/                 pannello gestionale (dietro Supabase Auth)
    index.html            login (email/password)
    dashboard.html/.js    KPI, tab turni, lista+azioni, mappa tavoli, realtime
    settings.html/.js     zone, tavoli, orari turni, chiusura settimanale
    app.js                modulo condiviso: client, auth guard, helper
  assets/
    css/theme.css        design token condivisi (stessi valori del widget)
    css/panel.css        componenti del pannello
    js/config.example.js modello di config (copiare in config.js, gitignorato)
    js/config.js          valori Supabase (anon key) + slug default, gitignorato
docs/
  DATABASE.md            schema, RLS, decisioni di design, bootstrap locale
.env.example              variabili d'ambiente (riferimento)
```

## Widget cliente

Pagina standalone (HTML+CSS+JS in un unico file, `public/index.html`),
responsive e mobile-first, che si appoggia solo alle RPC pubbliche del backend
(`get_widget_availability`, `create_public_reservation`): nessuna logica di
disponibilità è duplicata nel client.

Layout a pagina singola: stepper coperti (1-12) → riga date (prossimi giorni,
chiusure escluse) → slot orario (turni, quelli pieni disabilitati) → form →
conferma con riepilogo (data, ora, coperti, **tavolo assegnato**). Cambiando i
coperti la disponibilità di date e orari si ricalcola in tempo reale. Al submit
il backend assegna automaticamente il tavolo più piccolo adatto ai coperti e
salva la prenotazione **in attesa di conferma** del locale.

**Personalizzazione**: colori (palette carta paglia / marrone inchiostro /
rosso pomodoro) tutti in variabili CSS `:root` in cima al file; font Bricolage
Grotesque (titoli) + Inter (body) da Google Fonts. Il nome del locale è caricato
da Supabase in base allo slug.

Il locale è identificato dallo slug in `?locale=<slug>` (fallback su
`DEFAULT_VENUE_SLUG` in config.js). Ogni locale pilota riceve quindi un link
tipo `https://.../?locale=pizzeria-da-mario`.

## Pannello gestionale (`/admin/`)

Protetto da Supabase Auth (email/password, sessione persistente). Tre pagine
che condividono `theme.css` (stesso design system del widget) e il modulo
`app.js` (client, guardia auth, risoluzione del locale via `venue_staff`).

- **Login** (`admin/index.html`) — se già autenticato reindirizza alla
  dashboard.
- **Dashboard** (`admin/dashboard.html`) — selettore data con frecce, KPI
  (coperti confermati, prenotazioni attive, % occupazione su capienza × n°
  turni), tab per turno, lista prenotazioni con badge stato e azioni
  (attesa→conferma→arrivato / no-show / annulla, con ripristino), mappa tavoli
  per zona colorata per stato con nome cliente, e form inline di prenotazione
  manuale (con tavolo auto-suggerito via `suggest_table`). La lista si aggiorna
  in **tempo reale** via Supabase Realtime: una prenotazione dal widget compare
  senza refresh.
- **Impostazioni** (`admin/settings.html`) — CRUD zone e tavoli, orari turni
  (con giorni della settimana), e chiusura settimanale ricorrente
  (`venues.closed_weekdays`). Le scritture di configurazione sono riservate al
  ruolo `owner` dalla RLS; per lo staff la pagina è in sola lettura.

Accesso: crea l'utente in Supabase Auth e collegalo con una riga in
`venue_staff` (vedi bootstrap in [docs/DATABASE.md](docs/DATABASE.md)). Il
pannello usa lo stesso `config.js` del widget.

### Anteprima locale

```
cd public && npx -y serve . -l 8788
```

Prima serve `public/assets/js/config.js` (copia di `config.example.js`) con
`SUPABASE_URL` e `SUPABASE_ANON_KEY` reali, altrimenti il widget mostra lo
stato di errore "Impossibile contattare il servizio prenotazioni".

Vedi [docs/DATABASE.md](docs/DATABASE.md) per il dettaglio di tabelle, RLS e
funzioni, e per la procedura di onboarding di un nuovo locale pilota.

## Setup

1. Crea un progetto Supabase in region EU.
2. `supabase link --project-ref <ref>` poi `supabase db push` per applicare
   le migration in `supabase/migrations/`.
3. Copia `.env.example` in `.env` e valorizza `SUPABASE_URL` / `SUPABASE_ANON_KEY`
   (dashboard Supabase → Project Settings → API).
4. Segui la procedura di bootstrap in `docs/DATABASE.md` per creare il primo
   locale pilota, la sua sala (zone/tavoli/turni) e l'utente owner.

Il prossimo passo è l'implementazione del frontend (widget pubblico e
pannello gestionale).
