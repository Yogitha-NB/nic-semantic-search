"""
Measure retrieval accuracy against a hand-labelled evaluation set.

Usage (from backend/, venv active, after ingestion):
    python scripts/evaluate.py
    python scripts/evaluate.py --eval ../data/eval_set.csv --out ../data/eval_results.csv

Eval CSV columns:
    query           plain-English business description
    expected_codes  one or more acceptable NIC codes, separated by "|"
    type            optional label (e.g. "paraphrase" or "own") for per-group scores

Metrics:
    Top-1 / Top-3 / Top-5 accuracy : share of queries whose correct code is in the top N
    MRR                            : mean of 1/rank of the first correct code (0 if not in top 10)

This script queries Pinecone directly (no HTTP, no LLM), so it measures the
search quality only and costs no Groq tokens.
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.config import PROJECT_ROOT  # noqa: E402
from app.embeddings import embed_texts  # noqa: E402
from app.pinecone_client import query_similar  # noqa: E402

DEPTH = 10  # how deep we look when computing MRR


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate NIC retrieval accuracy.")
    parser.add_argument("--eval", type=Path, default=PROJECT_ROOT / "data" / "eval_set.csv")
    parser.add_argument("--out", type=Path, default=PROJECT_ROOT / "data" / "eval_results.csv")
    args = parser.parse_args()

    if not args.eval.exists():
        sys.exit(f"Eval file not found: {args.eval}")
    df = pd.read_csv(args.eval, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    df.columns = [c.strip().lower() for c in df.columns]
    if not {"query", "expected_codes"} <= set(df.columns):
        sys.exit("Eval CSV needs columns: query, expected_codes (optional: type)")
    if "type" not in df.columns:
        df["type"] = "all"

    print(f"Evaluating {len(df)} queries ...")
    vectors = embed_texts(df["query"].tolist(), batch_size=32)

    rows = []
    for (_, row), vec in zip(df.iterrows(), vectors):
        expected = {c.strip() for c in row["expected_codes"].split("|") if c.strip()}
        matches = query_similar(vec, DEPTH)
        got = [m["metadata"].get("code", m["id"]) for m in matches]
        rank = next((i + 1 for i, c in enumerate(got) if c in expected), None)
        top = matches[0]["metadata"].get("description", "") if matches else ""
        rows.append({
            "query": row["query"], "type": row["type"],
            "expected": "|".join(sorted(expected)), "rank": rank,
            "top5": " ".join(got[:5]), "top1_description": top,
        })

    res = pd.DataFrame(rows)

    def metrics(g: pd.DataFrame) -> dict:
        r = g["rank"]
        return {
            "n": len(g),
            "top1": (r <= 1).sum() / len(g),
            "top3": (r <= 3).sum() / len(g),
            "top5": (r <= 5).sum() / len(g),
            "mrr": r.map(lambda x: 0 if pd.isna(x) else 1 / x).mean(),
        }

    def show(label: str, g: pd.DataFrame) -> None:
        m = metrics(g)
        print(f"{label:<12} n={m['n']:<3} Top-1 {m['top1']:.0%}  Top-3 {m['top3']:.0%}  "
              f"Top-5 {m['top5']:.0%}  MRR {m['mrr']:.3f}")

    print()
    show("ALL", res)
    for t, g in res.groupby("type"):
        if res["type"].nunique() > 1:
            show(str(t), g)

    misses = res[res["rank"].isna() | (res["rank"] > 5)]
    if not misses.empty:
        print(f"\nQueries where the correct code is NOT in the top 5 ({len(misses)}):")
        for _, m in misses.iterrows():
            print(f"  - {m['query']}\n      expected {m['expected']} | rank {m['rank']} | got {m['top5']}\n"
                  f"      top result: {m['top1_description'][:90]}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    res.to_csv(args.out, index=False, encoding="utf-8")
    print(f"\nPer-query results saved to {args.out}")


if __name__ == "__main__":
    main()