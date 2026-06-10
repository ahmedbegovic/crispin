"""Chunking, embedding, and lancedb storage for RAG collections.

One lancedb table per collection (`col_<collection_id>`), rooted at the
directory main passes per-request (lancedb_dir) — the sidecar never hardcodes
app-data paths. Row schema: vector, text, doc_id, title, chunk_index.
Hybrid retrieval = vector + FTS queries run separately and merged with manual
RRF: lancedb 0.33 has no hybrid mode for tables without an embedding function.
"""

from __future__ import annotations

import re
from typing import Any, Optional

import httpx
import lancedb

CHUNK_CHARS = 3500
CHUNK_OVERLAP = 400
EMBED_BATCH = 32
RRF_K = 60

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def table_name(collection_id: str) -> str:
    return f"col_{collection_id}"


def connect(lancedb_dir: str) -> Any:
    return lancedb.connect(lancedb_dir)


def open_table(db: Any, collection_id: str) -> Optional[Any]:
    name = table_name(collection_id)
    return db.open_table(name) if name in db.table_names() else None


def sql_quote(value: str) -> str:
    """Escape for lancedb's SQL-style predicate strings (delete filters)."""
    return "'" + value.replace("'", "''") + "'"


def first_heading(markdown: str) -> Optional[str]:
    for line in markdown.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            return match.group(2)
    return None


def chunk_markdown(markdown: str, title: Optional[str]) -> list[dict[str, Any]]:
    """~CHUNK_CHARS windows with CHUNK_OVERLAP, split on heading boundaries.

    Each chunk is prefixed with its heading path ("<title> > <h1> > <h2>") so
    chunks stay self-describing once they leave the document.
    """
    sections: list[tuple[str, str]] = []  # (heading_path, body)
    stack: list[tuple[int, str]] = []
    buf: list[str] = []

    def heading_path() -> str:
        parts = [p for p in ([title] if title else []) + [text for _, text in stack] if p]
        # Docs whose H1 repeats the title would otherwise prefix "X > X".
        return " > ".join(p for i, p in enumerate(parts) if i == 0 or p != parts[i - 1])

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body:
            sections.append((heading_path(), body))
        buf.clear()

    for line in markdown.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            flush()
            level = len(match.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, match.group(2)))
        else:
            buf.append(line)
    flush()

    chunks: list[dict[str, Any]] = []
    step = CHUNK_CHARS - CHUNK_OVERLAP
    for path, body in sections:
        start = 0
        while start < len(body):
            piece = body[start : start + CHUNK_CHARS]
            text = f"{path}\n\n{piece}" if path else piece
            chunks.append({"text": text, "chunk_index": len(chunks)})
            if start + CHUNK_CHARS >= len(body):
                break
            start += step
    return chunks


def embed_texts(
    client: httpx.Client, embeddings_url: str, model: str, texts: list[str]
) -> list[list[float]]:
    """OpenAI-shaped embeddings call (the engine's /v1/embeddings)."""
    resp = client.post(embeddings_url, json={"model": model, "input": texts})
    resp.raise_for_status()
    items = resp.json()["data"]
    items.sort(key=lambda item: item.get("index", 0))
    if len(items) != len(texts):
        raise RuntimeError(f"embeddings returned {len(items)} vectors for {len(texts)} inputs")
    return [item["embedding"] for item in items]


def rrf_merge(ranked_lists: list[list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    """Reciprocal rank fusion over result lists keyed by (doc_id, chunk_index)."""
    scores: dict[tuple[str, int], float] = {}
    rows: dict[tuple[str, int], dict[str, Any]] = {}
    for ranked in ranked_lists:
        for rank, row in enumerate(ranked):
            key = (row["doc_id"], row["chunk_index"])
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
            rows.setdefault(key, row)
    ordered = sorted(rows, key=lambda key: scores[key], reverse=True)[:limit]
    return [{**rows[key], "score": scores[key]} for key in ordered]
