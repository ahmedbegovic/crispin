"""Web search and page visits for the chat tool loop.

/search prefers a local SearXNG instance when main passes its url (backend
'auto'), falling back to ddgs transparently; an explicit backend is strict.
/visit shares trafilatura extraction with /extract and truncates for prompt
budgets.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

import httpx
from ddgs import DDGS
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .extract import extract_url

router = APIRouter(tags=["web"])

# SearXNG is local-or-absent: fail fast on connect so the ddgs fallback stays snappy.
_SEARXNG_TIMEOUT = httpx.Timeout(8.0, connect=1.5)
_TRUNCATION_MARKER = "\n\n[truncated]"


class SearchRequest(BaseModel):
    query: str
    max_results: int = 8
    backend: Literal["auto", "searxng", "ddgs"] = "auto"
    searxng_url: Optional[str] = None


class VisitRequest(BaseModel):
    url: str
    max_chars: int = 20_000


def _search_searxng(searxng_url: str, query: str, max_results: int) -> list[dict[str, str]]:
    resp = httpx.get(
        f"{searxng_url.rstrip('/')}/search",
        params={"q": query, "format": "json"},
        timeout=_SEARXNG_TIMEOUT,
    )
    resp.raise_for_status()
    return [
        {"title": r.get("title") or "", "url": r.get("url") or "", "snippet": r.get("content") or ""}
        for r in resp.json().get("results", [])[:max_results]
    ]


def _search_ddgs(query: str, max_results: int) -> list[dict[str, str]]:
    # ddgs regions are country-lang; a bare country crashes most engines' build_payload.
    hits = DDGS().text(query, max_results=max_results, region="us-en")
    return [
        {"title": h.get("title") or "", "url": h.get("href") or "", "snippet": h.get("body") or ""}
        for h in hits
    ]


@router.post("/search")
def search(body: SearchRequest) -> dict[str, Any]:
    attempts: list[str] = []
    if body.backend in ("auto", "searxng") and body.searxng_url:
        attempts.append("searxng")
    if body.backend in ("auto", "ddgs"):
        attempts.append("ddgs")
    if not attempts:
        raise HTTPException(status_code=422, detail="backend 'searxng' requires searxng_url")

    errors: dict[str, str] = {}
    for backend in attempts:
        try:
            if backend == "searxng":
                results = _search_searxng(body.searxng_url, body.query, body.max_results)
            else:
                results = _search_ddgs(body.query, body.max_results)
            return {"results": results, "backend": backend}
        except Exception as exc:  # noqa: BLE001 — fall through to the next backend
            errors[backend] = str(exc) or type(exc).__name__
    raise HTTPException(
        status_code=503, detail={"message": "all search backends failed", "errors": errors}
    )


@router.post("/visit")
def visit(body: VisitRequest) -> dict[str, Any]:
    markdown, title, image_url = extract_url(body.url)
    if len(markdown) > body.max_chars:
        markdown = markdown[: body.max_chars] + _TRUNCATION_MARKER
    return {"markdown": markdown, "title": title, "url": body.url, "image_url": image_url}
