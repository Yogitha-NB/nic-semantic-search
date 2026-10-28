"""Pydantic request/response models for the public API."""

from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    """Body of POST /search."""

    query: str = Field(
        ...,
        min_length=3,
        max_length=500,
        description="Plain-English description of the business activity.",
        examples=["We stitch and export cotton shirts to Europe"],
    )
    top_k: int = Field(default=5, ge=5, le=7, description="Number of NIC codes to return (5-7).")


class HierarchyLevel(BaseModel):
    """One level of the NIC hierarchy (Section > Division > Group > Class > Sub-class)."""

    level: str
    code: str
    title: str


class NICResult(BaseModel):
    """A single matched NIC 2025 code."""

    code: str
    description: str
    hierarchy: list[HierarchyLevel]
    score: float = Field(description="Raw cosine similarity from Pinecone (0-1).")
    score_percent: int = Field(description="Similarity as a whole percentage (0-100).")


class SearchResponse(BaseModel):
    """Body returned by POST /search."""

    query: str
    results: list[NICResult]
    explanation: str | None = Field(default=None, description="LLM explanation, if available.")
    explanation_error: str | None = Field(
        default=None, description="Set when the LLM step failed; results are still valid."
    )
    took_ms: int


class HealthResponse(BaseModel):
    status: str
    embedding_model: str
    embedding_model_loaded: bool
    pinecone_index: str
    groq_model: str
