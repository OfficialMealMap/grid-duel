/* Accounts and stats, backed by Supabase. The server tells the browser which
   Supabase project to use (GET /api/config). If that isn't available, for
   example when the game is opened as a plain file, accounts are simply off. */
import { createClient } from "@supabase/supabase-js";

let client = null;
let starting = null;

export function initAccount() {
  if (!starting) {
    starting = fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg && cfg.supabaseUrl && cfg.supabaseKey) client = createClient(cfg.supabaseUrl, cfg.supabaseKey);
        return client;
      })
      .catch(() => null);
  }
  return starting;
}

/* The signed-in player's token, sent to the game server so it knows who is playing. */
export async function accessToken() {
  await initAccount();
  if (!client) return "";
  try {
    const { data } = await client.auth.getSession();
    return (data.session && data.session.access_token) || "";
  } catch (e) {
    return "";
  }
}

export async function loadProfile(id) {
  if (!client || !id) return null;
  const { data } = await client.from("profiles").select("id,username,rating,games,wins,losses,streak,best_streak,casual_wins,casual_losses").eq("id", id).maybeSingle();
  return data || null;
}

export async function loadRecentMatches(id) {
  if (!client || !id) return [];
  const { data } = await client
    .from("matches")
    .select("id,winner_side,reason,rounds,eclipse,rated,solaris_delta,noctis_delta,ended_at,solaris_id,noctis_id,solaris:profiles!matches_solaris_id_fkey(username),noctis:profiles!matches_noctis_id_fkey(username)")
    .or(`solaris_id.eq.${id},noctis_id.eq.${id}`)
    .order("ended_at", { ascending: false })
    .limit(8);
  return data || [];
}

export async function loadLeaderboard(limit = 10) {
  await initAccount();
  if (!client) return [];
  const { data } = await client.from("profiles").select("id,username,rating,wins,losses").gt("games", 0).order("rating", { ascending: false }).limit(limit);
  return data || [];
}

export const USERNAME_RULE = /^[A-Za-z0-9_]{3,16}$/;

export async function signUp(username, email, password) {
  if (!client) return { error: "Accounts aren't available right now." };
  if (!USERNAME_RULE.test(username)) return { error: "Usernames are 3 to 16 letters, numbers or underscores." };
  if (password.length < 8) return { error: "Use a password of at least 8 characters." };
  const free = await client.rpc("username_available", { name: username });
  if (free.error) return { error: "Couldn't check that username. Try again." };
  if (!free.data) return { error: "That username is taken." };
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return { error: error.message };
  // With email confirmation on, there's no session until the link is clicked.
  return { confirm: !data.session };
}

export async function signIn(email, password) {
  if (!client) return { error: "Accounts aren't available right now." };
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { error: /confirm/i.test(error.message) ? "Confirm your email first: check your inbox for the link." : "Wrong email or password." };
  return {};
}

export async function signOut() {
  if (client) await client.auth.signOut();
}

/* Calls back with the signed-in user's id (or null) now and whenever it changes. */
export function watchUser(cb) {
  let off = () => {};
  let stopped = false;
  initAccount().then((c) => {
    if (!c || stopped) return cb(null, !!c);
    const { data } = c.auth.onAuthStateChange((_event, session) => {
      // never call Supabase from inside this callback: defer
      setTimeout(() => !stopped && cb(session && session.user ? session.user.id : null, true), 0);
    });
    off = () => data.subscription.unsubscribe();
  });
  return () => {
    stopped = true;
    off();
  };
}
