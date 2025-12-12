// src/App.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
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

// ---------------------- Responsive helpers ----------------------
const MOBILE_BREAKPOINT = 768; // px

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

// ---------------------- localStorage + cleaning helpers ----------

const localHistoryKey = (deviceId) => `track_history_${deviceId}`;

function saveLocalHistory(deviceId, arr) {
  try {
    if (!deviceId) return;
    localStorage.setItem(localHistoryKey(deviceId), JSON.stringify(arr));
    console.log('[LS] saved history', deviceId, arr.length);
  } catch (e) {
    console.warn('[LS] save error', e);
  }
}

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

function cleanAndSortHistory(history, opts = {}) {
  if (!Array.isArray(history)) return [];
  const {
    minYear = 2009,
    jumpKmThreshold = 200,
    maxFutureSec = 24 * 3600,
  } = opts;

  const nowSec = Math.floor(Date.now() / 1000);

  const normalized = history
    .map((p) => ({
      lat: Number(p.lat),
      lon: Number(p.lon),
      ts: p.ts == null ? null : Number(p.ts),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  const withValidTs = normalized.filter((p) => {
    if (p.ts == null) return false;
    if (p.ts < minYear * 365 * 24 * 3600) return false;
    if (p.ts > nowSec + maxFutureSec) return false;
    return true;
  });

  withValidTs.sort((a, b) => a.ts - b.ts);

  const cleaned = [];
  const earthKm = (lat1, lon1, lat2, lon2) => {
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371;
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
      const dt = p.ts - prev.ts;
      if (km > jumpKmThreshold && dt < 60) {
        console.warn('[CLEAN] Dropping spike point', { prev, p, km, dt });
        continue;
      }
      cleaned.push(p);
    }
  }

  console.log('[CLEAN] before:', history.length, 'after:', cleaned.length);
  return cleaned;
}

// ---------------------- Leaflet icon fix (larger marker) ------------------

// Use scaled-up default marker icons so the pin is visible on large map
delete Icon.Default.prototype._getIconUrl;
const markerIconUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png';
const markerIconRetinaUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png';
const markerShadowUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';
Icon.Default.mergeOptions({
  iconRetinaUrl: markerIconRetinaUrl,
  iconUrl: markerIconUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [34, 48], // a touch bigger
  iconAnchor: [17, 48],
  popupAnchor: [0, -52],
  shadowSize: [50, 50],
});

// ---------------------- Helper Components ----------------------

// Smooth recentering
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
  }, [lat, lon, map]);
  return null;
}

function SmoothMarker({ position, children }) {
  const markerRef = useRef({ lat: position[0], lon: position[1] });
  const animRef = useRef(null);
  const leafletRef = useRef(null);

  useEffect(() => {
    const from = { ...markerRef.current };
    const to = { lat: position[0], lon: position[1] };
    if (from.lat === to.lat && from.lon === to.lon) return;

    const duration = 700;
    const start = performance.now();

    cancelAnimationFrame(animRef.current);

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lat = from.lat + (to.lat - from.lat) * ease;
      const lon = from.lon + (to.lon - from.lon) * ease;

      markerRef.current = { lat, lon };

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
  const [refreshInterval, setRefreshInterval] = useState(5000);
  const [followTarget, setFollowTarget] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [mapStyle, setMapStyle] = useState('standard');

  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT : false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [toastMessage, setToastMessage] = useState(null);
  const toastTimerRef = useRef(null);
  const mountedRef = useRef(true);

  const mapRef = useRef(null);

  useEffect(() => {
    function onResize() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) setDrawerOpen(false);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadData = async () => {
    if (!deviceId.trim()) {
      setError('Please enter a device ID');
      return;
    }

    setLatestLocation(null);
    setHistory([]);
    setError(null);
    setLoading(true);

    try {
      const [latest, historyData] = await Promise.all([
        fetchLatestLocation(deviceId),
        fetchHistory(deviceId),
      ]);

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

      let normalizedHistory = [];
      if (Array.isArray(historyData) && historyData.length > 0) {
        normalizedHistory = historyData.map((p) => ({
          lat: p.lat != null ? Number(p.lat) : NaN,
          lon: p.lon != null ? Number(p.lon) : NaN,
          ts: p.ts ?? p.timestamp ?? null,
        }));
      } else {
        const fromLS = loadLocalHistory(deviceId);
        if (fromLS && fromLS.length > 0) {
          normalizedHistory = fromLS;
        } else {
          normalizedHistory = [];
        }
      }

      const cleaned = cleanAndSortHistory(normalizedHistory);
      if (cleaned.length > 0) saveLocalHistory(deviceId, cleaned);

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

      setHistory(cleaned);
    } catch (err) {
      setError(`Failed to load data: ${err?.message ?? err}`);
      console.error(err);
      setLatestLocation(null);
      setHistory([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const clearLocalData = () => {
    setLatestLocation(null);
    setHistory([]);
    setError(null);

    try {
      localStorage.removeItem(localHistoryKey(deviceId));
    } catch (e) {
      console.warn('[LS] remove error', e);
    }

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastMessage('Cleared');
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 1500);
  };

  useEffect(() => {
    mountedRef.current = true;
    loadData();
    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      loadData();
    }, refreshInterval);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, refreshInterval, deviceId]);

  useEffect(() => {
    console.debug('[DEBUG] latestLocation:', latestLocation);
    console.debug('[DEBUG] history (count):', history.length);
  }, [latestLocation, history]);

  // Call invalidateSize when layout-affecting state changes
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const t = setTimeout(() => {
      try {
        m.invalidateSize?.();
      } catch (e) {
        console.warn('map invalidate failed', e);
      }
    }, 80);
    return () => clearTimeout(t);
  }, [isMobile, drawerOpen, mapStyle, deviceId]);

  const lastUpdateEpoch = useMemo(() => {
    if (latestLocation && (latestLocation.timestamp || latestLocation.timestamp === 0)) {
      return latestLocation.timestamp;
    }
    if (history && history.length > 0) {
      const last = history[history.length - 1];
      return last.ts ?? null;
    }
    return null;
  }, [latestLocation, history]);

  const lastUpdate = useMemo(() => {
    if (lastUpdateEpoch == null) return null;
    return formatHHMMSS(lastUpdateEpoch);
  }, [lastUpdateEpoch]);

  const pointsCount = useMemo(() => {
    if (Array.isArray(history) && history.length > 0) return history.length;
    if (latestLocation) return 1;
    return 0;
  }, [history, latestLocation]);

  const pathDistance = useMemo(() => {
    if (!Array.isArray(history) || history.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < history.length; i += 1) {
      const a = history[i - 1];
      const b = history[i];
      if (!a || !b) continue;
      const dx = b.lat - a.lat;
      const dy = b.lon - a.lon;
      total += Math.sqrt(dx * dx + dy * dy) * 111;
    }
    return total;
  }, [history]);

  const recentTrail = useMemo(() => {
    if (!Array.isArray(history) || history.length === 0) return [];
    return history.slice(-6).reverse();
  }, [history]);

  const polylineCoordinates = history.map((point) => [point.lat, point.lon]);

  const fallbackCenter = [29.866, 77.8905];
  const mapCenter = latestLocation
    ? [latestLocation.lat, latestLocation.lon]
    : history.length > 0
    ? [history[history.length - 1].lat, history[history.length - 1].lon]
    : fallbackCenter;

  const tileUrl =
    mapStyle === 'standard'
      ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

  const HEADER_HEIGHT = 64;
  const mapContainerStyle = isMobile
    ? { height: `calc(100vh - ${HEADER_HEIGHT}px)`, width: '100%' }
    : { height: '100%', width: '100%' }; // .map-shell handles desktop height

  return (
    <div className={`app-root ${isMobile ? 'mobile' : 'desktop'}`}>
      <div className="hero-glow" />

      <header className="bsf-header" style={{ height: HEADER_HEIGHT }}>
        <div className="bsf-title">
          <span className="bsf-badge">BSF</span>
          <div>
            <h1>Multi-Mode Tactical Tracker</h1>
            <p>Live field unit situational awareness</p>
          </div>
        </div>

        <div className="bsf-actions">
          {isMobile && (
            <button
              className="mobile-toggle"
              aria-label="Open controls"
              onClick={() => setDrawerOpen((v) => !v)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}

          <div className="chip success">
            <span className="status-dot online" />
            Backend online
          </div>
          <button className="btn outline" onClick={loadData} disabled={loading}>
            {loading ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </header>

      <div className={`layout ${isMobile ? 'mobile-layout' : 'desktop-layout'}`}>
        {/* Backdrop for drawer (mobile) */}
        {isMobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}

        {/* Control panel remains in DOM order after map (map is visually first via CSS order), but you can move places if you prefer */}
        <aside
          className={`control-panel drawer ${isMobile ? 'mobile-drawer' : ''} ${drawerOpen ? 'drawer-open' : ''}`}
          aria-hidden={!drawerOpen && isMobile}
        >
          <div className="panel-scroll">
            <div className="panel-section glass">
              <div className="panel-head">
                <h2>Target Control</h2>
                <div className="chip">Live</div>
              </div>
              <label htmlFor="deviceId" className="field-label">Device ID</label>
              <div className="device-row">
                <input
                  id="deviceId"
                  type="text"
                  value={deviceId}
                  onChange={(e) => {
                    setDeviceId(e.target.value);
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
                    Clear
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
                    <span>{latestLocation.lat.toFixed(6)}, {latestLocation.lon.toFixed(6)}</span>
                  </div>
                  {latestLocation.speed !== null && (
                    <div>
                      <span className="label">Speed</span>
                      <span>{latestLocation.speed.toFixed(2)} m/s</span>
                    </div>
                  )}
                  <div>
                    <span className="label">Track points</span>
                    <span>{pointsCount}</span>
                  </div>
                  <div>
                    <span className="label">Last update</span>
                    <span>{formatHHMMSS(lastUpdateEpoch ?? latestLocation.timestamp)}</span>
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
                    <div className="coords">{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</div>
                    <small>{p.ts ? formatHHMMSS(p.ts) : '--:--:--'}</small>
                  </div>
                </div>
              ))}
            </div>

            {error && <div className="panel-section glass error-box">{error}</div>}
          </div>
        </aside>

        <main className={`map-shell glass ${isMobile ? 'map-full' : ''}`} key={`${deviceId}-${mapStyle}`}>
          <div className="map-overlay-top">
            <div className="map-pill">
              <span className="pulse-dot" /> Live ops map
            </div>
            {latestLocation && (
              <div className="map-pill subtle">
                <strong>{latestLocation.device_id}</strong> · {latestLocation.lat.toFixed(4)}, {latestLocation.lon.toFixed(4)}
              </div>
            )}
          </div>

          <MapContainer
            whenCreated={(m) => {
              mapRef.current = m;
              // slight delay to allow layout/paint, then make leaflet recompute sizes
              setTimeout(() => m.invalidateSize?.(), 60);
            }}
            center={mapCenter}
            zoom={13}
            zoomControl={true}
            style={mapContainerStyle}
            id="leaflet-main-map"
          >
            <TileLayer attribution="&copy; OpenStreetMap contributors" url={tileUrl} />

            <ScaleControl position="bottomleft" />

            {followTarget && latestLocation && <RecenterOnTarget lat={latestLocation.lat} lon={latestLocation.lon} />}

            {showPath && polylineCoordinates.length > 1 && (
              <Polyline
                positions={polylineCoordinates}
                pathOptions={{
                  color: '#ff8c00',
                  weight: 4,
                  opacity: 0.9,
                  smoothFactor: 1.5,
                }}
              />
            )}

            {latestLocation && (
              <SmoothMarker position={[latestLocation.lat, latestLocation.lon]}>
                <Popup className="custom-popup">
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
                    <small>{formatHHMMSS(lastUpdateEpoch ?? latestLocation.timestamp)}</small>
                  </div>
                </Popup>
              </SmoothMarker>
            )}

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

      {toastMessage && (
        <div className="toast toast-success" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default App;
