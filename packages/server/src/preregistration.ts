/**
 * Pre-registration (POL-104) — declaring a box BEFORE it ever boots.
 *
 * Commissioning a rack used to be N blind approvals: each box arrived as a pending card carrying a
 * UUID and an output count, and an operator clicked Approve N times with no way to tell box 17 from
 * box 23. Pre-registration lets the operator paste the boxes in first (from the delivery note, the
 * MAC labels on the cartons, whatever they have) and have each one name itself, tag itself and — if
 * they said so — approve itself the moment it comes up.
 *
 * WHAT PRE-REGISTRATION IS NOT: a credential. It grants nothing. It is consulted only AFTER a hello
 * has already authenticated against a valid enrolment token (`enroll.ts`), and all it decides is what
 * happens to a box that has ALREADY proved it belongs: its name, its tags, and whether a human has to
 * click Approve. That ordering is the whole security argument for keying on things as soft as a MAC.
 *
 * THE KEYS, WEAKEST LAST:
 *   machineId — the box's own stable netboot identity (`dmi-…` / `mac-…`, POL-33). Strongest.
 *   dmiSerial — the chassis serial. Strong on real hardware; absent or a vendor placeholder in VMs and
 *               on plenty of cheap mini-PCs, so placeholders are filtered out rather than matched.
 *   mac       — weakest, DELIBERATELY. The homelab lesson (POL-63/POL-78): a Wi-Fi-bridged VM's MAC is
 *               REWRITTEN by its host, so the MAC a box reports is not always the MAC on its sticker;
 *               and a MAC is trivially spoofable by anyone who could already have got past the token.
 *               It is a convenience for the common case, never a proof.
 *
 * AN AMBIGUOUS MATCH MATCHES NOTHING. If two records hit at the same tier, the box parks in pending
 * with a note. Auto-naming (and auto-approving) the WRONG box is worse than one manual approval.
 */
import type { HostIdentity, PreRegistration } from "@polyptic/protocol";

/** Vendor placeholders that show up in `/sys/class/dmi/id/product_serial` on hardware that has no real
 *  serial to give. Matching on these would collide every such box into one pre-registration. */
const PLACEHOLDER_SERIALS = new Set([
  "",
  "0",
  "00000000",
  "0123456789",
  "123456789",
  "default string",
  "none",
  "not applicable",
  "not specified",
  "system serial number",
  "to be filled by o.e.m.",
  "unknown",
]);

/** Normalize a DMI serial for comparison, or return undefined if it is a placeholder/junk. */
export function normalizeSerial(serial: string | undefined): string | undefined {
  const trimmed = serial?.trim();
  if (!trimmed) return undefined;
  if (PLACEHOLDER_SERIALS.has(trimmed.toLowerCase())) return undefined;
  return trimmed.toLowerCase();
}

/** Normalize a MAC to lower-case colon form (`aa:bb:cc:dd:ee:ff`). Accepts `-`/`.`/bare-hex input, so
 *  an operator can paste whatever their vendor's spreadsheet gave them. Undefined if it is not 12 hex
 *  digits, or if it is the all-zero MAC. */
export function normalizeMac(mac: string | undefined): string | undefined {
  const hex = mac?.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!hex || hex.length !== 12) return undefined;
  if (hex === "000000000000") return undefined;
  return (hex.match(/.{2}/g) ?? []).join(":");
}

export type PreRegistrationMatchKey = "machineId" | "dmiSerial" | "mac";

export interface PreRegistrationMatch {
  record: PreRegistration;
  matchedOn: PreRegistrationMatchKey;
}

/** Records that are still available to claim: an unclaimed one, or one already claimed BY THIS BOX (so
 *  a re-enrol of the same machine is idempotent rather than a second, conflicting claim). */
function claimable(record: PreRegistration, machineId: string): boolean {
  return record.matchedMachineId === undefined || record.matchedMachineId === machineId;
}

/**
 * Find the pre-registration for a box that has just authenticated. Tiers are tried strongest-first and
 * the first tier with EXACTLY ONE hit wins; a tier with two or more hits is ambiguous and — rather
 * than guessing — stops the search and matches nothing.
 */
export function matchPreRegistration(
  records: readonly PreRegistration[],
  machineId: string,
  hardware: HostIdentity | undefined,
): PreRegistrationMatch | undefined {
  const available = records.filter((r) => claimable(r, machineId));

  const byMachineId = available.filter((r) => r.machineId !== undefined && r.machineId === machineId);
  if (byMachineId.length > 0) {
    return byMachineId.length === 1 ? { record: byMachineId[0]!, matchedOn: "machineId" } : undefined;
  }

  const serial = normalizeSerial(hardware?.dmiSerial);
  if (serial !== undefined) {
    const bySerial = available.filter((r) => normalizeSerial(r.dmiSerial) === serial);
    if (bySerial.length > 0) {
      return bySerial.length === 1 ? { record: bySerial[0]!, matchedOn: "dmiSerial" } : undefined;
    }
  }

  const macs = new Set(
    (hardware?.macs ?? []).map((m) => normalizeMac(m)).filter((m): m is string => m !== undefined),
  );
  if (macs.size > 0) {
    const byMac = available.filter((r) => {
      const mac = normalizeMac(r.mac);
      return mac !== undefined && macs.has(mac);
    });
    if (byMac.length > 0) {
      return byMac.length === 1 ? { record: byMac[0]!, matchedOn: "mac" } : undefined;
    }
  }

  return undefined;
}

/**
 * Parse a CSV paste into pre-registration inputs. The format is deliberately forgiving, because the
 * operator is pasting from a delivery note, not authoring a config file:
 *
 *   Lobby left, aa:bb:cc:dd:ee:01, floor-1, lobby
 *   Lobby right, SN-1234567, floor-1
 *   dmi-9f2c…,                          (an identifier alone — no label, no tags)
 *
 * Field 1 is the LABEL unless it parses as an identifier. Field 2 is the identifier, classified by
 * SHAPE — a MAC if it is 12 hex digits, otherwise a serial (and a value matching an existing
 * `machineId` is handled at match time by the machineId tier, so `machineId` is settable too via the
 * explicit `machineId:` prefix). Everything after is tags. `#` starts a comment; blank lines are
 * skipped. A line with no usable identifier is an error the caller reports back with its line number —
 * a silently-dropped row in a 50-box paste is a box that never auto-approves and nobody knows why.
 */
export interface ParsedPreRegistrationLine {
  line: number;
  label?: string;
  machineId?: string;
  dmiSerial?: string;
  mac?: string;
  tags: string[];
}

export interface ParsedPreRegistrationCsv {
  records: ParsedPreRegistrationLine[];
  errors: { line: number; text: string; reason: string }[];
}

/** True when a field looks like an identifier rather than a human label. */
function classifyIdentifier(field: string): Pick<ParsedPreRegistrationLine, "machineId" | "dmiSerial" | "mac"> | undefined {
  const value = field.trim();
  if (!value) return undefined;
  if (value.toLowerCase().startsWith("machineid:")) {
    const id = value.slice("machineid:".length).trim();
    return id ? { machineId: id } : undefined;
  }
  // A box's own netboot identity is `dmi-…` / `mac-…` (POL-33) — accept it verbatim as a machineId.
  if (/^(dmi|mac)-/i.test(value)) return { machineId: value };
  const mac = normalizeMac(value);
  if (mac) return { mac };
  // A serial: no spaces, and at least one digit — enough to tell "SN-1234567" from "Lobby left".
  if (!/\s/.test(value) && /\d/.test(value)) return { dmiSerial: value };
  return undefined;
}

export function parsePreRegistrationCsv(csv: string): ParsedPreRegistrationCsv {
  const records: ParsedPreRegistrationLine[] = [];
  const errors: { line: number; text: string; reason: string }[] = [];

  csv.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.split("#")[0]?.trim() ?? "";
    if (!text) return;

    const fields = text.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
    if (fields.length === 0) return;

    // Header rows a spreadsheet export tends to bring along.
    if (/^(label|name)$/i.test(fields[0] ?? "")) return;

    let label: string | undefined;
    let identifier: Pick<ParsedPreRegistrationLine, "machineId" | "dmiSerial" | "mac"> | undefined;
    const tags: string[] = [];

    for (const field of fields) {
      if (identifier === undefined) {
        const parsed = classifyIdentifier(field);
        if (parsed) {
          identifier = parsed;
          continue;
        }
        if (label === undefined) {
          label = field;
          continue;
        }
      }
      if (identifier !== undefined) tags.push(field);
      else if (label !== undefined) tags.push(field);
    }

    if (identifier === undefined) {
      errors.push({ line, text, reason: "no MAC, serial or machine id on this line" });
      return;
    }
    records.push({ line, ...(label ? { label } : {}), ...identifier, tags });
  });

  return { records, errors };
}
