const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.options("*", cors());

// ── Config ────────────────────────────────────────────────────────────────────
const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  REDIRECT_URI,
  SESSION_SECRET,
} = process.env;

const WHOOP_AUTH_URL  = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API       = "https://api.prod.whoop.com/developer";

// Token file — survives Railway process restarts (not new deploys)
const TOKEN_FILE = path.join(process.cwd(), "whoop_tokens.json");

let tokenStore = {
  access_token:  null,
  refresh_token: null,
  expires_at:    null,
};

// ── Token persistence ─────────────────────────────────────────────────────────
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (data.refresh_token) {
        tokenStore = data;
        console.log("✓ Whoop tokens loaded from file — already connected");
      }
    }
  } catch (e) {
    console.log("Could not load tokens from file:", e.message);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore), "utf8");
  } catch (e) {
    console.log("Could not save tokens:", e.message);
  }
}

// Load on startup
loadTokens();

// ── Token helpers ─────────────────────────────────────────────────────────────
async function refreshIfNeeded() {
  if (!tokenStore.refresh_token) throw new Error("Not connected to Whoop");
  const now = Date.now();
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

  saveTokens(); // persist after every refresh
  console.log("✓ Whoop token refreshed at", new Date().toISOString());
}

async function whoopGet(path) {
  await refreshIfNeeded();
  const res = await axios.get(`${WHOOP_API}${path}`, {
    headers: { Authorization: `Bearer ${tokenStore.access_token}` },
  });
  return res.data;
}

// ── Auth: Step 1 ──────────────────────────────────────────────────────────────
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

// ── Auth: Step 2 ──────────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (state !== SESSION_SECRET)
    return res.status(403).send("Invalid state. Please try again.");
  if (!code)
    return res.status(400).send("No code received from Whoop.");

  try {
    const params = new URLSearchParams({
      grant_type:   "authorization_code",
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

    saveTokens(); // persist immediately after login
    console.log("✓ Whoop connected and token saved at", new Date().toISOString());

    res.send(`
      <html>
        <body style="background:#EDE8DE;color:#1A1612;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
          <div style="font-size:48px">✓</div>
          <div style="font-size:22px;font-weight:700">Whoop verbonden!</div>
          <div style="font-size:14px;color:#9A8F82">Token opgeslagen — je hoeft dit niet te herhalen na herstart.</div>
          <div style="font-size:13px;color:#9A8F82">Je kunt dit tabblad sluiten en terug naar de app gaan.</div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Token exchange error:", err.response?.data || err.message);
    res.status(500).send("Verbinding mislukt. <a href='/auth/whoop'>Probeer opnieuw</a>");
  }
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    connected:          !!tokenStore.refresh_token,
    expires_at:         tokenStore.expires_at,
    expires_in_minutes: tokenStore.expires_at
      ? Math.round((tokenStore.expires_at - Date.now()) / 60000)
      : null,
    token_file_exists:  fs.existsSync(TOKEN_FILE),
  });
});

// ── Today ─────────────────────────────────────────────────────────────────────
app.get("/today", async (req, res) => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
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

    res.json({
      fetchedAt:          new Date().toISOString(),
      recovery:           rec?.score?.recovery_score         ?? null,
      hrv:                rec?.score?.hrv_rmssd_milli
                            ? Math.round(rec.score.hrv_rmssd_milli) : null,
      rhr:                rec?.score?.resting_heart_rate     ?? null,
      spo2:               rec?.score?.spo2_percentage
                            ? Math.round(rec.score.spo2_percentage * 10) / 10 : null,
      strain:             cycle?.score?.strain
                            ? Math.round(cycle.score.strain * 10) / 10 : null,
      avgHRDay:           cycle?.score?.average_heart_rate   ?? null,
      sleepPerf:          sleep?.score?.sleep_performance_percentage   ?? null,
      sleepEff:           sleep?.score?.sleep_efficiency_percentage
                            ? Math.round(sleep.score.sleep_efficiency_percentage) : null,
      sleepConsistency:   sleep?.score?.sleep_consistency_percentage   ?? null,
      respRate:           sleep?.score?.respiratory_rate
                            ? Math.round(sleep.score.respiratory_rate * 10) / 10 : null,
      sleepDurationHours: sleep?.score?.stage_summary
                            ? Math.round((sleep.score.stage_summary.total_in_bed_time_milli -
                               sleep.score.stage_summary.total_awake_time_milli) / 360000) / 10
                            : null,
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
                      ? Math.round(w.score.distance_meter / 10) / 100 : null,
        zones: {
          z0: w.score?.zone_durations?.zone_zero_milli  ?? null,
          z1: w.score?.zone_durations?.zone_one_milli   ?? null,
          z2: w.score?.zone_durations?.zone_two_milli   ?? null,
          z3: w.score?.zone_durations?.zone_three_milli ?? null,
          z4: w.score?.zone_durations?.zone_four_milli  ?? null,
          z5: w.score?.zone_durations?.zone_five_milli  ?? null,
        },
      })),
    });
  } catch (err) {
    console.error("/today error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get("/history", async (req, res) => {
  try {
    const days     = parseInt(req.query.days) || 7;
    const start    = new Date();
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
  console.log(`✓ Backend running on port ${PORT}`);
  console.log(`✓ Whoop connected: ${!!tokenStore.refresh_token}`);
  console.log(`✓ Token file exists: ${fs.existsSync(TOKEN_FILE)}`);
});
