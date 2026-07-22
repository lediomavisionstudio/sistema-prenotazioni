import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = window.APP_CONFIG || {};
let appId = CONFIG.ONESIGNAL_APP_ID || '';
const PROMPT_KEY = 'onesignal-customer-prompt-dismissed-v1';
let client = null;
let initialized = false;
let hasInteracted = false;

if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
  client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

window.BookingPush = {
  registerReservation,
};
window.addEventListener('click', markInteracted, true);
window.addEventListener('keydown', markInteracted, true);

async function registerReservation(summary) {
  if (!client || !summary) return;
  if (!isSupported()) return;
  appId = await resolveOneSignalAppId();
  if (!appId) {
    console.warn('[customer-push] ONESIGNAL_APP_ID non configurato');
    return;
  }
  await waitForInteraction();
  if (localStorage.getItem(PROMPT_KEY) === '1') return;
  try {
    await initOneSignal(summary);
    const granted = await requestPermission();
    if (!granted) {
      localStorage.setItem(PROMPT_KEY, '1');
      return;
    }
    await saveSubscription(summary);
  } catch (error) {
    console.warn('[customer-push] registrazione non riuscita:', error);
  }
}

async function resolveOneSignalAppId() {
  if (appId) return appId;
  try {
    const { data, error } = await client.functions.invoke('register-push-subscription', {
      body: { action: 'config' },
    });
    if (error || !data?.app_id) {
      if (error) console.warn('[customer-push] lettura config OneSignal fallita:', error);
      return '';
    }
    return data.app_id;
  } catch (error) {
    console.warn('[customer-push] config OneSignal non disponibile:', error);
    return '';
  }
}

function isSupported() {
  return ('Notification' in window && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'));
}

function waitForInteraction() {
  if (hasInteracted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('click', done, true);
      window.removeEventListener('keydown', done, true);
      markInteracted();
      resolve();
    };
    window.addEventListener('click', done, true);
    window.addEventListener('keydown', done, true);
  });
}

function markInteracted() {
  hasInteracted = true;
}

async function initOneSignal(summary) {
  if (initialized) return;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  await new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      await OneSignal.init({
        appId,
        serviceWorkerPath: '/OneSignalSDKWorker.js',
        allowLocalhostAsSecureOrigin: true,
      });
      if (summary.customerEmail || summary.customerPhone) {
        await OneSignal.login(`customer:${summary.venueId}:${summary.customerEmail || summary.customerPhone}`);
      }
      initialized = true;
      resolve();
    });
  });
}

async function requestPermission() {
  return await new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      if (OneSignal.Notifications.permission) {
        resolve(true);
        return;
      }
      const result = await OneSignal.Notifications.requestPermission();
      resolve(result === true || OneSignal.Notifications.permission === true);
    });
  });
}

async function saveSubscription(summary) {
  await new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      const subscriptionId = OneSignal.User.PushSubscription.id;
      if (!subscriptionId) {
        resolve();
        return;
      }
      const { error } = await client.functions.invoke('register-push-subscription', {
        body: {
          venue_id: summary.venueId,
          audience: 'customer',
          reservation_id: summary.reservationId || null,
          waitlist_id: summary.waitlistId || null,
          external_id: summary.customerEmail || summary.customerPhone || null,
          onesignal_id: OneSignal.User.onesignalId || null,
          subscription_id: subscriptionId,
          customer_email: summary.customerEmail || null,
          customer_phone: summary.customerPhone || null,
          marketing_consent: !!summary.marketingConsent,
          notification_permission: Notification.permission,
          browser: navigator.userAgent,
          pwa_installed: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
        },
      });
      if (error) console.warn('[customer-push] subscription non salvata:', error);
      resolve();
    });
  });
}
