-- Grid Duel database: player profiles, match history and stats.
-- Already applied to the "Grid Duel" Supabase project. Kept here for reference.

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  rating integer not null default 1000,
  games integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  streak integer not null default 0,
  best_streak integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index profiles_username_lower_key on public.profiles (lower(username));
create index profiles_rating_idx on public.profiles (rating desc);

-- ----------------------------------------------------------------- matches
create table public.matches (
  id bigint generated always as identity primary key,
  room_code text not null,
  solaris_id uuid references public.profiles (id) on delete set null,
  noctis_id uuid references public.profiles (id) on delete set null,
  winner_side smallint not null check (winner_side in (1, 2)),
  reason text not null check (reason in ('capture', 'time', 'left', 'resign')),
  rounds integer not null default 1,
  eclipse boolean not null default false,
  rated boolean not null default false,
  solaris_delta integer not null default 0,
  noctis_delta integer not null default 0,
  started_at timestamptz,
  ended_at timestamptz not null default now()
);
create index matches_solaris_idx on public.matches (solaris_id, ended_at desc);
create index matches_noctis_idx on public.matches (noctis_id, ended_at desc);

-- ------------------------------------------------------------------ access
-- Anyone can read profiles and match history. Nobody can write from the
-- browser: only the game server (using the secret key) records results.
alter table public.profiles enable row level security;
alter table public.matches enable row level security;

create policy "Profiles are public" on public.profiles for select to anon, authenticated using (true);
create policy "Matches are public" on public.matches for select to anon, authenticated using (true);

revoke all on public.profiles, public.matches from anon, authenticated;
grant select on public.profiles, public.matches to anon, authenticated;

-- ------------------------------------------------- profile on account sign-up
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  candidate text;
  n integer := 0;
begin
  base := regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', ''), '[^A-Za-z0-9_]', '', 'g');
  if length(base) < 3 then
    base := 'Player';
  end if;
  base := left(base, 16);
  candidate := base;
  -- if the name is taken, add digits until it isn't
  while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
    n := n + 1;
    candidate := left(base, 12) || (floor(random() * 9000) + 1000)::integer::text;
    exit when n > 20;
  end loop;
  insert into public.profiles (id, username) values (new.id, candidate);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.username_available(name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select name ~ '^[A-Za-z0-9_]{3,16}$'
    and not exists (select 1 from public.profiles p where lower(p.username) = lower(name));
$$;

-- ------------------------------------------------------ recording a result
-- Called by the game server when an online match ends. Saves the match and
-- updates both players' stats in one step. Rating (Elo, K = 32) only changes
-- when both players are signed in.
create function public.record_match(
  p_room text,
  p_solaris uuid,
  p_noctis uuid,
  p_winner_side integer,
  p_reason text,
  p_rounds integer,
  p_eclipse boolean,
  p_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r1 integer;
  r2 integer;
  d1 integer := 0;
  d2 integer := 0;
  expected1 numeric;
  is_rated boolean;
begin
  if p_winner_side not in (1, 2) then
    raise exception 'winner_side must be 1 or 2';
  end if;
  if p_solaris is null and p_noctis is null then
    return null; -- two guests: nothing to record
  end if;
  if p_solaris is not null and p_solaris = p_noctis then
    return null; -- someone playing themselves
  end if;

  -- lock both rows in a fixed order
  perform 1 from public.profiles where id in (p_solaris, p_noctis) order by id for update;
  select rating into r1 from public.profiles where id = p_solaris;
  select rating into r2 from public.profiles where id = p_noctis;

  is_rated := r1 is not null and r2 is not null;
  if is_rated then
    expected1 := 1 / (1 + power(10::numeric, (r2 - r1) / 400.0));
    d1 := round(32 * ((case when p_winner_side = 1 then 1 else 0 end) - expected1));
    d2 := -d1;
  end if;

  update public.profiles set
    games = games + 1,
    wins = wins + (case when p_winner_side = 1 then 1 else 0 end),
    losses = losses + (case when p_winner_side = 1 then 0 else 1 end),
    streak = case when p_winner_side = 1 then streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when p_winner_side = 1 then streak + 1 else 0 end),
    rating = greatest(100, rating + d1)
  where id = p_solaris;

  update public.profiles set
    games = games + 1,
    wins = wins + (case when p_winner_side = 2 then 1 else 0 end),
    losses = losses + (case when p_winner_side = 2 then 0 else 1 end),
    streak = case when p_winner_side = 2 then streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when p_winner_side = 2 then streak + 1 else 0 end),
    rating = greatest(100, rating + d2)
  where id = p_noctis;

  insert into public.matches (room_code, solaris_id, noctis_id, winner_side, reason, rounds, eclipse, rated, solaris_delta, noctis_delta, started_at)
  values (p_room, p_solaris, p_noctis, p_winner_side, p_reason, greatest(1, p_rounds), coalesce(p_eclipse, false), is_rated, d1, d2, p_started_at);

  return jsonb_build_object('rated', is_rated, 'd1', d1, 'd2', d2);
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.record_match(text, uuid, uuid, integer, text, integer, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.record_match(text, uuid, uuid, integer, text, integer, boolean, timestamptz) to service_role;
grant execute on function public.username_available(text) to anon, authenticated;

-- ------------------------------------------------ ranked and casual modes
-- Applied later as its own migration: profiles gained casual_wins and
-- casual_losses, and record_match gained p_ranked (default true). Ranked
-- matches change rating and the ranked record; casual matches only add to
-- the casual record. See the Supabase project's migration history for the
-- exact function body.
