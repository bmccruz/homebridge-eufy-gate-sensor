<div align="center">
  <img src="banner.jpg" alt="Software Banner" width="100%">
  <p>☕ <strong>Support the project:</strong> <a href="https://buymeacoffee.com/bmccruz">Buy Me a Coffee</a></p>
</div>

# homebridge-eufy-gate-sensor
Homebridge contact sensor plugin that detects if a gate or door is open using Eufy camera snapshots

## License

This project is licensed under the ISC License. See [LICENSE](LICENSE) for details.

## Description

Homebridge plugin that periodically captures a snapshot from your Eufy Security camera and compares a defined Region of Interest (ROI) against a saved reference image of the closed gate to determine whether a gate or garage door is open or closed.

Because it relies on lightweight snapshot polling via P2P instead of continuous video streaming or RTSP, it keeps native HomeKit Secure Video working on your camera and runs smoothly on low-memory devices like the **Raspberry Pi Zero**.

> **Note:** Since Eufy only allows one active login session per account, it is strongly recommended to create a secondary Eufy account, share the camera with it, and use those credentials in the plugin configuration.

## Features

- Exposes a native HomeKit **Contact Sensor** (`Open` / `Closed`) to trigger Apple Home notifications and automations.
- Works alongside native Apple HomeKit without requiring RTSP to be enabled.
- Ultra-low CPU and RAM footprint (ideal for Raspberry Pi Zero) by downscaling snapshots before pixel analysis.
- Customizable check interval (`intervalMinutes`), image difference threshold (`diffThreshold`), and Region of Interest (`roi`).
- Includes a stateless **Calibrate** switch in Apple Home to update the closed-gate reference snapshot on demand.

## Prerequisites

- A secondary **Eufy Security** account with shared access to your camera.

## Installation

1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-eufy-gate-sensor`
3. Update your configuration file. See the sample below.

If you do not wish to install from npm (e.g., because you are using a local copy or fork), you may also clone the git repository into a directory like `/usr/local/homebridge/plugins/homebridge-eufy-gate-sensor` and link it using `npm link`, or specify the plugin directory as an option (`-P /usr/local/homebridge/plugins`, typically using `HOMEBRIDGE_OPTS` in `/etc/default/homebridge`).

## Configuration

Example accessory config (needs to be added to the Homebridge `config.json`):

```json
"accessories": [
    {
        "accessory": "EufyGateSensor",
        "name": "Gate",
        "email": "secondary-email@email.com",
        "password": "yourpassword",
        "serialNumber": "T8410PXXXXXXXXXX",
        "country": "PT",
        "intervalMinutes": 10,
        "diffThreshold": 20,
        "roi": [
          100,
          50,
          120,
          80
        ]
    }
]
```

### Configuration Fields

- `accessory`: Must be `"EufyGateSensor"`.
- `name`: Name of the sensor shown in Apple Home.
- `email`: Email address of your secondary Eufy account.
- `password`: Password of your secondary Eufy account.
- `serialNumber`: Camera serial number (found in the Eufy app under *Settings > General > About Device*).
- `country`: Two-letter ISO country code (e.g., `PT`, `US`, `GB`).
- `intervalMinutes`: How often (in minutes) the plugin checks the camera snapshot (default: `10`).
- `diffThreshold`: Visual difference percentage (`0`–`100`) compared to the closed gate reference snapshot. Values above this threshold set the sensor to **Open** (default: `20`).
- `roi`: Region of Interest `[x, y, width, height]` on a `320x180` scaled image (`/tmp/gate_scaled.jpg`).

## Contributing

Bug reports and contributions are welcome. Please open an issue to report a problem or discuss a proposed change, and submit a pull request for contributions.