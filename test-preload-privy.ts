// Preload file to handle @privy-io/server-auth browser environment check
// This module throws if window is defined, so we need to delete it
// before the module is loaded in Bun's test environment

if (typeof window !== "undefined") {
  delete (globalThis as any).window;
}
