-- Career Readings: one row per reading, from the cast to the finished report.
-- status: cast → awaiting_payment → queued → running → done | failed
-- The id is a random UUID and works as the reading's private link.
-- Rows are read and written only by the server (service role); RLS blocks everyone else.
create table if not exists public.career_readings (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'cast' check (status in ('cast', 'awaiting_payment', 'queued', 'running', 'done', 'failed')),
  seed integer not null,
  cast_at timestamptz not null,
  asked_at timestamptz,
  user_id uuid references public.profiles (id) on delete set null,
  email text check (email is null or char_length(email) <= 254),
  input jsonb,                 -- {person, answers, question}: needed to write and re-render the report
  outputs jsonb,               -- each step's output, saved as the reading is written
  progress jsonb,              -- {done, total}
  report text,                 -- the finished Markdown
  error text,
  paid boolean not null default false,
  preview boolean not null default false,
  stripe_session text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_readings_status on public.career_readings (status);
create index if not exists career_readings_created on public.career_readings (created_at);
alter table public.career_readings enable row level security;   -- server only
