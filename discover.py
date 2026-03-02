from __future__ import annotations

import asyncio

from bleak import BleakClient, BleakScanner


async def discover_devices() -> None:
    print("Scanning for BLE devices (10 seconds)...")
    devices = await BleakScanner.discover(timeout=10)

    matches = [d for d in devices if (d.name or "").upper().startswith("TP25")]
    if not matches:
        print("No TP25 devices found.")
        return

    for device in matches:
        print("-" * 60)
        print(f"Name:    {device.name}")
        print(f"Address: {device.address}")
        print(f"RSSI:    {device.rssi}")

        try:
            async with BleakClient(device.address) as client:
                services = client.services
                print("Services:")
                for service in services:
                    print(f"  {service.uuid}")
                    for char in service.characteristics:
                        props = ",".join(char.properties)
                        print(f"    {char.uuid} [{props}]")
        except Exception as exc:
            print(f"  Could not inspect GATT services: {exc}")


if __name__ == "__main__":
    asyncio.run(discover_devices())
