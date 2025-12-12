# GPS Tracking Frontend

A React frontend application for visualizing real-time GPS tracking data on an interactive map.

## Features

- Real-time GPS location visualization on an interactive map
- Historical path tracking with polyline visualization
- Device information display (location, speed, battery, SOS status)
- Auto-refresh functionality with configurable interval
- Responsive design for desktop and mobile

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

The app will be available at `http://localhost:5173` (or the port Vite assigns).

## Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Preview Production Build

```bash
npm run preview
```

## Configuration

### API Base URL

Update the API base URL in one of these ways:

1. **Environment Variable (Recommended):**
   Create a `.env` file in the frontend directory:
   ```
   VITE_API_BASE_URL=https://your-backend-url.onrender.com
   ```

2. **Direct Edit:**
   Edit `src/api/trackingApi.js` and change the `API_BASE_URL` constant.

## Usage

1. Enter a device ID (e.g., `BSF_UNIT_01`) in the input field
2. Click "Refresh" to load the latest location and history
3. Enable "Auto-refresh" to automatically update the map at regular intervals
4. Adjust the refresh interval using the slider (2-30 seconds)
5. View the device's current location (marker) and historical path (blue polyline) on the map

## Map Features

- **Blue Marker:** Current location of the device
- **Blue Polyline:** Historical path showing the device's movement
- **Popup:** Click on the marker to see detailed device information

## Technologies

- React 18
- Vite
- Leaflet & React-Leaflet for map visualization
- Fetch API for HTTP requests

