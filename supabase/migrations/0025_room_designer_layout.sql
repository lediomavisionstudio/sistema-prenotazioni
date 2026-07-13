-- Layout visuale sala per il Designer del gestionale.
-- Migration additiva: non modifica prenotazioni, RPC o flusso booking.

alter table restaurant_tables
  add column if not exists layout_x numeric not null default 80,
  add column if not exists layout_y numeric not null default 80,
  add column if not exists layout_width numeric not null default 120,
  add column if not exists layout_height numeric not null default 90,
  add column if not exists layout_rotation numeric not null default 0,
  add column if not exists layout_shape text not null default 'rectangle',
  add column if not exists layout_color text not null default '#f4c7bb',
  add column if not exists layout_locked boolean not null default false,
  add column if not exists layout_updated_at timestamptz;

create index if not exists restaurant_tables_layout_venue_idx
  on restaurant_tables (venue_id, layout_updated_at);

comment on column restaurant_tables.layout_x is 'Coordinata X del tavolo nel designer sala.';
comment on column restaurant_tables.layout_y is 'Coordinata Y del tavolo nel designer sala.';
comment on column restaurant_tables.layout_width is 'Larghezza visuale del tavolo nel designer sala.';
comment on column restaurant_tables.layout_height is 'Altezza visuale del tavolo nel designer sala.';
comment on column restaurant_tables.layout_rotation is 'Rotazione visuale in gradi nel designer sala.';
comment on column restaurant_tables.layout_shape is 'Forma visuale: square, rectangle o round.';
comment on column restaurant_tables.layout_color is 'Colore visuale del tavolo nel designer sala.';
comment on column restaurant_tables.layout_locked is 'Blocca spostamento/modifica rapida nel designer sala.';
