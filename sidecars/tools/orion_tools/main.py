from fastapi import FastAPI, HTTPException

from . import __version__
from .jobs import registry
from .routers import downloads, extract, rag, web

app = FastAPI(title="orion-tools", version=__version__)
app.include_router(downloads.router)
app.include_router(extract.router)
app.include_router(rag.router)
app.include_router(web.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "orion-tools", "version": __version__}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return job.public()


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    return {"ok": registry.cancel(job_id)}
