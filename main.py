from __future__ import annotations

import os

import uvicorn

from main_tp25 import app


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main_tp25:app", host=host, port=port, reload=False)
