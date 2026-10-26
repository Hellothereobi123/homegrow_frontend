/**
 * Bluetooth LE fallback: pull the latest readings straight from the Raspberry Pi
 * when Supabase can't be reached. Implements ble-protocol.md (project root);
 * keep the UUIDs and message handling in step with that document.
 *
 * Flow for one sync: connect (MTU 517) → subscribe to DATA → write "GET n" to
 * CONTROL → collect header + n rows + end marker → disconnect. Read-only by design.
 *
 * Needs a development build on Android (`npx expo run:android`). Expo Go and web
 * have no BLE native module, so everything here is guarded by `bleAvailable()`.
 */

import { Buffer } from "buffer";
import { PermissionsAndroid, Platform } from "react-native";
import type { BleManager, Subscription } from "react-native-ble-plx";

// From ble-protocol.md → Identity
export const SERVICE_UUID = "6e3a1f80-5c21-4a7e-9d1b-2f8c4a0e7b31";
const CONTROL_UUID = "6e3a1f81-5c21-4a7e-9d1b-2f8c4a0e7b31";
const DATA_UUID = "6e3a1f82-5c21-4a7e-9d1b-2f8c4a0e7b31";

const REQUESTED_MTU = 517;
const TRANSFER_TIMEOUT_MS = 10_000;

export interface PiDevice {
  id: string;
  name: string;
  rssi: number | null;
}

export interface BleTransfer {
  cols: string[];
  rows: unknown[][]; // newest first, each the same length as cols
  sensorsOk: boolean; // false: Pi reachable but its sensor loop has stalled
}

let manager: BleManager | null = null;

export function bleAvailable(): boolean {
  return Platform.OS === "android";
}

// Created lazily so web and Expo Go never load the native module
function getManager(): BleManager {
  if (!manager) {
    try {
      const { BleManager } = require("react-native-ble-plx") as typeof import("react-native-ble-plx");
      manager = new BleManager();
    } catch {
      throw new Error("Bluetooth isn't available in this build. Use a development build (npx expo run:android), not Expo Go.");
    }
  }
  return manager;
}

/** Ask for the runtime permissions scanning and connecting need. Returns false if any are denied. */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const P = PermissionsAndroid.PERMISSIONS;
  // Android 12+ has dedicated Bluetooth permissions; older versions gate scanning behind location
  const wanted = Number(Platform.Version) >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT] : [P.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/** Throws a user-readable error unless permissions are granted and Bluetooth is on. */
export async function ensureBleReady(): Promise<void> {
  if (!bleAvailable()) throw new Error("Bluetooth sync is only available in the Android app.");
  if (!(await requestBlePermissions())) throw new Error("Bluetooth permission was denied. Allow it in the app's settings to sync from the Pi.");
  const state = await getManager().state();
  if (state !== "PoweredOn") throw new Error("Bluetooth is off. Turn it on and try again.");
}

/**
 * Scan for Pis advertising our service. Calls onFound once per device and onError if
 * the scan fails. Returns a function that stops the scan.
 */
export function scanForPis(onFound: (d: PiDevice) => void, onError: (e: Error) => void): () => void {
  const m = getManager();
  const seen = new Set<string>();
  m.startDeviceScan([SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
    if (error) {
      onError(new Error(error.message));
      return;
    }
    if (!device || seen.has(device.id)) return;
    seen.add(device.id);
    onFound({ id: device.id, name: device.localName ?? device.name ?? "HydroPi", rssi: device.rssi });
  }).catch((e) => onError(e instanceof Error ? e : new Error(String(e))));
  return () => {
    m.stopDeviceScan().catch(() => {});
  };
}

const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect to a Pi, request the newest `count` rows, and disconnect. */
export async function fetchRowsOverBle(deviceId: string, count = 10): Promise<BleTransfer> {
  const m = getManager();
  const device = await m.connectToDevice(deviceId, { requestMTU: REQUESTED_MTU, timeout: 8000 });
  let subscription: Subscription | null = null;
  try {
    await device.discoverAllServicesAndCharacteristics();

    let settled = false;
    let rejectTransfer: (e: Error) => void = () => {};
    const transfer = new Promise<BleTransfer>((resolve, reject) => {
      let header: { cols: string[]; n: number; sensors_ok: boolean } | null = null;
      const rows = new Map<number, unknown[]>();
      const timer = setTimeout(() => finish(() => reject(new Error("Timed out waiting for the Pi. Try again."))), TRANSFER_TIMEOUT_MS);

      function finish(settle: () => void) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle();
      }
      rejectTransfer = (e) => finish(() => reject(e));

      // Subscribe to DATA before writing the request, or the first notifications are missed
      subscription = device.monitorCharacteristicForService(SERVICE_UUID, DATA_UUID, (error, characteristic) => {
        if (settled) return; // late events, e.g. from our own disconnect
        if (error) return rejectTransfer(new Error(error.message));
        if (!characteristic?.value) return;

        let msg: any;
        try {
          msg = JSON.parse(decode(characteristic.value));
        } catch {
          return rejectTransfer(new Error("Received an unreadable message from the Pi."));
        }

        if (msg.t === "hdr") {
          header = { cols: msg.cols, n: msg.n, sensors_ok: msg.sensors_ok };
        } else if (msg.t === "row") {
          rows.set(msg.i, msg.v);
        } else if (msg.t === "err") {
          rejectTransfer(new Error(`The Pi reported an error: ${msg.msg}`));
        } else if (msg.t === "end") {
          const h = header;
          if (!h) return rejectTransfer(new Error("The Pi's reply was missing its header."));
          // Use the row indices to confirm nothing was dropped
          const ordered: unknown[][] = [];
          for (let i = 0; i < h.n; i++) {
            const row = rows.get(i);
            if (!row || row.length !== h.cols.length) {
              return rejectTransfer(new Error(`Row ${i + 1} of ${h.n} was lost in transfer. Try again.`));
            }
            ordered.push(row);
          }
          finish(() => resolve({ cols: h.cols, rows: ordered, sensorsOk: h.sensors_ok }));
        }
      });
    });

    // Give Android a moment to finish enabling notifications before sending the request
    await sleep(150);
    device
      .writeCharacteristicWithResponseForService(SERVICE_UUID, CONTROL_UUID, encode(`GET ${count}`))
      .catch((e) => rejectTransfer(e instanceof Error ? e : new Error(String(e))));

    return await transfer;
  } finally {
    (subscription as Subscription | null)?.remove();
    await m.cancelDeviceConnection(deviceId).catch(() => {});
  }
}
