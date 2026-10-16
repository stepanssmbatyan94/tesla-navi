# DESIGN.md — Tesla Navigation & Phone GPS Remote Design System

Generated via **Google Stitch** (`projects/3757969720799071143`) for in-car touchscreen display and companion mobile phone remote.

---

## 1. Design Principles & Goals
* **High Glanceability & Safety First**: Minimal distractions. Essential driving information (next maneuver, distance, current speed, route status) readable at a 0.5s glance.
* **Tesla In-Car MCU Optimization**: Dark automotive UI (`#0b0f17`), zero layout reflows, hardware-accelerated animations (`transform`, `opacity`), lightweight footprint (< 60KB runtime).
* **High-Contrast Telemetry**: JetBrains Mono for coordinates, latency, speed, and GPS accuracy; Space Grotesk for speedometer and maneuver banners.
* **Large Touch Targets**: Minimum 54×54px interactive elements for effortless driver interaction on bumpy roads.

---

## 2. Color Palette & Semantic Tokens

### Backgrounds & Surfaces
* **Canvas / Night Background**: `#0b0f17` (Deep cockpit night)
* **Surface Container Lowest**: `#080b11`
* **Surface Container / Glass Card**: `rgba(24, 28, 36, 0.88)` with `backdrop-filter: blur(16px)`
* **Surface Border**: `rgba(255, 255, 255, 0.08)`
* **Surface Hover / Active**: `rgba(255, 255, 255, 0.12)`

### Accents & Navigation Colors
* **Primary / Electric Cyan**: `#00f0ff` (Vehicle cursor, radar pulse, active highlights)
* **Navigation Blue / Maneuver Banner**: `#2563eb` (Turn-by-turn banner, primary actions)
* **Traffic Green (Flowing)**: `#10b981`
* **Traffic Amber (Moderate)**: `#f59e0b`
* **Traffic Red (Congestion)**: `#ef4444`
* **GPS Signal Good**: `#10b981` (Connected, latency < 100ms)
* **GPS Signal Weak / Lost**: `#ef4444` / `#f97316`

### Text
* **Text High-Emphasis**: `#ffffff`
* **Text Medium-Emphasis**: `rgba(255, 255, 255, 0.70)`
* **Text Low-Emphasis**: `rgba(255, 255, 255, 0.45)`

---

## 3. Typography Hierarchy
* **Display / Speedometer**: `Space Grotesk`, `72px`, weight `700`, line-height `1.0`
* **Maneuver Distance**: `Space Grotesk`, `48px`, weight `700`
* **Maneuver Next Street**: `Space Grotesk`, `24px`, weight `600`
* **Telemetry Data**: `JetBrains Mono`, `14px`, weight `500`, letter-spacing `0.02em`
* **Body / Controls**: `Inter` or `Space Grotesk`, `15px-16px`, weight `500`

---

## 4. Key Components

### A. Turn-by-Turn HUD Banner (Tesla Display)
* Position: Top-center floating (`top: 16px`, centered).
* Background: `#2563eb` with subtle gradient and inner border `rgba(255, 255, 255, 0.2)`.
* Elements: Large SVG direction arrow, maneuver text, ETA + remaining time + km, and tactile "End Route" button (`#ef4444`).

### B. Floating Cockpit Sidebar (Tesla Display)
* Position: Left-aligned floating panel (`left: 16px`, `top: 16px`, `bottom: 16px`, width `400px`).
* Contains:
  1. Brand Header with language toggle (`RU`, `HY`, `EN`).
  2. Quick commute tiles ("Home", "Work").
  3. Phone GPS Pairing Card with generated QR code, 6-character room code, and live telemetry chip.
  4. Quick amenities (Charging / Superchargers, Parking, Coffee).
  5. Alternative route selector.

### C. Right Quick Actions Bar (Tesla Display)
* Position: Right floating column (`right: 16px`, vertically centered).
* Buttons: 2D/3D perspective toggle, Traffic overlay toggle, Map Provider switch (**Yandex Maps** / **Google Maps**), Sound mute, Recenter FAB.

### D. Mobile Companion Remote (`/phone`)
* Layout: Mobile viewport portrait (375-430px).
* Connection Status Card: Pairing code, Tesla status chip (Connected / Disconnected).
* Primary Action: Big pulse button **«Start sharing my GPS»**.
* Destination Input: Address search with suggestions, Google Maps link paste, voice search button, and «Send to Tesla» trigger.
* Live Telemetry: Speedometer gauge (km/h) and GPS accuracy badge.
