# ThermoPro TP25 Bluetooth Dashboard

This project provides a web-based dashboard for the ThermoPro TP25 4-probe thermometer.

## Project Structure

- `main.py`: API backend that connects to the TP25 via BLE and serves data via WebSockets.
- `discover.py`: Helper script to find BLE devices and their UUIDs/MAC addresses.
- `frontend/`: React + Vite frontend for the dashboard.

## Requirements

- [uv](https://github.com/astral-sh/uv) (Python package manager)
- Python 3.11+
- Node.js & npm
- Bluetooth enabled on your computer

### Raspberry Pi (Raspberry Pi OS / Linux)

- Ensure Bluetooth stack is installed and running:
    ```bash
    sudo apt update
    sudo apt install -y bluetooth bluez libglib2.0-dev
    sudo systemctl enable --now bluetooth
    ```
- Add your user to Bluetooth-related groups, then log out/in:
    ```bash
    sudo usermod -a -G bluetooth,netdev $USER
    ```
- On Linux/BlueZ, the device may advertise as `Thermopro` instead of `TP25`; the backend now matches both by default.

## Setup

### Backend

This project uses `uv` for fast Python package management.

1.  **Sync dependencies**:
    ```bash
    uv sync
    ```
2.  **Run the backend**:
    ```bash
    uv run python main.py
    ```
    *Note: On macOS, you may need to grant your terminal/IDE Bluetooth permissions.*

    Backend configuration (optional):
    - `TP25_ADDRESS`: Fixed BLE MAC address to skip scanning (recommended once known).
    - `TP25_SCAN_TIMEOUT_SECONDS`: Scan duration per discovery pass (default: `8`).
    - `TP25_RECONNECT_BACKOFF_SECONDS`: Delay between failed attempts (default: `1`).
    - `TP25_NOTIFICATION_TIMEOUT_SECONDS`: Seconds to wait without data before re-handshake/reconnect (default: `30`).
    - `TP25_CONNECT_TIMEOUT_SECONDS`: BLE connect timeout per attempt (default: `8`).
    - `TP25_DEVICE_NAME_PREFIXES`: Comma-separated BLE name prefixes for discovery (default: `TP25,THERMOPRO`).

    Example:
    ```bash
    TP25_ADDRESS="AA:BB:CC:DD:EE:FF" uv run python main.py
    ```

3.  **Find device (Troubleshooting)**:
    If the device isn't found, run the discovery script to see available BLE devices:
    ```bash
    uv run python discover.py
    ```

### Frontend

1.  **Navigate to the frontend directory**:
    ```bash
    cd frontend
    ```
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Run the dev server**:
    ```bash
    npm run dev
    ```

## Usage

1.  Start the backend. It will scan for your TP25 (or use `TP25_ADDRESS` if set).
2.  Ensure your TP25 is turned on and within range.
3.  Open the frontend URL (usually `http://localhost:5173`) in your browser.
4.  Once connected, temperatures are streamed via WebSocket (`ws://localhost:8000/ws`) and the dashboard updates in real-time.
