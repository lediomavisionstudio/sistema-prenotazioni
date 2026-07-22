import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue,
  escapeHtml, toast, setAdminLogo,
} from './app.js';

const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  venue: null,
  role: null,
  subscriptions: [],
  campaigns: [],
};

init();

async function init() {
  state.session = await requireSession();
  if (!state.session) return;
  $('logoutBtn').addEventListener('click', confirmSignOut);

  try {
    const current = await loadCurrentVenue();
    if (!current) { location.replace('dashboard.html'); return; }
    state.venue = current.venue;
    state.role = current.role;
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');
    setAdminLogo(current.venue.logo_url || '');
    wire();
    await reload();
    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (error) {
    console.error('[communications] caricamento fallito:', error);
    $('pageSpinner').hidden = true;
    toast('Comunicazioni non caricate.', true);
  }
}

async function reload() {
  const [subs, campaigns] = await Promise.all([
    supabase.from('push_subscriptions').select('*').eq('venue_id', state.venue.id).order('last_seen_at', { ascending: false }),
    supabase.from('push_campaigns').select('*').eq('venue_id', state.venue.id).order('created_at', { ascending: false }).limit(100),
  ]);
  if (subs.error) throw subs.error;
  if (campaigns.error) throw campaigns.error;
  state.subscriptions = subs.data || [];
  state.campaigns = campaigns.data || [];
  renderStats();
  renderCampaigns();
}

function wire() {
  $('communicationTabs').querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });
  $('pushSchedule').addEventListener('change', () => {
    $('pushDateField').hidden = $('pushSchedule').value !== 'future';
  });
  $('notificationForm').addEventListener('submit', sendNotification);
  $('refreshCampaigns').addEventListener('click', reload);
}

function setTab(tab) {
  const active = tab === 'campaigns' ? 'campaigns' : 'notifications';
  $('notificationsPanel').hidden = active !== 'notifications';
  $('campaignsPanel').hidden = active !== 'campaigns';
  $('communicationTabs').querySelectorAll('[data-tab]').forEach((button) =>
    button.classList.toggle('is-active', button.dataset.tab === active));
}

function renderStats() {
  const admin = state.subscriptions.filter((row) => row.audience === 'admin').length;
  const customers = state.subscriptions.filter((row) => row.audience !== 'admin').length;
  $('subscribersCount').textContent = state.subscriptions.length;
  $('adminSubscribersCount').textContent = admin;
  $('customerSubscribersCount').textContent = customers;
  $('pushStatus').textContent = `${state.subscriptions.length} device push`;
}

function renderCampaigns() {
  $('campaignRows').innerHTML = state.campaigns.length
    ? state.campaigns.map((campaign) => `
      <div class="row-item campaign-row">
        <div><strong>${formatDate(campaign.sent_at || campaign.scheduled_for || campaign.created_at)}</strong><span>${escapeHtml(statusLabel(campaign.status))}</span></div>
        <div><strong>${escapeHtml(campaign.title)}</strong><span>${escapeHtml(campaign.message)}</span></div>
        <div><strong>${escapeHtml(audienceLabel(campaign.audience))}</strong><span>Destinatari</span></div>
        <div><strong>${campaign.delivered_count || 0}</strong><span>Consegnate</span></div>
        <div><strong>${campaign.opened_count || 0}</strong><span>Aperte</span></div>
        <div><strong>${campaign.click_count || 0}</strong><span>Click</span></div>
      </div>
    `).join('')
    : '<div class="res-empty">Nessuna campagna inviata.</div>';
}

async function sendNotification(event) {
  event.preventDefault();
  const scheduledFor = $('pushSchedule').value === 'future' ? $('pushScheduledFor').value : '';
  if ($('pushSchedule').value === 'future' && !scheduledFor) {
    toast('Seleziona data e ora della programmazione.', true);
    return;
  }
  const payload = {
    action: 'manual',
    venue_id: state.venue.id,
    title: $('pushTitle').value.trim(),
    message: $('pushMessage').value.trim(),
    image_url: $('pushImage').value.trim() || null,
    link_url: $('pushLink').value.trim() || null,
    audience: $('pushAudience').value,
    scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
  };
  if (!payload.title || !payload.message) return;
  $('sendPushBtn').disabled = true;
  try {
    const { data, error } = await supabase.functions.invoke('send-push-notification', { body: payload });
    if (error || data?.error) throw error || new Error(data.error);
    toast(data?.scheduled ? 'Notifica programmata.' : 'Notifica inviata.');
    $('notificationForm').reset();
    $('pushDateField').hidden = true;
    await reload();
  } catch (error) {
    console.error('[communications] invio push fallito:', error);
    toast('Invio notifica non riuscito.', true);
  } finally {
    $('sendPushBtn').disabled = false;
  }
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusLabel(status) {
  return ({
    draft: 'Bozza',
    scheduled: 'Programmato',
    sending: 'Invio',
    sent: 'Inviata',
    failed: 'Fallita',
  })[status] || status || '-';
}

function audienceLabel(audience) {
  return ({
    all: 'Tutti',
    marketing: 'Clienti marketing',
    loyal: 'Clienti fedeli',
    waitlist: 'Waiting list',
    admin: 'Admin',
  })[audience] || audience || '-';
}
