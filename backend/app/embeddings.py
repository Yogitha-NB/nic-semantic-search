"""
Embedding utilities.

The SentenceTransformer model (all-MiniLM-L6-v2, ~90 MB, 384-dim) is loaded
exactly once per process thanks to lru_cache and runs on CPU only.
"""

import logging
from functools import lru_cache

from sentence_transformers import SentenceTransformer

from app.config import get_settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_embedding_model() -> SentenceTransformer:
    """Load (once) and return the embedding model on CPU."""
    import torch  # imported lazily so merely importing this module stays cheap

    settings = get_settings()
    torch.set_num_threads(max(1, settings.torch_num_threads))

    logger.info("Loading embedding model '%s' on CPU ...", settings.embedding_model_name)
    model = SentenceTransformer(settings.embedding_model_name, device="cpu")

    dim = model.get_sentence_embedding_dimension()
    if dim != settings.embedding_dimension:
        raise RuntimeError(
            f"Embedding model outputs {dim} dimensions but EMBEDDING_DIMENSION is "
            f"{settings.embedding_dimension}. The Pinecone index must match the model."
        )
    return model


def embed_texts(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """Embed many texts. Vectors are L2-normalised so cosine similarity is well-behaved."""
    model = get_embedding_model()
    vectors = model.encode(
        texts,
        batch_size=batch_size,  # small batches keep peak RAM low
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return vectors.tolist()


def embed_query(text: str) -> list[float]:
    """Embed a single user query."""
    return embed_texts([text])[0]
