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
npm install
```

### 2. Configure MongoDB Atlas

#### a) Allow network access

In the Atlas UI → **Network Access** → **Add IP Address**
- For local testing add your current IP
- For production add `0.0.0.0/0` (or use Cloudflare IP ranges)

#### b) Get your connection string

Atlas UI → **Database** → **Connect** → **Drivers** → copy the
`mongodb+srv://...` string.

#### c) Create the vector search index

This is the most important step — without it `$vectorSearch` won't work.

1. Atlas UI → your cluster → **Search** tab → **Create Search Index**
2. Choose **Atlas Vector Search** (not "Atlas Search")
3. Select database `hybrid_ai_demo`, collection `messages`
4. Use **JSON editor** and paste:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 384,
      "similarity": "cosine"
    }
  ]
}
```

5. Name the index exactly **`vector_index`**
6. Click **Create** — it takes ~1 minute to become Active

> **Why 384?**  `@cf/baai/bge-small-en-v1.5` produces 384-dimensional vectors.
> The index dimension must match exactly.

### 3. Set local secrets

Edit `.dev.vars` (already created, already in `.gitignore`):

```
MONGODB_URI=mongodb+srv://YOUR_USER:YOUR_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority
```

Replace the placeholders with your real credentials.

### 4. Run locally

```bash
npm run dev
```

Wrangler will print something like:

```
⛅️  wrangler 3.x.x
------------------
⎔  Starting local server...
[wrangler:inf] Ready on http://localhost:8787
```

Open **http://localhost:8787** in your browser — you'll see the chat UI.

> **Note:** Even when running "locally", the Worker still calls the real
> Cloudflare AI service and your real MongoDB Atlas cluster over the internet.
> `wrangler dev` runs the Worker *runtime* locally but does not mock AI or
> external network calls.

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

### 1. Store secrets in Cloudflare (one-time)

```bash
wrangler secret put MONGODB_URI
# paste your connection string when prompted
```

### 2. Deploy

```bash
npm run deploy
```

Wrangler will print the public Worker URL, e.g.:
`https://cf-worker-mdb.YOUR_SUBDOMAIN.workers.dev`

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
