
import os
import time
import hmac
import base64
import logging
from contextlib import asynccontextmanager

import dns.message
import dns.flags
import dns.rdatatype
import httpx

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import Response, JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("efootball-dns")

TOKEN = os.environ["DOH_TOKEN"]

UPSTREAMS = [
    x.strip() for x in os.getenv(
        "UPSTREAM_DOH",
        "https://cloudflare-dns.com/dns-query,"
        "https://dns.google/dns-query"
    ).split(",") if x.strip()
]

CACHE = {}
CACHE_LIMIT = 2000
MAX_DNS_SIZE = 4096
TIMEOUT = 4.0

stats = {
    "queries": 0,
    "cache_hits": 0,
    "upstream_failures": 0,
    "fallback_uses": 0,
    "total_upstream_ms": 0.0,
    "upstream_successes": 0
}

client = None


@asynccontextmanager
async def lifespan(app):
    global client

    client = httpx.AsyncClient(
        timeout=TIMEOUT,
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=30
        )
    )
    yield
    await client.aclose()


app = FastAPI(
    title="eFootball DNS Optimizer V2",
    lifespan=lifespan
)


def authenticate(token):
    if not hmac.compare_digest(token, TOKEN):
        raise HTTPException(status_code=404)


def parse_query(packet):
    if len(packet) < 12 or len(packet) > MAX_DNS_SIZE:
        raise HTTPException(status_code=400)

    try:
        query = dns.message.from_wire(packet)
    except Exception:
        raise HTTPException(status_code=400)

    if query.flags & dns.flags.QR:
        raise HTTPException(status_code=400)

    if len(query.question) != 1:
        raise HTTPException(status_code=400)

    return query


def cache_key(query):
    question = query.question[0]

    return (
        question.name.to_text().lower(),
        question.rdtype,
        question.rdclass,
        query.flags & (dns.flags.RD | dns.flags.CD),
        query.ednsflags & dns.flags.DO
    )


def get_cached(key, query_id):
    item = CACHE.get(key)

    if not item:
        return None

    wire, stored_at, ttl = item
    elapsed = time.monotonic() - stored_at

    if elapsed >= ttl:
        CACHE.pop(key, None)
        return None

    try:
        answer = dns.message.from_wire(wire)
        answer.id = query_id

        remaining = max(0, int(ttl - elapsed))

        for section in (
            answer.answer,
            answer.authority,
            answer.additional
        ):
            for rrset in section:
                if rrset.rdtype != dns.rdatatype.OPT:
                    rrset.ttl = min(rrset.ttl, remaining)

        return answer.to_wire()

    except Exception:
        CACHE.pop(key, None)
        return None


def save_cache(key, packet):
    try:
        answer = dns.message.from_wire(packet)

        if answer.rcode() != 0 or not answer.answer:
            return

        ttls = [
            rrset.ttl
            for rrset in answer.answer
            if rrset.rdtype != dns.rdatatype.OPT
        ]

        if not ttls:
            return

        ttl = min(min(ttls), 300)

        if ttl <= 0:
            return

        if len(CACHE) >= CACHE_LIMIT:
            CACHE.pop(next(iter(CACHE)))

        CACHE[key] = (
            packet,
            time.monotonic(),
            ttl
        )

    except Exception:
        logger.warning("DNS cache write failed")


async def forward_dns(query, packet):
    global stats

    for index, upstream in enumerate(UPSTREAMS):
        start = time.perf_counter()

        try:
            response = await client.post(
                upstream,
                content=packet,
                headers={
                    "Content-Type": "application/dns-message",
                    "Accept": "application/dns-message"
                }
            )

            response.raise_for_status()

            if "application/dns-message" not in (
                response.headers.get("content-type", "").lower()
            ):
                raise ValueError("Invalid upstream content type")

            result = response.content

            if len(result) < 12 or len(result) > MAX_DNS_SIZE:
                raise ValueError("Invalid DNS response size")

            answer = dns.message.from_wire(result)

            if not answer.flags & dns.flags.QR:
                raise ValueError("Not a DNS response")

            answer.id = query.id
            result = answer.to_wire()

            elapsed = (time.perf_counter() - start) * 1000

            stats["upstream_successes"] += 1
            stats["total_upstream_ms"] += elapsed

            if index > 0:
                stats["fallback_uses"] += 1

            logger.info(
                "Upstream %s responded in %.2f ms",
                upstream,
                elapsed
            )

            save_cache(cache_key(query), result)

            return result

        except Exception as exc:
            stats["upstream_failures"] += 1
            logger.warning(
                "Upstream %s failed: %s",
                upstream,
                type(exc).__name__
            )

    raise HTTPException(status_code=502)


async def handle_dns(packet):
    query = parse_query(packet)
    stats["queries"] += 1

    key = cache_key(query)

    cached = get_cached(key, query.id)

    if cached:
        stats["cache_hits"] += 1
        return cached

    return await forward_dns(query, packet)


@app.get("/health")
async def health():
    return {
        "status": "online",
        "version": "2.0",
        "upstreams": len(UPSTREAMS)
    }


@app.get("/stats/{token}")
async def get_stats(token: str):
    authenticate(token)

    successes = stats["upstream_successes"]

    average = (
        stats["total_upstream_ms"] / successes
        if successes else 0
    )

    return {
        **stats,
        "average_upstream_ms": round(average, 2),
        "cache_entries": len(CACHE)
    }


@app.post("/dns-query/{token}")
async def dns_post(token: str, request: Request):
    authenticate(token)

    if "application/dns-message" not in (
        request.headers.get("content-type", "").lower()
    ):
        raise HTTPException(status_code=415)

    packet = await request.body()

    if len(packet) > MAX_DNS_SIZE:
        raise HTTPException(status_code=413)

    result = await handle_dns(packet)

    return Response(
        content=result,
        media_type="application/dns-message",
        headers={"Cache-Control": "no-store"}
    )


@app.get("/dns-query/{token}")
async def dns_get(token: str, request: Request):
    authenticate(token)

    encoded = request.query_params.get("dns", "")

    if not encoded or len(encoded) > 6000:
        raise HTTPException(status_code=400)

    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        packet = base64.urlsafe_b64decode(padded)
    except Exception:
        raise HTTPException(status_code=400)

    result = await handle_dns(packet)

    return Response(
        content=result,
        media_type="application/dns-message",
        headers={"Cache-Control": "no-store"}
    )


@app.get("/")
async def root():
    return JSONResponse({
        "name": "eFootball DNS Optimizer",
        "version": "2.0",
        "status": "running"
    })
