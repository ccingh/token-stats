-- Token Stats · usage_snapshots
-- 在 Supabase SQL Editor 中整段执行一次即可。
--
-- 桌面端使用邮箱密码登录：
--   Authentication → Providers → Email → Enable
--   自用建议关闭 Confirm email

create table if not exists public.usage_snapshots (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null,
  session_count integer not null default 0,
  total_tokens bigint not null default 0,
  cost_usd numeric,
  device_label text,
  updated_at timestamptz not null default now()
);

comment on table public.usage_snapshots is 'Token Stats desktop full-scan snapshot (stats only, one row per user)';

alter table public.usage_snapshots enable row level security;

drop policy if exists "usage_snapshots_select_own" on public.usage_snapshots;
create policy "usage_snapshots_select_own"
  on public.usage_snapshots
  for select
  using (auth.uid() = user_id);

drop policy if exists "usage_snapshots_insert_own" on public.usage_snapshots;
create policy "usage_snapshots_insert_own"
  on public.usage_snapshots
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "usage_snapshots_update_own" on public.usage_snapshots;
create policy "usage_snapshots_update_own"
  on public.usage_snapshots
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 可选：仅允许已登录用户（RLS 已足够；此处不 grant 给 anon 写权限外的额外角色）
grant select, insert, update on public.usage_snapshots to authenticated;
