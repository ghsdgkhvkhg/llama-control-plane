import express from "express";
import fetch from "node-fetch";
import { supabaseAdmin, requireUser } from "./lib/supabaseAdmin.js";
import { getPod, startPod, stopPod } from "./lib/runpod.js";
import { enqueueRequest, getNextQueued, markRunning, markDone, markFailed } from "./lib/queue.js";
import { buildMessages } from "./lib/prompt.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const sb = supabaseAdmin();

const PRESENCE_ACTIVE_SECONDS = parseInt(process.env.PRESENCE_ACTIVE_SECONDS || "120", 10);
const IDLE_SHUTDOWN_SECONDS = parseInt(process.env.IDLE_SHUTDOWN_SECONDS || "900", 10);

function nowISO() { return new Date().toISOString(); }

async function setModelState(patch) {
  const { error } = await sb
    .from("model_state")
    .upsert({ id: 1, updated_at: nowISO(), ...patch }, { onConflict: "id" });
  if (error) throw error;
}

async function anyUsersOnline() {
  const cutoff = new Date(Date.now() - PRESENCE_ACTIVE_SECONDS * 1000).toISOString();
  const { count, error } = await sb
    .from("user_presence")
    .select("*", { count: "exact", head: true })
    .gte("last_seen", cutoff);

  if (error) throw error;
  return (count || 0) > 0;
}

async function ensurePodRunning() {
  // If users are online, pod should be running
  const online = await anyUsersOnline();
  if (!online) return { ok: true, online: false, action: "none" };

  // try read pod
  let pod;
  try {
    pod = await getPod();
  } catch (e) {
    // still proceed; runpod api hiccup
    return { ok: false, error: String(e) };
  }

  // If desiredStatus isn't RUNNING, resume
  if (pod?.desiredStatus && pod.desiredStatus !== "RUNNING") {
    await startPod();
    await setModelState({ pod_status: "starting", last_start_at: nowISO() });
    return { ok: true, online: true, action: "starting" };
  }

  await setModelState({ pod_status: "running" });
  return { ok: true, online: true, action: "running" };
}

async function maybeStopPodIfIdle() {
  const online = await anyUsersOnline();
  if (online) return { ok: true, action: "kept_running" };

  // if no users online, check last_request_at age
  const { data, error } = await sb.from("model_state").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;

  const lastReq = data?.last_request_at ? new Date(data.last_request_at).getTime() : 0;
  const idleFor = Date.now() - lastReq;

  if (idleFor < IDLE_SHUTDOWN_SECONDS * 1000) {
    return { ok: true, action: "waiting_idle_timeout" };
  }

  // stop pod
  try {
    await stopPod();
    await setModelState({ pod_status: "stopping", last_stop_at: nowISO() });
    return { ok: true, action: "stopping" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// health
app.get("/health", (req, res) => res.json({ ok: true, name: process.env.PUBLIC_APP_NAME || "control-plane" }));

// presence heartbeat (client calls every ~30s)
app.post("/api/presence/heartbeat", async (req, res) => {
  const { user, error } = await requireUser(req, sb);
  if (error) return res.status(401).json({ ok: false, error });

  const { error: upErr } = await sb
    .from("user_presence")
    .upsert({ user_id: user.id, last_seen: nowISO() }, { onConflict: "user_id" });

  if (upErr) return res.status(500).json({ ok: false, error: upErr.message });

  // If someone is online, try ensure pod is running
  const podState = await ensurePodRunning();
  return res.json({ ok: true, pod: podState });
});

// status
app.get("/api/pod/status", async (req, res) => {
  try {
    const pod = await getPod();
    res.json({ ok: true, pod });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// enqueue chat request
app.post("/api/chat", async (req, res) => {
  const { user, error } = await requireUser(req, sb);
  if (error) return res.status(401).json({ ok: false, error });

  const { conversation_id, text } = req.body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ ok: false, error: "missing_text" });

  // update presence opportunistically
  await sb.from("user_presence").upsert({ user_id: user.id, last_seen: nowISO() }, { onConflict: "user_id" });

  // ensure pod running if needed
  const podState = await ensurePodRunning();
  if (!podState.ok) return res.status(500).json({ ok: false, error: podState.error });

  // enqueue
  const enq = await enqueueRequest(sb, user.id, conversation_id || null);
  if (!enq.ok) return res.status(429).json({ ok: false, error: enq.error });

  res.json({ ok: true, queued: enq.item });
});

// worker loop: process queue (single process, FIFO)
async function processQueueOnce() {
  const next = await getNextQueued(sb);
  if (!next) return;

  await markRunning(sb, next.id);
  await setModelState({ last_request_at: nowISO() });

  try {
    // pull user settings + memory
    const { data: settings } = await sb.from("user_settings").select("*").eq("user_id", next.user_id).maybeSingle();
    const systemPrompt = settings?.system_prompt || "You are a helpful assistant.";
    const memory = settings?.memory || "";

    // history (last 20 messages in this conversation)
    let history = [];
    if (next.conversation_id) {
      const { data: msgs } = await sb
        .from("messages")
        .select("role,content,created_at")
        .eq("conversation_id", next.conversation_id)
        .order("created_at", { ascending: true })
        .limit(20);
      history = (msgs || []).map(m => ({ role: m.role, content: m.content }));
    }

    // get the latest user message from request_queue? (we didn’t store it there)
    // For now, we read last pending user message from messages is optional.
    // Minimal: require client to insert message into messages first. We'll add that in UI step.
    // Temporary placeholder:
    const userText = "[CLIENT MUST INSERT USER MESSAGE INTO messages BEFORE /api/chat]";

    const payload = {
      messages: buildMessages({ systemPrompt, memory, history, userText }),
      temperature: settings?.temperature ?? 0.7
    };

    const llamaBase = process.env.LLAMA_BASE_URL;
    const llamaURL = `${llamaBase}/v1/chat/completions`;

    const resp = await fetch(llamaURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-model",
        messages: payload.messages,
        temperature: payload.temperature,
        stream: false
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(json));

    await markDone(sb, next.id, { tokens: json?.usage || null });
  } catch (e) {
    await markFailed(sb, next.id, e);
  }
}

// background loops
setInterval(async () => {
  try {
    await processQueueOnce();
  } catch {}
}, 700); // quick polling, FIFO for 5 users

setInterval(async () => {
  try {
    await maybeStopPodIfIdle();
  } catch {}
}, 60_000);

app.listen(process.env.PORT || 8080, () => {
  console.log("control plane listening on", process.env.PORT || 8080);
});
