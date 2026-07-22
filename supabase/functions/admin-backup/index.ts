import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BACKUP_SCHEMA = "sistema-prenotazioni-backup";
const BACKUP_VERSION = 1;

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type BackupPayload = Record<string, any>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase service secrets mancanti");
    const body = await req.json().catch(() => ({})) as {
      action?: "export" | "restore";
      venue_id?: string;
      backup?: BackupPayload;
    };
    const venueId = body.venue_id;
    if (!venueId) return json({ error: "venue_id richiesto" }, 400);

    const user = await requireUser(req);
    await requireOwner(user.id, venueId);

    if (body.action === "export") {
      return json({ backup: await buildBackupPayload(venueId, "backup") });
    }

    if (body.action === "restore") {
      validateBackupPayload(body.backup);
      const beforeBackup = await buildBackupPayload(venueId, "pre-ripristino");
      await restoreBackup(venueId, body.backup!);
      return json({ restored: true, before_backup: beforeBackup });
    }

    return json({ error: "azione non supportata" }, 400);
  } catch (error) {
    console.error("[admin-backup] errore", error);
    return json({ error: error instanceof Error ? error.message : "Errore backup" }, 500);
  }
});

async function requireUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Utente non autenticato");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Sessione non valida");
  return data.user;
}

async function requireOwner(userId: string, venueId: string) {
  const { data, error } = await supabase
    .from("venue_staff")
    .select("role")
    .eq("venue_id", venueId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data?.role !== "owner") throw new Error("Permesso negato: solo il titolare puo' gestire i backup");
}

async function rows(table: string, query: any) {
  const { data, error } = await query;
  if (error) {
    console.error(`[admin-backup] lettura ${table} fallita`, error);
    throw error;
  }
  return data || [];
}

async function single(table: string, query: any) {
  const { data, error } = await query;
  if (error) {
    console.error(`[admin-backup] lettura ${table} fallita`, error);
    throw error;
  }
  return data || null;
}

function inOrEmpty(table: string, column: string, ids: string[]) {
  if (!ids.length) return Promise.resolve({ data: [], error: null });
  return supabase.from(table).select("*").in(column, ids);
}

async function buildBackupPayload(venueId: string, reason: string) {
  const venue = await single("venues", supabase.from("venues").select("*").eq("id", venueId).maybeSingle());
  const [
    zones,
    tables,
    shifts,
    closures,
    reservations,
    waitlist,
    customerProfiles,
    menuSettings,
    menuCategories,
  ] = await Promise.all([
    rows("zones", supabase.from("zones").select("*").eq("venue_id", venueId).order("sort_order")),
    rows("restaurant_tables", supabase.from("restaurant_tables").select("*").eq("venue_id", venueId).order("code")),
    rows("service_shifts", supabase.from("service_shifts").select("*").eq("venue_id", venueId).order("sort_order")),
    rows("venue_closures", supabase.from("venue_closures").select("*").eq("venue_id", venueId).order("closed_date")),
    rows("reservations", supabase.from("reservations").select("*").eq("venue_id", venueId).order("reservation_date")),
    rows("waitlist", supabase.from("waitlist").select("*").eq("venue_id", venueId).order("created_at")),
    rows("customer_profiles", supabase.from("customer_profiles").select("*").eq("venue_id", venueId).order("updated_at", { ascending: false })),
    single("menu_settings", supabase.from("menu_settings").select("*").eq("venue_id", venueId).maybeSingle()),
    rows("menu_categories", supabase.from("menu_categories").select("*").eq("venue_id", venueId).order("sort_order")),
  ]);

  const reservationIds = reservations.map((row: any) => row.id).filter(Boolean);
  const categoryIds = menuCategories.map((row: any) => row.id).filter(Boolean);
  const [reservationTables, categoryTranslations, menuItems] = await Promise.all([
    rows("reservation_tables", inOrEmpty("reservation_tables", "reservation_id", reservationIds)),
    rows("menu_category_translations", inOrEmpty("menu_category_translations", "category_id", categoryIds)),
    rows("menu_items", inOrEmpty("menu_items", "category_id", categoryIds)),
  ]);
  const itemIds = menuItems.map((row: any) => row.id).filter(Boolean);
  const [itemTranslations, menuOptions] = await Promise.all([
    rows("menu_item_translations", inOrEmpty("menu_item_translations", "item_id", itemIds)),
    rows("menu_options", inOrEmpty("menu_options", "item_id", itemIds)),
  ]);

  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    reason,
    app: "SISTEMA PRENOTAZIONI",
    venue: { id: venueId, name: venue?.name || "" },
    data: {
      venue,
      zones,
      restaurant_tables: tables,
      service_shifts: shifts,
      venue_closures: closures,
      reservations,
      reservation_tables: reservationTables,
      waitlist,
      customer_profiles: customerProfiles,
      menu_settings: menuSettings,
      menu_categories: menuCategories,
      menu_category_translations: categoryTranslations,
      menu_items: menuItems,
      menu_item_translations: itemTranslations,
      menu_options: menuOptions,
    },
  };
}

function validateBackupPayload(payload?: BackupPayload) {
  if (!payload || typeof payload !== "object") throw new Error("File backup non valido");
  if (payload.schema !== BACKUP_SCHEMA) throw new Error("Schema backup non compatibile");
  if (payload.version !== BACKUP_VERSION) throw new Error("Versione backup non compatibile");
  if (!payload.data?.venue) throw new Error("Dati locale mancanti");
  [
    "zones",
    "service_shifts",
    "restaurant_tables",
    "venue_closures",
    "reservations",
    "reservation_tables",
    "waitlist",
    "customer_profiles",
    "menu_categories",
    "menu_category_translations",
    "menu_items",
    "menu_item_translations",
    "menu_options",
  ].forEach((key) => {
    if (payload.data[key] !== undefined && !Array.isArray(payload.data[key])) {
      throw new Error(`Sezione ${key} non valida`);
    }
  });
}

function withVenue(rows: any[] = [], venueId: string) {
  return rows.map((row) => ({ ...row, venue_id: venueId }));
}

function reservationsForRestore(rows: any[] = [], venueId: string) {
  return withVenue(rows, venueId).map((row) => ({ ...row, created_by: null }));
}

async function deleteByVenue(table: string, venueId: string) {
  const { error } = await supabase.from(table).delete().eq("venue_id", venueId);
  if (error) throw error;
}

async function deleteByIds(table: string, column: string, ids: string[]) {
  if (!ids.length) return;
  const { error } = await supabase.from(table).delete().in(column, ids);
  if (error) throw error;
}

async function upsertRows(table: string, rowsToUpsert: any[] = []) {
  if (!rowsToUpsert.length) return;
  const { error } = await supabase.from(table).upsert(rowsToUpsert);
  if (error) throw error;
}

async function restoreBackup(venueId: string, payload: BackupPayload) {
  const data = payload.data;
  const currentCategories = await rows("menu_categories", supabase.from("menu_categories").select("id").eq("venue_id", venueId));
  const currentCategoryIds = currentCategories.map((row: any) => row.id).filter(Boolean);
  const currentItems = await rows("menu_items", inOrEmpty("menu_items", "category_id", currentCategoryIds));
  const currentItemIds = currentItems.map((row: any) => row.id).filter(Boolean);
  const currentReservations = await rows("reservations", supabase.from("reservations").select("id").eq("venue_id", venueId));
  const currentReservationIds = currentReservations.map((row: any) => row.id).filter(Boolean);

  await deleteByIds("menu_options", "item_id", currentItemIds);
  await deleteByIds("menu_item_translations", "item_id", currentItemIds);
  await deleteByIds("menu_items", "category_id", currentCategoryIds);
  await deleteByIds("menu_category_translations", "category_id", currentCategoryIds);
  await deleteByVenue("menu_categories", venueId);
  await deleteByVenue("menu_settings", venueId);
  await deleteByIds("reservation_tables", "reservation_id", currentReservationIds);
  await deleteByVenue("waitlist", venueId);
  await deleteByVenue("reservations", venueId);
  await deleteByVenue("customer_profiles", venueId);
  await deleteByVenue("venue_closures", venueId);
  await deleteByVenue("restaurant_tables", venueId);
  await deleteByVenue("service_shifts", venueId);
  await deleteByVenue("zones", venueId);

  const venuePatch = Object.fromEntries(Object.entries(data.venue || {}).filter(([key]) =>
    !["id", "created_at", "updated_at"].includes(key)
  ));
  if (Object.keys(venuePatch).length) {
    const { error } = await supabase.from("venues").update(venuePatch).eq("id", venueId);
    if (error) throw error;
  }

  await upsertRows("zones", withVenue(data.zones, venueId));
  await upsertRows("service_shifts", withVenue(data.service_shifts, venueId));
  await upsertRows("restaurant_tables", withVenue(data.restaurant_tables, venueId));
  await upsertRows("venue_closures", withVenue(data.venue_closures, venueId));
  await upsertRows("customer_profiles", withVenue(data.customer_profiles, venueId));
  await upsertRows("reservations", reservationsForRestore(data.reservations, venueId));
  await upsertRows("reservation_tables", data.reservation_tables || []);
  await upsertRows("waitlist", withVenue(data.waitlist, venueId));
  if (data.menu_settings) await upsertRows("menu_settings", [{ ...data.menu_settings, venue_id: venueId }]);
  await upsertRows("menu_categories", withVenue(data.menu_categories, venueId));
  await upsertRows("menu_category_translations", data.menu_category_translations || []);
  await upsertRows("menu_items", data.menu_items || []);
  await upsertRows("menu_item_translations", data.menu_item_translations || []);
  await upsertRows("menu_options", data.menu_options || []);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
