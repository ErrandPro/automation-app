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
    title: "Generate carousel posts",
    url: "https://wellen256-n8n.hf.space/webhook/6653114c-69ed-48a6-aeef-85351c9abd72",
  },
  "encouragement": {
    title: "Post text",
    url: "https://wellen256-n8n.hf.space/webhook/dd0b93c3-b456-4b73-81a6-0fc6f7897710",
  },
  "reflection-post": {
    title: "Post text",
    url: "https://wellen256-n8n.hf.space/webhook/6804195a-7738-4e56-ba94-dca325b13874",
  },
  "slide-generator": {
    title: "Text on slide maker",
    url: "https://wellen256-n8n.hf.space/webhook/34391dd7-7713-467f-b10a-d291d0d812b2",
  },
};

// Holds the live node-cron task per engine so we can stop/replace it on save.
const activeJobs = {};

// Converts a plain-English schedule description (e.g. "every weekday at 7am")
// into a 5-field cron expression, using Groq. Called once at save time, not
// on every run, so the schedule stays cheap and stable once it's set.
async function naturalLanguageToCron(description) {
  if (!description || !description.trim()) {
    throw new Error("Please describe when this should run.");
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not configured on the server.");
  }

  const systemPrompt =
    "You convert a plain English scheduling request into a single standard 5-field cron " +
    "expression (minute hour day-of-month month day-of-week), assuming UTC time. " +
    "Respond with ONLY a JSON object in the exact form {\"cron\": \"<expression>\"} and nothing " +
    "else. No markdown, no code fences, no explanation. If the request is ambiguous, make the " +
    "most reasonable choice.";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + groqKey,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error("Groq request failed with status " + res.status);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Could not understand that schedule. Try rephrasing it.");
  }

  if (!parsed.cron || !cron.validate(parsed.cron)) {
    throw new Error("That schedule didn't convert cleanly. Try rephrasing it.");
  }

  return parsed.cron;
}

// Computes the cron expression to store for daily/weekly types. Custom
// descriptions are resolved separately via naturalLanguageToCron.
function buildFixedCronExpression(settings) {
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

// The cron expression is now always precomputed and stored at save time
// (either from time/day fields or via Groq), so scheduling just reads it.
function scheduleEngine(engineId, settings) {
  if (activeJobs[engineId]) {
    activeJobs[engineId].stop();
    delete activeJobs[engineId];
  }

  if (!settings.enabled || settings.schedule_type === "off") return;

  if (!settings.cron_expression || !cron.validate(settings.cron_expression)) {
    console.warn(`[Automate] No valid cron stored for ${engineId}, skipping schedule.`);
    return;
  }

  activeJobs[engineId] = cron.schedule(
    settings.cron_expression,
    () => fireEngine(engineId, settings),
    { timezone: "UTC" }
  );

  console.log(`[Automate] Scheduled ${engineId} with "${settings.cron_expression}"`);
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
    schedule_description,
    instructions,
    tone,
    destination,
    notify_on_failure,
  } = req.body;

  let cron_expression = null;
  let scheduleWarning = null;

  if (schedule_type === "daily" || schedule_type === "weekly") {
    cron_expression = buildFixedCronExpression({ schedule_type, schedule_time, schedule_day });
  } else if (schedule_type === "custom") {
    try {
      cron_expression = await naturalLanguageToCron(schedule_description);
    } catch (err) {
      scheduleWarning = err.message;
    }
  }

  const { data, error } = await supabase
    .from("automation_settings")
    .update({
      enabled,
      schedule_type,
      schedule_time,
      schedule_day,
      schedule_description,
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

  scheduleEngine(engineId, data);

  if (scheduleWarning) {
    return res.status(207).json({ ...data, schedule_warning: scheduleWarning });
  }
  res.json(data);
});

// Instant enable/disable — used by the toggle switch so flipping it takes
// effect immediately without requiring a full "Save settings" click.
app.post("/api/engines/:id/toggle", async (req, res) => {
  const engineId = req.params.id;
  if (!ENGINES[engineId]) return res.status(404).json({ error: "Unknown engine" });

  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }

  const { data, error } = await supabase
    .from("automation_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("engine_id", engineId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  scheduleEngine(engineId, data);
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
