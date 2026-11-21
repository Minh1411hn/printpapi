// printpapi — self-hosted PrintNode alternative. Elastic License 2.0 (see LICENSE).
// The setup window's rules, free of React and of Tauri so they can be tested.
import type { AgentStatus, ConfigPatch, FoundPrinter, Platform, PrinterChoice, Scale, SetupError } from "./api";

/** `printers` in agent.ini is `name[|pdf[|scale]][=target]` joined by `;`, so these cannot appear in a name. */
const NAME_FORBIDDEN = /[;=|]/;
const HOST = /^[A-Za-z0-9.-]+$/;

export const DEFAULT_RAW_PORT = 9100;

/** The scaling menu of a PDF printer: "Not set" sends nothing, the rest are SumatraPDF's words. */
export const SCALES: { value: Scale | null; label: string; help: string }[] = [
  { value: null, label: "Not set", help: "Nothing is sent. SumatraPDF uses its own default." },
  { value: "fit", label: "Fit to paper", help: "Every page scaled up or down to fill the paper." },
  { value: "shrink", label: "Shrink to fit", help: "Only pages too big for the paper are scaled down." },
  { value: "noscale", label: "Actual size", help: "Printed at 100%, never scaled." },
  { value: "stretch", label: "Stretch", help: "Fills the paper both ways. The page can look squashed." },
];

/**
 * Scaling is a SumatraPDF setting, so Windows only, and only for a printer that takes PDF through
 * its driver: not a raw or network printer, not one set by hand in agent.ini.
 */
export function showsScaling(platform: Platform, p: PrinterChoice): boolean {
  return platform === "windows" && p.pdf && !p.locked && !(p.target?.startsWith("socket://") ?? false);
}

/** A printer that becomes raw has no paper scaling, so it loses what it had. */
export function withKind(p: PrinterChoice, pdf: boolean): PrinterChoice {
  return { ...p, pdf, scale: pdf ? p.scale : null };
}

export function fromFound(found: FoundPrinter[]): PrinterChoice[] {
  return found.map((f) => ({ name: f.name, pdf: false, target: null, locked: false, scale: null }));
}

/** At least one printer must stay chosen. A machine with none found can add a network printer. */
export function canLeavePrinters(list: PrinterChoice[]): boolean {
  return list.length > 0;
}

/** A network printer is `name = socket://ip:port` and always raw. Throws a readable Error. */
export function addNetworkPrinter(
  list: PrinterChoice[],
  name: string,
  ip: string,
  port: number,
): PrinterChoice[] {
  const n = name.trim();
  const host = ip.trim();
  if (!n) throw new Error("Enter a printer name.");
  if (NAME_FORBIDDEN.test(n)) throw new Error('A printer name cannot contain ";", "=" or "|".');
  if (list.some((p) => p.name === n)) throw new Error(`A printer named "${n}" is already in the list.`);
  if (!HOST.test(host)) throw new Error("Enter the printer's IP address or host name.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The port must be a number from 1 to 65535.");
  }
  return [...list, { name: n, pdf: false, target: `socket://${host}:${port}`, locked: false, scale: null }];
}

/** SumatraPDF prints PDFs on Windows only. */
export function needsSumatra(platform: Platform, list: PrinterChoice[], present: boolean): boolean {
  return platform === "windows" && !present && list.some((p) => p.pdf);
}

export function canTest(p: PrinterChoice, platform: Platform, sumatraPresent: boolean): boolean {
  if (p.locked) return false;
  return !(p.pdf && platform === "windows" && !sumatraPresent);
}

/** The text for a failed command. A proxy refusal gets the way around it, the rest speak for themselves. */
export function errorText(e: SetupError): string {
  if (e.code === "proxy") {
    return "A proxy in front of the server refused this. Set up the agent by hand with [headers], see docs/agent.md.";
  }
  return e.message;
}

/**
 * Failures of the install's own register call that only another key or name fixes. The window goes
 * back to step 1 for them (a proxy, the network or the machine are not fixed there).
 */
export function returnsToConnect(code: string): boolean {
  return code === "key_in_use" || code === "name_taken";
}

/**
 * Whether the finish step offers "Change server or key". Only a failure that another address, key
 * or name fixes does: an unreachable server, a key that is taken, a name that belongs to another key.
 */
export function connectMayHelp(code: string): boolean {
  return code === "unreachable" || returnsToConnect(code);
}

/**
 * A printer connected for one user only is invisible to the agent (a service), so it cannot be
 * switched on. One that is already on can still be switched off.
 */
export function canSwitchOn(found: FoundPrinter | null, on: boolean): boolean {
  if (on) return true;
  return found === null || (found.usable && !found.per_user);
}

/** Where the installed agent writes its crash log, next to its status file; mirrors `service_log_path` in crates/agent/src/install.rs. */
export function logLocation(platform: Platform): string {
  switch (platform) {
    case "windows":
      return "C:\\ProgramData\\printpapi-agent\\print_agent-error.log";
    case "macos":
      return "/Library/Application Support/printpapi-agent/print_agent-error.log";
    case "linux":
      return "/var/lib/printpapi-agent/print_agent-error.log";
  }
}

export function statusWord(state: AgentStatus["state"]): string {
  switch (state) {
    case "online":
      return "Connected";
    case "offline":
      return "Offline";
    case "not_running":
      return "Not running";
  }
}

/**
 * The "Last job" line of the overview. A missing job reads "none yet" only when the agent runs; an
 * agent that is not running has reported nothing, so the value is "—" like the other fields.
 */
export function lastJobText(
  state: AgentStatus["state"],
  job: AgentStatus["lastJob"],
  ago: (ts: number) => string,
): string {
  if (job) return `#${job.id} ${job.ok ? "printed" : "failed"}, ${ago(job.at)}`;
  return state === "not_running" ? "—" : "none yet";
}

/** A path in pieces that may be broken between, each ending in its separator, so a file name stays whole. */
export function pathParts(path: string): string[] {
  return path.match(/[^\\/]+[\\/]?|[\\/]/g) ?? [];
}

/** An address the way the agent reads it: no space, no slash at the end, the host in lower case. */
function normalizedServer(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The server binds a device name and a key to each other, so a new key on the same server cannot
 * keep the name. On another server the device is new there and the name can stay. With no old
 * server known (no status file yet) there is nothing to compare.
 */
export function needsNewName(oldServer: string, newServer: string): boolean {
  const old = normalizedServer(oldServer);
  return old !== "" && old === normalizedServer(newServer);
}

/** The timeout the agent accepts: at least `MIN_TIMEOUT` of crates/agent/src/config.rs, in seconds. */
const MIN_TIMEOUT = 30;

/** What is wrong with the text of a timeout field, or null. */
export function timeoutProblem(text: string): string | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return "Enter the timeout in seconds, for example 60.";
  if (Number(t) < MIN_TIMEOUT) {
    return `The timeout must be at least ${MIN_TIMEOUT} seconds: the server holds a request for up to 25.`;
  }
  return null;
}

/** What can be changed in an installed agent. A header value of null is one that is not known. */
export type Settings = {
  printers: PrinterChoice[];
  timeout: number;
  headers: [string, string | null][];
};

const printerKey = (list: PrinterChoice[]) => JSON.stringify(list.map((p) => [p.name, p.pdf, p.target, p.scale]));

/**
 * What differs between two states, as the patch the agent applies to its `agent.ini`: only the
 * fields that both sides know and that changed. A header is set when it is new or has another value
 * and removed (null) when it is gone; one whose value was never shown (null) stays as it is unless
 * a value was typed for it. Header names do not differ by case.
 */
export function patchFor(before: Partial<Settings>, after: Partial<Settings>): ConfigPatch {
  const patch: ConfigPatch = {};
  if (before.printers && after.printers && printerKey(before.printers) !== printerKey(after.printers)) {
    patch.printers = after.printers;
  }
  if (before.timeout !== undefined && after.timeout !== undefined && before.timeout !== after.timeout) {
    patch.timeout = after.timeout;
  }
  if (before.headers && after.headers) {
    const old = new Map(before.headers.map(([n, v]) => [n.toLowerCase(), v] as const));
    const now = new Set(after.headers.map(([n]) => n.toLowerCase()));
    const changes: [string, string | null][] = [];
    for (const [name, value] of after.headers) {
      if (value !== null && old.get(name.toLowerCase()) !== value) changes.push([name, value]);
    }
    for (const [name] of before.headers) {
      if (!now.has(name.toLowerCase())) changes.push([name, null]);
    }
    if (changes.length > 0) patch.headers = changes;
  }
  return patch;
}
