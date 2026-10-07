import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedPaths = new Set([
  "sessions",
  "sessions/current",
  "game",
  "game/solution",
  "game/start",
  "game/evidence/reveal",
  "game/message",
  "game/suspect",
  "game/accuse",
  "game/timeout",
  "game/heat",
]);

function backendOrigin() {
  const configured =
    process.env.BACKEND_URL ??
    new URL(process.env.AGENT_URL ?? "http://localhost:8123/").origin;
  return new URL(configured);
}

async function forward(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const resource = path.join("/");
  if (!allowedPaths.has(resource)) {
    return NextResponse.json({ detail: "Not found" }, { status: 404 });
  }

  const url = new URL(`/${path.map(encodeURIComponent).join("/")}`, backendOrigin());
  const startedAt = Date.now();
  console.info(`[game-api] ${request.method} /${resource} -> backend`);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const cookie = request.headers.get("cookie");
  if (contentType) headers.set("content-type", contentType);
  if (cookie) headers.set("cookie", cookie);

  let upstream: Response;
  const waitLog = setInterval(() => {
    console.info(
      `[game-api] ${request.method} /${resource} still waiting for backend (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
  }, 15000);
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "DELETE"
        ? undefined
        : await request.text(),
      cache: "no-store",
    });
  } catch (error) {
    clearInterval(waitLog);
    console.error(
      `[game-api] ${request.method} /${resource} upstream connection failed after ${Date.now() - startedAt}ms`,
      error,
    );
    return NextResponse.json(
      { detail: "Game backend is unavailable. Check that the backend is running." },
      { status: 502 },
    );
  }
  clearInterval(waitLog);
  console.info(
    `[game-api] ${request.method} /${resource} backend responded ${upstream.status} in ${Date.now() - startedAt}ms`,
  );

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) {
    const browserCookie =
      request.nextUrl.protocol === "https:" && !/;\s*secure/i.test(setCookie)
        ? setCookie + "; Secure"
        : setCookie;
    response.headers.set("set-cookie", browserCookie);
  }
  return response;
}

export const GET = forward;
export const POST = forward;
export const DELETE = forward;
