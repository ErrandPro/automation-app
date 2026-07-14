import express from "express";
import cors from "cors";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // put automate.html + assets in /public

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only, never expose in frontend
);

// Your four production n8n webhooks live here, server-side only.
const ENGINES = {
  "reflections-carousel": {
    title: "Run reflections carousel",
    url: "https://wellen256-n8n.hf.space/webhook/6653114c-69ed-48a6-aeef-85351c9abd72",
  },
  "encouragement": {
    title: "Send encouragement",
    url: "https://wellen256-n8n.hf.space/webhook/dd0b93c3-b456-4b73-81a6-0fc6f7897710",
  },
  "reflection-post": {
    title: "Post reflection",
    url: "https://wellen256-n8n.hf.space/webhook/6804195a-7738-4e56-ba94-dca325b13874",
  },
  "slide-generator": {
    title: "Generate slide",
    url: "https://wellen256-n8n.hf.space/webhook/34391dd7-7713-467f-b10a-d291d0d812b2",
  },
};

// Holds the live node-cron task per engine so we can stop/replace it on save.
const activeJobs = {};

function buildCronExpression(settings) {
  if (settings.schedule_type === "custom") {
    return settings.cron_expression || null;
  }
  if (!settings.schedule_time) return null;
  const [hour, minute] = settings.schedule_time.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  if (settings.schedule_type === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (settings.schedule_type === "weekly") {
    const day = settings.schedule_day ?? 0;
    return `${minute} ${hour} * * ${day}`;
  }
  return null;
}

async function fireEngine(engineId, settings) {
  const engine = ENGINES[engineId];
  if (!engine) return;

  const payload = {
    instructions: settings?.instructions || "",
    tone: settings?.tone || "",
    destination: settings?.destination || "",
    source: "automate-scheduled",
  };

  let status = "success";
  let message = "Ran successfully";
  let outputUrl = null;
  let outputUrls = null;

  try {
    const res = await fetch(engine.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      status = "error";
      message = `Failed with status ${res.status}`;
    } else {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        if (Array.isArray(data?.images)) {
          outputUrls = data.images;
        } else {
          outputUrl = data?.imageUrl || data?.image_url || data?.url || null;
        }
      }
    }
  } catch (err) {
    status = "error";
    message = err.message;
  }

  await supabase
    .from("automation_settings")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: status,
      last_message: message,
      last_output_url: outputUrl,
      last_output_urls: outputUrls,
    })
    .eq("engine_id", engineId);

  if (status === "error" && settings?.notify_on_failure) {
    // Hook this up to Grace/WhatsApp later — placeholder for now.
    console.error(`[Automate] ${engineId} failed: ${message}`);
  }

  return { status, message, outputUrl, outputUrls };
}

function scheduleEngine(engineId, settings) {
  // Clear any existing job before rescheduling.
  if (activeJobs[engineId]) {
    activeJobs[engineId].stop();
    delete activeJobs[engineId];
  }

  if (!settings.enabled || settings.schedule_type === "off") return;

  const cronExpression = buildCronExpression(settings);
  if (!cronExpression || !cron.validate(cronExpression)) {
    console.warn(`[Automate] Invalid cron for ${engineId}: ${cronExpression}`);
    return;
  }

  activeJobs[engineId] = cron.schedule(cronExpression, () => {
    fireEngine(engineId, settings);
  });

  console.log(`[Automate] Scheduled ${engineId} with "${cronExpression}"`);
}

async function loadAllSchedules() {
  const { data, error } = await supabase.from("automation_settings").select("*");
  if (error) {
    console.error("[Automate] Failed to load settings:", error.message);
    return;
  }
  data.forEach((settings) => scheduleEngine(settings.engine_id, settings));
}

// --- Routes ---

app.get("/api/engines", async (req, res) => {
  const { data, error } = await supabase.from("automation_settings").select("*");
  if (error) return res.status(500).json({ error: error.message });

  const merged = data.map((row) => ({
    ...row,
    title: ENGINES[row.engine_id]?.title || row.engine_id,
  }));
  res.json(merged);
});

app.post("/api/engines/:id/settings", async (req, res) => {
  const engineId = req.params.id;
  if (!ENGINES[engineId]) return res.status(404).json({ error: "Unknown engine" });

  const {
    enabled,
    schedule_type,
    schedule_time,
    schedule_day,
    cron_expression,
    instructions,
    tone,
    destination,
    notify_on_failure,
  } = req.body;

  const { data, error } = await supabase
    .from("automation_settings")
    .update({
      enabled,
      schedule_type,
      schedule_time,
      schedule_day,
      cron_expression,
      instructions,
      tone,
      destination,
      notify_on_failure,
      updated_at: new Date().toISOString(),
    })
    .eq("engine_id", engineId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  scheduleEngine(engineId, data); // reschedule immediately, no restart needed
  res.json(data);
});

app.post("/api/engines/:id/trigger", async (req, res) => {
  const engineId = req.params.id;
  if (!ENGINES[engineId]) return res.status(404).json({ error: "Unknown engine" });

  const { data: settings } = await supabase
    .from("automation_settings")
    .select("*")
    .eq("engine_id", engineId)
    .single();

  const result = await fireEngine(engineId, settings);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Automate backend running on port ${PORT}`);
  await loadAllSchedules();
});
