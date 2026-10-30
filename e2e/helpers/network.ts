import type { Page } from '@playwright/test';

/**
 * NFR-PERF-03 (harness): the two network conditions of SRS line 2852, through Chrome's own network
 * emulation (CDP `Network.emulateNetworkConditions`), so the page's real requests are slowed, not a
 * stub of them. Chromium only; a run on another engine fails at the CDP session.
 *
 * Constrained: 1.6 Mbit/s down, 0.75 Mbit/s up, 150 ms. Poor: 0.4 Mbit/s both ways, 400 ms.
 * Throughput is in bytes per second.
 */
export type NetworkProfile = 'Constrained' | 'Poor';

const PROFILES: Record<NetworkProfile, { downloadThroughput: number; uploadThroughput: number; latency: number }> = {
  Constrained: { downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8, latency: 150 },
  Poor: { downloadThroughput: 0.4e6 / 8, uploadThroughput: 0.4e6 / 8, latency: 400 },
};

export async function applyNetworkProfile(page: Page, p: NetworkProfile): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', { offline: false, ...PROFILES[p] });
}
