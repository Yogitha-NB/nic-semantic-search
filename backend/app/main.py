"""
FastAPI entry point.

Run from the backend/ folder:
    uvicorn app.main:app --reload --port 8000

Endpoints:
    GET  /health  - liveness + configuration summary (no external calls)
    POST /search  - semantic NIC search + LLM explanation
"""

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, Response

from app.config import get_settings
from app.embeddings import embed_query, get_embedding_model
from app.llm import explain_results
from app.pinecone_client import query_similar
from app.schemas import (
    HealthResponse,
    HierarchyLevel,
    NICResult,
    SearchRequest,
    SearchResponse,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s: %(message)s")
logger = logging.getLogger("nic-search")
settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Warm up the embedding model once at startup so the first request is fast."""
    if settings.preload_model:
        get_embedding_model()
        logger.info("Embedding model ready.")
    yield


app = FastAPI(
    title="NIC 2025 Semantic Search API",
    description="Find official NIC 2025 codes from a plain-English business description.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,  # localhost:3000 by default
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# (metadata key prefix, label shown in the UI) - ordered broad -> specific.
_HIERARCHY_LEVELS = [
    ("section", "Section"),
    ("division", "Division"),
    ("group", "Group"),
    ("class", "Class"),
]


def _build_hierarchy(md: dict[str, Any]) -> list[HierarchyLevel]:
    """Turn the flat Pinecone metadata into an ordered hierarchy list.

    Levels missing from the data are skipped. The Sub-class (the 6-digit NIC
    code itself) is always added as the final level.
    """
    levels: list[HierarchyLevel] = []
    for prefix, label in _HIERARCHY_LEVELS:
        code = str(md.get(f"{prefix}_code", "") or "").strip()
        title = str(md.get(f"{prefix}_name", "") or "").strip()
        if code or title:
            levels.append(HierarchyLevel(level=label, code=code, title=title))

    description = str(md.get("description", "") or "")
    subclass_title = str(md.get("title", "") or "").strip() or (
        description if len(description) <= 120 else description[:117] + "..."
    )
    levels.append(HierarchyLevel(level="Sub-class", code=str(md.get("code", "")), title=subclass_title))
    return levels


def _to_result(match: dict[str, Any]) -> NICResult:
    """Convert a raw Pinecone match into the public NICResult model."""
    md = match["metadata"]
    score = max(0.0, min(1.0, match["score"]))  # clamp cosine to 0-1 for display
    return NICResult(
        code=str(md.get("code", match["id"])),
        description=str(md.get("description", "")),
        hierarchy=_build_hierarchy(md),
        score=round(score, 4),
        score_percent=round(score * 100),
    )


@app.get("/", include_in_schema=False)
def root():
    """Send anyone who opens the bare API address to the interactive docs."""
    return RedirectResponse(url="/docs")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Browsers ask for a tab icon; answer 'no content' instead of a 404."""
    return Response(status_code=204)

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Cheap liveness probe. Does not call Pinecone or Groq."""
    return HealthResponse(
        status="ok",
        embedding_model=settings.embedding_model_name,
        embedding_model_loaded=get_embedding_model.cache_info().currsize > 0,
        pinecone_index=settings.pinecone_index_name,
        groq_model=settings.groq_model,
    )


# NOTE: these handlers are plain `def` (not `async def`) on purpose. Embedding,
# Pinecone and Groq calls are blocking, so FastAPI runs them in a worker thread
# and the event loop stays responsive.
@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    """Embed the query, retrieve the closest NIC codes, then explain them with the LLM."""
    started = time.perf_counter()
    query = request.query.strip()
    if len(query) < 3:
        raise HTTPException(status_code=422, detail="Please describe the business in a few words.")

    # 1) Embed the query locally (CPU).
    try:
        vector = embed_query(query)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Embedding failed")
        raise HTTPException(status_code=500, detail=f"Could not embed the query: {exc}") from exc

    # 2) Retrieve the nearest NIC codes from Pinecone.
    try:
        matches = query_similar(vector, request.top_k)
    except RuntimeError as exc:  # e.g. missing API key
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Pinecone query failed")
        raise HTTPException(
            status_code=502,
            detail="The vector database is unavailable. Check your Pinecone key and index name.",
        ) from exc

    results = [_to_result(m) for m in matches]

    # 3) Ask the LLM to explain. A failure here must NOT lose the search results.
    explanation: str | None = None
    explanation_error: str | None = None
    if results:
        try:
            explanation = explain_results(query, results)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM explanation failed: %s", exc)
            explanation_error = (
                "The AI explanation is unavailable right now. The matched codes below are still valid."
            )

    return SearchResponse(
        query=query,
        results=results,
        explanation=explanation,
        explanation_error=explanation_error,
        took_ms=round((time.perf_counter() - started) * 1000),
    )
