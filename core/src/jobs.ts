import { createHash, randomBytes } from "node:crypto";

export const JOB_CONSENT_VERSION = "2026-08-04";
export const JOB_TERMINAL_STATUSES = ["applied", "not_applied", "failed", "cancelled"] as const;

const TRACKING_QUERY_KEYS = new Set([
  "source",
  "ref",
  "referrer",
  "gh_src",
  "lever-source",
  // Corporate career pages commonly add this attribution field around an
  // embedded ATS application. It must not create a second logical job.
  "jobpipeline",
]);
const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data.ec2.internal",
]);

export function normalizeJobUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:") throw new Error("Job links must use HTTPS");
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  url.searchParams.sort();
  return url.toString();
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") ||
      host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    return mapped ? isPrivateHostname(mapped) : false;
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function assertPublicJobUrl(input: string): URL {
  const url = new URL(normalizeJobUrl(input));
  if (isPrivateHostname(url.hostname)) throw new Error("Private or local job links are not allowed");
  return url;
}

export type DnsLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

/** Resolve immediately before navigation and reject mixed/private answers. */
export async function resolvePublicJobUrl(input: string, lookup: DnsLookup): Promise<{
  url: URL;
  addresses: readonly string[];
}> {
  const url = assertPublicJobUrl(input);
  const answers = await lookup(url.hostname);
  if (answers.length === 0) throw new Error("Job destination did not resolve");
  const addresses = answers.map((answer) => answer.address);
  if (addresses.some(isPrivateHostname)) {
    throw new Error("Job destination resolves to private or local infrastructure");
  }
  return { url, addresses };
}

export function detectAts(input: string): string {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (host.includes("greenhouse.io")) return "greenhouse";
  // Greenhouse's documented embed links carry the Greenhouse job id even
  // when the visible page remains on the employer's own domain.
  if (/^\d+$/.test(url.searchParams.get("gh_jid") ?? "")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("myworkdayjobs.com") || host.includes("workday.com")) return "workday";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("smartrecruiters.com")) return "smartrecruiters";
  return "generic";
}

export function normalizeJobQuestion(label: string): string {
  return label.normalize("NFKC").toLowerCase().replace(/\b(required|optional)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_").slice(0, 160);
}

export type JobAnswerType = "text" | "boolean" | "number" | "date" | "single_choice" | "multi_choice";

/** Bind answers to the exact type and option inventory shown by the portal. */
export function validateJobAnswer(type: JobAnswerType, options: readonly string[], value: unknown): boolean {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "text" || type === "date") return typeof value === "string";
  if (type === "single_choice") return typeof value === "string" && options.includes(value);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && options.includes(item))) return false;
  return new Set(value).size === value.length;
}

export function jobOptionSignature(type: JobAnswerType, options: readonly string[] = []): string {
  if (type !== "single_choice" && type !== "multi_choice") return type;
  const normalized = options.map((option) => option.normalize("NFKC").trim()).sort();
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return `${type}:sha256:${digest}`;
}

function legacyJobOptionSignature(type: JobAnswerType, options: readonly string[] = []): string {
  if (type !== "single_choice" && type !== "multi_choice") return type;
  const normalized = options.map((option) => option.normalize("NFKC").trim()).sort();
  return `${type}:${JSON.stringify(normalized)}`;
}

export function jobAnswerMatchKey(label: string, type: JobAnswerType, options: readonly string[] = []): string {
  return `${normalizeJobQuestion(label)}::${jobOptionSignature(type, options)}`;
}

/** Read compatibility for answers saved before option inventories were hashed. */
export function jobAnswerMatchCandidates(label: string, type: JobAnswerType, options: readonly string[] = []): Array<{
  questionKey: string;
  optionSignature: string;
}> {
  const current = jobOptionSignature(type, options);
  const legacy = legacyJobOptionSignature(type, options);
  const signatures = current === legacy ? [current] : [current, legacy];
  const normalized = normalizeJobQuestion(label);
  return signatures.map((optionSignature) => ({
    questionKey: `${normalized}::${optionSignature}`,
    optionSignature,
  }));
}

export function generatePortalPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
  const generated = [...randomBytes(24)].map((byte) => alphabet[byte! % alphabet.length]).join("");
  return `aA7!${generated}`;
}

const SECRET_TOKEN = /^\{\{BP_(SECRET|ANSWER|PROFILE|DOCUMENT):([a-zA-Z0-9_-]+)\}\}$/;
export type JobPlaceholder = { kind: "SECRET" | "ANSWER" | "PROFILE" | "DOCUMENT"; id: string };

export function parseJobPlaceholder(value: unknown): JobPlaceholder | null {
  if (typeof value !== "string") return null;
  const match = SECRET_TOKEN.exec(value);
  return match ? { kind: match[1] as JobPlaceholder["kind"], id: match[2]! } : null;
}

export function redactJobToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const redact = (value: unknown, key?: string): unknown => {
    if (parseJobPlaceholder(value)) return "[protected value]";
    if (typeof value === "string" && key && /password|token|secret|otp|answer|value|text/i.test(key)) {
      return value ? "[redacted]" : value;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([nestedKey, nestedValue]) => [nestedKey, redact(nestedValue, nestedKey)]));
    }
    return value;
  };
  return redact(input) as Record<string, unknown>;
}

export async function substituteJobPlaceholders(
  input: unknown,
  resolve: (placeholder: JobPlaceholder) => Promise<unknown>,
): Promise<unknown> {
  const placeholder = parseJobPlaceholder(input);
  if (placeholder) return resolve(placeholder);
  if (Array.isArray(input)) return Promise.all(input.map((value) => substituteJobPlaceholders(value, resolve)));
  if (input && typeof input === "object") {
    const entries = await Promise.all(Object.entries(input as Record<string, unknown>).map(async ([key, value]) =>
      [key, await substituteJobPlaceholders(value, resolve)] as const));
    return Object.fromEntries(entries);
  }
  return input;
}

export type AtsPlaybook = {
  kind: "greenhouse" | "lever" | "workday" | "ashby" | "smartrecruiters" | "generic";
  accountScope: "origin" | "tenant_origin" | "portal";
  normallyRequiresAccount: boolean;
  authenticationPaths: readonly RegExp[];
  applicationMarkers: readonly RegExp[];
  confirmationPatterns: readonly RegExp[];
};

const COMMON_CONFIRMATION = [/application (?:was )?submitted/i, /thank you for applying/i, /application received/i];

export const ATS_PLAYBOOKS: Record<AtsPlaybook["kind"], AtsPlaybook> = {
  greenhouse: { kind: "greenhouse", accountScope: "portal", normallyRequiresAccount: false,
    authenticationPaths: [/\/users\/sign_in/i], applicationMarkers: [/\/jobs\/\d+/i], confirmationPatterns: COMMON_CONFIRMATION },
  lever: { kind: "lever", accountScope: "portal", normallyRequiresAccount: false,
    authenticationPaths: [/\/auth\//i], applicationMarkers: [/\/[^/]+\/[a-f0-9-]+/i], confirmationPatterns: COMMON_CONFIRMATION },
  workday: { kind: "workday", accountScope: "tenant_origin", normallyRequiresAccount: true,
    authenticationPaths: [/\/login/i, /\/account/i], applicationMarkers: [/\/job\//i], confirmationPatterns: COMMON_CONFIRMATION },
  ashby: { kind: "ashby", accountScope: "portal", normallyRequiresAccount: false,
    authenticationPaths: [/\/auth/i], applicationMarkers: [/\/job\//i, /\/application\//i], confirmationPatterns: COMMON_CONFIRMATION },
  smartrecruiters: { kind: "smartrecruiters", accountScope: "portal", normallyRequiresAccount: true,
    authenticationPaths: [/\/login/i, /\/candidate-portal/i], applicationMarkers: [/\/job\//i], confirmationPatterns: COMMON_CONFIRMATION },
  generic: { kind: "generic", accountScope: "origin", normallyRequiresAccount: false,
    authenticationPaths: [/login/i, /sign-?in/i], applicationMarkers: [/job/i, /career/i], confirmationPatterns: COMMON_CONFIRMATION },
};

export function atsPlaybook(input: string): AtsPlaybook {
  const kind = detectAts(input) as AtsPlaybook["kind"];
  return ATS_PLAYBOOKS[kind] ?? ATS_PLAYBOOKS.generic;
}

/** Derive the credential-sharing boundary from the playbook, never from model input. */
export function portalAccountKey(input: string): string {
  const url = assertPublicJobUrl(input);
  const playbook = atsPlaybook(input);
  if (playbook.accountScope === "portal") return `portal:${playbook.kind}`;
  if (playbook.accountScope === "tenant_origin") return `tenant:${url.origin}`;
  return `origin:${url.origin}`;
}

export type ApplicationInventory = {
  requiredFields: readonly { key: string; handled: boolean }[];
  unresolvedQuestionIds: readonly string[];
  resumeStaged: boolean;
  coverLetterRequired: boolean;
  coverLetterStaged: boolean;
  consentGranted: boolean;
  unusualLegalLanguage: boolean;
};

export function validateApplicationInventory(inventory: ApplicationInventory): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const missing = inventory.requiredFields.filter((field) => !field.handled).map((field) => field.key);
  if (missing.length) reasons.push(`Required fields are unresolved: ${missing.join(", ")}`);
  if (inventory.unresolvedQuestionIds.length) reasons.push("Unseen answers remain unresolved");
  if (!inventory.resumeStaged) reasons.push("A résumé has not been staged");
  if (inventory.coverLetterRequired && !inventory.coverLetterStaged) reasons.push("The required cover letter is missing");
  if (!inventory.consentGranted) reasons.push("Application consent is missing");
  if (inventory.unusualLegalLanguage) reasons.push("Unusual legal language requires manual review");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export type SubmissionEvidence = {
  confirmationText?: string;
  confirmationUrl?: string;
  screenshotKey?: string;
  referenceId?: string;
};

export function hasSubmissionEvidence(evidence: SubmissionEvidence): boolean {
  return [evidence.confirmationText, evidence.confirmationUrl, evidence.screenshotKey, evidence.referenceId]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

/** Parse a verification message locally; callers discard the body immediately. */
export function parseGmailVerification(body: string, allowedHosts: readonly string[] = []): {
  code?: string;
  link?: string;
} {
  const code = body.match(/(?:verification|security|confirmation|one[- ]time)\s*(?:code|pin)?\s*(?:is|:)?\s*([0-9]{4,8})/i)?.[1];
  const links = body.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const link = links.find((candidate) => {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      return !isPrivateHostname(url.hostname) && (allowedHosts.length === 0 || allowedHosts.includes(url.hostname));
    } catch { return false; }
  });
  return { ...(code ? { code } : {}), ...(link ? { link: link.replace(/[),.;]+$/, "") } : {}) };
}

export function notificationRetryAt(attempt: number, now = Date.now()): Date {
  const safeAttempt = Math.max(1, Math.min(10, Math.trunc(attempt)));
  const delayMs = Math.min(24 * 60 * 60 * 1_000, 30_000 * 2 ** (safeAttempt - 1));
  return new Date(now + delayMs);
}
