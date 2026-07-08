# Onboarding di un nuovo locale

Il sistema è **multi-attività su un unico progetto condiviso**: aggiungere un
cliente **non** richiede un nuovo database, né un nuovo deploy, né modifiche al
codice. Si aggiungono solo dati.

Ogni locale è identificato da uno **slug** e riceve un link tipo:

```
https://tuo-dominio.pages.dev/?locale=pub-da-luigi
```

Il pannello gestionale è unico per tutti: `https://tuo-dominio.pages.dev/admin/`
(ogni utente vede solo i locali di cui è staff — lo garantiscono le RLS).

## Procedura (~5 minuti)

1. **Crea il locale** — apri `supabase/onboarding_new_venue.sql`, compila i
   `<SEGNAPOSTO>` del BLOCCO 1 (nome, slug, telefono, indirizzo, eventuali
   chiusure fisse, colore/logo opzionali) ed eseguilo nel **SQL Editor**.

2. **Crea l'utente titolare** — in Supabase: *Authentication → Users → Add user*
   (email + password del cliente). Copia il suo **UUID**.

3. **Collega il titolare al locale** — incolla l'UUID nel BLOCCO 2 di
   `onboarding_new_venue.sql` ed eseguilo.

4. **Configura la sala** — il titolare accede a `/admin/` e imposta da solo, dal
   pannello **Impostazioni**: zone, tavoli, orari turni e chiusure. (In
   alternativa puoi precaricarli via SQL col BLOCCO 3.)

5. **Personalizza l'aspetto (opzionale)** — imposta colore accento e logo:

   ```sql
   update venues
     set brand_primary = '#1f6f4a',
         logo_url = 'https://.../logo.png'
     where slug = 'pub-da-luigi';
   ```

   Il widget applica colore e logo automaticamente; se lasci NULL usa il tema di
   default. (Prerequisito: aver applicato `apply_branding.sql` una volta sola.)

6. **Consegna i link** al cliente:
   - Prenotazioni clienti: `.../?locale=pub-da-luigi`
   - Pannello gestionale: `.../admin/`
   - Privacy: compila i placeholder di `privacy-policy.html` con i dati del locale.

## Cosa NON serve fare

- ❌ Creare un nuovo progetto Supabase
- ❌ Riapplicare le migration
- ❌ Duplicare o rifare il deploy del frontend

Gli aggiornamenti al prodotto (nuove funzioni, correzioni) valgono
automaticamente per **tutti** i locali.

## Se un cliente vuole andarsene

Il locale è titolare dei propri dati. Per esportarli e rimuoverli:

```sql
-- Esporta (esempio): prenotazioni del locale
-- select * from reservations r
-- join venues v on v.id = r.venue_id where v.slug = 'pub-da-luigi';

-- Rimozione completa (cascade su zone/tavoli/turni/prenotazioni/staff)
-- delete from venues where slug = 'pub-da-luigi';
```
