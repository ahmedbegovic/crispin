"""RSS/Atom feed fetching for the News tab.

We fetch the feed bytes ourselves with httpx (browser UA, hard timeouts —
see extract.py for why parser libraries must never fetch urls) and hand them
to feedparser. Conditional requests via ETag/Last-Modified keep refresh polls
cheap: a 304 short-circuits with not_modified and no entries.
"""

from __future__ import annotations

import calendar
from typing import Any, Optional
from urllib.parse import urlsplit

import feedparser
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .extract import _FETCH_HEADERS, _FETCH_TIMEOUT

router = APIRouter(tags=["news"])

_MAX_ENTRIES = 50


class NewsFetchRequest(BaseModel):
    url: str
    etag: Optional[str] = None
    last_modified: Optional[str] = None


def _published_ms(entry: Any) -> Optional[int]:
    # Atom entries often carry only <updated>; fall back so items still sort.
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    return calendar.timegm(parsed) * 1000 if parsed else None


def _http_link(raw: Any) -> Optional[str]:
    """entry.link, but only when it is an absolute http(s) URL.

    feedparser maps non-URL RSS <guid>s into entry.link; downstream extraction
    treats a null link as unextractable instead of failing a doomed fetch.
    """
    if not raw or not isinstance(raw, str):
        return None
    try:
        split = urlsplit(raw)
    except ValueError:
        return None
    return raw if split.scheme in ("http", "https") and split.netloc else None


def _entry_image(entry: Any) -> Optional[str]:
    """First usable thumbnail: media:thumbnail, image-typed media:content, enclosure."""
    for item in entry.get("media_thumbnail") or []:
        url = _http_link(item.get("url"))
        if url:
            return url
    for item in entry.get("media_content") or []:
        medium = item.get("medium")
        mime = item.get("type") or ""
        # Accept only explicitly image-typed or completely untyped entries —
        # either attribute saying "not an image" (video/mp4, x-shockwave-flash…)
        # must skip, or video/podcast URLs end up rendered as <img>.
        if (medium or mime) and medium != "image" and not mime.startswith("image/"):
            continue
        url = _http_link(item.get("url"))
        if url:
            return url
    for link in entry.get("links") or []:
        if link.get("rel") == "enclosure" and (link.get("type") or "").startswith("image/"):
            url = _http_link(link.get("href"))
            if url:
                return url
    return None


@router.post("/news/fetch")
def news_fetch(body: NewsFetchRequest) -> dict[str, Any]:
    headers = dict(_FETCH_HEADERS)
    if body.etag:
        headers["If-None-Match"] = body.etag
    if body.last_modified:
        headers["If-Modified-Since"] = body.last_modified
    try:
        response = httpx.get(
            body.url, headers=headers, timeout=_FETCH_TIMEOUT, follow_redirects=True
        )
        if response.status_code == 304:
            return {
                "not_modified": True,
                "etag": body.etag,
                "last_modified": body.last_modified,
                "feed_title": None,
                "entries": [],
            }
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502, detail=f"fetch failed: {body.url} returned {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch {body.url}: {exc}") from exc

    # content-location gives feedparser a base URI (the post-redirect final
    # url), so relative entry hrefs resolve to absolute ones.
    parsed = feedparser.parse(
        response.content, response_headers={"content-location": str(response.url)}
    )
    # Well-formed non-feed XML (sitemaps, OPML) and empty 200 bodies are not
    # bozo but carry no version — without this they become silent dead sources.
    if not parsed.entries and (parsed.bozo or not parsed.get("version")):
        raise HTTPException(
            status_code=422,
            detail=f"not a feed: {body.url} "
            f"({parsed.get('bozo_exception') or 'no recognizable feed format'})",
        )

    entries = []
    # Cap newest-first, not in document order — oldest-first feeds with more
    # than _MAX_ENTRIES would otherwise permanently lose their newest items.
    # sorted() is stable, so fully undated feeds keep document order.
    ordered = sorted(parsed.entries, key=lambda e: _published_ms(e) or 0, reverse=True)
    for entry in ordered[:_MAX_ENTRIES]:
        guid = entry.get("id") or entry.get("link")
        if not guid:  # nothing stable to dedupe on — drop the entry
            continue
        entries.append(
            {
                "guid": guid,
                "title": entry.get("title") or None,
                "link": _http_link(entry.get("link")),
                "published_ms": _published_ms(entry),
                "summary": entry.get("summary") or None,
                "image_url": _entry_image(entry),
            }
        )

    return {
        "not_modified": False,
        "etag": response.headers.get("etag"),
        "last_modified": response.headers.get("last-modified"),
        "feed_title": parsed.feed.get("title") or None,
        "entries": entries,
    }
