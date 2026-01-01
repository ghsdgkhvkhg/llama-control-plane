export function buildMessages({ systemPrompt, memory, history, userText }) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });

  if (memory && memory.trim()) {
    msgs.push({
      role: "system",
      content: `User memory (high priority, factual preferences only):\n${memory.trim()}`
    });
  }

  for (const h of history || []) msgs.push(h);

  msgs.push({ role: "user", content: userText });
  return msgs;
}
