"""
Ingest the cleaned NIC 2025 CSV into Pinecone.

Usage (from the backend/ folder, venv active):
    python scripts/ingest_nic.py
    python scripts/ingest_nic.py --csv ../data/nic_2025_cleaned.csv --batch-size 64

Expected CSV columns (header row required, UTF-8):
    code           REQUIRED  6-digit NIC 2025 sub-class code (keep as text!)
    description    REQUIRED  official description of the activity
    title          optional  short official title of the sub-class
    section_code   optional  e.g. the section letter
    section        optional  section title
    division_code  optional
    division       optional  division title
    group_code     optional
    group          optional  group title
    class_code     optional
    class          optional  class title

If your CSV only has hierarchy *codes* (section=A, division=01, group=011,
class_code=0111) and no titles, that works too: the script detects it and the UI
shows the codes. Extra columns such as "hierarchy" are ignored.

The script is idempotent: vector IDs are the NIC codes, so re-running updates
records in place instead of creating duplicates.
"""

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd
from tqdm import tqdm

# Allow `import app...` when running this file directly.
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.config import PROJECT_ROOT, get_settings  # noqa: E402
from app.embeddings import embed_texts  # noqa: E402
from app.pinecone_client import ensure_index, get_index  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("ingest")

DEFAULT_CSV = PROJECT_ROOT / "data" / "nic_2025_cleaned.csv"
REQUIRED_COLUMNS = ["code", "description"]
OPTIONAL_COLUMNS = [
    "title",
    "section_code", "section",
    "division_code", "division",
    "group_code", "group",
    "class_code", "class",
]
MAX_TEXT_FIELD = 2000  # keep each metadata value comfortably under Pinecone limits


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Support CSVs where section/division/group hold CODES (e.g. 'A', '01', '011').

    If '<level>_code' is absent and every value in '<level>' is short (<= 4 chars),
    those values are codes, not titles: move them to '<level>_code'.
    """
    for level in ("section", "division", "group"):
        code_col = f"{level}_code"
        if code_col not in df.columns and level in df.columns:
            values = df[level].astype(str).str.strip()
            if (values.str.len() <= 4).all():
                df[code_col] = values
                df[level] = ""
    return df


def load_csv(path: Path) -> pd.DataFrame:
    """Read and validate the CSV. Everything is read as text so codes keep leading zeros."""
    if not path.exists():
        sys.exit(
            f"CSV not found: {path}\n"
            "Create data/nic_2025_cleaned.csv from the official MoSPI NIC 2025 document "
            "(see README: 'Getting the real NIC 2025 data')."
        )

    df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    df.columns = [c.strip().lower() for c in df.columns]
    df = normalize_columns(df)

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(f"CSV is missing required column(s): {missing}. Found: {list(df.columns)}")

    for col in OPTIONAL_COLUMNS:
        if col not in df.columns:
            df[col] = ""

    df = df.apply(lambda s: s.str.strip())
    before = len(df)
    df = df[(df["code"] != "") & (df["description"] != "")]
    df = df.drop_duplicates(subset="code", keep="first").reset_index(drop=True)
    if len(df) != before:
        logger.warning("Dropped %d empty/duplicate rows.", before - len(df))

    non_numeric = df[~df["code"].str.fullmatch(r"\d+")]
    if not non_numeric.empty:
        logger.warning(
            "%d code(s) are not purely numeric, e.g. %s. Check your CSV.",
            len(non_numeric), non_numeric["code"].head(3).tolist(),
        )
    wrong_len = df[df["code"].str.len() != 6]
    if not wrong_len.empty:
        logger.warning(
            "%d code(s) are not 6 digits long (NIC 2025 uses 6-digit codes), e.g. %s.",
            len(wrong_len), wrong_len["code"].head(3).tolist(),
        )
    return df


def build_embedding_text(row: pd.Series) -> str:
    """Text that gets embedded: the description plus its category path.

    Including the hierarchy gives the model extra context (e.g. 'Manufacture of
    textiles') which improves retrieval for short, vague descriptions.
    """
    parts = [row["title"], row["description"]]
    path = " > ".join(
        p for p in (row["section"], row["division"], row["group"], row["class"]) if p
    )
    if path:
        parts.append(f"Category: {path}")
    return ". ".join(p for p in parts if p)


def build_metadata(row: pd.Series) -> dict[str, str]:
    """Metadata stored next to each vector (returned at query time). Empty values are omitted."""
    md = {
        "code": row["code"],
        "title": row["title"],
        "description": row["description"],
        "section_code": row["section_code"],
        "section_name": row["section"],
        "division_code": row["division_code"],
        "division_name": row["division"],
        "group_code": row["group_code"],
        "group_name": row["group"],
        "class_code": row["class_code"],
        "class_name": row["class"],
    }
    return {k: v[:MAX_TEXT_FIELD] for k, v in md.items() if v}


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest NIC 2025 into Pinecone.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="Path to the cleaned CSV.")
    parser.add_argument("--batch-size", type=int, default=64, help="Records per batch (default 64).")
    args = parser.parse_args()

    settings = get_settings()
    df = load_csv(args.csv)
    logger.info("Loaded %d NIC records from %s", len(df), args.csv)

    ensure_index()
    index = get_index()

    total_batches = (len(df) + args.batch_size - 1) // args.batch_size
    for start in tqdm(range(0, len(df), args.batch_size), total=total_batches, desc="Upserting"):
        batch = df.iloc[start : start + args.batch_size]

        # Embed one small batch at a time to keep RAM usage low.
        vectors = embed_texts([build_embedding_text(r) for _, r in batch.iterrows()], batch_size=32)

        index.upsert(
            vectors=[
                {"id": row["code"], "values": vec, "metadata": build_metadata(row)}
                for (_, row), vec in zip(batch.iterrows(), vectors)
            ],
            namespace=settings.pinecone_namespace,
        )

    stats = index.describe_index_stats()
    summary = stats.namespaces.get(settings.pinecone_namespace)
    count = summary.vector_count if summary else "pending"
    logger.info(
        "Done. Namespace '%s' now reports %s vectors (stats can lag a few seconds).",
        settings.pinecone_namespace, count,
    )


if __name__ == "__main__":
    main()
