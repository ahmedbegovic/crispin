"""Structured fast paths for common developer lookups.

Generic web search is noisy for "the latest version of X" or "the newest release
of owner/repo". These key-free APIs return clean, authoritative facts the chat
model can cite directly: PyPI / npm registries (package versions), the GitHub
releases API, and the arXiv Atom API (papers). Every handler degrades to
ok:false on any failure so the caller (main) can fall back to generic search.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Optional

import feedparser
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .extract import _MAX_REDIRECTS, _guard_url

router = APIRouter(tags=["providers"])

# Structured APIs are fast or not worth waiting on — keep the chat loop snappy.
_TIMEOUT = httpx.Timeout(8.0, connect=2.0)
_HEADERS = {"User-Agent": "crispin-tools/1.0 (+https://github.com/crispin)"}
_SUMMARY_CLIP = 1200

# Display labels per kind, so `source` is the same on a hit and on a miss.
_LABELS = {"pypi": "PyPI", "npm": "npm", "github_release": "GitHub", "arxiv": "arXiv"}

# Server-side name grammar — the endpoint must not trust the TS regex alone. A
# single path segment only (npm allows one leading @scope/), no dot-segments, so
# a crafted name can't widen the fixed-host registry URL path.
_PYPI_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_NPM_NAME = re.compile(r"^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,99}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_GH_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class ProviderRequest(BaseModel):
    kind: Literal["pypi", "npm", "github_release", "arxiv"]
    name: Optional[str] = None
    owner: Optional[str] = None
    repo: Optional[str] = None


def _ok(source: str, title: Optional[str], summary: str, url: Optional[str]) -> dict[str, Any]:
    return {
        "ok": True,
        "source": source,
        "title": title,
        "summary": summary[:_SUMMARY_CLIP],
        "url": url,
        "error": None,
    }


def _miss(source: str, error: str) -> dict[str, Any]:
    return {"ok": False, "source": source, "title": None, "summary": "", "url": None, "error": error}


def _get_json(url: str) -> Any:
    # Follow redirects MANUALLY so the SSRF guard runs on every hop — same as
    # extract_url. A trusted host that open-redirects must not be able to steer the
    # fetch to 127.0.0.1 / a metadata IP (httpx's follow_redirects=True would).
    current = url
    with httpx.Client(headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=False) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            _guard_url(current)
            resp = client.get(current)
            if resp.is_redirect and resp.headers.get("location"):
                current = str(resp.url.join(resp.headers["location"]))
                continue
            resp.raise_for_status()
            return resp.json()
    raise HTTPException(status_code=502, detail=f"too many redirects: {url}")


def _pypi(name: str) -> dict[str, Any]:
    data = _get_json(f"https://pypi.org/pypi/{name}/json")
    info = data.get("info", {})
    version = info.get("version") or "?"
    summary = info.get("summary") or ""
    home = info.get("home_page") or info.get("project_url") or f"https://pypi.org/project/{name}/"
    requires = info.get("requires_python") or ""
    body = f"{name} latest version: {version}."
    if summary:
        body += f" {summary}"
    if requires:
        body += f" Requires Python {requires}."
    return _ok("PyPI", f"{name} {version}", body, f"https://pypi.org/project/{name}/{version}/")


def _npm(name: str) -> dict[str, Any]:
    data = _get_json(f"https://registry.npmjs.org/{name}")
    latest = (data.get("dist-tags") or {}).get("latest") or "?"
    versions = data.get("versions") or {}
    meta = versions.get(latest, {})
    desc = meta.get("description") or data.get("description") or ""
    body = f"{name} latest version: {latest}."
    if desc:
        body += f" {desc}"
    license_ = meta.get("license")
    if isinstance(license_, str) and license_:
        body += f" License: {license_}."
    return _ok("npm", f"{name} {latest}", body, f"https://www.npmjs.com/package/{name}")


def _github_release(owner: str, repo: str) -> dict[str, Any]:
    data = _get_json(f"https://api.github.com/repos/{owner}/{repo}/releases/latest")
    tag = data.get("tag_name") or "?"
    name = data.get("name") or tag
    published = data.get("published_at") or ""
    notes = (data.get("body") or "").strip()
    body = f"{owner}/{repo} latest release: {tag} ({name})."
    if published:
        body += f" Published {published}."
    if notes:
        body += f"\n\nRelease notes:\n{notes}"
    url = data.get("html_url") or f"https://github.com/{owner}/{repo}/releases/latest"
    return _ok("GitHub", f"{owner}/{repo} {tag}", body, url)


def _arxiv(arxiv_id: str) -> dict[str, Any]:
    # HTTPS export host; parse with feedparser (the project's feed parser, used in
    # news.py) rather than stdlib ElementTree — feedparser does not resolve
    # external entities, so it isn't exposed to XXE / billion-laughs from the feed.
    resp = httpx.get(
        "https://export.arxiv.org/api/query",
        params={"id_list": arxiv_id, "max_results": 1},
        timeout=_TIMEOUT,
        headers=_HEADERS,
    )
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)
    if not parsed.entries:
        return _miss("arXiv", "no such paper")
    entry = parsed.entries[0]
    title = (entry.get("title") or "").strip()
    summary = (entry.get("summary") or "").strip()
    authors = [(a.get("name") or "").strip() for a in entry.get("authors", []) if a.get("name")]
    published = (entry.get("published") or "")[:10]
    url = entry.get("id") or entry.get("link") or f"https://arxiv.org/abs/{arxiv_id}"
    body = title
    if authors:
        body += f"\nAuthors: {', '.join(authors[:8])}"
    if published:
        body += f"\nPublished: {published}"
    if summary:
        body += f"\n\nAbstract: {summary}"
    return _ok("arXiv", title or arxiv_id, body, url)


def _bad(name: Optional[str], pattern: re.Pattern[str]) -> bool:
    return not name or not pattern.match(name)


@router.post("/providers/lookup")
def lookup(body: ProviderRequest) -> dict[str, Any]:
    label = _LABELS.get(body.kind, body.kind)
    try:
        if body.kind == "pypi":
            if _bad(body.name, _PYPI_NAME):
                return _miss(label, "invalid package name")
            return _pypi(body.name)
        if body.kind == "npm":
            if _bad(body.name, _NPM_NAME):
                return _miss(label, "invalid package name")
            return _npm(body.name)
        if body.kind == "github_release":
            if _bad(body.owner, _GH_SEGMENT) or _bad(body.repo, _GH_SEGMENT):
                return _miss(label, "invalid owner/repo")
            return _github_release(body.owner, body.repo)
        if body.kind == "arxiv" and body.name:
            return _arxiv(body.name)
        raise HTTPException(status_code=422, detail="missing fields for provider kind")
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        # 404 etc. — a real "not found", returned as a miss so main degrades cleanly.
        return _miss(label, f"{exc.response.status_code}")
    except Exception as exc:  # noqa: BLE001 — any upstream failure degrades to a miss
        return _miss(label, str(exc) or type(exc).__name__)
