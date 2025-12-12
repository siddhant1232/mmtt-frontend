// src/App.jsx
import { useState, useEffect, useRef, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  ScaleControl,
  useMap,
} from 'react-leaflet';
import { Icon } from 'leaflet';
import { fetchLatestLocation, fetchHistory } from './api/trackingapp.js';
import './App.css';
import 'leaflet/dist/leaflet.css';

// Base URL fallback (used for server time HEAD request if needed)
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://mmtt-web.onrender.com';

// ---------------------- Helpers ----------------------

// Convert epoch seconds -> "HH:MM:SS"
const formatHHMMSS = (epochSeconds) => {
  if (!epochSeconds && epochSeconds !== 0) return '--:--:--';
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

// Optional human readable with timezone (kept for other places if needed)
const formatServerTimeLong = (epochSeconds) => {
  if (!epochSeconds && epochSeconds !== 0) return null;
  const dt = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(dt);
};

// ---------------------- localStorage + cleaning helpers ----------

// localStorage key per device
const localHistoryKey = (deviceId) => `track_history_${deviceId}`;

// Save normalized history to localStorage (array of {lat, lon, ts})
function saveLocalHistory(deviceId, arr) {
  try {
    if (!deviceId) return;
    localStorage.setItem(localHistoryKey(deviceId), JSON.stringify(arr));
    console.log('[LS] saved history', deviceId, arr.length);
  } catch (e) {
    console.warn('[LS] save error', e);
  }
}

// Load history from localStorage (returns array or [])
function loadLocalHistory(deviceId) {
  try {
    if (!deviceId) return [];
    const raw = localStorage.getItem(localHistoryKey(deviceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    console.warn('[LS] load error', e);
    return [];
  }
}

/**
 * cleanAndSortHistory(history)
 * - Removes points with no/invalid ts
 * - Filters NaN lat/lon
 * - Removes huge jumps (spikes) using a distance threshold (default 200 km)
 * - Sorts by ts ascending
 */
function cleanAndSortHistory(history, opts = {}) {
  if (!Array.isArray(history)) return [];
  const {
    minYear = 2009, // timestamps before this year are suspicious
    jumpKmThreshold = 200, // remove isolated jumps bigger than this (200 km)
    maxFutureSec = 24 * 3600, // allow timestamps up to 24h in future
  } = opts;

  const nowSec = Math.floor(Date.now() / 1000);

  // filter valid coordinates and parse ts as number
  const normalized = history
    .map((p) => ({
      lat: Number(p.lat),
      lon: Number(p.lon),
      ts: p.ts == null ? null : Number(p.ts),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  // remove invalid timestamps
  const withValidTs = normalized.filter((p) => {
    if (p.ts == null) return false;
    // sensible range
    if (p.ts < minYear * 365 * 24 * 3600) return false;
    if (p.ts > nowSec + maxFutureSec) return false;
    return true;
  });

  // sort by ts ascending
  withValidTs.sort((a, b) => a.ts - b.ts);

  // remove huge isolated jumps: keep a running cleaned array
  const cleaned = [];
  const earthKm = (lat1, lon1, lat2, lon2) => {
    // haversine
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  for (let i = 0; i < withValidTs.length; i += 1) {
    const p = withValidTs[i];
    if (cleaned.length === 0) {
      cleaned.push(p);
    } else {
      const prev = cleaned[cleaned.length - 1];
      const km = earthKm(prev.lat, prev.lon, p.lat, p.lon);
      const dt = p.ts - prev.ts; // seconds
      // if jump is huge but dt is very small, it's suspicious
      if (km > jumpKmThreshold && dt < 60) {
        console.warn('[CLEAN] Dropping spike point', { prev, p, km, dt });
        // skip p
        continue;
      }
      cleaned.push(p);
    }
  }

  console.log('[CLEAN] before:', history.length, 'after:', cleaned.length);
  return cleaned;
}

// Optional helper to append a point client-side and persist
function appendPointToLocal(deviceId, point) {
  try {
    const existing = loadLocalHistory(deviceId);
    existing.push(point);
    const cleaned = cleanAndSortHistory(existing);
    saveLocalHistory(deviceId, cleaned);
    return cleaned;
  } catch (e) {
    console.warn('[LS] append error', e);
    return [];
  }
}

// ---------------------- Leaflet icon fix ----------------------

// Fix for default marker icon in React-Leaflet
delete Icon.Default.prototype._getIconUrl;
Icon.Default.mergeOptions({
  iconRetinaUrl:
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ---------------------- Helper Components ----------------------

// Small helper component to recenter map when target moves — now pans smoothly
function RecenterOnTarget({ lat, lon }) {
  const map = useMap();

  useEffect(() => {
    if (lat || lat === 0) {
      try {
        map.panTo([lat, lon], { animate: true, duration: 0.7 });
      } catch {
        map.setView([lat, lon]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon]);

  return null;
}

/**
 * SmoothMarker
 * - Interpolates marker position using requestAnimationFrame when coordinates update.
 * - This creates smooth micro-movements for tiny GPS changes.
 */
function SmoothMarker({ position, children }) {
  const markerRef = useRef({ lat: position[0], lon: position[1] });
  const animRef = useRef(null);
  const leafletRef = useRef(null);

  useEffect(() => {
    const from = { ...markerRef.current };
    const to = { lat: position[0], lon: position[1] };

    // If no movement, do nothing
    if (from.lat === to.lat && from.lon === to.lon) return;

    const duration = 700; // milliseconds for the interpolation
    const start = performance.now();

    cancelAnimationFrame(animRef.current);

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      // ease in-out cubic
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lat = from.lat + (to.lat - from.lat) * ease;
      const lon = from.lon + (to.lon - from.lon) * ease;

      markerRef.current = { lat, lon };

      // update leaflet marker position directly to avoid re-render
      if (leafletRef.current && leafletRef.current.setLatLng) {
        leafletRef.current.setLatLng([lat, lon]);
      }

      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      }
    }

    animRef.current = requestAnimationFrame(step);

    return () => cancelAnimationFrame(animRef.current);
  }, [position]);

  // initial render - position taken from markerRef so small changes animate
  return (
    <Marker
      position={[markerRef.current.lat, markerRef.current.lon]}
      ref={(m) => {
        if (m && m.setLatLng) {
          leafletRef.current = m;
        } else if (m && m._leaflet_id) {
          leafletRef.current = m;
        }
      }}
    >
      {children}
    </Marker>
  );
}

// ---------------------- Main App ----------------------

function App() {
  const [deviceId, setDeviceId] = useState('esp01');
  const [latestLocation, setLatestLocation] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000); // 5 seconds
  const [followTarget, setFollowTarget] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [mapStyle, setMapStyle] = useState('standard');

  const [toastMessage, setToastMessage] = useState(null);
  const toastTimerRef = useRef(null);

  const mountedRef = useRef(true);

  // Fetch data function — clears previous data immediately to avoid stale visuals
  const loadData = async () => {
    if (!deviceId.trim()) {
      setError('Please enter a device ID');
      return;
    }

    // Clear previous data right away so UI removes old points while fetching
    setLatestLocation(null);
    setHistory([]);
    setError(null);
    setLoading(true);

    try {
      const [latest, historyData] = await Promise.all([
        fetchLatestLocation(deviceId),
        fetchHistory(deviceId),
      ]);

      // Normalize latest
      if (latest) {
        const normalizedLatest = {
          device_id: latest.device_id ?? deviceId,
          lat: Number(latest.lat),
          lon: Number(latest.lon),
          speed: latest.speed == null ? null : Number(latest.speed),
          battery: latest.battery == null ? null : Number(latest.battery),
          sos: !!latest.sos,
          timestamp: latest.timestamp ?? Math.floor(Date.now() / 1000),
        };
        setLatestLocation(normalizedLatest);
      } else {
        setLatestLocation(null);
      }

      // Normalize history: array of {lat, lon, ts}
      let normalizedHistory = [];
      if (Array.isArray(historyData) && historyData.length > 0) {
        normalizedHistory = historyData.map((p) => ({
          lat: p.lat != null ? Number(p.lat) : NaN,
          lon: p.lon != null ? Number(p.lon) : NaN,
          ts: p.ts ?? p.timestamp ?? null,
        }));
      } else {
        // API returned empty -> try localStorage fallback
        const fromLS = loadLocalHistory(deviceId);
        if (fromLS && fromLS.length > 0) {
          console.log('[LOAD] Using localStorage fallback', fromLS.length);
          normalizedHistory = fromLS;
        } else {
          normalizedHistory = [];
        }
      }

      // Clean + sort the history (removes invalid ts and spikes)
      const cleaned = cleanAndSortHistory(normalizedHistory);

      // Persist cleaned history to localStorage for future runs
      if (cleaned.length > 0) saveLocalHistory(deviceId, cleaned);

      // If server didn't provide latest but we do have cleaned history, use last point as latest
      if (!latest && cleaned.length > 0) {
        const last = cleaned[cleaned.length - 1];
        const lastNormalized = {
          device_id: deviceId,
          lat: last.lat,
          lon: last.lon,
          speed: null,
          battery: null,
          sos: false,
          timestamp: last.ts,
        };
        setLatestLocation(lastNormalized);
      }

      // update state with cleaned history
      setHistory(cleaned);
    } catch (err) {
      setError(`Failed to load data: ${err?.message ?? err}`);
      console.error(err);
      // keep cleared state on error
      setLatestLocation(null);
      setHistory([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // Clears frontend-only data (does NOT hit backend)
  const clearLocalData = () => {
    setLatestLocation(null);
    setHistory([]);
    setError(null);

    // remove stored local history for this device
    try {
      localStorage.removeItem(localHistoryKey(deviceId));
      console.log('[LS] removed history for', deviceId);
    } catch (e) {
      console.warn('[LS] remove error', e);
    }

    // toast: transient cleared message
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastMessage('Cleared');
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 1500);
  };

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    loadData();

    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      loadData();
    }, refreshInterval);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshInterval, deviceId]);

  // Prepare polyline coordinates
  const polylineCoordinates = history.map((point) => [point.lat, point.lon]);

  // Calculate map center
  const fallbackCenter = [29.866, 77.8905]; // Roorkee-ish default
  const mapCenter = latestLocation
    ? [latestLocation.lat, latestLocation.lon]
    : history.length > 0
    ? [history[history.length - 1].lat, history[history.length - 1].lon]
    : fallbackCenter;

  // Choose tile style
  const tileUrl =
    mapStyle === 'standard'
      ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

  // Last update HH:MM:SS (uses latestLocation.timestamp)
  const lastUpdate = useMemo(() => {
    if (!latestLocation || latestLocation.timestamp == null) return null;
    return formatHHMMSS(latestLocation.timestamp);
  }, [latestLocation]);

  const pathDistance = useMemo(() => {
    // quick-and-light distance approximation for the small hackathon demo
    let total = 0;
    for (let i = 1; i < history.length; i += 1) {
      const a = history[i - 1];
      const b = history[i];
      const dx = b.lat - a.lat;
      const dy = b.lon - a.lon;
      total += Math.sqrt(dx * dx + dy * dy) * 111; // rough km scale
    }
    return total;
  }, [history]);

  const recentTrail = useMemo(() => history.slice(-6).reverse(), [history]);

  return (
    <div className="app-root">
      <div className="hero-glow" />

      {/* Top BSF header */}
      <header className="bsf-header">
        <div className="bsf-title">
          <span className="bsf-badge">BSF</span>
          <div>
            <h1>Multi-Mode Tactical Tracker</h1>
            <p>Live field unit situational awareness</p>
          </div>
        </div>

        <div className="bsf-actions">
          <div className="chip ghost">Render-ready</div>
          <div className="chip success">
            <span className="status-dot online" />
            Backend online
          </div>
          <button className="btn outline" onClick={loadData} disabled={loading}>
            {loading ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </header>

      {/* Top stats ribbon */}
      <section className="ribbon">
        <div className="stat-card">
          <span className="label">Tracking</span>
          <strong>{latestLocation ? latestLocation.device_id : '—'}</strong>
          <small>Device ID</small>
        </div>
        <div className="stat-card">
          <span className="label">Points</span>
          <strong>{history.length}</strong>
          <small>Track samples</small>
        </div>
        <div className="stat-card">
          <span className="label">Path length</span>
          <strong>{pathDistance.toFixed(2)} km</strong>
          <small>Approx. ground distance</small>
        </div>
        <div className="stat-card">
          <span className="label">Last update</span>
          <strong>{lastUpdate || 'Waiting…'}</strong>
          <small>HH:MM:SS</small>
        </div>
      </section>

      <div className="layout">
        {/* Left control panel */}
        <aside className="control-panel">
          <div className="panel-section glass">
            <div className="panel-head">
              <h2>Target Control</h2>
              <div className="chip">Live</div>
            </div>
            <label htmlFor="deviceId" className="field-label">
              Device ID
            </label>
            <div className="device-row">
              <input
                id="deviceId"
                type="text"
                value={deviceId}
                onChange={(e) => {
                  setDeviceId(e.target.value);
                  // clear previous points immediately when device changes
                  setLatestLocation(null);
                  setHistory([]);
                }}
                placeholder="esp01"
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={loadData} disabled={loading}>
                  {loading ? 'Loading…' : 'Refresh'}
                </button>
                <button
                  className="btn outline"
                  onClick={clearLocalData}
                  disabled={loading && !latestLocation && history.length === 0}
                  title="Clear local latest & history"
                >
                  Clear data
                </button>
              </div>
            </div>

            <div className="toggle-row">
              <label>
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />{' '}
                Auto-refresh ({refreshInterval / 1000}s)
              </label>
              <input
                type="range"
                min="2000"
                max="30000"
                step="1000"
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                disabled={!autoRefresh}
              />
            </div>

            <div className="toggle-row">
              <label>
                <input type="checkbox" checked={followTarget} onChange={(e) => setFollowTarget(e.target.checked)} /> Follow
                target
              </label>
              <label>
                <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} /> Show path
              </label>
            </div>

            <div className="toggle-row map-style-row">
              <span>Map style</span>
              <div className="map-style-toggle">
                <button className={mapStyle === 'standard' ? 'btn small active' : 'btn small'} onClick={() => setMapStyle('standard')}>
                  Standard
                </button>
                <button className={mapStyle === 'dark' ? 'btn small active' : 'btn small'} onClick={() => setMapStyle('dark')}>
                  Night Ops
                </button>
              </div>
            </div>
          </div>

          {latestLocation && (
            <div className="panel-section glass device-info">
              <div className="panel-head">
                <h2>Unit Snapshot</h2>
                <div className="chip ghost">Live feed</div>
              </div>
              <h3>{latestLocation.device_id}</h3>
              <div className="info-grid">
                <div>
                  <span className="label">Location</span>
                  <span>
                    {latestLocation.lat.toFixed(6)}, {latestLocation.lon.toFixed(6)}
                  </span>
                </div>
                {latestLocation.speed !== null && (
                  <div>
                    <span className="label">Speed</span>
                    <span>{latestLocation.speed.toFixed(2)} m/s</span>
                  </div>
                )}
                {latestLocation.battery !== null && (
                  <div>
                    <span className="label">Battery</span>
                    <span>{latestLocation.battery}%</span>
                  </div>
                )}
                <div>
                  <span className="label">SOS</span>
                  <span className={latestLocation.sos ? 'sos active' : 'sos'}>{latestLocation.sos ? '⚠ ACTIVE' : 'Normal'}</span>
                </div>
                <div>
                  <span className="label">Track points</span>
                  <span>{history.length}</span>
                </div>
                <div>
                  <span className="label">Last update</span>
                  <span>{formatHHMMSS(latestLocation.timestamp)}</span>
                </div>
              </div>
            </div>
          )}

          <div className="panel-section glass mini-trail">
            <div className="panel-head">
              <h2>Recent trail</h2>
              <small>Last {recentTrail.length} points</small>
            </div>
            {recentTrail.length === 0 && <p className="muted">No trail yet. Ingest data to see it live.</p>}
            {recentTrail.map((p, idx) => (
              <div key={`${p.lat}-${p.lon}-${idx}`} className="trail-row">
                <span className="dot" />
                <div>
                  <div className="coords">
                    {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                  </div>
                  <small>{p.ts ? formatHHMMSS(p.ts) : '--:--:--'}</small>
                </div>
              </div>
            ))}
          </div>

          {error && <div className="panel-section glass error-box">{error}</div>}
        </aside>

        {/* Map area */}
        <main className="map-shell glass">
          <div className="map-overlay-top">
            <div className="map-pill">
              <span className="pulse-dot" /> Live ops map
            </div>
            {latestLocation && (
              <div className="map-pill subtle">
                <strong>{latestLocation.device_id}</strong> · {latestLocation.lat.toFixed(4)},{' '}
                {latestLocation.lon.toFixed(4)}
              </div>
            )}
          </div>

          <MapContainer center={mapCenter} zoom={13} zoomControl={true} style={{ height: '100%', width: '100%' }}>
            <TileLayer attribution="&copy; OpenStreetMap contributors" url={tileUrl} />

            <ScaleControl position="bottomleft" />

            {/* Auto-recenter when following target */}
            {followTarget && latestLocation && <RecenterOnTarget lat={latestLocation.lat} lon={latestLocation.lon} />}

            {/* Historical path polyline */}
            {showPath && polylineCoordinates.length > 1 && (
              <Polyline
                positions={polylineCoordinates}
                pathOptions={{
                  color: '#ff8c00',
                  weight: 4,
                  opacity: 0.85,
                  smoothFactor: 1.5,
                }}
              />
            )}

            {/* Latest location marker (smooth) */}
            {latestLocation && (
              <SmoothMarker position={[latestLocation.lat, latestLocation.lon]}>
                <Popup>
                  <div className="popup-content">
                    <strong>{latestLocation.device_id}</strong>
                    <br />
                    Lat: {latestLocation.lat.toFixed(6)}
                    <br />
                    Lon: {latestLocation.lon.toFixed(6)}
                    {latestLocation.speed !== null && (
                      <>
                        <br />
                        Speed: {latestLocation.speed.toFixed(2)} m/s
                      </>
                    )}
                    {latestLocation.battery !== null && (
                      <>
                        <br />
                        Battery: {latestLocation.battery}%
                      </>
                    )}
                    {latestLocation.sos && (
                      <>
                        <br />
                        <strong style={{ color: 'red' }}>⚠ SOS ACTIVE</strong>
                      </>
                    )}
                    <br />
                    <small>{formatHHMMSS(latestLocation.timestamp)}</small>
                  </div>
                </Popup>
              </SmoothMarker>
            )}

            {/* SOS overlay card */}
            {latestLocation && latestLocation.sos && (
              <div className="sos-floating-card" aria-hidden>
                <div className="sos-inner">
                  <h3>⚠ SOS ACTIVE</h3>
                  <p>
                    Unit <strong>{latestLocation.device_id}</strong> reported SOS.
                    <br />
                    {latestLocation.lat.toFixed(6)}, {latestLocation.lon.toFixed(6)}
                  </p>
                </div>
              </div>
            )}
          </MapContainer>
        </main>
      </div>

      {/* Toast / transient messages */}
      {toastMessage && (
        <div className="toast toast-success" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default App;
