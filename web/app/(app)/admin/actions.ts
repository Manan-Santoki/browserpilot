"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  encryptSecret,
  generateToken,
  normalizeBaseUrl,
  parseStoredCatalogue,
  resolveModel,
  type ModelChoice,
} from "@browserpilot/core";
import { invites, settings, users } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

export type AdminState = { error?: string; success?: string; inviteUrl?: string };

const INVITE_TTL_DAYS = 7;

/**
 * Invites are the only route to an account. The link is shown once, here —
 * there is no mail server configured, and a link an admin copies by hand is
 * one fewer moving part to trust.
 */
export async function inviteUser(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requireAdmin();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "USER") === "ADMIN" ? "ADMIN" : "USER";
  if (!email.includes("@")) return { error: "Enter a valid email address." };

  const [existing] = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return { error: "Someone with that email already has an account." };

  const { token, hash } = generateToken();
  await db()
    .insert(invites)
    .values({
      email,
      role,
      tokenHash: hash,
      invitedById: admin.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

  await audit({
    actorUserId: admin.id,
    action: "user.invited",
    targetType: "invite",
    metadata: { email, role },
  });

  const base = process.env.BP_WEB_URL ?? "http://127.0.0.1:3000";
  revalidatePath("/admin/users");
  return {
    success: `Invited ${email}. The link below works once, and expires in ${INVITE_TTL_DAYS} days.`,
    inviteUrl: `${base}/invite/${token}`,
  };
}

export async function setUserActive(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  // Locking yourself out is never the intent, and an empty admin set would
  // leave nobody able to fix it.
  if (userId === admin.id) return;

  await db().update(users).set({ isActive: active }).where(eq(users.id, userId));
  await audit({
    actorUserId: admin.id,
    action: "user.updated",
    targetType: "user",
    targetId: userId,
    metadata: { isActive: active },
  });
  revalidatePath("/admin/users");
}

export async function setUserRole(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "") === "ADMIN" ? "ADMIN" : "USER";

  if (userId === admin.id) return;

  await db().update(users).set({ role }).where(eq(users.id, userId));
  await audit({
    actorUserId: admin.id,
    action: "user.updated",
    targetType: "user",
    targetId: userId,
    metadata: { role },
  });
  revalidatePath("/admin/users");
}

const NUMERIC_SETTINGS = [
  "perUserSessionLimit",
  "globalSessionLimit",
  "idleTimeoutMs",
  "hardCapMs",
] as const;

export async function saveSettings(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requireAdmin();

  const writes: Array<{ key: string; value: unknown }> = [];

  for (const key of NUMERIC_SETTINGS) {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `${key} must be a positive number.` };
    }
    writes.push({ key, value });
  }

  const model = String(formData.get("defaultModel") ?? "").trim();
  if (model) writes.push({ key: "defaultModel", value: model });

  for (const write of writes) {
    await db()
      .insert(settings)
      .values({ key: write.key, value: write.value, updatedById: admin.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: write.value, updatedById: admin.id, updatedAt: new Date() },
      });
  }

  await audit({
    actorUserId: admin.id,
    action: "settings.updated",
    metadata: Object.fromEntries(writes.map((w) => [w.key, w.value])),
  });

  revalidatePath("/admin/settings");
  return { success: "Saved. New sessions use these limits immediately." };
}

/**
 * Where downloads are kept.
 *
 * The deployment supplies a bucket through the environment, which is how the
 * bundled MinIO is wired up; this is how an administrator points the whole
 * thing somewhere else instead. The secret key is sealed with the same master
 * key as a site's signing secret and never read back out to the browser — an
 * empty field means "leave the stored one alone", not "clear it".
 */
export async function saveStorageSettings(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const admin = await requireAdmin();

  const driver = String(formData.get("storageDriver") ?? "s3");
  const endpoint = String(formData.get("s3Endpoint") ?? "").trim();
  const region = String(formData.get("s3Region") ?? "").trim();
  const bucket = String(formData.get("s3Bucket") ?? "").trim();
  const accessKeyId = String(formData.get("s3AccessKeyId") ?? "").trim();
  const secret = String(formData.get("s3SecretAccessKey") ?? "");
  const pathStyle = formData.get("s3ForcePathStyle") !== null;

  if (driver === "s3") {
    if (!bucket || !accessKeyId) {
      return { error: "A bucket and an access key are both required to use object storage." };
    }
    if (endpoint) {
      try {
        new URL(endpoint);
      } catch {
        return { error: "That endpoint does not look like a URL." };
      }
    }

    const [existing] = await db()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "s3SecretAccessKey"))
      .limit(1);

    if (!secret && !existing) {
      return { error: "A secret access key is required the first time." };
    }
  }

  const writes: Array<{ key: string; value: unknown }> = [
    { key: "storageDriver", value: driver },
    { key: "s3Endpoint", value: endpoint },
    { key: "s3Region", value: region },
    { key: "s3Bucket", value: bucket },
    { key: "s3AccessKeyId", value: accessKeyId },
    { key: "s3ForcePathStyle", value: pathStyle },
  ];

  // Sealed before it touches the table, like every other secret here.
  if (secret) {
    writes.push({ key: "s3SecretAccessKey", value: encryptSecret(secret, masterKey()) });
  }

  for (const write of writes) {
    await db()
      .insert(settings)
      .values({ key: write.key, value: write.value, updatedById: admin.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: write.value, updatedById: admin.id, updatedAt: new Date() },
      });
  }

  await audit({
    actorUserId: admin.id,
    action: "settings.updated",
    metadata: { storageDriver: driver, s3Bucket: bucket, s3Endpoint: endpoint },
  });

  revalidatePath("/admin/storage");
  return {
    success:
      driver === "s3"
        ? `Saved. New downloads go to ${bucket}.`
        : "Saved. New downloads are kept on the server's disk.",
  };
}

/**
 * Point the agent at a model provider.
 *
 * The whole point of this living in the database is that switching providers —
 * back to Anthropic, or on to a different gateway — should take effect on the
 * next session rather than the next redeploy. The runtime re-reads these rows
 * every time it starts one.
 */
export async function saveProviderSettings(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const admin = await requireAdmin();

  const format = String(formData.get("providerFormat") ?? "anthropic") === "openai"
    ? "openai"
    : "anthropic";
  const credentialKind = String(formData.get("providerCredentialKind") ?? "apiKey");
  const credential = String(formData.get("providerCredential") ?? "");
  const rawBaseUrl = String(formData.get("providerBaseUrl") ?? "").trim();

  let baseUrl: string;
  try {
    // Normalised here as well as in the runtime, so the field shows back what
    // will actually be used rather than what was pasted.
    baseUrl = normalizeBaseUrl(rawBaseUrl) ?? "";
  } catch (error) {
    return { error: (error as Error).message };
  }

  if (!["oauth", "apiKey", "authToken"].includes(credentialKind)) {
    return { error: "Choose how the credential should be sent." };
  }

  let models: ModelChoice[];
  try {
    models = parseStoredCatalogue(JSON.parse(String(formData.get("providerModels") ?? "[]")));
  } catch {
    return { error: "The model list could not be read. Reload the page and try again." };
  }

  if (baseUrl && models.length === 0) {
    // A gateway serves its own line-up; with none listed the console would
    // offer Claude ids that 404 there, once per session, unexplained.
    return { error: "List at least one model this provider serves." };
  }

  const [existing] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "providerCredential"))
    .limit(1);

  if (!credential && !existing) {
    return { error: "A credential is required the first time." };
  }
  if (baseUrl && credentialKind === "oauth") {
    // It authenticates to Anthropic and nowhere else; every session would fail
    // on its first model call with someone else's opaque 401.
    return { error: "A Claude subscription token cannot be used with a gateway." };
  }

  const writes: Array<{ key: string; value: unknown }> = [
    { key: "providerFormat", value: format },
    { key: "providerBaseUrl", value: baseUrl },
    { key: "providerCredentialKind", value: credentialKind },
    { key: "providerModels", value: models },
  ];
  if (credential) {
    writes.push({ key: "providerCredential", value: encryptSecret(credential, masterKey()) });
  }

  for (const write of writes) {
    await db()
      .insert(settings)
      .values({ key: write.key, value: write.value, updatedById: admin.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: write.value, updatedById: admin.id, updatedAt: new Date() },
      });
  }

  // A default that is no longer in the catalogue would be sent to a provider
  // that has never heard of it, so it follows the list rather than lingering.
  const [storedDefault] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "defaultModel"))
    .limit(1);

  const current = typeof storedDefault?.value === "string" ? storedDefault.value : undefined;
  const resolved = resolveModel({ fallback: undefined, requested: current, catalogue: models });
  if (resolved && resolved !== current) {
    await db()
      .insert(settings)
      .values({ key: "defaultModel", value: resolved, updatedById: admin.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: resolved, updatedById: admin.id, updatedAt: new Date() },
      });
  }

  await audit({
    actorUserId: admin.id,
    action: "settings.updated",
    metadata: {
      providerFormat: format,
      providerBaseUrl: baseUrl || "https://api.anthropic.com",
      providerModels: models.map((m) => m.value),
      credentialChanged: Boolean(credential),
    },
  });

  revalidatePath("/admin/models");
  return {
    success: `Saved. New sessions use ${baseUrl || "Anthropic"}${
      resolved && resolved !== current ? `, defaulting to ${resolved}` : ""
    }.`,
  };
}

function masterKey(): string {
  const key = process.env.BP_MASTER_KEY;
  if (!key) throw new Error("BP_MASTER_KEY is required");
  return key;
}
