from contextlib import asynccontextmanager

from fastapi import FastAPI


def health():
    return {"status": "ready"}


@asynccontextmanager
async def lifespan(application):
    application.add_api_route("/health", health, methods=["GET"])
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/catalog")
def catalog():
    return {"items": [{"id": "book", "quantity": 2}]}
