# Elmo — Element IoT Bulk Manager

Elmo is a client-side web application for managing devices, folders (tags), mandates, and actions in Element IoT. It provides bulk operations, filtering, and a user-friendly interface for administrative tasks.

**Note:** Elmo is an unofficial third-party tool and is not affiliated with, endorsed by, or connected to Zenner IoT Solutions GmbH or the Element IoT product.

## Features

- **Devices**: View, search, filter, and bulk-manage devices
- **Folders**: Create and manage folders (tags) with custom colors
- **Mandates**: View mandate information and device counts
- **Actions**: View action history, create/schedule new actions, cancel pending actions
- **Network**: Map of gateways and devices; see which gateway receives which device (RSSI, SNR, link margin), find silent / weak / single-gateway devices and coverage holes, export as CSV
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

The **Network** view loads the devices of a folder (or all devices), the gateway devices visible to the API key and the most recent uplinks of every device (`GET /devices/:id/packets?packet_type=up&after=…`). The per-gateway reception data Element IoT attaches to packets (gateway stats: gateway EUI, RSSI, SNR) is used to build device ↔ gateway links.

- **Gateways** are matched to Element devices of type `gateway` by the EUI in their interface options (or an EUI in their slug/name). Gateways that only appear in packet metadata are shown as *external* (e.g. gateways of other mandates or public gateways); their location is taken from the packet if present.
- **Device rating**: *good* (≥ 2 gateways, healthy link), *single gateway* (no redundancy), *weak* (best link below the RSSI or link-margin threshold), *silent* (no uplink in the window), *no gateway data* (the driver does not provide gateway stats). Link margin = SNR − demodulation floor of the spreading factor (SF7 −7.5 dB … SF12 −20 dB). Thresholds are adjustable.
- **Coverage holes**: located devices are grouped into grid cells (250 m – 2 km). A cell is a *hole* when every rated device in it is silent or weak, *marginal* when some are silent/weak/single-gateway. Cells without devices are not rated. The *observed range* layer draws, per gateway, the distance within which it received 90 % of its located devices.
- **Gateways table** shows for each gateway how many devices depend on it alone ("Only GW for").
- Requests are throttled to Element's rate limit (default 50 requests / 10 s), so an analysis costs roughly one request per device.

## Data & Privacy

- **No data transmitted to the developer** — All API requests go directly from your browser to Element IoT
- **Optional localStorage** — API credentials can be stored locally (disabled by default)
- **No analytics or tracking** — No third-party analytics or cookies
- **Map tiles** — The Network view loads map tiles from OpenStreetMap by default (configurable / can be disabled in Configuration)
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
