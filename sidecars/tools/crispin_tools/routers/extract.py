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
from urllib.parse import urlsplit

import httpx
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

# Sites with bot protection (e.g. cbc.ca) tarpit trafilatura's default
# urllib3 fetcher indefinitely — its DOWNLOAD_TIMEOUT never fires, the
# request thread hangs for minutes, and chat generations stall until main's
# client timeout. Fetch ourselves with a browser UA and hard bounds instead.
_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_FETCH_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

_markitdown = MarkItDown()


class ExtractRequest(BaseModel):
    path: Optional[str] = None
    url: Optional[str] = None


def _http_image(raw: Any) -> Optional[str]:
    """og:image candidates, but only absolute http(s) URLs."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        split = urlsplit(raw)
    except ValueError:
        return None
    return raw if split.scheme in ("http", "https") and split.netloc else None


def extract_html(html: str, url: Optional[str] = None) -> tuple[str, Optional[str], Optional[str]]:
    """Article markdown + title + og:image from raw html; shared by /extract and /visit."""
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
    title = meta.title if meta is not None else None
    image_url = _http_image(getattr(meta, "image", None)) if meta is not None else None
    return markdown, title, image_url


def extract_url(url: str) -> tuple[str, Optional[str], Optional[str]]:
    try:
        response = httpx.get(
            url, headers=_FETCH_HEADERS, timeout=_FETCH_TIMEOUT, follow_redirects=True
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502, detail=f"fetch failed: {url} returned {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch {url}: {exc}") from exc
    content_type = response.headers.get("content-type", "")
    if content_type and "html" not in content_type and "xml" not in content_type:
        raise HTTPException(
            status_code=422, detail=f"{url} is not a web page (content-type {content_type})"
        )
    return extract_html(response.text, url=url)


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
        markdown, title, image_url = extract_url(body.url)
        return {"markdown": markdown, "title": title, "kind": "url", "image_url": image_url}

    path = Path(body.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no such file: {path}")
    ext = path.suffix.lower()
    image_url: Optional[str] = None
    try:
        if ext == ".pdf":
            markdown, title = _extract_pdf(path)
            kind = "pdf"
        elif ext in _OFFICE_EXTS:
            result = _markitdown.convert(str(path))
            markdown, title, kind = result.markdown, result.title or path.stem, "office"
        elif ext in _HTML_EXTS:
            markdown, title, image_url = extract_html(path.read_text(errors="replace"))
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
    return {"markdown": markdown, "title": title, "kind": kind, "image_url": image_url}
