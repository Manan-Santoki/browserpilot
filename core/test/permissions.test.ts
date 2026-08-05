import { describe, expect, test } from "bun:test";
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  canAccess,
  isPermission,
  parsePermissions,
} from "../src/permissions";

describe("parsePermissions", () => {
  test("keeps every box a form ticked", () => {
    // The bug this replaces: the field was read with `formData.get`, which
    // returns only the first value of a repeated field. An administrator ticked
    // five boxes, the account was granted one, and nothing said so.
    expect(parsePermissions(["session.start", "session.approve", "user.manage"])).toEqual([
      "session.start",
      "session.approve",
      "user.manage",
    ]);
  });

  test("reads the dialog's comma-joined field too", () => {
    // Two surfaces post this differently and both have to work.
    expect(parsePermissions(["session.start,user.manage"])).toEqual([
      "session.start",
      "user.manage",
    ]);
  });

  test("a repeated permission is granted once", () => {
    // The table has a uniqueness constraint, so a duplicate is an insert error
    // rather than something quietly ignored.
    expect(parsePermissions(["user.manage", "user.manage,user.manage"])).toEqual(["user.manage"]);
  });

  test("anything not on the list is dropped", () => {
    // This arrives from a form post, so it is exactly as trustworthy as the
    // person sending it.
    expect(parsePermissions(["user.manage", "admin.everything", "", "  "])).toEqual([
      "user.manage",
    ]);
  });

  test("nothing ticked is no permissions, not an error", () => {
    expect(parsePermissions([])).toEqual([]);
  });

  test("surrounding whitespace does not stop a permission being recognised", () => {
    expect(parsePermissions([" user.manage , audit.view "])).toEqual([
      "user.manage",
      "audit.view",
    ]);
  });
});

describe("canAccess", () => {
  test("an administrator holds every permission without a row for it", () => {
    for (const permission of PERMISSIONS) {
      expect(canAccess("ADMIN", [], permission)).toBe(true);
    }
  });

  test("a user holds exactly what was granted", () => {
    expect(canAccess("USER", ["session.start"], "session.start")).toBe(true);
    expect(canAccess("USER", ["session.start"], "user.manage")).toBe(false);
  });
});

describe("the permission list", () => {
  test("every permission has a label a person can read", () => {
    // The console renders these directly; a missing one shows up as blank.
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_LABELS[permission]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("isPermission rejects anything else", () => {
    expect(isPermission("session.start")).toBe(true);
    expect(isPermission("session.START")).toBe(false);
    expect(isPermission(undefined)).toBe(false);
  });
});
