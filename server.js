const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ── Config from environment variables (set in Railway dashboard) ──────────────
const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  REDIRECT_URI,       // e.g. https://your-app.railway.app/callback
  SESSION_SECRET,     // any random string, e.g. "lars-ironman-2026"
} = process.env;

const WHOOP_AUTH_URL  = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API       = "https://api.prod.whoop.com/developer";

// In-memory token store (persists as long as server runs)
// Railway keeps servers alive — tokens survive restarts via refresh
let tokenStore = {
  access_token:  null,
  refresh_token: null,
  expires_at:    null,
};

// ── Token helpers ─────────────────────────────────────────────────────────────
async function refreshIfNeeded() {
  if (!tokenStore.refresh_token) throw new Error("Not connected to Whoop");
  const now = Date.now();
  // Refresh if expired or within 5 minutes of expiry
  if (tokenStore.expires_at && now < tokenStore.expires_at - 300000) return;
  
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: tokenStore.refresh_token,
    client_id:     WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
  });

  const res = await axios.post(WHOOP_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  tokenStore = {
    access_token:  res.data.access_token,
    refresh_token: res.data.refresh_token || tokenStore.refresh_token,
    expires_at:    Date.now() + (res.data.expires_in * 1000),
  };
  console.log("✓ Whoop token refreshed at", new Date().toISOString());
}

async function whoopGet(path) {
  await refreshIfNeeded();
  const res = await axios.get(`${WHOOP_API}${path}`, {
    headers: { Authorization: `Bearer ${tokenStore.access_token}` },
  });
  return res.data;
}

// ── Step 1: App redirects Lars to Whoop login ─────────────────────────────────
app.get("/auth/whoop", (req, res) => {
  const scope = [
    "offline",
    "read:recovery",
    "read:cycles",
    "read:sleep",
    "read:workout",
    "read:profile",
    "read:body_measurement",
  ].join(" ");

  const url = new URL(WHOOP_AUTH_URL);
  url.searchParams.set("client_id",     WHOOP_CLIENT_ID);
  url.searchParams.set("redirect_uri",  REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         scope);
  url.searchParams.set("state",         SESSION_SECRET);

  res.redirect(url.toString());
});

// ── Step 2: Whoop redirects back with auth code ───────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (state !== SESSION_SECRET) {
    return res.status(403).send("Invalid state — possible CSRF. Please try again.");
  }
  if (!code) {
    return res.status(400).send("No code received from Whoop.");
  }

  try {
    const params = new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
    });

    const tokenRes = await axios.post(WHOOP_TOKEN_URL, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    tokenStore = {
      access_token:  tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_at:    Date.now() + (tokenRes.data.expires_in * 1000),
    };

    console.log("✓ Whoop connected successfully at", new Date().toISOString());
    res.send(`
      <html>
        <body style="background:#0a0c12;color:#3ae87a;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
          <div style="font-size:32px">✓</div>
          <div style="font-size:18px;font-weight:700">Whoop connected!</div>
          <div style="font-size:14px;color:#4a5168">You can close this tab and go back to the app.</div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Token exchange error:", err.response?.data || err.message);
    res.status(500).send("Failed to connect Whoop. Please try again: <a href='/auth/whoop'>Retry</a>");
  }
});

// ── Status endpoint — is Whoop connected? ─────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    connected: !!tokenStore.refresh_token,
    expires_at: tokenStore.expires_at,
    expires_in_minutes: tokenStore.expires_at
      ? Math.round((tokenStore.expires_at - Date.now()) / 60000)
      : null,
  });
});

// ── Today's data — everything in one call ─────────────────────────────────────
app.get("/today", async (req, res) => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0,0,0,0);
    const startStr = start.toISOString();

    const [recoveries, cycles, sleeps, workouts] = await Promise.all([
      whoopGet("/v2/recovery?limit=1").catch(() => null),
      whoopGet("/v2/cycle?limit=1").catch(() => null),
      whoopGet(`/v2/activity/sleep?limit=1&start=${startStr}`).catch(() => null),
      whoopGet(`/v2/activity/workout?limit=5&start=${startStr}`).catch(() => null),
    ]);

    const rec   = recoveries?.records?.[0];
    const cycle = cycles?.records?.[0];
    const sleep = sleeps?.records?.[0];

    const data = {
      fetchedAt:        new Date().toISOString(),
      // Recovery
      recovery:         rec?.score?.recovery_score         ?? null,
      hrv:              rec?.score?.hrv_rmssd_milli
                          ? Math.round(rec.score.hrv_rmssd_milli)
                          : null,
      rhr:              rec?.score?.resting_heart_rate     ?? null,
      spo2:             rec?.score?.spo2_percentage
                          ? Math.round(rec.score.spo2_percentage * 10) / 10
                          : null,
      // Cycle (day strain)
      strain:           cycle?.score?.strain
                          ? Math.round(cycle.score.strain * 10) / 10
                          : null,
      avgHRDay:         cycle?.score?.average_heart_rate   ?? null,
      // Sleep
      sleepPerf:        sleep?.score?.sleep_performance_percentage   ?? null,
      sleepEff:         sleep?.score?.sleep_efficiency_percentage
                          ? Math.round(sleep.score.sleep_efficiency_percentage)
                          : null,
      sleepConsistency: sleep?.score?.sleep_consistency_percentage   ?? null,
      respRate:         sleep?.score?.respiratory_rate
                          ? Math.round(sleep.score.respiratory_rate * 10) / 10
                          : null,
      sleepDurationHours: sleep?.score?.stage_summary
                          ? Math.round(
                              (sleep.score.stage_summary.total_in_bed_time_milli -
                               sleep.score.stage_summary.total_awake_time_milli)
                              / 360000
                            ) / 10
                          : null,
      // Workouts
      workouts: (workouts?.records || []).map(w => ({
        id:         w.id,
        sport:      w.sport_name || "Workout",
        start:      w.start,
        end:        w.end,
        strain:     w.score?.strain ? Math.round(w.score.strain * 10) / 10 : null,
        avgHR:      w.score?.average_heart_rate ?? null,
        maxHR:      w.score?.max_heart_rate     ?? null,
        calories:   w.score?.kilojoule ? Math.round(w.score.kilojoule / 4.184) : null,
        distanceKm: w.score?.distance_meter
                      ? Math.round(w.score.distance_meter / 10) / 100
                      : null,
        zones: {
          z0: w.score?.zone_durations?.zone_zero_milli  ?? null,
          z1: w.score?.zone_durations?.zone_one_milli   ?? null,
          z2: w.score?.zone_durations?.zone_two_milli   ?? null,
          z3: w.score?.zone_durations?.zone_three_milli ?? null,
          z4: w.score?.zone_durations?.zone_four_milli  ?? null,
          z5: w.score?.zone_durations?.zone_five_milli  ?? null,
        },
      })),
    };

    res.json(data);
  } catch (err) {
    console.error("/today error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Historical data (last N days) ─────────────────────────────────────────────
app.get("/history", async (req, res) => {
  try {
    const days  = parseInt(req.query.days) || 7;
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startStr = start.toISOString();

    const [recoveries, cycles, workouts] = await Promise.all([
      whoopGet(`/v2/recovery?limit=${days}&start=${startStr}`).catch(() => null),
      whoopGet(`/v2/cycle?limit=${days}&start=${startStr}`).catch(() => null),
      whoopGet(`/v2/activity/workout?limit=25&start=${startStr}`).catch(() => null),
    ]);

    res.json({
      recoveries: recoveries?.records || [],
      cycles:     cycles?.records     || [],
      workouts:   workouts?.records   || [],
      fetchedAt:  new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:    "Lars Ironman Backend · running",
    connected: !!tokenStore.refresh_token,
    time:      new Date().toISOString(),
  });
});

// ── Auto-refresh token every 45 minutes ──────────────────────────────────────
setInterval(async () => {
  if (tokenStore.refresh_token) {
    try {
      await refreshIfNeeded();
    } catch (e) {
      console.error("Auto-refresh failed:", e.message);
    }
  }
}, 45 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Lars backend running on port ${PORT}`);
  console.log(`✓ Connect Whoop at: ${REDIRECT_URI?.replace("/callback", "/auth/whoop") || "/auth/whoop"}`);
});
