"""Document/url → markdown extraction.

Synchronous on purpose — extraction takes seconds, not minutes, so callers get
the markdown back directly instead of polling a job. Routing: pymupdf4llm for
PDFs, markitdown for office/epub/csv, trafilatura for urls and html, plain
read for md/txt. `kind` in the response is the routing category
(pdf|office|html|text|url) so main can branch on it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import pymupdf
import pymupdf4llm
import trafilatura
from fastapi import APIRouter, HTTPException
from markitdown import MarkItDown
from pydantic import BaseModel

from ..rag_store import first_heading

router = APIRouter(tags=["extract"])

_OFFICE_EXTS = {".docx", ".pptx", ".xlsx", ".epub", ".csv"}
_TEXT_EXTS = {".md", ".markdown", ".txt"}
_HTML_EXTS = {".html", ".htm"}

_markitdown = MarkItDown()


class ExtractRequest(BaseModel):
    path: Optional[str] = None
    url: Optional[str] = None


def extract_html(html: str, url: Optional[str] = None) -> tuple[str, Optional[str]]:
    """Article markdown + title from raw html; shared by /extract and /visit."""
    markdown = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        favor_recall=True,
    )
    if not markdown:
        raise HTTPException(
            status_code=422, detail=f"no extractable content{f' at {url}' if url else ''}"
        )
    # with_metadata=True or .title stays None (trafilatura 2.x default is off).
    meta = trafilatura.bare_extraction(html, url=url, with_metadata=True)
    return markdown, meta.title if meta is not None else None


def extract_url(url: str) -> tuple[str, Optional[str]]:
    html = trafilatura.fetch_url(url)
    if html is None:
        raise HTTPException(status_code=502, detail=f"could not fetch {url}")
    return extract_html(html, url=url)


def _extract_pdf(path: Path) -> tuple[str, Optional[str]]:
    markdown = pymupdf4llm.to_markdown(str(path), show_progress=False)
    with pymupdf.open(path) as doc:
        title = (doc.metadata or {}).get("title")
    return markdown, title or path.stem


@router.post("/extract")
def extract(body: ExtractRequest) -> dict[str, Any]:
    if (body.path is None) == (body.url is None):
        raise HTTPException(status_code=422, detail="provide exactly one of path or url")

    if body.url is not None:
        markdown, title = extract_url(body.url)
        return {"markdown": markdown, "title": title, "kind": "url"}

    path = Path(body.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no such file: {path}")
    ext = path.suffix.lower()
    try:
        if ext == ".pdf":
            markdown, title = _extract_pdf(path)
            kind = "pdf"
        elif ext in _OFFICE_EXTS:
            result = _markitdown.convert(str(path))
            markdown, title, kind = result.markdown, result.title or path.stem, "office"
        elif ext in _HTML_EXTS:
            markdown, title = extract_html(path.read_text(errors="replace"))
            title, kind = title or path.stem, "html"
        elif ext in _TEXT_EXTS:
            markdown = path.read_text(errors="replace")
            title, kind = first_heading(markdown) or path.stem, "text"
        else:
            raise HTTPException(
                status_code=415,
                detail=f"unsupported file type '{ext}' — supported: .pdf, "
                f"{', '.join(sorted(_OFFICE_EXTS | _HTML_EXTS | _TEXT_EXTS))}",
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — extractor internals vary; surface as 422
        raise HTTPException(
            status_code=422, detail=f"extraction failed for {path.name}: {exc}"
        ) from exc

    if not markdown.strip():
        raise HTTPException(
            status_code=422, detail=f"no text extracted from {path.name} (scanned or empty?)"
        )
    return {"markdown": markdown, "title": title, "kind": kind}
