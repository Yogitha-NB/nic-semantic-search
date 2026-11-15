# NIC 2025 Semantic Search

Describe a business in plain English and get the closest **official NIC 2025** codes
(India's National Industrial Classification, released by MoSPI on 18 Nov 2025), each
with its full hierarchy, official description, similarity score and an AI explanation
of why it fits.

| Layer      | Technology                                                      |
|------------|-----------------------------------------------------------------|
| Frontend   | Next.js 14 (App Router), TypeScript, Tailwind CSS               |
| Backend    | Python, FastAPI, pydantic-settings                              |
| Embeddings | `sentence-transformers/all-MiniLM-L6-v2` (384-dim, CPU, ~90 MB) |
| Vector DB  | Pinecone serverless (cosine)                                    |
| LLM        | Groq (`openai/gpt-oss-20b` or `openai/gpt-oss-120b`; Groq retired the Llama 3.x models on 16 Aug 2026) via LangChain + `langchain-groq` |

---

## 1. Architecture

```
 Browser (Next.js, :3000)
        |  POST /search { query, top_k }
        v
 FastAPI (:8000)
   1. embeddings.py       query -> 384-dim vector (local, CPU, model loaded once)
   2. pinecone_client.py  top-k nearest NIC records (cosine) + metadata
   3. llm.py              LangChain: prompt | ChatGroq | parser -> explanation
        |
        v
 JSON { results[code, hierarchy, description, score], explanation }
```

**Offline ingestion (run once):** `scripts/ingest_nic.py` reads
`data/nic_2025_cleaned.csv`, embeds each record in batches of 64 and upserts it to
Pinecone. Vector ID = NIC code, so re-running updates records instead of duplicating.

**Design notes**

- The LLM only *explains*. It receives the retrieved codes and is told never to invent
  codes, so every code shown comes from the official data.
- If Groq fails (rate limit, network), the search results are still returned with a
  notice. Search never fails because of the LLM.
- Low-RAM choices: CPU-only PyTorch, a 90 MB model loaded once (`lru_cache`), small
  embedding batches, and `TORCH_NUM_THREADS=2`. Expect roughly 600-900 MB for the
  backend process.
- Similarity is Pinecone's cosine score shown as a percentage. MiniLM scores for short
  queries are often in the 30-70% range, so use the *ranking* more than the absolute
  number.

---

## 2. Project structure

```
nic-semantic-search/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py             FastAPI app, /health and /search
│   │   ├── config.py           pydantic-settings
│   │   ├── embeddings.py       cached SentenceTransformer
│   │   ├── pinecone_client.py  cached Pinecone client, index creation, query
│   │   ├── llm.py              LangChain + Groq explanation
│   │   └── schemas.py          request/response models
│   ├── scripts/ingest_nic.py   CSV -> embeddings -> Pinecone
│   ├── requirements.txt
│   └── .env.example
├── frontend/                   Next.js 14 app (app/page.tsx is the whole UI)
├── data/                       put nic_2025_cleaned.csv here
└── README.md
```

---

## 3. Getting the real NIC 2025 data

This repository intentionally ships **no sample data**. You build the CSV from the
official MoSPI publication.

1. Open the Ministry of Statistics and Programme Implementation site,
   <https://www.mospi.gov.in>, and go to **Documents > Publications/Reports**. Search
   for **National Industrial Classification 2025 (NIC 2025)** and download the PDF.
   MoSPI also offers a lookup tool at <https://nicfinder.mospi.gov.in/> for spot-checking
   individual codes.
2. Convert the classification tables into `data/nic_2025_cleaned.csv`. Parse the PDF
   with a tool such as `pdfplumber` or Camelot and check the result by hand: layout
   differences between sections are common.
3. Use this exact header (UTF-8). Only `code` and `description` are required, but the
   hierarchy columns are what make the results informative:

```csv
code,title,description,section_code,section,division_code,division,group_code,group,class_code,class
<6-digit code>,<sub-class title>,<official description>,<section>,<section title>,<division>,<division title>,<group>,<group title>,<class>,<class title>
```

Rules for the CSV:

- **Keep `code` as text.** Opening and re-saving in Excel can strip leading zeros; check
  the file afterwards in a text editor.
- One row per **6-digit sub-class**. Codes must be unique.
- Copy official wording; do not paraphrase.
- The ingest script warns about codes that are not 6 digits, empty rows and duplicates.

---

## 4. Create the Pinecone index

You can let the ingest script create it automatically, or create it by hand.

1. Sign up at <https://app.pinecone.io> and copy your API key from **API Keys**.
2. **Create index** with:
   - Name: `nic-2025` (must match `PINECONE_INDEX_NAME`)
   - Dimensions: **384**
   - Metric: **cosine**
   - Type: **Serverless**, cloud `aws`, region `us-east-1` (free plan region)
3. Or skip step 2: `ingest_nic.py` creates a serverless index with exactly these settings
   if the name does not exist, and stops with an error if an index of the same name has a
   different dimension or metric.

---

## 5. Get a Groq API key

1. Go to <https://console.groq.com> and sign in.
2. Open **API Keys**, click **Create API Key**, and copy it (it is shown once).
3. Choose the model in `.env`:
   - `openai/gpt-oss-20b`: fast, good for this task (default)
   - `openai/gpt-oss-120b`: better explanations, slower
   - Check https://console.groq.com/docs/models for the current list

---

## 6. Setup

Prerequisites: Python 3.10+ (3.11 recommended), Node.js 18.17+ (20 LTS recommended).

### Backend (Windows PowerShell)

```powershell
cd nic-semantic-search\backend
python -m venv venv
.\venv\Scripts\Activate.ps1

# CPU-only PyTorch first (much smaller, lower RAM), then the rest
pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt

copy .env.example .env      # then edit .env and add both API keys
```

macOS / Linux: `source venv/bin/activate` and `cp .env.example .env`.

### Load the data (once)

Place `nic_2025_cleaned.csv` in `data\`, then:

```powershell
python scripts\ingest_nic.py
# optional: python scripts\ingest_nic.py --csv ..\data\nic_2025_cleaned.csv --batch-size 64
```

The first run downloads the embedding model (~90 MB). Ingestion shows a progress bar and
finishes by printing the vector count (Pinecone stats can lag a few seconds).

### Run the backend

```powershell
uvicorn app.main:app --reload --port 8000
```

Check <http://localhost:8000/health> and the interactive docs at
<http://localhost:8000/docs>.

> On a very small machine, drop `--reload` (the reloader starts a second process that
> loads the model again).

### Frontend

```powershell
cd nic-semantic-search\frontend
copy .env.local.example .env.local
npm install
npm run dev
```

Open <http://localhost:3000>. Press **Ctrl/Cmd + Enter** in the box to search.

---

## 7. Environment variables

`backend/.env`:

```env
PINECONE_API_KEY=your-pinecone-api-key
PINECONE_INDEX_NAME=nic-2025
PINECONE_NAMESPACE=nic-2025
PINECONE_CLOUD=aws
PINECONE_REGION=us-east-1

GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=openai/gpt-oss-20b
GROQ_MAX_TOKENS=1500

EMBEDDING_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
TORCH_NUM_THREADS=2
```

`frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

## 8. API

`GET /health` returns configuration and whether the model is loaded. It makes no external calls.

`POST /search`

```json
{ "query": "We stitch and export cotton shirts", "top_k": 5 }
```

Response (shape):

```json
{
  "query": "...",
  "results": [
    {
      "code": "<NIC code>",
      "description": "<official description>",
      "hierarchy": [{ "level": "Section", "code": "...", "title": "..." }],
      "score": 0.62,
      "score_percent": 62
    }
  ],
  "explanation": "...",
  "explanation_error": null,
  "took_ms": 840
}
```

`top_k` must be 5-7. Errors: `422` invalid input, `502` Pinecone unreachable, `500`
missing key or embedding failure.

---

## 9. Troubleshooting

| Symptom | Fix |
|---------|-----|
| UI says it can't reach the search service | Backend not running, or `NEXT_PUBLIC_API_URL` is wrong. Restart `npm run dev` after editing `.env.local`. |
| Browser CORS error | Add your frontend origin to `CORS_ORIGINS` and restart the backend. |
| `PINECONE_API_KEY is not set` | Create `backend/.env` from `.env.example`; run commands from the `backend` folder. |
| Index dimension/metric error | Delete the index in the Pinecone console and re-run ingestion. It must be 384 / cosine. |
| Results empty | Ingestion has not run, or the namespace differs from `PINECONE_NAMESPACE`. |
| "AI explanation is unavailable" | Check `GROQ_API_KEY`/model name, or you hit Groq's rate limit. Results still work. |
| Out of memory | Use CPU-only torch, no `--reload`, `TORCH_NUM_THREADS=1`, close other apps. |
| `ModuleNotFoundError: app` when ingesting | Run `python scripts\ingest_nic.py` from inside `backend\`. |

---

## 10. Notes

- NIC codes classify activity for statistics and registrations. Always confirm the final
  code with MoSPI's NIC finder or your registering authority before filing.
- This tool is for English descriptions only.
