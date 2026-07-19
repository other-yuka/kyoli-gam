import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  collectActionableDoctorDrift,
} from "../../../../scripts/check-kyoli-doctor-drift.mjs";

describe("collectActionableDoctorDrift", () => {
  it("leaves fingerprint and version warnings to the Class A/B automation", () => {
    const report = {
      name: "claude-binary",
      checks: [
        {
          name: "bundled template version",
          status: "warn",
          detail: "selected=2.1.206 bundled=2.1.205",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([]);
  });

  it("keeps runtime failures actionable", () => {
    const report = {
      name: "claude/obedience",
      checks: [
        {
          name: "client-system order",
          status: "fail",
          detail: "precedence preface was missing",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([
      {
        report: "claude/obedience",
        check: "client-system order",
        status: "fail",
        detail: "precedence preface was missing",
      },
    ]);
  });

  it("keeps non-fingerprint runtime warnings actionable", () => {
    const report = {
      name: "claude-binary",
      checks: [
        {
          name: "oauth config source",
          status: "warn",
          detail: "source=fallback",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([
      {
        report: "claude-binary",
        check: "oauth config source",
        status: "warn",
        detail: "source=fallback",
      },
    ]);
  });

  it("ignores the expected Node-only TLS warning", () => {
    const report = {
      name: "claude",
      checks: [
        {
          name: "runtime/tls/node-only",
          status: "warn",
          detail: "node-only: Node v22.0.0 uses OpenSSL TLS",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([]);
  });

  it("keeps an unverified Bun TLS warning actionable", () => {
    const report = {
      name: "claude",
      checks: [
        {
          name: "runtime/tls",
          status: "warn",
          detail: "unverified: Bun 1.3.8 is below verified floor 1.3.14",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([
      {
        report: "claude",
        check: "runtime/tls",
        status: "warn",
        detail: "unverified: Bun 1.3.8 is below verified floor 1.3.14",
      },
    ]);
  });

  it("schedules the default Claude doctor", () => {
    const workflow = readFileSync(
      new URL("../../../../.github/workflows/kyoli-doctor-drift-watch.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      '["pnpm","--dir","packages/cli","run","doctor","claude","--json"]',
    );
  });
});
