// src/api/trackingapp.js
// Improved, fully-debuggable API client
// Shows timestamp logs in browser console for debugging.

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "https://mmtt-web.onrender.com";

/**
 * safeFetchJson
 * Lightweight wrapper around fetch that supports timeout.
 */
async function safeFetchJson(url, opts = {}, timeoutMs = 15000) {
  console.log("%c[API] Fetch:", "color:#00aaff", url);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(id);

    console.log("%c[API] Status:", "color:#ffaa00", res.status);

    if (!res.ok) return { status: res.status, ok: false, res };

    const json = await res.json();
    console.log("%c[API] JSON Response:", "color:#22cc88", json);

    return { status: res.status, ok: true, json, res };
  } catch (err) {
    clearTimeout(id);
    console.error("%c[API] Fetch Error:", "color:red", err);
    throw err;
  }
}

/**
 * parseTimestampCandidate
 * Converts seconds / ms / ISO → epoch seconds
 */
function parseTimestampCandidate(val) {
  console.log("%c[TIME] Raw candidate:", "color:#bb00ff", val);

  if (val == null) return null;

  // numeric string
  if (typeof val === "string" && /^\d+$/.test(val)) val = Number(val);

  if (typeof val === "number") {
    // milliseconds?
    if (val > 1e12) {
      console.log("%c[TIME] Detected milliseconds", "color:orange");
      return Math.floor(val / 1000);
    }
    // seconds?
    if (val >= 1e9) {
      console.log("%c[TIME] Detected seconds", "color:orange");
      return Math.floor(val);
    }

    console.warn("%c[TIME] Number too small to be a timestamp:", "color:red", val);
    return null;
  }

  // ISO string
  if (typeof val === "string") {
    const ms = Date.parse(val);
    if (!Number.isNaN(ms)) {
      console.log("%c[TIME] Parsed ISO timestamp", "color:orange", ms);
      return Math.floor(ms / 1000);
    }
    console.warn("%c[TIME] Invalid ISO timestamp:", "color:red", val);
    return null;
  }

  return null;
}

/**
 * extractServerDateHeader → epoch seconds
 */
function extractServerDateHeader(res) {
  try {
    const header =
      res?.headers?.get?.("Date") || res?.headers?.get?.("date");

    console.log("%c[TIME] Server Date header:", "color:#0088ff", header);

    if (!header) return null;

    const ms = new Date(header).getTime();
    if (Number.isNaN(ms)) return null;

    return Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

/**
 * fetchLatestLocation()
 * Main Latest Location Fetcher
 */
export async function fetchLatestLocation(deviceId) {
  if (!deviceId) return null;

  const url = `${API_BASE_URL}/device/${encodeURIComponent(
    deviceId
  )}/latest`;

  console.log(
    "%c[LATEST] Fetching latest location for:",
    "color:#00ddff",
    deviceId
  );

  try {
    const resp = await safeFetchJson(url, { method: "GET" }, 12000);

    if (!resp.ok) {
      console.warn(
        "%c[LATEST] Non-OK status:",
        "color:red",
        resp.status
      );
      if (resp.status === 404) return null;
      throw new Error(`fetchLatestLocation HTTP ${resp.status}`);
    }

    const data = resp.json || null;
    if (!data) return null;

    console.log("%c[LATEST] Raw Data:", "color:#44ff44", data);

    const candidate =
      data.timestamp ??
      data.ts ??
      data.time ??
      data.server_time ??
      data.date ??
      null;

    console.log(
      "%c[TIME] Timestamp candidate:",
      "color:#ffaa00",
      candidate
    );

    // Try parsing timestamp
    let finalTs = parseTimestampCandidate(candidate);

    // Try server Date header as fallback
    if (finalTs == null) {
      console.warn(
        "%c[TIME] Invalid body timestamp, using server header",
        "color:red"
      );
      finalTs = extractServerDateHeader(resp.res);
    }

    // Final fallback: local system time
    if (finalTs == null) {
      console.warn(
        "%c[TIME] WARNING: Using LOCAL SYSTEM TIME!",
        "color:red"
      );
      finalTs = Math.floor(Date.now() / 1000);
    }

    console.log("%c[TIME] FINAL TIMESTAMP:", "color:#00ff00", finalTs);

    return {
      ...data,
      lat: data.lat != null ? Number(data.lat) : null,
      lon: data.lon != null ? Number(data.lon) : null,
      timestamp: finalTs,
    };
  } catch (err) {
    console.error("%c[LATEST] ERROR:", "color:red", err);
    throw err;
  }
}

/**
 * fetchHistory()
 * Historical location data
 */
export async function fetchHistory(deviceId) {
  if (!deviceId) return [];
  const url = `${API_BASE_URL}/device/${encodeURIComponent(
    deviceId
  )}/history`;

  console.log(
    "%c[HISTORY] Fetch history for:",
    "color:#00ffaa",
    deviceId
  );

  try {
    const resp = await safeFetchJson(url, { method: "GET" }, 15000);

    if (!resp.ok) {
      console.warn(
        "%c[HISTORY] Non-OK status:",
        "color:red",
        resp.status
      );
      return [];
    }

    const data = resp.json;
    if (!data) return [];

    console.log("%c[HISTORY] Raw Data:", "color:#77ff77", data);

    let arr = null;

    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.coordinates)) arr = data.coordinates;
    else if (Array.isArray(data.points)) arr = data.points;
    else if (Array.isArray(data.data)) arr = data.data;
    else if (Array.isArray(data.history)) arr = data.history;
    else arr = [];

    const normalized = arr
      .map((p, index) => {
        const tsCandidate =
          p.ts ?? p.timestamp ?? p.time ?? p.server_time ?? null;

        const parsedTs = parseTimestampCandidate(tsCandidate);

        console.log(
          `%c[HISTORY] Point ${index}:`,
          "color:#ffaaee",
          "lat:",
          p.lat,
          "lon:",
          p.lon,
          "raw ts:",
          tsCandidate,
          "parsed:",
          parsedTs
        );

        return {
          lat: p.lat != null ? Number(p.lat) : NaN,
          lon: p.lon != null ? Number(p.lon) : NaN,
          ts: parsedTs,
        };
      })
      .filter(
        (p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lon)
      );

    console.log(
      "%c[HISTORY] Final normalized points:",
      "color:#00ff99",
      normalized
    );

    return normalized;
  } catch (err) {
    console.error("%c[HISTORY] ERROR:", "color:red", err);
    return [];
  }
}
