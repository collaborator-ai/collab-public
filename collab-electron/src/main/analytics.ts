import { PostHog } from "posthog-node";
import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const ANALYTICS_SHUTDOWN_TIMEOUT_MS = 2000;

let client: PostHog | null = null;
let deviceId: string | null = null;

function deviceIdPath(): string {
  return join(app.getPath("userData"), "device-id");
}

export function getDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    deviceId = readFileSync(deviceIdPath(), "utf-8").trim();
  } catch {
    deviceId = randomUUID();
    const filePath = deviceIdPath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, deviceId);
  }
  return deviceId;
}

export function initMainAnalytics(): void {
  const apiKey = import.meta.env.MAIN_VITE_POSTHOG_KEY;
  if (!apiKey) {
    console.warn("[analytics] MAIN_VITE_POSTHOG_KEY not set, skipping init");
    return;
  }

  client = new PostHog(apiKey, {
    host:
      import.meta.env.MAIN_VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
  });

  client.capture({
    distinctId: getDeviceId(),
    event: "$identify",
    properties: {
      $set: { platform: process.platform, arch: process.arch },
      $set_once: { first_seen_version: app.getVersion() },
    },
  });
}

export function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  client?.capture({
    distinctId: getDeviceId(),
    event,
    properties: {
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron_version: process.versions.electron,
      ...properties,
    },
  });
}

export function shutdownAnalytics(): Promise<void> {
  if (!client) return Promise.resolve();

  return Promise.race([
    client.shutdown(),
    new Promise<void>((resolve) =>
      setTimeout(resolve, ANALYTICS_SHUTDOWN_TIMEOUT_MS),
    ),
  ]);
}

export async function getFlagPayload(flag: string): Promise<unknown> {
  if (!client) return null;
  const distinctId = getDeviceId();
  const value = await client.getFeatureFlag(flag, distinctId);
  if (!value) return null;
  return (await client.getFeatureFlagPayload(flag, distinctId)) ?? null;
}
