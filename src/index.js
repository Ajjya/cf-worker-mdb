/**
 * Cloudflare Worker — Hybrid AI Demo
 *
 * Architecture:
 *  1. User sends a message via the chat UI
 *  2. Worker generates an embedding  (@cf/baai/bge-small-en-v1.5, 384 dims, free)
 *  3. Worker runs a MongoDB Atlas $vectorSearch to retrieve similar past messages
 *  4. Retrieved messages are injected as context into the LLM prompt
 *  5. Worker calls the LLM      (@cf/meta/llama-3.1-8b-instruct)
 *  6. Worker generates an embedding for the assistant reply
 *  7. Both the user message and the assistant reply are saved to MongoDB with their embeddings
 *  8. Response is returned to the UI
 *
 * Bindings (wrangler.toml / secrets):
 *  - env.AI           → Workers AI binding
 *  - env.MONGODB_URI  → Atlas connection string (secret)
 *  - env.MONGODB_DATABASE   → database name
 *  - env.MONGODB_COLLECTION → collection name
 */

import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// MongoDB connection — singleton with automatic reconnect.
//
// "Topology is closed" means the driver's internal connection pool was shut
// down (idle timeout, network blip, Worker cold-start reuse of a stale
// module-level variable). We detect that state and reconnect transparently.
// ---------------------------------------------------------------------------
let _client = null;

function isConnected(client) {
  try {
    // topology is set and not closed
    return client && client.topology && client.topology.isConnected();
  } catch {
    return false;
  }
}

async function getDB(env) {
  if (!isConnected(_client)) {
    // Close the stale client if it exists so we don't leak sockets
    if (_client) {
      try { await _client.close(true); } catch { /* ignore */ }
      _client = null;
    }
    _client = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15_000,
      connectTimeoutMS: 15_000,
      socketTimeoutMS: 45_000,
      tls: true,
      tlsAllowInvalidCertificates: false,
      checkServerIdentity: () => undefined, // required for Workers TLS compat
    });
    await _client.connect();
  }
  return _client.db(env.MONGODB_DATABASE).collection(env.MONGODB_COLLECTION);
}

// ---------------------------------------------------------------------------
// Simple HTML chat UI (served at GET /)
// ---------------------------------------------------------------------------
const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hybrid AI Demo</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d0d0d;
      color: #e5e5e5;
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 14px 20px;
      background: #161616;
      border-bottom: 1px solid #2a2a2a;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    header h1 { font-size: 15px; font-weight: 600; }
    header span { font-size: 12px; color: #666; }
    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .bubble {
      max-width: 72%;
      padding: 11px 15px;
      border-radius: 14px;
      line-height: 1.55;
      font-size: 14px;
      white-space: pre-wrap;
    }
    .user      { align-self: flex-end;   background: #1d4ed8; }
    .assistant { align-self: flex-start; background: #1c1c1c; border: 1px solid #2a2a2a; }
    .assistant.thinking { opacity: 0.5; font-style: italic; }
    .ctx-note  { font-size: 10px; color: #555; margin-top: 6px; }
    #form {
      padding: 14px 20px;
      background: #161616;
      border-top: 1px solid #2a2a2a;
      display: flex;
      gap: 10px;
    }
    #input {
      flex: 1;
      padding: 11px 15px;
      background: #222;
      border: 1px solid #333;
      border-radius: 10px;
      color: #e5e5e5;
      font-size: 14px;
      outline: none;
    }
    #input:focus { border-color: #1d4ed8; }
    #send {
      padding: 11px 22px;
      background: #1d4ed8;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    #send:disabled { opacity: 0.45; cursor: not-allowed; }
  </style>
</head>
<body>
  <header>
    <h1>🤖 Hybrid AI Demo</h1>
    <span>Cloudflare Workers AI + MongoDB Atlas Vector Search</span>
  </header>
  <div id="chat"></div>
  <form id="form">
    <input id="input" placeholder="Ask anything…" autocomplete="off" />
    <button id="send" type="submit">Send</button>
  </form>

  <script>
    // Each browser tab gets its own session so histories don't mix
    const SESSION = crypto.randomUUID();
    const chatEl  = document.getElementById('chat');
    const inputEl = document.getElementById('input');
    const sendEl  = document.getElementById('send');

    function appendBubble(role, text, ctxCount = 0) {
      const div = document.createElement('div');
      div.className = 'bubble ' + role;
      div.textContent = text;
      if (ctxCount > 0) {
        const note = document.createElement('div');
        note.className = 'ctx-note';
        note.textContent = '📚 ' + ctxCount + ' similar past message(s) used as context';
        div.appendChild(note);
      }
      chatEl.appendChild(div);
      chatEl.scrollTop = chatEl.scrollHeight;
      return div;
    }

    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = '';
      sendEl.disabled = true;
      appendBubble('user', text);

      const thinking = appendBubble('assistant thinking', 'Thinking…');

      try {
        const res  = await fetch('/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ message: text, session_id: SESSION }),
        });
        const data = await res.json();
        thinking.remove();

        if (data.error) {
          appendBubble('assistant', '⚠️ ' + data.error);
        } else {
          appendBubble('assistant', data.response, data.context_used ?? 0);
        }
      } catch (err) {
        thinking.remove();
        appendBubble('assistant', '⚠️ Network error: ' + err.message);
      }

      sendEl.disabled = false;
      inputEl.focus();
    });
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return html(HTML);
      }

      if (url.pathname === "/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/history" && request.method === "GET") {
        return await handleHistory(request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// POST /chat
// Body: { message: string, session_id?: string }
// ---------------------------------------------------------------------------
async function handleChat(request, env) {
  const body = await request.json();
  const { message, session_id } = body;

  if (!message || typeof message !== "string") {
    return json({ error: "message (string) is required" }, 400);
  }

  const sessionId = session_id || crypto.randomUUID();

  // ── Step 1: embed the user message ───────────────────────────────────────
  // Model: @cf/baai/bge-small-en-v1.5  (free tier, 384-dimensional output)
  const userEmbedding = await embed(env, message);

  // ── Step 2: vector search — find similar past messages ───────────────────
  // Requires a MongoDB Atlas vector search index named "vector_index".
  // Falls back gracefully when running against local MongoDB (no vector index).
  let similarDocs = [];
  try {
    similarDocs = await vectorSearch(env, userEmbedding, 10);
    console.log("vectorSearch results:", similarDocs.length, similarDocs.map(d => ({score: d.score, content: d.content?.slice(0, 50)})));
  } catch (e) {
    // $vectorSearch is Atlas-only — silently skip when running locally
    console.warn("vectorSearch skipped:", e.message);
  }

  // ── Step 3: build LLM prompt with retrieved context ──────────────────────
  const contextBlock =
    similarDocs.length > 0
      ? "Relevant past context from memory:\n" +
        similarDocs.map((d) => `${d.role}: ${d.content}`).join("\n") +
        "\n\n"
      : "";

  // ── Step 4: call the LLM ─────────────────────────────────────────────────
  // Model: @cf/meta/llama-3.1-8b-instruct  (cheapest capable model on CF)
  const llmResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {
        role: "system",
        content: contextBlock
          ? `You are a helpful assistant. You have access to memory of past conversations. IMPORTANT: The following messages are REAL excerpts from previous conversations with this user. You MUST use this information to answer:\n\n${contextBlock}Answer the user's question using the context above. If the context contains relevant information, state it directly and confidently.`
          : "You are a helpful assistant. Answer the user concisely and helpfully.",
      },
      { role: "user", content: message },
    ],
  });

  const assistantText = llmResult.response;

  // ── Step 5: embed the assistant reply ────────────────────────────────────
  const assistantEmbedding = await embed(env, assistantText);

  // ── Step 6: persist both messages with their embeddings ──────────────────
  const col = await getDB(env);
  const now = new Date().toISOString();

  await col.insertMany([
    {
      role: "user",
      content: message,
      embedding: userEmbedding,
      session_id: sessionId,
      timestamp: now,
    },
    {
      role: "assistant",
      content: assistantText,
      embedding: assistantEmbedding,
      session_id: sessionId,
      timestamp: now,
    },
  ]);

  return json({
    response: assistantText,
    session_id: sessionId,
    context_used: similarDocs.length,
  });
}

// ---------------------------------------------------------------------------
// GET /history?session_id=<id>
// Returns all messages for a session (without embedding vectors)
// ---------------------------------------------------------------------------
async function handleHistory(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return json({ error: "session_id query param is required" }, 400);
  }

  const col = await getDB(env);

  const messages = await col
    .find(
      { session_id: sessionId },
      { projection: { embedding: 0 } } // don't return huge float arrays
    )
    .sort({ timestamp: 1 })
    .limit(100)
    .toArray();

  return json({ messages });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a 384-dimensional embedding vector using Workers AI.
 * @cf/baai/bge-small-en-v1.5 is on the free tier — no cost per request.
 */
async function embed(env, text) {
  const result = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: [text],
  });
  return result.data[0]; // Float32Array-like, 384 dimensions
}

/**
 * Run a $vectorSearch aggregation against MongoDB Atlas.
 * Only returns documents with a cosine similarity score > 0.7.
 *
 * Requires a vector search index named "vector_index" on the
 * `embedding` field (see README).
 */
async function vectorSearch(env, queryVector, limit = 3) {
  const col = await getDB(env);

  const results = await col
    .aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: Array.from(queryVector), // must be a plain JS array
          numCandidates: 150,                   // candidates scanned (>= 10 × limit)
          limit,
          filter: { role: "user" },
        },
      },
      {
        $project: {
          role: 1,
          content: 1,
          session_id: 1,
          timestamp: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray();

  // Deduplicate by content, keep top 10, min score 0.3
  // Sort by combined rank: similarity score (70%) + recency (30%)
  const seen = new Set();
  const now = Date.now();
  const ONE_DAY = 86_400_000;

  return results
    .filter((d) => {
      if (d.score < 0.3) return false;
      if (seen.has(d.content)) return false;
      seen.add(d.content);
      return true;
    })
    .map((d) => {
      const ageMs = now - new Date(d.timestamp).getTime();
      const recencyScore = Math.exp(-ageMs / (7 * ONE_DAY)); // decays over 7 days
      d._rank = 0.7 * d.score + 0.3 * recencyScore;
      return d;
    })
    .sort((a, b) => b._rank - a._rank);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
