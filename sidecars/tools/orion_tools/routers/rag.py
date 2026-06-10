"""RAG ingest/query over per-collection lancedb tables.

Ingest is a job (chunk → embed via the engine's OpenAI-shaped /v1/embeddings →
lancedb write + FTS reindex); query is synchronous hybrid search (vector + FTS
merged with manual RRF). main passes embeddings_url / embedding_model /
lancedb_dir on every request so the sidecar stays free of engine ports and
app-data paths.
"""

from __future__ import annotations

import threading
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import rag_store
from ..jobs import Job, registry

router = APIRouter(prefix="/rag", tags=["rag"])

# The first embed call may lazily load the embedding model inside the engine —
# allow well past the usual request budget before giving up.
_EMBED_TIMEOUT = httpx.Timeout(180.0, connect=10.0)

# Concurrent ingests race on create_table and the FTS rebuild (lance CreateIndex
# commits conflict rather than retry) — serialize the write+index phase only.
_WRITE_LOCK = threading.Lock()


class IngestRequest(BaseModel):
    collection_id: str
    doc_id: str
    markdown: str
    title: Optional[str] = None
    embeddings_url: str
    embedding_model: str
    lancedb_dir: str


class QueryRequest(BaseModel):
    collection_id: str
    query: str
    k: int = 6
    embeddings_url: str
    embedding_model: str
    lancedb_dir: str


class DeleteDocRequest(BaseModel):
    collection_id: str
    doc_id: str
    lancedb_dir: str


class DropCollectionRequest(BaseModel):
    collection_id: str
    lancedb_dir: str


def _run_ingest(job: Job, req: IngestRequest) -> dict[str, Any]:
    chunks = rag_store.chunk_markdown(req.markdown, req.title)
    job.data["chunks_total"] = len(chunks)

    rows: list[dict[str, Any]] = []
    with httpx.Client(timeout=_EMBED_TIMEOUT) as client:
        for start in range(0, len(chunks), rag_store.EMBED_BATCH):
            if job.cancel_event.is_set():
                return {}
            batch = chunks[start : start + rag_store.EMBED_BATCH]
            vectors = rag_store.embed_texts(
                client, req.embeddings_url, req.embedding_model, [c["text"] for c in batch]
            )
            rows.extend(
                {
                    "vector": vector,
                    "text": chunk["text"],
                    "doc_id": req.doc_id,
                    "title": req.title or "",
                    "chunk_index": chunk["chunk_index"],
                }
                for chunk, vector in zip(batch, vectors)
            )
            job.data["chunks_done"] = len(rows)
            job.progress = len(rows) / len(chunks)
            job.detail = f"embedded {len(rows)}/{len(chunks)} chunks"

    with _WRITE_LOCK:
        db = rag_store.connect(req.lancedb_dir)
        tbl = rag_store.open_table(db, req.collection_id)
        # Re-ingest replaces: drop this doc's previous rows before inserting.
        if tbl is not None:
            tbl.delete(f"doc_id = {rag_store.sql_quote(req.doc_id)}")
            if rows:
                tbl.add(rows)
        elif rows:
            tbl = db.create_table(rag_store.table_name(req.collection_id), rows)
        if tbl is not None and rows:
            # Native lance FTS only serves indexed rows — rebuild after every write.
            tbl.create_fts_index("text", replace=True)
    job.detail = f"indexed {len(rows)} chunks"
    return {"chunks": len(rows)}


@router.post("/ingest")
def ingest(body: IngestRequest) -> dict[str, str]:
    job = registry.start(
        "rag-ingest",
        lambda job: _run_ingest(job, body),
        data={
            "collection_id": body.collection_id,
            "doc_id": body.doc_id,
            "chunks_done": 0,
            "chunks_total": None,
        },
    )
    return {"job_id": job.id}


@router.post("/query")
def query(body: QueryRequest) -> dict[str, Any]:
    db = rag_store.connect(body.lancedb_dir)
    tbl = rag_store.open_table(db, body.collection_id)
    if tbl is None:
        return {"results": []}  # collection exists but nothing ingested yet

    with httpx.Client(timeout=_EMBED_TIMEOUT) as client:
        try:
            vector = rag_store.embed_texts(
                client, body.embeddings_url, body.embedding_model, [body.query]
            )[0]
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"embeddings request failed: {exc}") from exc

    overfetch = max(body.k * 3, 12)
    columns = ["text", "doc_id", "title", "chunk_index"]
    vector_hits = tbl.search(vector).select(columns).limit(overfetch).to_list()
    try:
        fts_hits = tbl.search(body.query, query_type="fts").select(columns).limit(overfetch).to_list()
    except Exception:  # noqa: BLE001 — FTS chokes on some query syntax; vector side still answers
        fts_hits = []

    merged = rag_store.rrf_merge([vector_hits, fts_hits], limit=body.k)
    return {
        "results": [
            {
                "text": row["text"],
                "doc_id": row["doc_id"],
                # Ingest stores '' (lancedb schema inference needs strings); the
                # wire contract is string|null, so empty serializes as null.
                "title": row["title"] or None,
                "score": row["score"],
                "chunk_index": row["chunk_index"],
            }
            for row in merged
        ]
    }


@router.post("/delete_doc")
def delete_doc(body: DeleteDocRequest) -> dict[str, bool]:
    db = rag_store.connect(body.lancedb_dir)
    tbl = rag_store.open_table(db, body.collection_id)
    if tbl is not None:
        tbl.delete(f"doc_id = {rag_store.sql_quote(body.doc_id)}")
    return {"ok": True}


@router.post("/drop_collection")
def drop_collection(body: DropCollectionRequest) -> dict[str, bool]:
    db = rag_store.connect(body.lancedb_dir)
    if rag_store.table_name(body.collection_id) in db.table_names():
        db.drop_table(rag_store.table_name(body.collection_id))
    return {"ok": True}
