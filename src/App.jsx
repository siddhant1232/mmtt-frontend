// src/App.jsx
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
import 'leaflet/dist/leaflet.css';
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
  const [showStats, setShowStats] = useState(true);
  const [showTooltips, setShowTooltips] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT : false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  const loadData = useCallback(async () => {
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
  }, [deviceId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e) => {
      // Don't trigger shortcuts when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Ctrl/Cmd + R: Refresh
      if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault();
        loadData();
        return;
      }

      // Ctrl/Cmd + K: Toggle drawer (mobile)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (isMobile) setDrawerOpen((prev) => !prev);
        return;
      }

      // Space: Toggle auto-refresh
      if (e.key === ' ' && !e.target.tagName.match(/INPUT|TEXTAREA|BUTTON/)) {
        e.preventDefault();
        setAutoRefresh((prev) => !prev);
        return;
      }

      // M: Toggle map style
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setMapStyle((prev) => (prev === 'standard' ? 'dark' : 'standard'));
        return;
      }

      // F: Toggle follow target
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setFollowTarget((prev) => !prev);
        return;
      }

      // P: Toggle path
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setShowPath((prev) => !prev);
        return;
      }

      // ?: Toggle help
      if (e.key === '?') {
        e.preventDefault();
        setShowHelp((prev) => !prev);
        return;
      }

      // Escape: Close modals/drawer
      if (e.key === 'Escape') {
        setShowHelp(false);
        if (isMobile) setDrawerOpen(false);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isMobile, loadData]);

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

  // Calculate accurate distance using Haversine formula
  const pathDistance = useMemo(() => {
    if (!Array.isArray(history) || history.length < 2) return 0;
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371; // Earth radius in km
    let total = 0;
    for (let i = 1; i < history.length; i += 1) {
      const a = history[i - 1];
      const b = history[i];
      if (!a || !b) continue;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lon - a.lon);
      const lat1 = toRad(a.lat);
      const lat2 = toRad(b.lat);
      const calc =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc));
      total += R * c;
    }
    return total;
  }, [history]);

  // Calculate average speed
  const averageSpeed = useMemo(() => {
    if (!latestLocation || latestLocation.speed === null) return null;
    if (history.length < 2) return latestLocation.speed;

    const speeds = history
      .map((p, i) => {
        if (i === 0 || !p.ts || !history[i - 1]?.ts) return null;
        const dt = p.ts - history[i - 1].ts;
        if (dt <= 0) return null;
        const toRad = (v) => (v * Math.PI) / 180;
        const R = 6371;
        const dLat = toRad(p.lat - history[i - 1].lat);
        const dLon = toRad(p.lon - history[i - 1].lon);
        const lat1 = toRad(history[i - 1].lat);
        const lat2 = toRad(p.lat);
        const calc =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc));
        const distance = R * c * 1000; // in meters
        return distance / dt; // m/s
      })
      .filter((s) => s !== null);

    if (speeds.length === 0) return latestLocation.speed;
    const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return avg;
  }, [history, latestLocation]);

  // Calculate tracking duration
  const trackingDuration = useMemo(() => {
    if (!Array.isArray(history) || history.length < 2) return null;
    const first = history[0]?.ts;
    const last = history[history.length - 1]?.ts;
    if (!first || !last) return null;
    return last - first;
  }, [history]);

  // Format duration
  const formatDuration = (seconds) => {
    if (!seconds) return '--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

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

  const mapContainerStyle = { height: '100%', width: '100%', outline: 'none' };

  return (
    <div className={`app-root ${isMobile ? 'mobile' : 'desktop'}`}>

      {/* 1. Map Layer (Background) */}
      <main className={`map-shell ${isMobile ? 'map-full' : ''}`} key={`${deviceId}-${mapStyle}`}>
        <MapContainer
          whenCreated={(m) => {
            mapRef.current = m;
            setTimeout(() => m.invalidateSize?.(), 60);
          }}
          center={mapCenter}
          zoom={13}
          zoomControl={false} /* We style our own or use default position but moved via CSS */
          style={mapContainerStyle}
          id="leaflet-main-map"
        >
          <TileLayer attribution="&copy; OpenStreetMap contributors" url={tileUrl} />
          <ScaleControl position="bottomleft" />

          {/* Custom Zoom Control position if needed, or rely on CSS overriding .leaflet-top */}

          {followTarget && latestLocation && <RecenterOnTarget lat={latestLocation.lat} lon={latestLocation.lon} />}

          {showPath && polylineCoordinates.length > 1 && (
            <Polyline
              positions={polylineCoordinates}
              pathOptions={{
                color: '#ff8c00',
                weight: 5,
                opacity: 0.85,
                smoothFactor: 1.5,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          )}

          {latestLocation && (
            <SmoothMarker position={[latestLocation.lat, latestLocation.lon]}>
              <Popup className="custom-popup">
                <div className="popup-content">
                  <strong>{latestLocation.device_id}</strong>
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    <div style={{ marginBottom: '4px' }}>
                      <span style={{ opacity: 0.7, fontSize: '11px' }}>Lat:</span> {latestLocation.lat.toFixed(6)}
                    </div>
                    <div style={{ marginBottom: '4px' }}>
                      <span style={{ opacity: 0.7, fontSize: '11px' }}>Lon:</span> {latestLocation.lon.toFixed(6)}
                    </div>
                    {latestLocation.speed !== null && (
                      <div style={{ marginBottom: '4px' }}>
                        <span style={{ opacity: 0.7, fontSize: '11px' }}>Speed:</span> {latestLocation.speed.toFixed(2)} m/s
                      </div>
                    )}
                    {latestLocation.battery !== null && (
                      <div style={{ marginBottom: '4px' }}>
                        <span style={{ opacity: 0.7, fontSize: '11px' }}>Battery:</span> {latestLocation.battery}%
                      </div>
                    )}
                    {latestLocation.sos && (
                      <div style={{
                        marginTop: '8px',
                        padding: '6px',
                        background: 'rgba(239, 68, 68, 0.2)',
                        borderRadius: '6px',
                        border: '1px solid rgba(239, 68, 68, 0.4)'
                      }}>
                        <strong style={{ color: '#ef4444', fontSize: '12px' }}>⚠ SOS ACTIVE</strong>
                      </div>
                    )}
                    <small>{formatHHMMSS(lastUpdateEpoch ?? latestLocation.timestamp)}</small>
                  </div>
                </div>
              </Popup>
            </SmoothMarker>
          )}

          {latestLocation && latestLocation.sos && (
            <>
              <div className="sos-pulse-layer" />
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
            </>
          )}
        </MapContainer>

        {/* Map Overlays (Top-Right) */}
        <div className="map-overlay-top">
          <div className="map-pill">
            <span className="pulse-dot" /> Live ops map
          </div>
          {latestLocation && (
            <div className="map-pill subtle">
              <strong style={{ color: '#ff8c00' }}>{latestLocation.device_id}</strong> · {latestLocation.lat.toFixed(4)}, {latestLocation.lon.toFixed(4)}
            </div>
          )}
          {latestLocation && latestLocation.speed !== null && (
            <div className="map-pill subtle">
              Speed: <strong>{latestLocation.speed.toFixed(1)} m/s</strong>
            </div>
          )}
        </div>
      </main>

      {/* Mobile Toggle Button (Floating) */}
      {
        isMobile && !drawerOpen && (
          <button
            className="mobile-floating-toggle"
            aria-label="Open controls"
            onClick={() => setDrawerOpen(true)}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
        )
      }

      {/* 2. Header Layer (Floating Top) */}
      {/* 2. Header Layer (Moved to Sidebar) */}

      {/* 3. Controls Layer (Floating Left) */}
      <div className={`layout ${isMobile ? 'mobile-layout' : 'desktop-layout'}`}>
        {/* Backdrop for drawer (mobile) */}
        {isMobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}

        <aside
          className={`control-panel drawer ${isMobile ? 'mobile-drawer' : ''} ${drawerOpen ? 'drawer-open' : ''} ${!isMobile && !sidebarOpen ? 'collapsed' : ''}`}
          aria-hidden={!drawerOpen && isMobile}
        >
          {/* Sidebar Hardware Toggle (Desktop) */}
          {!isMobile && (
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {sidebarOpen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
          )}

          <div className="panel-scroll">
            {/* Header integrated into Sidebar */}
            {/* Header integrated into Sidebar */}
            <div className="bsf-header-sidebar">
              <div className="bsf-title-section">
                <div className="bsf-title-row">
                  {/* <span className="bsf-badge">BSF</span> */}
                  <div className="chip success small-status">
                    <span className="status-dot online" />
                  </div>
                  {isMobile && (
                    <button
                      className="btn-icon mobile-close-btn"
                      onClick={() => setDrawerOpen(false)}
                      aria-label="Close menu"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <h1 className="bsf-app-title">MMTT</h1>
                <p className="bsf-app-subtitle">Live field unit situational awareness</p>
              </div>

              <div className="bsf-actions-row">
                <button
                  className="btn outline flex-grow-btn"
                  onClick={loadData}
                  disabled={loading}
                  title="Refresh data (Ctrl/Cmd + R)"
                >
                  {loading ? 'Syncing...' : 'Sync Data'}
                </button>
                <button
                  className="btn-icon"
                  onClick={() => setShowHelp(true)}
                  title="Keyboard shortcuts (?)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="panel-section glass">
              <div className="panel-head">
                <h2>Target Control</h2>
                <div className="chip">Live</div>
              </div>
              <label htmlFor="deviceId" className="field-label">Device ID</label>
              <div className="control-group">
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
                  aria-label="Device ID input"
                  autoComplete="off"
                />
              </div>

              <div className="action-row">
                <button className="btn primary flex-btn" onClick={loadData} disabled={loading}>
                  {loading ? (
                    <>
                      <span className="loading-spinner" style={{ marginRight: '6px' }} />
                      Loading
                    </>
                  ) : (
                    'Refresh'
                  )}
                </button>
                <button
                  className="btn outline flex-btn"
                  onClick={clearLocalData}
                  disabled={loading && !latestLocation && history.length === 0}
                  title="Clear local latest & history"
                >
                  Clear
                </button>
              </div>

              <div className="section-divider" />

              <div className="toggles-container">
                <div className="toggle-item-row">
                  <label className="toggle-label-group">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(e) => setAutoRefresh(e.target.checked)}
                      aria-label="Auto-refresh toggle"
                    />
                    <span>Auto-refresh</span>
                  </label>
                  <div className="slider-wrapper">
                    <span className="slider-value">{refreshInterval / 1000}s</span>
                    <input
                      type="range"
                      min="2000"
                      max="30000"
                      step="1000"
                      value={refreshInterval}
                      onChange={(e) => setRefreshInterval(Number(e.target.value))}
                      disabled={!autoRefresh}
                      className="mini-slider"
                    />
                  </div>
                </div>

                <div className="toggle-item-row">
                  <label className="toggle-label-group">
                    <input
                      type="checkbox"
                      checked={followTarget}
                      onChange={(e) => setFollowTarget(e.target.checked)}
                    />
                    <span>Follow target (F)</span>
                  </label>
                </div>

                <div className="toggle-item-row">
                  <label className="toggle-label-group">
                    <input
                      type="checkbox"
                      checked={showPath}
                      onChange={(e) => setShowPath(e.target.checked)}
                    />
                    <span>Show trail (P)</span>
                  </label>
                </div>
              </div>

              <div className="section-divider" />

              <div className="map-style-block">
                <span className="style-label">Map Style</span>
                <div className="style-toggles">
                  <button
                    className={mapStyle === 'standard' ? 'btn small active' : 'btn small'}
                    onClick={() => setMapStyle('standard')}
                  >
                    Standard
                  </button>
                  <button
                    className={mapStyle === 'dark' ? 'btn small active' : 'btn small'}
                    onClick={() => setMapStyle('dark')}
                  >
                    Night Ops
                  </button>
                </div>
              </div>
            </div>

            {showStats && (latestLocation || history.length > 0) && (
              <div className="panel-section glass stats-dashboard">
                <div className="panel-head">
                  <h2>Statistics</h2>
                  <button
                    className="btn-icon"
                    onClick={() => setShowStats(false)}
                    aria-label="Hide statistics"
                    title="Hide statistics"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-icon" style={{ background: 'rgba(255, 140, 0, 0.15)' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                    </div>
                    <div className="stat-content">
                      <span className="stat-label">Track Points</span>
                      <span className="stat-value">{pointsCount.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-icon" style={{ background: 'rgba(99, 102, 241, 0.15)' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </div>
                    <div className="stat-content">
                      <span className="stat-label">Distance</span>
                      <span className="stat-value">
                        {pathDistance < 1
                          ? `${(pathDistance * 1000).toFixed(0)} m`
                          : `${pathDistance.toFixed(2)} km`}
                      </span>
                    </div>
                  </div>
                  {averageSpeed !== null && (
                    <div className="stat-card">
                      <div className="stat-icon" style={{ background: 'rgba(34, 197, 94, 0.15)' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                        </svg>
                      </div>
                      <div className="stat-content">
                        <span className="stat-label">Avg Speed</span>
                        <span className="stat-value">{averageSpeed.toFixed(2)} m/s</span>
                      </div>
                    </div>
                  )}
                  {trackingDuration && (
                    <div className="stat-card">
                      <div className="stat-icon" style={{ background: 'rgba(139, 92, 246, 0.15)' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                      <div className="stat-content">
                        <span className="stat-label">Duration</span>
                        <span className="stat-value">{formatDuration(trackingDuration)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!showStats && (latestLocation || history.length > 0) && (
              <button
                className="btn outline"
                onClick={() => setShowStats(true)}
                style={{ marginBottom: '16px', width: '100%' }}
              >
                Show Statistics
              </button>
            )}

            {latestLocation && (
              <div className="panel-section glass device-info">
                <div className="panel-head">
                  <h2>Unit Snapshot</h2>
                  <div className="chip ghost">Live feed</div>
                </div>
                <h3 style={{
                  background: 'linear-gradient(135deg, #ff8c00 0%, #ffbd4a 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  marginBottom: '16px'
                }}>
                  {latestLocation.device_id}
                </h3>
                <div className="info-grid">
                  <div className="tooltip-container">
                    <span className="label">Location</span>
                    <span>{latestLocation.lat.toFixed(6)}, {latestLocation.lon.toFixed(6)}</span>
                    {showTooltips && (
                      <span className="tooltip">Click to copy coordinates</span>
                    )}
                  </div>
                  {latestLocation.speed !== null && (
                    <div>
                      <span className="label">Speed</span>
                      <span>{latestLocation.speed.toFixed(2)} m/s</span>
                    </div>
                  )}
                  {latestLocation.battery !== null && (
                    <div className="battery-indicator">
                      <span className="label">Battery</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{latestLocation.battery}%</span>
                        <div className="battery-bar">
                          <div
                            className="battery-fill"
                            style={{
                              width: `${latestLocation.battery}%`,
                              background: latestLocation.battery > 50
                                ? 'linear-gradient(90deg, #22c55e, #16a34a)'
                                : latestLocation.battery > 20
                                  ? 'linear-gradient(90deg, #f59e0b, #d97706)'
                                  : 'linear-gradient(90deg, #ef4444, #dc2626)'
                            }}
                          />
                        </div>
                      </div>
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
                  {latestLocation.sos && (
                    <div style={{ gridColumn: '1 / -1', background: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgba(239, 68, 68, 0.4)' }}>
                      <span className="label" style={{ color: '#ef4444' }}>Status</span>
                      <span style={{ color: '#ef4444', fontWeight: 700 }}>⚠ SOS ACTIVE</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="panel-section glass mini-trail">
              <div className="panel-head">
                <h2>Recent trail</h2>
                {recentTrail.length > 0 && (
                  <div className="chip" style={{ fontSize: '10px', padding: '4px 8px' }}>
                    {recentTrail.length} points
                  </div>
                )}
              </div>
              {recentTrail.length === 0 && (
                <div className="empty-state-trail">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: '12px' }}>
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  <p className="muted" style={{ marginBottom: '4px', fontWeight: 500 }}>No trail data yet</p>
                  <small className="muted">Track points will appear here as data is received</small>
                </div>
              )}
              {recentTrail.length > 0 && (
                <div style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
                  {recentTrail.map((p, idx) => (
                    <div key={`${p.lat}-${p.lon}-${idx}`} className="trail-row" style={{ animationDelay: `${idx * 0.05}s` }}>
                      <span className="dot" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="coords">{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</div>
                        <small>{p.ts ? formatHHMMSS(p.ts) : '--:--:--'}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="panel-section glass error-box" role="alert">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '16px' }}>⚠️</span>
                  <span>{error}</span>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {
        toastMessage && (
          <div className="toast toast-success" aria-live="polite">
            {toastMessage}
          </div>
        )
      }

      {/* Help Modal */}
      {
        showHelp && (
          <>
            <div className="modal-backdrop" onClick={() => setShowHelp(false)} />
            <div className="modal" role="dialog" aria-labelledby="help-title" aria-modal="true">
              <div className="modal-header">
                <h2 id="help-title">Keyboard Shortcuts</h2>
                <button
                  className="btn-icon"
                  onClick={() => setShowHelp(false)}
                  aria-label="Close help"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="modal-content">
                <div className="shortcut-list">
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">Ctrl</kbd> + <kbd className="kbd-key">R</kbd>
                    </div>
                    <span className="shortcut-desc">Refresh data</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">Space</kbd>
                    </div>
                    <span className="shortcut-desc">Toggle auto-refresh</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">M</kbd>
                    </div>
                    <span className="shortcut-desc">Toggle map style</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">F</kbd>
                    </div>
                    <span className="shortcut-desc">Toggle follow target</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">P</kbd>
                    </div>
                    <span className="shortcut-desc">Toggle path display</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">Ctrl</kbd> + <kbd className="kbd-key">K</kbd>
                    </div>
                    <span className="shortcut-desc">Toggle drawer (mobile)</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">?</kbd>
                    </div>
                    <span className="shortcut-desc">Show this help</span>
                  </div>
                  <div className="shortcut-item">
                    <div className="shortcut-keys">
                      <kbd className="kbd-key">Esc</kbd>
                    </div>
                    <span className="shortcut-desc">Close modals/drawer</span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )
      }
    </div >
  );
}

export default App;
