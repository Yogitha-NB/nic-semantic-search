# NIC 2025 Semantic Search

Describe a business in plain English and get the closest **official NIC 2025** codes
(India's National Industrial Classification, released by MoSPI on 18 Nov 2025), each
with its hierarchy, official description, similarity score and an AI explanation of
why it fits.

| Layer      | Technology                                                      |
|------------|-----------------------------------------------------------------|
| Frontend   | Next.js 14 (App Router), TypeScript, Tailwind CSS               |
| Backend    | Python, FastAPI, pydantic-settings                              |
| Embeddings | `sentence-transformers/all-MiniLM-L6-v2` (384-dim, CPU, ~90 MB) |
| Vector DB  | Pinecone serverless (cosine)                                    |
| LLM        | Groq (`openai/gpt-oss-20b` or `openai/gpt-oss-120b`; Groq retired the Llama 3.x models on 16 Aug 2026) via LangChain + `langchain-groq` |

**Measured retrieval accuracy:** on 22 realistic, owner-style test queries the correct
code is in the top 5 results **82%** of the time (45% as the first result). See
[Evaluation](#11-evaluation) for the full table, the method and its limits.

<!-- After recording a short GIF or taking a screenshot, save it as docs/demo.gif
     and uncomment the next line:
![Demo: searching for a cotton shirt business](docs/demo.gif)
-->

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
│   ├── scripts/
│   │   ├── ingest_nic.py       CSV -> embeddings -> Pinecone
│   │   └── evaluate.py         retrieval accuracy on a labelled query set
│   ├── requirements.txt
│   └── .env.example
├── frontend/                   Next.js 14 app (app/page.tsx is the whole UI)
├── data/
│   └── eval_set.csv            labelled evaluation queries
└── README.md
```

`data/nic_2025_cleaned.csv` is **not** in this repository (see section 3).

---

## 3. Getting the NIC 2025 data

This repository intentionally ships **no classification data**. Build the CSV from the
official NIC 2025 classification published by MoSPI, and spot-check codes with MoSPI's
lookup tool at <https://nicfinder.mospi.gov.in/>.

1. Obtain the official NIC 2025 classification from the Ministry of Statistics and
   Programme Implementation, <https://www.mospi.gov.in> (search for
   *National Industrial Classification 2025*).
2. Convert it into `data/nic_2025_cleaned.csv` (UTF-8, header row required) and check
   the result by hand.
3. Required columns are `code` and `description`. Hierarchy columns are optional but
   make the results more informative:

```csv
code,title,description,section_code,section,division_code,division,group_code,group,class_code,class
```

The ingest script also accepts a file where `section`, `division` and `group` contain
**codes** (for example `A`, `01`, `011`) with no titles. It detects this and treats them
as codes. Extra columns are ignored.

Rules for the CSV:

- **Keep `code` as text.** Opening and re-saving in Excel can strip leading zeros.
- One row per **6-digit sub-class**. Codes must be unique.
- Copy official wording; do not paraphrase.
- The ingest script warns about codes that are not 6 digits, empty rows and duplicates.
- The data file is excluded by `.gitignore`. Do not republish data you do not have the
  right to redistribute.

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
   - Check <https://console.groq.com/docs/models> for the current list

---

## 6. Setup

Prerequisites: Python 3.10+ (3.11 recommended), Node.js 18.17+ (20 LTS recommended).
Allow roughly 5 GB of free disk space for the Python and Node dependencies.

### Backend (Windows PowerShell)

```powershell
cd nic-semantic-search\backend
python -m venv venv
.\venv\Scripts\Activate.ps1

# CPU-only PyTorch (smaller, lower RAM), then the rest
pip install torch==2.4.1 --extra-index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt

copy .env.example .env      # then edit .env and add both API keys
```

macOS / Linux: `source venv/bin/activate` and `cp .env.example .env`.

### Load the data (once)

Place `nic_2025_cleaned.csv` in `data\`, then run from the `backend` folder:

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

`backend/.env` (never commit this file):

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
| `No space left on device` during `pip install` | Free at least 5 GB, then reinstall with `pip install --no-cache-dir -r requirements.txt`. |
| Out of memory | Use CPU-only torch, no `--reload`, `TORCH_NUM_THREADS=1`, close other apps. |
| `ModuleNotFoundError: app` when ingesting | Run `python scripts\ingest_nic.py` from inside `backend\`. |

---

## 10. Notes

- NIC codes classify activity for statistics and registrations. Always confirm the final
  code with MoSPI's NIC finder or your registering authority before filing.
- This tool is for English descriptions only.

---

## 11. Evaluation

`backend/scripts/evaluate.py` measures retrieval quality only (embedding + Pinecone, no
LLM), so it is fast and uses no Groq tokens.

```powershell
cd backend
python scripts\evaluate.py
```

It reads `data/eval_set.csv` with columns `query`, `expected_codes` (one or more
acceptable codes separated by `|`) and `type`, then prints Top-1 / Top-3 / Top-5
accuracy and MRR, lists the queries it missed, and writes per-query details to
`data/eval_results.csv` (git-ignored).

### Results (55 labelled queries)

| Set | Queries | Top-1 | Top-3 | Top-5 | MRR |
|-----|---------|-------|-------|-------|-----|
| `paraphrase` (reworded official text) | 33 | 85% | 100% | 100% | 0.90 |
| `own` (realistic owner-style wording) | 22 | 45% | 73% | 82% | 0.61 |
| All | 55 | 69% | 89% | 93% | 0.79 |

**How to read this**

- Top-N is the share of queries whose correct code appears in the first N results.
  MRR is the mean of 1/rank of the first correct code (0 if it is not in the top 10).
- The `paraphrase` set is easy by design: those queries reword the official
  descriptions. The **`own` set is the honest measure** of real-world behaviour.
- The app shows 5-7 results, so Top-5 is the most relevant figure: the correct code
  is usually found, but it is often not ranked first.
- **Sample size is small** (22 realistic queries), so treat these numbers as
  indicative, not precise. The same queries were not used to tune the system.

### Failure analysis (queries with the correct code outside the top 5)

| Query | Expected rank | What went wrong |
|-------|---------------|-----------------|
| "We have a small dairy farm and sell milk" | 7 | Matched "sell milk" to retail dairy codes instead of dairy farming. |
| "We run a coaching centre for school students" | not in top 10 | Word-sense confusion: "coaching" matched bus "coach" services. |
| "We sell groceries and daily household items in our village shop" | 10 | Retrieved plausible retail food codes; broad retail wording and multiple acceptable codes make this ambiguous. |
| "I own a truck and carry goods between cities" | 10 | A very similar road-freight code ranked second; labelling ambiguity is possible and should be reviewed. |

---

## 12. Known limitations

- The hierarchy shows section/division/group/class **codes only**, because the cleaned
  data has no titles for those levels. If the CSV has `section`, `division`, `group`
  and `class` title columns, the app shows them without code changes.
- A small general-purpose embedding model confuses words with several meanings and
  struggles with catch-all ("n.e.c.") codes and businesses with several activities.
- The similarity percentage is a ranking aid, not a probability.
- The LLM explanation is restricted to the retrieved codes but is not independently
  verified.
- English only. No user accounts, authentication or rate limiting.
- Evaluation uses a small hand-labelled set; some labels may admit more than one
  correct code.
- Not deployed: it runs locally and needs your own Pinecone and Groq keys.

---

## 13. Roadmap

Planned improvements, each to be judged by re-running `evaluate.py` before and after:

1. **Query rewriting:** have the LLM rephrase vague input into official-style wording
   before embedding (targets failures like "coaching centre").
2. **Reranking:** reorder the top 10 results with the LLM to improve Top-1.
3. **Embedding model comparison:** try a stronger 384-dimension model (for example
   `BAAI/bge-small-en-v1.5`) in a separate Pinecone namespace.
4. **Larger evaluation set** (100+ queries) with a held-out portion that is never used
   for tuning.
5. **Section/division/group titles** in the data and UI.
6. **Automated tests** (`pytest`) and a CI workflow.
7. **Rate limiting** on `/search` and a hosted demo.

---

## 14. Security notes

- Never commit `backend/.env`. It is listed in `.gitignore`; run `git status` before
  every commit. If a key is ever exposed, delete it in the Groq or Pinecone dashboard
  and create a new one.
- `backend/.env.example` contains placeholders only.
- The API has no authentication or rate limiting; do not expose it publicly without
  adding both.
