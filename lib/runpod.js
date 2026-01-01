import fetch from "node-fetch";

const RUNPOD_API_BASE = "https://api.runpod.io/graphql";

function gql(query, variables) {
  return { query, variables };
}

export async function runpodRequest(query, variables) {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) throw new Error("Missing RUNPOD_API_KEY");

  const res = await fetch(RUNPOD_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(gql(query, variables))
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`RunPod error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

export async function getPod() {
  const podId = process.env.RUNPOD_POD_ID;
  if (!podId) throw new Error("Missing RUNPOD_POD_ID");

  const q = `
    query Pod($id: String!) {
      pod(input: { podId: $id }) {
        id
        desiredStatus
        runtime {
          uptimeInSeconds
          ports { privatePort publicPort ip }
        }
      }
    }
  `;
  const data = await runpodRequest(q, { id: podId });
  return data.pod;
}

export async function startPod() {
  const podId = process.env.RUNPOD_POD_ID;
  const m = `
    mutation Start($id: String!) {
      podResume(input: { podId: $id }) { id }
    }
  `;
  return runpodRequest(m, { id: podId });
}

export async function stopPod() {
  const podId = process.env.RUNPOD_POD_ID;
  const m = `
    mutation Stop($id: String!) {
      podStop(input: { podId: $id }) { id }
    }
  `;
  return runpodRequest(m, { id: podId });
    }
