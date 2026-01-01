export async function enqueueRequest(sb, userId, conversationId) {
  const max = parseInt(process.env.MAX_QUEUE_SIZE || "5", 10);

  const { count } = await sb
    .from("request_queue")
    .select("*", { count: "exact", head: true })
    .in("status", ["queued", "running"]);

  if ((count || 0) >= max) {
    return { ok: false, error: "queue_full" };
  }

  const { data, error } = await sb
    .from("request_queue")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      status: "queued"
    })
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, item: data };
}

export async function getNextQueued(sb) {
  const { data, error } = await sb
    .from("request_queue")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

export async function markRunning(sb, id) {
  const { error } = await sb
    .from("request_queue")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function markDone(sb, id, resultMeta = {}) {
  const { error } = await sb
    .from("request_queue")
    .update({ status: "done", finished_at: new Date().toISOString(), result_meta: resultMeta })
    .eq("id", id);
  if (error) throw error;
}

export async function markFailed(sb, id, err) {
  const { error } = await sb
    .from("request_queue")
    .update({ status: "failed", finished_at: new Date().toISOString(), error: String(err).slice(0, 500) })
    .eq("id", id);
  if (error) throw error;
                     }
