import { supabase, requireSession, loadCurrentVenue } from './app.js';

const CONFIG = window.APP_CONFIG || {};
let appId = CONFIG.ONESIGNAL_APP_ID || '';
const PROMPT_KEY = 'onesignal-admin-prompt-dismissed-v1';
let initialized = false;
let venueContext = null;

initAdminPush();

async function initAdminPush() {
  if (!supabase || !isSupported()) return;
  const session = await requireSession();
  if (!session) return;
  try {
    appId = await resolveOneSignalAppId();
    if (!appId) {
      console.warn('[push] ONESIGNAL_APP_ID non configurato');
      return;
    }
    venueContext = await loadCurrentVenue();
    if (!venueContext?.venue?.id) return;
    await waitForOneSignal();
    await initOneSignal(session.user.id);
    registerAfterInteraction(session.user.id);
  } catch (error) {
    console.warn('[push] inizializzazione admin non riuscita:', error);
  }
}

async function resolveOneSignalAppId() {
  if (appId) return appId;
  try {
    const { data, error } = await supabase.functions.invoke('register-push-subscription', {
      body: { action: 'config' },
    });
    if (error || !data?.app_id) {
      if (error) console.warn('[push] lettura config OneSignal fallita:', error);
      return '';
    }
    return data.app_id;
  } catch (error) {
    console.warn('[push] config OneSignal non disponibile:', error);
    return '';
  }
}

function isSupported() {
  return ('Notification' in window && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'));
}

function waitForOneSignal() {
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  return new Promise((resolve) => {
    window.OneSignalDeferred.push((OneSignal) => resolve(OneSignal));
  });
}

async function initOneSignal(userId) {
  if (initialized) return;
  await new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      await OneSignal.init({
        appId,
        serviceWorkerPath: '/OneSignalSDKWorker.js',
        allowLocalhostAsSecureOrigin: true,
      });
      await OneSignal.login(`admin:${venueContext.venue.id}:${userId}`);
      initialized = true;
      resolve();
    });
  });
}

function registerAfterInteraction(userId) {
  const handler = async () => {
    window.removeEventListener('click', handler, true);
    window.removeEventListener('keydown', handler, true);
    if (localStorage.getItem(PROMPT_KEY) === '1') return;
    try {
      const granted = await requestPermissionOnce();
      if (!granted) {
        localStorage.setItem(PROMPT_KEY, '1');
        return;
      }
      await saveSubscription(userId);
    } catch (error) {
      console.warn('[push] consenso/registrazione admin non riusciti:', error);
    }
  };
  window.addEventListener('click', handler, true);
  window.addEventListener('keydown', handler, true);
}

async function requestPermissionOnce() {
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

async function saveSubscription(userId) {
  await new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      const subscriptionId = OneSignal.User.PushSubscription.id;
      if (!subscriptionId) {
        resolve();
        return;
      }
      const { error } = await supabase.functions.invoke('register-push-subscription', {
        body: {
          venue_id: venueContext.venue.id,
          audience: 'admin',
          external_id: `admin:${venueContext.venue.id}:${userId}`,
          onesignal_id: OneSignal.User.onesignalId || null,
          subscription_id: subscriptionId,
          notification_permission: Notification.permission,
          browser: navigator.userAgent,
          pwa_installed: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
        },
      });
      if (error) console.warn('[push] salvataggio subscription admin fallito:', error);
      resolve();
    });
  });
}
