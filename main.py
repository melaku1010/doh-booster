
import os
import time
import hmac
import base64
import logging

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import Response, JSONResponse

app = FastAPI(title="eFootball DNS Optimizer")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("doh")

DOH_TOKEN = os.environ.get("DOH_TOKEN", "")
UPSTREAM = os.environ.get(
    "UPSTREAM_DOH",
    "https://cloudflare-dns.com/dns-query"
)

MAX_DNS_SIZE = 4096
TIMEOUT = 5.0

client = httpx.AsyncClient(
    timeout=TIMEOUT,
    limits=httpx.Limits(
        max_connections=100,
        max_keepalive_connections=20
    ),
    headers={"User-Agent": "eFootball-DNS-Optimizer/1.0"}
)


@app.get("/health")
async def health():
    return {
        "status": "online",
        "service": "eFootball DNS Optimizer"
    }


def authenticate(token: str):
    if not DOH_TOKEN or not hmac.compare_digest(
        token, DOH_TOKEN
    ):
        raise HTTPException(status_code=404)


def validate_dns(packet: bytes):
    if len(packet) < 12 or len(packet) > MAX_DNS_SIZE:
        raise HTTPException(status_code=400)

    # Reject packets that are already DNS responses.
    if packet[2] & 0x80:
        raise HTTPException(status_code=400)


async def forward_dns(packet: bytes):
    start = time.perf_counter()

    try:
        upstream_response = await client.post(
            UPSTREAM,
            content=packet,
            headers={
                "Content-Type": "application/dns-message",
                "Accept": "application/dns-message"
            }
        )

        upstream_response.raise_for_status()

        if "application/dns-message" not in (
            upstream_response.headers.get("content-type", "")
        ).lower():
            raise HTTPException(status_code=502)

        result = upstream_response.content

        if len(result) < 12 or len(result) > MAX_DNS_SIZE:
            raise HTTPException(status_code=502)

        if not (result[2] & 0x80):
            raise HTTPException(status_code=502)

        elapsed = (time.perf_counter() - start) * 1000

        logger.info("DNS upstream response: %.2f ms", elapsed)

        return Response(
            content=result,
            media_type="application/dns-message",
            headers={"Cache-Control": "no-store"}
        )

    except httpx.HTTPError:
        logger.warning("Upstream DNS request failed")
        raise HTTPException(status_code=502)


@app.post("/dns-query/{token}")
async def dns_post(token: str, request: Request):
    authenticate(token)

    content_type = request.headers.get("content-type", "")

    if "application/dns-message" not in content_type.lower():
        raise HTTPException(status_code=415)

    packet = await request.body()
    validate_dns(packet)

    return await forward_dns(packet)


@app.get("/dns-query/{token}")
async def dns_get(token: str, request: Request):
    authenticate(token)

    dns_param = request.query_params.get("dns")

    if not dns_param or len(dns_param) > 6000:
        raise HTTPException(status_code=400)

    try:
        padded = dns_param + "=" * (-len(dns_param) % 4)
        packet = base64.urlsafe_b64decode(padded)
    except Exception:
        raise HTTPException(status_code=400)

    validate_dns(packet)

    return await forward_dns(packet)


@app.on_event("shutdown")
async def shutdown():
    await client.aclose()


@app.get("/")
async def root():
    return JSONResponse({
        "name": "eFootball DNS Optimizer",
        "status": "running",
        "dns_endpoint": "/dns-query/{token}"
    })
