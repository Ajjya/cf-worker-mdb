# Hybrid AI Demo — Cloudflare Workers AI + MongoDB Atlas

A minimal demo showing how to combine **Cloudflare Workers AI** (edge inference)
with **MongoDB Atlas Vector Search** (semantic memory) in a single Worker.

---

## How it works

```
Browser
  │
  │  POST /chat  { message, session_id }
  ▼
Cloudflare Worker  (your code, running at the edge)
  │
  ├─ 1. embed(message)  ──────────────► @cf/baai/bge-small-en-v1.5
  │                                     Returns a 384-dim float vector
  │
  ├─ 2. $vectorSearch ───────────────► MongoDB Atlas
  │      find top-3 past messages        (cosine similarity > 0.7)
  │      that are semantically similar
  │
  ├─ 3. build prompt with context
  │      system: "Here are relevant past messages: ..."
  │      user:   <current message>
  │
  ├─ 4. LLM call ────────────────────► @cf/meta/llama-3.1-8b-instruct
  │      (cheapest capable model on CF AI, ~$0.001 / 1k tokens)
  │
  ├─ 5. embed(assistant reply)  ─────► @cf/baai/bge-small-en-v1.5
  │
  └─ 6. insertMany ──────────────────► MongoDB Atlas
         save { role, content, embedding, session_id, timestamp }
         for both user message and assistant reply
```

**Why store embeddings?**
Every message is saved with its vector. The next time you ask something related,
the Worker finds those past messages via vector search and feeds them as context
to the LLM — giving it a semantic memory across conversations.

---

## Stack

| Layer | What | Cost |
|---|---|---|
| Inference | `@cf/meta/llama-3.1-8b-instruct` | Paid tier (~$0.001/1k tokens) |
| Embeddings | `@cf/baai/bge-small-en-v1.5` | **Free tier** |
| Storage + Vector search | MongoDB Atlas M0 (free cluster) | **Free tier** |
| Hosting | Cloudflare Workers | Free tier (100k req/day) |

---

## Prerequisites

- Node.js ≥ 18
- Wrangler CLI already installed (`wrangler --version` to confirm)
- Cloudflare account (free)
- MongoDB Atlas account with an existing cluster (free M0 is fine)

---

## Setup

### 1. Install dependencies

```bash
yarn
```

### 2. Configure MongoDB Atlas

#### a) Allow network access

Atlas UI → **Network Access** → **Add IP Address** → **Add Current IP Address**

> For production add `0.0.0.0/0` (or Cloudflare IP ranges).

#### b) Create the database and collection

Atlas UI → your cluster → **Browse Collections** → **Create Database**

| Field | Value |
|---|---|
| Database name | `hybrid_ai_demo` |
| Collection name | `messages` |
| Additional Preferences | leave empty |

Click **Create**.

#### c) Get your connection string

Atlas UI → your cluster → **Connect** → **Drivers** → copy the `mongodb+srv://...` string.

#### d) Create the vector search index

1. Atlas UI → your cluster → **Search & Vector Search** tab → **Create Search Index**
2. **Search Type** → select **Vector Search**
3. **How do you want to set up your vector data?** → select **Bring your own embeddings**
4. Select database `hybrid_ai_demo`, collection `messages`, click **Next**
5. Fill in the **Vector Field** form:

| Field | Value |
|---|---|
| Path | `embedding` |
| Number of Dimensions | `384` |
| Similarity Method | `cosine` |

6. **Filter Field** → leave empty (click 🗑️ to remove it)
7. Click **Next** → on the Review screen set the index name to **`vector_index`**
8. Click **Create Search Index** — it takes ~1 minute to become Active

> **Why 384?** `@cf/baai/bge-small-en-v1.5` produces 384-dimensional vectors.
> The index dimension must match exactly.
>
> **Why "Bring your own embeddings"?** Cloudflare AI generates the embeddings
> and saves them to the `embedding` field — Atlas just needs to index them.

### 3. Store the Atlas URI as a Cloudflare secret (one-time)

```bash
wrangler secret put MONGODB_URI
# paste: mongodb+srv://USER:PASS@cluster.mongodb.net/?retryWrites=true&w=majority
```

### 4. Run locally

`wrangler dev --remote` runs the Worker on the **real Cloudflare edge** instead
of the local Miniflare sandbox — this is required so the Worker can reach
MongoDB Atlas over TLS and `$vectorSearch` works fully.

```bash
yarn dev
```

Open **http://localhost:8787** — you'll see the chat UI.
`context_used` in responses will show real numbers once you have a few messages saved.

---

## API reference

### `GET /`
Returns the HTML chat UI.

---

### `POST /chat`
Send a message and get an AI response.

**Request body**
```json
{
  "message": "What is vector search?",
  "session_id": "optional-uuid-to-continue-a-conversation"
}
```

**Response**
```json
{
  "response": "Vector search is ...",
  "session_id": "3f2a1b...",
  "context_used": 2
}
```

`context_used` tells you how many past messages were retrieved from MongoDB
and injected as context into the LLM prompt.

---

### `GET /history?session_id=<id>`
Fetch all saved messages for a session (without embedding vectors).

**Response**
```json
{
  "messages": [
    { "role": "user",      "content": "...", "timestamp": "..." },
    { "role": "assistant", "content": "...", "timestamp": "..." }
  ]
}
```

---

## Deploy to Cloudflare

```bash
yarn deploy
```

Wrangler will print the public Worker URL, e.g.:
`https://cf-worker-mdb.YOUR_SUBDOMAIN.workers.dev`

> The `MONGODB_URI` secret stored via `wrangler secret put` is automatically
> available in production — no extra steps needed.

---

## Project structure

```
cf-worker-mdb/
├── src/
│   └── index.js        ← Worker code (chat, embed, vector search, HTML UI)
├── .dev.vars           ← Local secrets (gitignored)
├── .gitignore
├── package.json
├── wrangler.toml       ← CF Worker config (AI binding, DB names)
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `MongoServerError: $vectorSearch is not allowed` | The vector search index isn't Active yet, or is named differently — must be **`vector_index`** |
| `Authentication failed` | Wrong user/password in `MONGODB_URI`, or the DB user doesn't have `readWrite` on `hybrid_ai_demo` |
| AI binding error locally | Make sure you're logged in: `wrangler login` |
| `numDimensions mismatch` | Index was created with wrong dims — delete it and recreate with `384` |
