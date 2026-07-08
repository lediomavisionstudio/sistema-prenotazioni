# Deploy su Cloudflare Pages

Il frontend è **statico** (HTML/CSS/JS, nessun build step): si pubblica così com'è.
Backend = Supabase (già online). Un solo deploy serve **tutti** i locali (modello
condiviso): ogni locale è un link `?locale=<slug>`.

> ⚠️ **Attenzione a `config.js`**: `public/assets/js/config.js` è in `.gitignore`.
> Contiene `SUPABASE_URL` e la **anon key** (che è pubblica per natura: la
> sicurezza è nelle RLS, non nel segreto). Deve comunque finire online, altrimenti
> il sito non contatta Supabase. Vedi le note per ciascun metodo.

## Metodo A — Direct Upload (consigliato per il primo deploy, senza Git)

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets**.
2. Dai un nome al progetto (es. `prenotazioni`).
3. Trascina il **contenuto della cartella `public/`** (non la cartella stessa):
   assicurati che dentro ci sia anche `assets/js/config.js` con i valori reali.
4. **Deploy**. Ottieni un URL tipo `https://prenotazioni.pages.dev`.
5. Test:
   - Widget cliente: `https://prenotazioni.pages.dev/?locale=pizzeria-da-mario`
   - Pannello: `https://prenotazioni.pages.dev/admin/`

Per aggiornare: ripeti l'upload (nuova versione). Semplice, ma manuale.

## Metodo B — Da Git (deploy automatico ad ogni push)

1. Inizializza il repo e caricalo su GitHub (il progetto **non** è ancora un repo git):
   `git init && git add . && git commit -m "deploy" && git push`.
2. Cloudflare → Pages → **Connect to Git** → seleziona il repo.
3. Build settings: **Framework preset = None**, **Build command = (vuoto)**,
   **Build output directory = `public`**.
4. **config.js con Git**: essendo gitignorato non finisce nel repo. Due opzioni:
   - **Semplice**: togli `config.js` dal `.gitignore` e committalo (la anon key è
     pubblica, è accettabile).
   - **Pulito**: tienilo fuori dal repo e crealo in build da variabili d'ambiente
     Cloudflare (richiede un piccolo script di build).

## Passi comuni dopo il deploy

- **HTTPS**: `*.pages.dev` è già HTTPS — necessario per PWA/service worker (che
  funzionano solo su HTTPS o localhost).
- **Dominio personalizzato** (opzionale): Pages → **Custom domains** → aggiungi il
  dominio e segui il CNAME. HTTPS automatico.
- **Supabase Auth** (solo se userai reset password/email): Supabase → Authentication
  → URL Configuration → aggiungi l'URL del sito come **Site URL**. Per il
  login email/password del pannello non serve nient'altro.

## Test PWA su telefono (item Fase 2)

1. Apri l'URL sul telefono (Chrome su Android, Safari su iOS).
2. Dovrebbe comparire il banner **"Aggiungi alla home…"** (o usa il menu del
   browser → *Aggiungi a schermata Home*).
3. Installa: l'app si apre a tutto schermo, con icona propria.
4. Prova offline: attiva la modalità aereo e riapri — l'interfaccia si carica dalla
   cache (i dati richiedono la rete).

> **Nota cache**: il service worker serve gli asset dalla cache. Dopo aver
> aggiornato il sito, incrementa `CACHE_VERSION` in `public/sw.js` per far
> scaricare le nuove versioni ai dispositivi già installati.

## Logo reale (item Fase 2)

- **Icona app (PWA)**: sostituisci `public/assets/icons/icon.svg` con il logo del
  locale (SVG o PNG quadrato ~512×512). È l'icona su home/installazione.
- **Logo nel widget**: imposta `venues.logo_url` con l'URL di un'immagine (anche
  ospitata altrove). Il widget lo mostra in cima automaticamente.

## Verifica Statistiche (item Fase 2)

Accedi a `.../admin/` con l'utente owner → tab **Statistiche**: controlla che i
grafici (coperti/giorno, occupazione turni, no-show, top clienti, widget vs
manuali) si popolino e che il selettore periodo funzioni.
