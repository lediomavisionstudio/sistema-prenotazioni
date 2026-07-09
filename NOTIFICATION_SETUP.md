# Setup notifiche prenotazioni

Questa guida configura la prima versione del sistema notifiche:

- email al gestore quando arriva una nuova prenotazione pubblica;
- architettura pronta per future email cliente;
- architettura pronta per futuri reminder WhatsApp ufficiali;
- log backend su `notification_logs`;
- nessuna API key nel frontend o nel repository.

## 1. Applicare la migration

```bash
supabase db push
```

La migration `0020_notifications.sql` aggiunge:

- campi di configurazione notifiche su `venues`;
- campi di tracciamento invio/errori su `reservations`;
- tabella `notification_logs` con RLS in sola lettura per lo staff;
- nessuna policy pubblica di scrittura sui log.

## 2. Deploy Edge Functions

```bash
supabase functions deploy send-admin-booking-email
supabase functions deploy send-customer-email
supabase functions deploy whatsapp-reminder
```

Le funzioni usano `SUPABASE_SERVICE_ROLE_KEY` lato backend. Non inserirla mai in
`public/assets/js/config.js`.

## 3. Secret Supabase richiesti

```bash
supabase secrets set SUPABASE_URL="https://<project-ref>.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
supabase secrets set RESEND_API_KEY="<resend-api-key>"
supabase secrets set EMAIL_FROM="Prenotazioni <prenotazioni@tuodominio.it>"
supabase secrets set PUBLIC_ADMIN_URL="https://tuodominio.it/admin/"
```

`PUBLIC_ADMIN_URL` viene usato nel pulsante "Apri Gestionale" dentro l'email.

## 4. Resend

1. Crea un account Resend.
2. Aggiungi e verifica il dominio mittente.
3. Configura DNS SPF/DKIM/DMARC come indicato da Resend.
4. Genera una API key.
5. Salvala nei Supabase Secrets con `RESEND_API_KEY`.

Il codice supporta Resend in questa versione. Altri provider email possono
essere aggiunti creando un adapter dedicato.

## 5. Destinatario email admin

La funzione sceglie il destinatario cosi:

1. usa `venues.notification_admin_email`, se valorizzata;
2. altrimenti recupera la prima email di un utente `owner` collegato al locale
   in `venue_staff`;
3. se non trova owner con email, prova con lo staff.

Per cambiare il destinatario senza modificare codice:

```sql
update venues
set notification_admin_email = 'gestore@tuodominio.it'
where slug = 'slug-del-locale';
```

Per disattivare l'email admin:

```sql
update venues
set admin_booking_email_enabled = false
where slug = 'slug-del-locale';
```

## 6. Email cliente

La funzione `send-customer-email` e i template HTML sono predisposti ma non
inviano ancora messaggi ai clienti in questa versione.

Template presenti:

- `supabase/functions/_shared/templates/booking-confirmation.html`
- `supabase/functions/_shared/templates/booking-reminder.html`
- `supabase/functions/_shared/templates/booking-cancelled.html`
- `supabase/functions/_shared/templates/booking-modified.html`

Quando verra' attivata, la funzione dovra':

- leggere `reservations.customer_email`;
- scegliere il template;
- inviare via provider email;
- aggiornare `customer_email_sent_at` o `customer_email_error`;
- scrivere sempre su `notification_logs`.

## 7. WhatsApp ufficiale

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

Il provider e' documentato in
`supabase/functions/_shared/services/whatsapp/provider.ts` ed espone:

- `sendWhatsappReminder()`
- `sendWhatsappConfirmation()`
- `sendWhatsappCancellation()`

In questa versione gli adapter sono stub documentati e non inviano messaggi.

## 8. Attivare un reminder futuro

Quando si passa all'invio reale:

1. aggiungere opt-in WhatsApp esplicito nel flusso cliente;
2. usare template approvati Meta/Twilio se richiesti;
3. schedulare `whatsapp-reminder` con Supabase Scheduled Functions o cron esterno;
4. cercare prenotazioni future con `whatsapp_reminder_sent_at is null`;
5. aggiornare `whatsapp_reminder_sent_at` o `whatsapp_reminder_error`;
6. scrivere un record in `notification_logs`.

## 9. Test consigliati

Email admin:

1. applica migration e deploy funzioni;
2. imposta i secret;
3. configura `notification_admin_email` o collega un owner in `venue_staff`;
4. crea una prenotazione dal widget pubblico;
5. verifica arrivo email;
6. controlla `reservations.admin_notification_sent_at`;
7. controlla `notification_logs`.

Error handling:

- se Resend fallisce, la prenotazione resta salvata;
- l'errore viene salvato in `admin_notification_error`;
- viene creato un log `failed`;
- la funzione risponde senza cancellare o bloccare la prenotazione.

## 10. Prima della produzione

- Verificare dominio email e deliverability.
- Inserire segreti solo nei Supabase Secrets.
- Testare email su desktop e mobile.
- Definire policy privacy per email cliente e WhatsApp.
- Attivare WhatsApp solo con opt-in esplicito e provider ufficiale.
