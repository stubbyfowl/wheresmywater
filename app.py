"""
app.py — Where's My Water AZ backend

Minimal FastAPI wrapper around check_address(). Loads the ADWR layers once
at startup (not per-request) so lookups stay fast.

Run:
    uvicorn app:app --reload --port 8000

Then:
    GET http://localhost:8000/check?address=28900+N+Pinnacle+Ranch+Rd,+Rio+Verde,+AZ+85263

This is what script.js's mockLookup() should eventually call instead of
generating fake data -- see the comment block at the top of script.js.
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from check_address import check_address, load_layers, load_wells

app = FastAPI(title="Where's My Water AZ API")

# Allow the static site to call this API from the browser.
#
# NOTE: the deployed site does not use this API at all -- it runs the whole
# lookup client-side against site/data/*.json so it can live on GitHub Pages
# with no backend. This app is kept for local testing and for the day a
# lookup gets too big to ship to the browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://wheresmywater.org",
        "https://www.wheresmywater.org",
        "http://localhost:8080",
    ],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_layers = None
_wells = None


@app.on_event("startup")
def startup():
    global _layers, _wells
    _layers = load_layers()
    _wells = load_wells()


@app.get("/check")
def check(address: str = Query(..., min_length=5, description="Full street address")):
    try:
        return check_address(address, layers=_layers, wells=_wells)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lookup failed: {e}")


@app.get("/health")
def health():
    return {"status": "ok", "layers_loaded": _layers is not None}
