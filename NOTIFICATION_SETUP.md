# Setup notifiche prenotazioni

Questa guida configura il sistema notifiche email del progetto.

- Provider predefinito: **Gmail SMTP tramite Nodemailer**.
- Provider mantenuto come fallback futuro: **Resend**.
- Le credenziali restano solo nei **Supabase Secrets**.
- Le funzioni Edge scrivono esiti ed errori su `notification_logs`.
- Le prenotazioni non vengono annullate se l'invio email fallisce.

## 1. Applicare le migration

Non applicare migration automaticamente da Codex. Da terminale:

```bash
supabase db push
```

Verifica che risultino applicate almeno:

- `0020_notifications.sql`
- `0021_public_booking_email.sql`
- `0022_public_reservation_status.sql`

La migration `0020_notifications.sql` aggiunge:

- campi di configurazione notifiche su `venues`;
- campi di tracciamento invio/errori su `reservations`;
- tabella `notification_logs` con RLS in sola lettura per lo staff.

La migration `0021_public_booking_email.sql` aggiorna le RPC pubbliche per salvare `customer_email` e `client_request_id`.

## 2. Deploy Edge Functions

Le funzioni usate dal frontend sono:

```bash
supabase functions deploy send-admin-booking-email
supabase functions deploy send-customer-email
```

`whatsapp-reminder` resta separata:

```bash
supabase functions deploy whatsapp-reminder
```

## 3. Secret Supabase richiesti per Gmail SMTP

Configura Gmail SMTP tramite Supabase Secrets:

```bash
supabase secrets set SMTP_HOST="smtp.gmail.com"
supabase secrets set SMTP_PORT="465"
supabase secrets set SMTP_SECURE="true"
supabase secrets set SMTP_USER="<indirizzo-gmail>"
supabase secrets set SMTP_PASS="<password-per-le-app-google>"
supabase secrets set EMAIL_FROM="<indirizzo-gmail-o-alias-verificato>"
supabase secrets set PUBLIC_ADMIN_URL="https://tuodominio.it/admin/"
supabase secrets set SUPABASE_URL="https://<project-ref>.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

`EMAIL_FROM` deve essere un indirizzo valido e autorizzato nell'account Gmail. Se usi un alias, configurarlo prima in Gmail.

## 4. Creare una Password per le app Google

Gmail SMTP non deve usare la password principale dell'account Google.

Procedura:

1. Accedi all'account Google che inviera' le email.
2. Attiva la verifica in due passaggi. E' obbligatoria per generare una Password per le app.
3. Apri **Account Google > Sicurezza**.
4. Cerca **Password per le app**.
5. Crea una nuova password per l'app, ad esempio con nome `Sistema Prenotazioni`.
6. Copia la password generata.
7. Salvala solo nei Supabase Secrets come `SMTP_PASS`.

Non salvare mai la Password per le app nel repository, nel frontend o in file `.env` committati.

## 5. Destinatario email admin

La funzione `send-admin-booking-email` usa esclusivamente email configurate sul locale:

1. `venues.notification_admin_email`, se valorizzata;
2. `venues.contact_email`, cioe' il campo **Email** nella pagina impostazioni del gestionale.

Non usa l'email di login admin come fallback. Se entrambi i campi sono vuoti, l'email admin non viene inviata e viene scritto un errore nei log.

Per impostare il destinatario senza modificare codice:

```sql
update venues
set notification_admin_email = '<email-reale-gestore>'
where slug = '<slug-locale>';
```

Per disattivare l'email admin:

```sql
update venues
set admin_booking_email_enabled = false
where slug = '<slug-locale>';
```

## 6. Email cliente

La funzione `send-customer-email` invia:

- richiesta ricevuta dopo prenotazione pubblica;
- conferma prenotazione quando l'admin conferma;
- rifiuto/annullamento quando l'admin annulla;
- eventuale email di modifica prenotazione.

L'indirizzo cliente viene letto da `reservations.customer_email`.

Se una prenotazione e' stata creata con una vecchia RPC senza `customer_email`, la funzione prova a usare il fallback passato dal widget subito dopo l'invio e a salvare l'indirizzo nella prenotazione.

## 7. Log e diagnosi

Ogni invio registra:

- provider;
- destinatario;
- tipo email;
- stato;
- message id provider, quando disponibile;
- errore completo, senza password o API key;
- timestamp.

Query utili:

```sql
select channel, kind, recipient, provider, status, error_message, metadata, created_at
from notification_logs
order by created_at desc
limit 20;
```

```sql
select id, customer_email, admin_notification_error, customer_email_error,
       admin_notification_sent_at, customer_email_sent_at
from reservations
order by created_at desc
limit 10;
```

Log funzioni:

```bash
supabase functions logs send-admin-booking-email
supabase functions logs send-customer-email
```

## 8. Passare da Gmail SMTP a Resend

Resend resta disponibile. Per riattivarlo:

```bash
supabase secrets set EMAIL_PROVIDER="resend"
supabase secrets set RESEND_API_KEY="<resend-api-key>"
supabase secrets set EMAIL_FROM="Prenotazioni <prenotazioni@tuodominio.it>"
```

Poi ridistribuisci:

```bash
supabase functions deploy send-admin-booking-email
supabase functions deploy send-customer-email
```

Per tornare a Gmail SMTP:

```bash
supabase secrets unset EMAIL_PROVIDER
```

oppure:

```bash
supabase secrets set EMAIL_PROVIDER="smtp"
```

## 9. Test consigliati

Email admin:

1. applica le migration;
2. deploya le funzioni;
3. imposta i secret Gmail SMTP;
4. configura `notification_admin_email`;
5. crea una prenotazione dal widget pubblico;
6. verifica arrivo email admin;
7. controlla `reservations.admin_notification_sent_at`;
8. controlla `notification_logs`.

Email cliente:

1. crea una prenotazione con email reale del cliente;
2. verifica email "richiesta ricevuta";
3. conferma dal gestionale;
4. verifica email di conferma;
5. crea o usa un'altra prenotazione;
6. annulla dal gestionale;
7. verifica email di rifiuto;
8. controlla `customer_email_sent_at`, `customer_email_error` e `notification_logs`.

Errore provider:

1. rimuovi temporaneamente `SMTP_PASS` dai secrets solo in ambiente test;
2. invia una prenotazione;
3. verifica che la prenotazione resti salvata;
4. verifica `customer_email_error` o `admin_notification_error`;
5. verifica un log `failed` in `notification_logs`.

## 10. Sicurezza

- Non inserire password Gmail nel frontend.
- Non inserire password Gmail nel repository.
- Non salvare password o API key nei log.
- Usa solo Supabase Secrets per `SMTP_PASS`, `RESEND_API_KEY` e `SUPABASE_SERVICE_ROLE_KEY`.
- Usa una Password per le app Google, non la password principale.
- Mantieni attiva la verifica in due passaggi sull'account Google.

## 11. WhatsApp ufficiale

WhatsApp personale o WhatsApp Web non bastano per reminder automatici. Servono:

- Meta WhatsApp Business Platform, oppure
- Twilio WhatsApp.

Secret predisposti per Meta:

```bash
supabase secrets set WHATSAPP_PROVIDER="meta"
supabase secrets set WHATSAPP_ACCESS_TOKEN="<meta-token>"
supabase secrets set WHATSAPP_PHONE_NUMBER_ID="<phone-number-id>"
supabase secrets set WHATSAPP_BUSINESS_ACCOUNT_ID="<business-account-id>"
```

Secret predisposti per Twilio:

```bash
supabase secrets set WHATSAPP_PROVIDER="twilio"
supabase secrets set TWILIO_ACCOUNT_SID="<account-sid>"
supabase secrets set TWILIO_AUTH_TOKEN="<auth-token>"
supabase secrets set TWILIO_WHATSAPP_FROM="whatsapp:+14155238886"
```
