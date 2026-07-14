# Schema database — Sistema Prenotazioni

Backend Supabase (Postgres + Auth + RLS), multi-tenant: un solo progetto Supabase
serve tutti i locali pilota, isolati tra loro tramite `venue_id` + Row Level
Security.

## Decisioni di design

**Le prenotazioni nascono sempre `in_attesa`.** Sia che arrivino dal widget
pubblico sia che vengano inserite manualmente dallo staff, nessuna
prenotazione viene confermata automaticamente. Il sistema calcola un tavolo
*suggerito* in base a coperti/data/turno (funzione `suggest_table`), ma è
sempre il gestore che accetta o rifiuta dal pannello, eventualmente
cambiando il tavolo assegnato. Questo evita di dover gestire lato DB casi
limite di overbooking "silenzioso": il conflitto, se c'è, lo risolve un
umano al momento della conferma.

Di conseguenza un tavolo è considerato realmente **occupato** solo quando è
collegato a una prenotazione con stato `confermata` o `arrivato`. Più
richieste `in_attesa` possono puntare allo stesso tavolo suggerito: è
normale, il gestore ne accetterà una e per le altre sceglierà un tavolo
diverso o le rifiuterà.

**Niente accorpamento tavoli in questa fase.** Per party che non entrano in
un singolo tavolo (tipicamente 10-12 coperti), se non esiste un tavolo
abbastanza grande il widget restituisce "nessuna disponibilità" e il cliente
è invitato a chiamare il locale. La tabella ponte `reservation_tables` è già
presente per una fase 2 (assegnazione multi-tavolo), ma non è ancora usata
dalla logica applicativa.

**Il widget pubblico non tocca mai la tabella `reservations` direttamente.**
Passa sempre dalla funzione `create_public_reservation()` (SECURITY DEFINER),
che valida tutto lato server (locale attivo, turno valido per quel giorno,
locale non chiuso quel giorno, coperti 1-12, dati cliente presenti) e
inserisce la riga. Questo evita di dover esporre una policy INSERT permissiva
su una tabella che contiene PII dei clienti (nome, cognome, telefono), e
tiene la validazione in un solo posto invece che duplicata nel client.

**Nessun DELETE su `reservations`.** L'annullamento è un cambio di stato
(`annullata`), non una cancellazione fisica, per mantenere lo storico. Le
policy RLS non includono affatto una policy `for delete` sulla tabella.

## Tabelle

| Tabella | Scopo |
|---|---|
| `venues` | Un locale pilota (pizzeria/pub). `slug` è l'identificatore pubblico usato dal widget, `active` disattiva tutto (widget e login) senza cancellare dati. `closed_weekdays` (array ISO dow) è la chiusura settimanale ricorrente: quei giorni sono esclusi dal widget. |
| `venue_staff` | Chi (utente Supabase Auth) gestisce quale locale, con ruolo `owner` (configura zone/tavoli/turni/staff) o `staff` (gestisce solo il servizio). Un utente può stare su più locali. |
| `zones` | Aree del locale (Sala, Dehors...), per raggruppare i tavoli nella mappa visuale. |
| `restaurant_tables` | Tavolo fisico: `seats_max` definisce il numero massimo di coperti gestibili dal tavolo. |
| `service_shifts` | Turni configurabili per locale (es. Turno I 19-21, Turno II 21-23), con `days_of_week` (ISO: 1=lunedì..7=domenica) per gestire orari diversi nel weekend. |
| `venue_closures` | Date di chiusura _straordinaria_ (singole date: ferie, eventi). Diverse da `venues.closed_weekdays`, che è la chiusura _ricorrente_ per giorno della settimana. |
| `reservations` | Cuore del sistema. Stato: `in_attesa → confermata → arrivato / no_show / annullata`. `table_id` è il tavolo suggerito/assegnato (nullable). `source` distingue `widget` da `manuale`. |
| `reservation_tables` | Predisposta per fase 2 (accorpamento tavoli), non ancora usata. |

## Funzioni

- **`suggest_table(venue_id, date, shift_id, party_size)`** — trova il
  tavolo attivo più piccolo che ospita `party_size`, escludendo solo quelli
  già occupati da prenotazioni `confermata`/`arrivato` nello stesso
  giorno/turno. `SECURITY DEFINER`, eseguibile solo da `authenticated`
  (usata dal pannello per la mappa tavoli e internamente da
  `create_public_reservation`).
- **`get_widget_availability(venue_slug, party_size)`** — per il widget:
  elenco dei prossimi N giorni (finestra configurata per locale) × turni
  attivi, con un flag `available` calcolato senza esporre alcun dettaglio
  delle prenotazioni esistenti. `SECURITY DEFINER`, eseguibile da `anon`.
- **`create_public_reservation(...)`** — unico punto di scrittura per il
  widget pubblico. Valida tutto e inserisce sempre con stato `in_attesa`.
  `SECURITY DEFINER`, eseguibile da `anon`.

## RLS — riepilogo per ruolo

| Tabella | anon (widget) | authenticated non-staff | staff del locale | owner del locale |
|---|---|---|---|---|
| `venues` | SELECT se `active` | come anon | SELECT sempre | SELECT + UPDATE |
| `zones` / `restaurant_tables` / `service_shifts` | SELECT se locale attivo | come anon | SELECT sempre | SELECT + INSERT/UPDATE/DELETE |
| `venue_closures` | SELECT se locale attivo | come anon | SELECT sempre | tutto |
| `venue_staff` | — | — | SELECT solo la propria riga | SELECT/INSERT/UPDATE/DELETE per il proprio locale |
| `reservations` | solo via RPC `create_public_reservation` | — | SELECT/INSERT/UPDATE | come staff |
| `reservation_tables` | — | — | SELECT/INSERT/UPDATE/DELETE (via join su reservations) | come staff |

"Staff del locale" = riga presente in `venue_staff` per quel `venue_id`
(qualunque ruolo). Le funzioni helper `is_staff_of(venue_id)` e
`is_owner_of(venue_id)` (in `0007_rls_helpers.sql`) centralizzano questo
controllo in tutte le policy.

## Bootstrap di un nuovo locale (onboarding pilota)

Non essendoci ancora un pannello di onboarding self-service, ogni nuovo
locale pilota va creato manualmente (SQL editor di Supabase o service role),
in quest'ordine:

1. `insert into venues (...)`
2. `insert into zones (...)`, poi `insert into restaurant_tables (...)`
3. `insert into service_shifts (...)`
4. Creare l'utente owner in Supabase Auth (dashboard → Authentication → Users
   → Invite), poi `insert into venue_staff (venue_id, user_id, role) values (..., ..., 'owner')`

Da quel momento in poi l'owner può gestire il proprio staff (`venue_staff`) e
la configurazione sala autonomamente tramite il pannello (RLS già lo
permette), senza bisogno di accesso diretto al database.

## KPI dashboard

La vista `venue_shift_occupancy` (`security_invoker = true`, quindi filtrata
dalla stessa RLS di `reservations`) aggrega per locale/data/turno: numero
prenotazioni per stato e coperti confermati. La % di occupazione va calcolata
lato client dividendo `coperti_confermati` per la capienza totale del locale
(`sum(seats_max)` da `restaurant_tables` dove `active`), perché dipende dalla
configurazione tavoli e non va duplicata nel DB.

## Realtime

La tabella `reservations` è aggiunta alla publication `supabase_realtime`
(`0011_realtime.sql`) così il pannello gestionale riceve insert/update in tempo
reale — es. una prenotazione dal widget compare senza refresh. La consegna
degli eventi rispetta la RLS: ogni client riceve solo le righe del proprio
locale (policy `reservations_select_staff`). La tabella è impostata a
`replica identity full` perché i payload di UPDATE/DELETE includano i valori
usati nei filtri realtime (`venue_id`, `reservation_date`).

## Applicare le migration

```
supabase link --project-ref <ref-progetto>
supabase db push
```

In locale (con Docker):

```
supabase start
supabase db reset   # applica migrations + seed.sql
```

## Estensioni previste ma non ancora implementate (fuori scope di questa fase)

- Accorpamento automatico di più tavoli per party numerosi (`reservation_tables`).
- Notifiche (email/SMS) al cliente su conferma/rifiuto.
- Onboarding self-service di un nuovo locale dal pannello.
