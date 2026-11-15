"""
Application configuration.

All settings are read from environment variables (or from backend/.env) using
pydantic-settings. Access them anywhere with `get_settings()`.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ directory (parent of the "app" package)
BACKEND_DIR = Path(__file__).resolve().parent.parent
# Repository root (parent of backend/) - where data/ lives
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Typed settings with sensible defaults. Secrets default to empty strings so
    the API can boot (e.g. /health) and report a clear error when a key is missing."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Pinecone -----------------------------------------------------------
    pinecone_api_key: str = ""
    pinecone_index_name: str = "nic-2025"
    pinecone_namespace: str = "nic-2025"
    pinecone_cloud: str = "aws"
    pinecone_region: str = "us-east-1"

    # --- Embeddings ---------------------------------------------------------
    embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dimension: int = 384  # all-MiniLM-L6-v2 output size
    torch_num_threads: int = 2  # keep CPU/RAM pressure low on small machines
    preload_model: bool = True  # load the embedding model at startup

    # --- Groq LLM -----------------------------------------------------------
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-20b"
    groq_temperature: float = 0.2
    groq_max_tokens: int = 1500  # gpt-oss models spend tokens on reasoning too
    groq_timeout_seconds: float = 20.0

    # --- API ----------------------------------------------------------------
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        """Split the comma-separated CORS_ORIGINS string into a clean list."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Create the Settings object once and reuse it."""
    return Settings()
