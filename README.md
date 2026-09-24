# Elmo — Element IoT Bulk Manager

Elmo is a client-side web application for managing devices, folders (tags), mandates, and actions in Element IoT. It provides bulk operations, filtering, and a user-friendly interface for administrative tasks.

**Note:** Elmo is an unofficial third-party tool and is not affiliated with, endorsed by, or connected to Zenner IoT Solutions GmbH or the Element IoT product.

## Features

- **Devices**: View, search, filter, and bulk-manage devices
- **Folders**: Create and manage folders (tags) with custom colors
- **Mandates**: View mandate information and device counts
- **Actions**: View action history, create/schedule new actions, cancel pending actions
- **Network** (ELEMENT LNS): Map of gateways and devices; see which gateway receives which device (RSSI, SNR, link margin), find silent / weak / single-gateway devices, estimate areas without reception (also where no devices exist), export as CSV
- **API Log**: Monitor all API requests with duration and status
- **Bulk Operations**: Add/remove devices from folders, send actions to multiple devices, bulk profile editing

## Usage

### Prerequisites

1. **Create an API Key in Element IoT**:
   - **Mandate-specific key**: Go to Settings → API keys → Add new API key
   - **Superadmin**: Go to Administration → Accounts, Users & API key → Create
   - Set desired permissions (read/write depending on your needs)

2. **Add Allowed Origin**:
   - In the same API settings, add this application's URL as an allowed origin
   - Local development: `http://localhost:5500` (or your port)
   - Published: `https://elmo.liphip.de` (or your deployed URL)

### Running Locally

1. Clone the repository
2. Open `index.html` in a browser, OR serve via local server:
   - VS Code: Use "Go Live" extension
   - Python: `python -m http.server 8080`
   - Node: `npx serve .`

### Configuration

1. Go to the **Configuration** tab
2. Enter your Element IoT domain (e.g., `https://your-instance.element-iot.com`)
3. Enter your API Key
4. Click **Save** or **Test Connection**

## Network Analysis

Built for LoRaWAN devices on the **ELEMENT LNS** driver. The **Network** view loads the devices of a folder (or all devices), the gateway devices visible to the API key and the most recent uplinks of every device (`GET /devices/:id/packets?packet_type=up&after=…`). The per-gateway reception data ELEMENT LNS attaches to packets (gateway EUI, RSSI, SNR) is turned into device ↔ gateway links.

- **Scopes**: devices and gateways have separate scopes – mandates (multi-select), folders (multi-select, any of) and a name filter each. Scopes are applied as API filters (`/tags/:id/devices` per folder, `mandate_id_is`, `name_ilike`) and re-checked client-side. With *Element LNS only* (default) devices without an interface on an ELEMENT LNS driver instance (`GET /drivers/instances`) are skipped.
- **Gateways** are devices with a gateway-management interface (`opts.gateway_id`); ELEMENT does not return a device `type` on every instance. They are loaded with the AbacusSql filter `interfaces[0].opts.gateway_id != null` (falls back to scanning the gateway scope if the server rejects it). Gateways that received packets but are outside the gateway scope are looked up by EUI (20 per request); gateways not visible to the key are shown as *external*. Packets are matched via `gateways[].gateway_id` (or `meta.gateway_stats[].router_id_hex`). Gateway state: *receiving*, *idle*, *offline* (last packet-forwarder ping older than 1 h), *external*.
- **Fewer requests**: devices whose ELEMENT statistics (`stats.transceived_at`) show no uplink within the time window are rated silent without loading packets. *Quick* mode rates all devices from ELEMENT statistics (average RSSI/SNR/SF/gateway count) without any packet request – no per-gateway links or reception estimate in that mode. The number of API requests is shown after each run.
- **Device rating**: *good* (≥ 2 gateways, healthy link), *single gateway* (no redundancy), *weak* (best link below the RSSI or link-margin threshold), *silent* (no uplink in the window), *no gateway data*. Link margin = SNR − demodulation floor of the spreading factor (SF7 −7.5 dB … SF12 −20 dB).
- **Reception map / no-reception areas** – also where no devices exist:
  1. A log-distance path-loss model `RSSI = RSSI@1km − 10·n·log10(d / 1 km)` is fitted to the measured links (exponent from within-gateway variation, per-gateway level; defaults when data is sparse).
  2. Every cell of a grid (100 m – 1 km) over the analysed area (device extent + margin, or the current map view) gets the best and second-best predicted RSSI: *no reception* below the weak RSSI threshold, *marginal* within the fade margin, *single gateway* / *covered* above it.
  3. Where devices exist, their measured rating overrides the prediction.
  4. Contiguous no-reception cells form **areas**, listed by size with the devices affected, the nearest receiving gateway and the basis (*estimate*, *model + devices*, or *measured* – devices are silent/weak although the model predicts reception, which often points to the device rather than coverage).
  The model knows nothing about terrain or buildings beyond what the fit captures; the scatter of the fit (± dB) is shown under the table. Treat areas without devices as an estimate.
- **Gateways table** shows how many devices depend on each gateway alone ("Only GW for").
- Requests are throttled to Element's rate limit (default 50 requests / 10 s), so an analysis costs roughly one request per device.

## Data & Privacy

- **No data transmitted to the developer** — All API requests go directly from your browser to Element IoT
- **Optional localStorage** — API credentials can be stored locally (disabled by default)
- **No analytics or tracking** — No third-party analytics or cookies
- **No external requests by default** — The Network map shows no base map until you enable external map tiles (per session on the map, or permanently in Configuration). Tiles default to OpenStreetMap; the tile server is configurable
- **In-memory only** — Device data is loaded into memory and cleared when closing the tab

See [LEGAL.html](LEGAL.html) for full legal information (Impressum & Datenschutz).

## Tech Stack

- HTML5, CSS3, JavaScript (ES6+)
- Bootstrap 5.3 + Bootstrap Icons
- Leaflet 1.9 (maps, vendored)
- jQuery 3.7
- Vanilla JS (no framework)

## License

MIT License — see [LICENSE](LICENSE)

## Support

- [Report issues](https://github.com/liphip/elmo-admin/issues/new/choose)
- [View on GitHub](https://github.com/liphip/elmo-admin)

---

**Disclaimer**: This tool is provided "as is" without warranty. Always review actions before executing them and maintain backups of your data.
