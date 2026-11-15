"""
Pinecone (serverless) helpers: cached client/index handles, similarity query,
and an idempotent "create index if missing" used by the ingestion script.
"""

import logging
import time
from functools import lru_cache
from typing import Any

from pinecone import Pinecone, ServerlessSpec

from app.config import get_settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_pinecone() -> Pinecone:
    """Create the Pinecone client once."""
    settings = get_settings()
    if not settings.pinecone_api_key:
        raise RuntimeError("PINECONE_API_KEY is not set. Add it to backend/.env.")
    return Pinecone(api_key=settings.pinecone_api_key)


@lru_cache(maxsize=1)
def get_index():
    """Return a handle to the NIC index (resolved once, then reused)."""
    settings = get_settings()
    return get_pinecone().Index(settings.pinecone_index_name)


def ensure_index() -> None:
    """Create the serverless index (dim=384, cosine) if it does not exist yet.

    Raises if an index with the same name exists but has the wrong dimension or metric.
    """
    settings = get_settings()
    pc = get_pinecone()
    name = settings.pinecone_index_name

    existing_names = pc.list_indexes().names()
    if name in existing_names:
        info = pc.describe_index(name)
        if info.dimension != settings.embedding_dimension or info.metric != "cosine":
            raise RuntimeError(
                f"Index '{name}' exists with dimension={info.dimension}, metric={info.metric}. "
                f"Expected dimension={settings.embedding_dimension}, metric=cosine."
            )
        return

    logger.info("Creating serverless index '%s' ...", name)
    pc.create_index(
        name=name,
        dimension=settings.embedding_dimension,
        metric="cosine",
        spec=ServerlessSpec(cloud=settings.pinecone_cloud, region=settings.pinecone_region),
    )
    # Wait until the index is ready to accept data.
    while not pc.describe_index(name).status["ready"]:
        time.sleep(2)


def query_similar(vector: list[float], top_k: int) -> list[dict[str, Any]]:
    """Return the top_k nearest NIC records as plain dicts: {id, score, metadata}."""
    settings = get_settings()
    response = get_index().query(
        vector=vector,
        top_k=top_k,
        include_metadata=True,
        namespace=settings.pinecone_namespace,
    )
    return [
        {"id": m.id, "score": float(m.score), "metadata": dict(m.metadata or {})}
        for m in response.matches
    ]
