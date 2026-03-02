from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakDeviceNotFoundError
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import uvicorn

LOGGER = logging.getLogger("thermopro.backend")

TP25_CMD_CHAR_UUID = "1086fff1-3343-4817-8bb2-b32206336ce8"
TP25_DATA_CHAR_UUID = "1086fff2-3343-4817-8bb2-b32206336ce8"
TP25_NUM_PROBES = 6
TP25_HANDSHAKE_COMMAND = bytes.fromhex("01098a7a13b73ed68b67c2a0")


def _configure_logging() -> None:
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class RuntimeConfig:
    tp25_address: str | None
    scan_timeout_seconds: float
    reconnect_backoff_seconds: float
    notification_timeout_seconds: float
    connect_timeout_seconds: float


def _decode_probe_temperature(byte1: int, byte2: int) -> float | None:
    if byte1 == 0xFF and byte2 == 0xFF:
        return None
    if byte1 == 0xDD and byte2 == 0xDD:
        return None
    if byte1 == 0xEE and byte2 == 0xEE:
        return None

    is_negative = (byte1 & 0x80) != 0
    hundreds = ((byte1 & 0x70) // 16) * 100
    tens = (byte1 & 0x0F) * 10
    ones = (byte2 & 0xF0) // 16
    decimal = (byte2 & 0x0F) * 0.1

    value = hundreds + tens + ones + decimal
    if is_negative:
        value = -value
    return round(value, 1)


def _parse_tp25_command_30(payload: bytes) -> tuple[list[float | None], int | None]:
    if len(payload) < 6 or payload[0] != 0x30:
        return [None, None, None, None], None

    battery = payload[2]
    temperatures: list[float | None] = []

    if payload[4] == 0x00:
        probe_count = 4
    else:
        probe_count = max(0, min(int(payload[4]), 4))

    probe_offset = 5
    for probe_index in range(probe_count):
        offset = probe_offset + (probe_index * 2)
        if offset + 1 >= len(payload):
            temperatures.append(None)
            continue

        temperatures.append(_decode_probe_temperature(payload[offset], payload[offset + 1]))

    while len(temperatures) < 4:
        temperatures.append(None)

    return temperatures, battery


class StateStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._state: dict[str, Any] = {
            "probe1": None,
            "probe2": None,
            "probe3": None,
            "probe4": None,
            "connected": False,
            "battery": None,
            "device_address": None,
            "last_update": None,
            "error": None,
            "connection_state": "searching",
            "ble_packet_count": 0,
            "last_ble_packet": None,
            "last_disconnect": None,
        }

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return dict(self._state)

    async def set_error(self, message: str | None) -> None:
        async with self._lock:
            self._state["error"] = message
            self._state["last_update"] = _now_iso()

    async def set_connection_state(self, state: str) -> None:
        async with self._lock:
            self._state["connection_state"] = state
            self._state["last_update"] = _now_iso()

    async def set_disconnected(self, address: str | None = None) -> None:
        async with self._lock:
            self._state.update(
                {
                    "probe1": None,
                    "probe2": None,
                    "probe3": None,
                    "probe4": None,
                    "battery": None,
                    "connected": False,
                    "device_address": address,
                    "connection_state": "reconnecting" if address else "searching",
                    "last_update": _now_iso(),
                    "last_disconnect": _now_iso(),
                }
            )

    async def update_readings(
        self,
        *,
        connected: bool,
        address: str,
        probe_readings: list[float | None] | None,
        battery_reading: int | None,
        packet_received: bool = False,
    ) -> None:
        async with self._lock:
            if not connected:
                self._state.update(
                    {
                        "connected": False,
                        "device_address": address,
                        "connection_state": "reconnecting" if address else "searching",
                        "last_update": _now_iso(),
                    }
                )
                return

            values = probe_readings or []
            padded_values = (values + [None, None, None, None])[:4]

            self._state.update(
                {
                    "connected": True,
                    "probe1": padded_values[0],
                    "probe2": padded_values[1],
                    "probe3": padded_values[2],
                    "probe4": padded_values[3],
                    "battery": battery_reading,
                    "device_address": address,
                    "connection_state": "connected",
                    "last_update": _now_iso(),
                    "error": None,
                }
            )
            if packet_received:
                self._state["ble_packet_count"] = int(self._state["ble_packet_count"]) + 1
                self._state["last_ble_packet"] = _now_iso()


class WebSocketHub:
    def __init__(self) -> None:
        self._sockets: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._sockets.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._sockets.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._sockets)

        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:
                stale.append(socket)

        if stale:
            async with self._lock:
                for socket in stale:
                    self._sockets.discard(socket)


class TP25Service:
    def __init__(
        self,
        *,
        config: RuntimeConfig,
        state: StateStore,
        websocket_hub: WebSocketHub,
    ) -> None:
        self._config = config
        self._state = state
        self._websocket_hub = websocket_hub
        self._stop_event = asyncio.Event()
        self._worker_task: asyncio.Task[None] | None = None
        self._client: BleakClient | None = None
        self._known_address: str | None = config.tp25_address
        self._consecutive_connect_failures = 0

    async def start(self) -> None:
        if self._worker_task and not self._worker_task.done():
            return

        self._stop_event.clear()
        self._worker_task = asyncio.create_task(self._run(), name="tp25-service")

    async def stop(self) -> None:
        self._stop_event.set()

        if self._client is not None:
            with contextlib.suppress(Exception):
                await self._client.disconnect()

        if self._worker_task is not None:
            self._worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker_task

    async def _publish_state(self) -> None:
        payload = await self._state.snapshot()
        await self._websocket_hub.broadcast(payload)

    async def _handle_update(
        self,
        *,
        address: str,
        connected: bool,
        probe_readings: list[float | None] | None,
        battery_reading: int | None,
        packet_received: bool = False,
    ) -> None:
        await self._state.update_readings(
            connected=connected,
            address=address,
            probe_readings=probe_readings,
            battery_reading=battery_reading,
            packet_received=packet_received,
        )
        await self._publish_state()

    async def _discover_address(self) -> str | None:
        LOGGER.info("Scanning for TP25 BLE devices...")
        discovered = await BleakScanner.discover(
            timeout=self._config.scan_timeout_seconds,
            return_adv=True,
        )

        matches: list[tuple[str, int]] = []
        for address, (device, advertisement) in discovered.items():
            if (device.name or "").upper().startswith("TP25"):
                matches.append((address, advertisement.rssi))

        if not matches:
            return None

        best_address, best_rssi = max(matches, key=lambda item: item[1])
        LOGGER.info("Discovered TP25 device %s (RSSI %s)", best_address, best_rssi)
        return best_address

    async def _run_connected_session(self, address: str) -> None:
        disconnect_event = asyncio.Event()
        latest_readings: list[float | None] = [None, None, None, None]
        latest_battery: int | None = None
        last_packet_time: float | None = None
        last_poll_attempt_time: float = 0.0
        handshake_attempts = 0
        loop = asyncio.get_running_loop()

        def on_disconnected(_: BleakClient) -> None:
            disconnect_event.set()

        client = BleakClient(address, disconnected_callback=on_disconnected)
        self._client = client

        def on_notification(_: int, data: bytearray) -> None:
            nonlocal latest_readings, latest_battery, last_packet_time
            packet = bytes(data)
            if not packet:
                return

            command = packet[0]
            if command != 0x30:
                return

            temperatures, battery = _parse_tp25_command_30(packet)
            latest_readings = temperatures[:4]
            latest_battery = battery
            last_packet_time = loop.time()

            async def _publish_notification_update() -> None:
                await self._handle_update(
                    address=address,
                    connected=True,
                    probe_readings=latest_readings,
                    battery_reading=latest_battery,
                    packet_received=True,
                )

            loop.call_soon_threadsafe(asyncio.create_task, _publish_notification_update())

        try:
            try:
                await client.connect(timeout=self._config.connect_timeout_seconds)
            except BleakDeviceNotFoundError:
                LOGGER.warning(
                    "TP25 not found by cached address %s; scanning briefly and retrying connect",
                    address,
                )
                discovered_device = await BleakScanner.find_device_by_address(
                    address,
                    timeout=min(self._config.scan_timeout_seconds, 3.0),
                )
                if discovered_device is None:
                    raise

                client = BleakClient(discovered_device, disconnected_callback=on_disconnected)
                self._client = client
                await client.connect(timeout=self._config.connect_timeout_seconds)

            await client.start_notify(TP25_DATA_CHAR_UUID, on_notification)
            await asyncio.sleep(0.5)
            await client.write_gatt_char(TP25_CMD_CHAR_UUID, TP25_HANDSHAKE_COMMAND)
            handshake_attempts = 1
            await asyncio.sleep(1.0)

            if last_packet_time is None:
                try:
                    polled = await client.read_gatt_char(TP25_DATA_CHAR_UUID)
                    if polled and polled[0] == 0x30:
                        temperatures, battery = _parse_tp25_command_30(bytes(polled))
                        latest_readings = temperatures[:4]
                        latest_battery = battery
                        last_packet_time = loop.time()
                        await self._handle_update(
                            address=address,
                            connected=True,
                            probe_readings=latest_readings,
                            battery_reading=latest_battery,
                            packet_received=True,
                        )
                except Exception:
                    pass

            await self._handle_update(
                address=address,
                connected=True,
                probe_readings=latest_readings,
                battery_reading=latest_battery,
            )
            await self._state.set_error(None)
            await self._publish_state()

            while not self._stop_event.is_set():
                stop_task = asyncio.create_task(self._stop_event.wait())
                disconnect_task = asyncio.create_task(disconnect_event.wait())
                tick_task = asyncio.create_task(asyncio.sleep(1))

                done, pending = await asyncio.wait(
                    {stop_task, disconnect_task, tick_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()

                if disconnect_task in done and disconnect_event.is_set():
                    LOGGER.warning("TP25 BLE link dropped; reconnecting")
                    break

                if stop_task in done and self._stop_event.is_set():
                    break

                if tick_task in done:
                    now = loop.time()
                    if (
                        last_packet_time is None
                        or now - last_packet_time > self._config.notification_timeout_seconds
                    ):
                        if now - last_poll_attempt_time >= 3.0:
                            last_poll_attempt_time = now
                            with contextlib.suppress(Exception):
                                polled = await client.read_gatt_char(TP25_DATA_CHAR_UUID)
                                if polled and polled[0] == 0x30:
                                    temperatures, battery = _parse_tp25_command_30(bytes(polled))
                                    latest_readings = temperatures[:4]
                                    latest_battery = battery
                                    last_packet_time = now
                                    handshake_attempts = 0
                                    await self._handle_update(
                                        address=address,
                                        connected=True,
                                        probe_readings=latest_readings,
                                        battery_reading=latest_battery,
                                        packet_received=True,
                                    )
                                    continue

                        if handshake_attempts >= 3:
                            LOGGER.warning(
                                "No TP25 temperature notifications for %.1fs; reconnecting",
                                self._config.notification_timeout_seconds,
                            )
                            break

                        try:
                            await client.write_gatt_char(
                                TP25_CMD_CHAR_UUID,
                                TP25_HANDSHAKE_COMMAND,
                            )
                            handshake_attempts += 1
                            LOGGER.info(
                                "No recent TP25 data; re-sent handshake (%d/3)",
                                handshake_attempts,
                            )
                        except Exception:
                            break
                    else:
                        handshake_attempts = 0
        finally:
            with contextlib.suppress(Exception):
                await client.stop_notify(TP25_DATA_CHAR_UUID)
            with contextlib.suppress(Exception):
                await client.disconnect()

            self._client = None
            await self._state.set_disconnected(address)
            await self._publish_state()

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                address = self._known_address
                if not address:
                    await self._state.set_connection_state("searching")
                    address = await self._discover_address()
                    if address:
                        self._known_address = address

                if not address:
                    await self._state.set_disconnected(None)
                    await self._state.set_error(
                        "No TP25 device found. Ensure it is powered on and in range."
                    )
                    await self._publish_state()
                    await asyncio.sleep(self._config.reconnect_backoff_seconds)
                    continue

                LOGGER.info("Connecting to TP25 at %s", address)
                await self._state.set_connection_state("reconnecting")
                await self._run_connected_session(address)
                self._consecutive_connect_failures = 0

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._consecutive_connect_failures += 1
                LOGGER.exception("TP25 service error: %s", exc)
                await self._state.set_disconnected(self._known_address)
                await self._state.set_error(
                    None if self._known_address else str(exc)
                )
                await self._publish_state()

                if (
                    self._config.tp25_address is None
                    and self._consecutive_connect_failures >= 3
                ):
                    LOGGER.warning(
                        "Clearing cached TP25 address after %d consecutive failures",
                        self._consecutive_connect_failures,
                    )
                    self._known_address = None
                    self._consecutive_connect_failures = 0

                await asyncio.sleep(self._config.reconnect_backoff_seconds)


def _load_config() -> RuntimeConfig:
    raw_timeout = os.getenv("TP25_SCAN_TIMEOUT_SECONDS", "8")
    raw_backoff = os.getenv("TP25_RECONNECT_BACKOFF_SECONDS", "1")
    raw_notification_timeout = os.getenv("TP25_NOTIFICATION_TIMEOUT_SECONDS", "30")
    raw_connect_timeout = os.getenv("TP25_CONNECT_TIMEOUT_SECONDS", "8")
    return RuntimeConfig(
        tp25_address=os.getenv("TP25_ADDRESS"),
        scan_timeout_seconds=float(raw_timeout),
        reconnect_backoff_seconds=float(raw_backoff),
        notification_timeout_seconds=float(raw_notification_timeout),
        connect_timeout_seconds=float(raw_connect_timeout),
    )


_configure_logging()
config = _load_config()
state_store = StateStore()
ws_hub = WebSocketHub()
tp25_service = TP25Service(config=config, state=state_store, websocket_hub=ws_hub)


@asynccontextmanager
async def lifespan(_: FastAPI):
    LOGGER.info("Starting TP25 backend service")
    await tp25_service.start()
    try:
        yield
    finally:
        LOGGER.info("Stopping TP25 backend service")
        await tp25_service.stop()

app = FastAPI(title="ThermoPro TP25 Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/state")
async def get_state() -> dict[str, Any]:
    return await state_store.snapshot()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await ws_hub.connect(websocket)
    try:
        await websocket.send_json(await state_store.snapshot())
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_hub.disconnect(websocket)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=False)
