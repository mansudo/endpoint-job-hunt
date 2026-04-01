/**
 * keychain.mjs — Secure key retrieval from macOS Keychain
 *
 * All API keys live in the system Keychain under account "kofi".
 * Retrieve with: security find-generic-password -s <service> -a kofi -w
 *
 * Services registered:
 *   jsearch-rapidapi          — JSearch / RapidAPI
 *   rxresume-api              — Reactive Resume
 *   github-aiprdteam-pat      — GitHub PAT (aiprdteam account)
 *   github-aiprdteam-password — GitHub account password (aiprdteam)
 *   anthropic-api             — Anthropic Claude
 *   notion-api                — Notion
 *   unifi-hoa                 — UniFi controller (hoa.local), user: orakle
 *   gmail-aiprdteam           — Gmail (aiprdteam@gmail.com)
 *
 * To add a new key:
 *   security add-generic-password -s "service-name" -a "kofi" -w "YOUR_KEY" -U
 *
 * To update a key:
 *   security add-generic-password -s "service-name" -a "kofi" -w "NEW_KEY" -U
 *
 * To delete a key:
 *   security delete-generic-password -s "service-name" -a "kofi"
 */

import { execSync } from 'node:child_process';

const ACCOUNT = 'kofi';
const cache = new Map();

/**
 * getKey(service) → string
 * Retrieves a key from macOS Keychain. Throws if not found.
 */
export function getKey(service) {
  if (cache.has(service)) return cache.get(service);

  try {
    const value = execSync(
      `security find-generic-password -s "${service}" -a "${ACCOUNT}" -w`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();

    if (!value) throw new Error(`Empty value for service: ${service}`);
    cache.set(service, value);
    return value;
  } catch (err) {
    throw new Error(
      `Keychain: key not found for service "${service}". ` +
      `Add it with: security add-generic-password -s "${service}" -a "${ACCOUNT}" -w "YOUR_KEY" -U`
    );
  }
}

/**
 * setKey(service, value) → void
 * Stores or updates a key in macOS Keychain.
 */
export function setKey(service, value) {
  execSync(
    `security add-generic-password -s "${service}" -a "${ACCOUNT}" -w "${value}" -U`,
    { stdio: 'pipe' }
  );
  cache.set(service, value);
}

// Named shortcuts
export const keys = {
  get jsearch()        { return getKey('jsearch-rapidapi'); },
  get rxresume()       { return getKey('rxresume-api'); },
  get github()         { return getKey('github-aiprdteam-pat'); },
  get anthropic()      { return getKey('anthropic-api'); },
  get notion()         { return getKey('notion-api'); },
  get unifi()          { return getKey('unifi-hoa'); },
  get gmailAiprdteam() { return getKey('gmail-aiprdteam'); },
};
